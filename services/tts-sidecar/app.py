"""
tts-sidecar — Coqui XTTS-v2 voice-cloning service.

Standalone FastAPI process the Novan API calls over HTTP. Runs on its
own port (default 5005) so the Node API stays free of Python deps.

Why a sidecar:
  - XTTS-v2 needs PyTorch + CUDA + a ~1.5 GB model. Keeping that
    isolated from the Node runtime means the API stays light and the
    sidecar can crash / restart without touching the rest of the
    platform.
  - Loaded once at startup; every /synthesize call reuses the warm
    model (first call ~5 s for model load, subsequent calls <1 s on
    GPU, ~5–10 s on CPU).

Endpoints:
  GET  /health         → { ok, model_loaded, device }
  POST /synthesize     → audio/wav body
  GET  /languages      → list of supported XTTS-v2 languages

Honest scope:
  - This is an inference server, not a training server. It clones
    timbre zero-shot from a single short reference clip (6–30 s of
    clean speech works best).
  - No celebrity presets are bundled. The operator supplies their own
    reference audio paths.
  - This binary is for the operator's personal use only. Do not deploy
    to a public surface — voice cloning of non-consenting parties is
    illegal in many jurisdictions.
"""

from __future__ import annotations

import io
import os
import logging
import wave
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tts-sidecar")

# Model handle is lazy — loaded on first synth or via /warm.
_tts = None
_device = "cpu"


def _load_model():
    """Load XTTS-v2 once, cache the handle."""
    global _tts, _device
    if _tts is not None:
        return _tts

    # Imported lazily so the FastAPI process starts even when torch is
    # uninstalled (returns clear /health errors instead of crashing).
    try:
        import torch  # noqa: WPS433
        from TTS.api import TTS  # noqa: WPS433
    except ImportError as e:
        raise HTTPException(
            status_code=503,
            detail=(
                "TTS dependencies missing — install with: "
                "pip install -r services/tts-sidecar/requirements.txt"
                f" (underlying: {e})"
            ),
        ) from e

    _device = "cuda" if torch.cuda.is_available() else "cpu"
    log.info("Loading XTTS-v2 on %s — first run will download the model", _device)
    _tts = TTS(model_name="tts_models/multilingual/multi-dataset/xtts_v2").to(_device)
    log.info("XTTS-v2 loaded.")
    return _tts


# ─── App ──────────────────────────────────────────────────────────────

app = FastAPI(title="Novan TTS sidecar", version="0.1.0")

# Where reference audio files live, set by the launcher. The Node API
# writes relative paths to the voice_profiles table; we resolve them
# under this directory so the sidecar can't be tricked into reading
# arbitrary host paths.
REF_ROOT = Path(os.environ.get("TTS_REF_ROOT", "data/voice-refs")).resolve()
REF_ROOT.mkdir(parents=True, exist_ok=True)


@app.get("/health")
def health() -> JSONResponse:
    """Cheap probe — doesn't trigger model load."""
    return JSONResponse({
        "ok": True,
        "model_loaded": _tts is not None,
        "device": _device,
        "ref_root": str(REF_ROOT),
    })


@app.post("/warm")
def warm() -> JSONResponse:
    """Force model load now so the first /synthesize is fast."""
    _load_model()
    return JSONResponse({"ok": True, "device": _device})


@app.get("/languages")
def languages() -> JSONResponse:
    """XTTS-v2 supports these out of the box."""
    return JSONResponse({
        "languages": [
            "en", "es", "fr", "de", "it", "pt", "pl", "tr",
            "ru", "nl", "cs", "ar", "zh-cn", "hu", "ko", "ja", "hi",
        ],
    })


class SynthesizeIn(BaseModel):
    text:        str = Field(min_length=1, max_length=2_000)
    # Relative path under REF_ROOT (e.g. "ws_dev/morgan.wav"). Optional
    # — when omitted, the sidecar synthesizes with a default speaker.
    speaker_wav: Optional[str] = None
    language:    str = "en"
    speed:       float = Field(default=1.0, ge=0.5, le=1.5)


def _resolve_ref(rel: str) -> Path:
    """Safely resolve a reference path under REF_ROOT (no escaping)."""
    p = (REF_ROOT / rel).resolve()
    if REF_ROOT not in p.parents and p != REF_ROOT:
        raise HTTPException(status_code=400, detail="invalid speaker_wav path")
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"speaker_wav not found: {rel}")
    return p


@app.post("/synthesize")
def synthesize(req: SynthesizeIn) -> Response:
    tts = _load_model()
    kwargs = {"text": req.text, "language": req.language, "speed": req.speed}
    if req.speaker_wav:
        kwargs["speaker_wav"] = str(_resolve_ref(req.speaker_wav))
    else:
        # XTTS-v2 requires a speaker_wav for voice cloning; fall back to
        # the bundled sample so a smoke test still works.
        # (Operator is expected to manage their own profiles.)
        try:
            kwargs["speaker"] = tts.speakers[0] if hasattr(tts, "speakers") and tts.speakers else None
        except Exception:
            pass

    try:
        wav = tts.tts(**{k: v for k, v in kwargs.items() if v is not None})
    except Exception as e:
        log.exception("synth failed")
        raise HTTPException(status_code=500, detail=f"synth failed: {e}") from e

    # Convert float32 list/np array → 16-bit PCM WAV in memory
    import numpy as np
    arr = np.asarray(wav, dtype=np.float32)
    arr = np.clip(arr, -1.0, 1.0)
    pcm = (arr * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24_000)
        w.writeframes(pcm.tobytes())
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("TTS_SIDECAR_PORT", "5005"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
