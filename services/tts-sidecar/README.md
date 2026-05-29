# Novan TTS Sidecar

Voice-cloning service that wraps [Coqui XTTS-v2](https://github.com/coqui-ai/TTS) for personal-use voice synthesis.

## What it is

A FastAPI process running alongside the Novan API. The Node API proxies synthesis requests to this sidecar over HTTP (port 5005 by default). XTTS-v2 clones any voice from a single short audio reference (6–30 s of clean speech), so each "voice profile" in Novan is just a friendly name + a path to a reference WAV file.

## What it isn't

- **Not a celebrity preset library.** No bundled voices. You supply your own reference audio.
- **Not for commercial deployment.** This is a personal-use tool. Cloning real people's voices without consent is illegal in many jurisdictions. The `voice_profiles.consent_attested` column tracks self-attested consent for auditability.
- **Not exposed publicly.** The sidecar binds to `127.0.0.1` only.

## Setup (one-time)

```powershell
# 1. Install TTS-dev in editable mode from your local checkout
pip install -e "C:/Users/19496/Downloads/TTS-dev"

# 2. Install sidecar runtime deps
pip install -r services/tts-sidecar/requirements.txt

# 3. Install PyTorch — CUDA build if you have a GPU (recommended)
#    GPU: ~1 s per ~5-word utterance
#    CPU: ~5–15 s per utterance
pip install torch==2.4.0 --index-url https://download.pytorch.org/whl/cu121
# OR (CPU only):
pip install torch==2.4.0
```

## Run

```powershell
# From the Novan repo root
python services/tts-sidecar/app.py
# Default port 5005. Override with TTS_SIDECAR_PORT=5006 etc.
```

The first `/synthesize` call downloads the XTTS-v2 model (~1.5 GB) into `~/.local/share/tts/`. Subsequent runs reuse the cache.

## Health check

```powershell
curl http://127.0.0.1:5005/health
# { "ok": true, "model_loaded": false, "device": "cuda", "ref_root": "..." }
```

## Adding a voice profile

1. Get a 6–30 s clean WAV of the target voice (`16 kHz mono` works best, but XTTS resamples internally).
2. Save it under `data/voice-refs/<workspace_id>/<name>.wav`.
3. In Novan, go to **Account → Voice Profiles** and link the file.
4. Mark it active. The brain + chat will use that voice for every synthesis from then on.

## Endpoint reference

| Endpoint | Method | Notes |
|---|---|---|
| `/health` | GET | Cheap probe |
| `/warm` | POST | Force model load (returns once warm) |
| `/languages` | GET | XTTS-v2 supported language codes |
| `/synthesize` | POST | `{ text, speaker_wav?, language?, speed? }` → `audio/wav` |

## Failure modes

- **Sidecar not running** → Novan API returns 503 with a clear "TTS sidecar unreachable" message. The rest of the platform still works.
- **Reference audio missing** → 404 with the bad path.
- **Path escapes `data/voice-refs/`** → 400 (host filesystem is protected).
- **Model load fails** → 503 with the underlying torch error.

The Node API treats every TTS call as best-effort. If the sidecar is down or slow, voice playback degrades but text responses are unaffected.
