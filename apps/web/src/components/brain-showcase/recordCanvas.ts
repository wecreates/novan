/**
 * recordCanvas.ts — Record the WebGL canvas to a downloadable WebM/MP4
 * via the browser's MediaRecorder API.
 *
 * Captures `canvas.captureStream(fps)`. WebM (vp9 or vp8) is the
 * universally-supported container; MP4 (h264) is added when the
 * browser advertises support so the operator gets a file most
 * platforms accept natively.
 *
 * Honest scope: this is a single-track video recorder, not a
 * production cinema export. No audio. Quality is "good enough to
 * post," not "good enough for a sizzle reel."
 */

export interface RecordHandle {
  stop: () => Promise<Blob | null>
  /** True if MediaRecorder + captureStream are available in this browser. */
  supported: boolean
}

const CANDIDATE_MIME_TYPES = [
  'video/mp4; codecs="avc1.42E01E"',   // H.264 baseline — Safari preference
  'video/webm; codecs=vp9',
  'video/webm; codecs=vp8',
  'video/webm',
] as const

export function pickSupportedMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const m of CANDIDATE_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return null
}

export function startRecording(canvas: HTMLCanvasElement, fps: number = 30): RecordHandle {
  const supported = typeof MediaRecorder !== 'undefined'
    && typeof (canvas as { captureStream?: unknown }).captureStream === 'function'
  if (!supported) {
    return { supported: false, stop: async () => null }
  }
  const mime = pickSupportedMime()
  if (!mime) return { supported: false, stop: async () => null }

  // captureStream is a real method but TS lib lags — narrow + cast safely.
  const cs = (canvas as unknown as { captureStream: (fps: number) => MediaStream }).captureStream(fps)
  const recorder = new MediaRecorder(cs, { mimeType: mime, videoBitsPerSecond: 4_000_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data) }
  recorder.start(1_000)   // 1-second chunks

  return {
    supported: true,
    stop: () => new Promise(resolve => {
      recorder.onstop = () => {
        if (chunks.length === 0) { resolve(null); return }
        resolve(new Blob(chunks, { type: mime }))
      }
      try { recorder.stop() } catch { resolve(null) }
    }),
  }
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke after a tick so the click can finish committing the download.
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** Pick a file extension from the mime string. */
export function extFromMime(mime: string): 'mp4' | 'webm' {
  return mime.includes('mp4') ? 'mp4' : 'webm'
}
