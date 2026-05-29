/**
 * VoiceProfilesPage — manage voice-clone profiles.
 *
 * The TTS sidecar (Coqui XTTS-v2) clones any voice from a single
 * reference WAV file (6–30 s of clean speech). This page:
 *
 *   - lists existing profiles for the workspace
 *   - shows the sidecar's health (reachable + model loaded)
 *   - registers a new profile (operator places the audio file under
 *     data/voice-refs/<workspace_id>/ first, then enters the relative
 *     path here — no multipart upload pipeline)
 *   - attests consent before a profile becomes activatable
 *   - lets the operator pick the active profile (used by chat + brain)
 *   - exposes a "Test this voice" button that streams a synthesized
 *     sample audio back into the browser
 *
 * Honest scope:
 *   - No celebrity presets. The operator supplies the reference audio.
 *   - The consent toggle is self-attestation, not a check on the audio
 *     itself. Cloning real people without permission is illegal in
 *     many jurisdictions — this UI surfaces that risk in plain text.
 */
import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Mic, MicOff, Plus, Trash2, CheckCircle2, AlertTriangle, Play,
  Loader2, ShieldAlert, Volume2,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { PageHeader } from '../components/PageHeader.js'
import { EmptyState } from '../components/EmptyState.js'

interface VoiceProfile {
  id:                string
  workspaceId:       string
  name:              string
  refAudioPath:      string
  language:          string
  consentAttested:   boolean
  isActive:          boolean
  durationSeconds:   number | null
  notes:             string | null
  createdAt:         number
  updatedAt:         number
}

interface SidecarHealth {
  reachable:    boolean
  modelLoaded?: boolean
  device?:      string
  error?:       string
}

export default function VoiceProfilesPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [newName, setNewName]   = useState('')
  const [newPath, setNewPath]   = useState('')
  const [newLang, setNewLang]   = useState('en')
  const [newNotes, setNewNotes] = useState('')
  const [testText, setTestText] = useState('Hello — this is a quick voice test.')
  const [playing, setPlaying]   = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const profiles = useQuery({
    queryKey: ['voice-profiles', workspaceId],
    queryFn: () => api.get<{ data: VoiceProfile[] }>(`/api/v1/tts/profiles?workspace_id=${workspaceId}`),
  })

  const health = useQuery({
    queryKey: ['tts-sidecar-health'],
    queryFn:  () => api.get<{ data: SidecarHealth }>(`/api/v1/tts/sidecar/health`),
    refetchInterval: 10_000,
  })

  const create = useMutation({
    mutationFn: () => api.post<{ data: { id: string } }>(`/api/v1/tts/profiles`, {
      workspace_id: workspaceId,
      name: newName, ref_audio_path: newPath,
      language: newLang, notes: newNotes,
    }),
    onSuccess: () => {
      setNewName(''); setNewPath(''); setNewNotes('')
      qc.invalidateQueries({ queryKey: ['voice-profiles', workspaceId] })
    },
  })

  const consent = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/tts/profiles/${id}/consent`, {
      workspace_id: workspaceId, attested: true,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['voice-profiles', workspaceId] }),
  })

  const activate = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/tts/profiles/${id}/activate`, {
      workspace_id: workspaceId,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['voice-profiles', workspaceId] }),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/tts/profiles/${id}?workspace_id=${workspaceId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['voice-profiles', workspaceId] }),
  })

  async function testVoice(profileId: string) {
    setPlaying(profileId)
    try {
      const res = await fetch(`/api/v1/tts/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId,
          profile_id: profileId,
          text: testText,
        }),
      })
      if (!res.ok) throw new Error(`synth failed: HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      if (audioRef.current) {
        audioRef.current.src = url
        await audioRef.current.play()
      }
    } catch (e) {
      // eslint-disable-next-line no-alert
      alert((e as Error).message)
    } finally {
      setTimeout(() => setPlaying(null), 800)
    }
  }

  const list = profiles.data?.data ?? []
  const h = health.data?.data

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader
        breadcrumb="Operator · Voice"
        title="Voice Profiles"
        subtitle="Clone any voice for the brain + chat to speak in. Personal use only."
      />

      {/* Sidecar status */}
      <section className="panel p-4 mb-6 flex items-center gap-3">
        <div className={`w-2 h-2 rounded-full ${h?.reachable ? 'bg-[var(--accent-healthy)]' : 'bg-[var(--accent-critical)]'}`} />
        <div className="flex-1">
          <div className="text-[13px] text-[var(--text-primary)]">
            {h?.reachable ? 'TTS sidecar online' : 'TTS sidecar offline'}
          </div>
          <div className="text-[11px] text-[var(--text-muted)]">
            {h?.reachable
              ? `${h.device ?? 'cpu'} · model ${h.modelLoaded ? 'loaded' : 'cold (first synth will load it)'}`
              : `Start it from the repo root: python services/tts-sidecar/app.py`}
          </div>
        </div>
        {!h?.reachable && (
          <a href="https://github.com/coqui-ai/TTS"
             target="_blank" rel="noreferrer"
             className="text-[11px] text-[var(--accent-active)] hover:underline">
            Coqui TTS docs ↗
          </a>
        )}
      </section>

      {/* Ethical guardrail */}
      <section className="panel p-4 mb-6 border-[var(--accent-warning)]/40">
        <div className="flex items-start gap-2.5">
          <ShieldAlert className="w-4 h-4 text-[var(--accent-warning)] mt-0.5 shrink-0" />
          <div className="text-[12px] text-[var(--text-secondary)] leading-relaxed">
            Voice cloning of real people without their consent is illegal in many jurisdictions.
            By marking a profile as <em>consent attested</em> you confirm you have permission to use that voice.
            This system is personal-use only — never publish synthesized audio of others without explicit consent.
          </div>
        </div>
      </section>

      {/* Register new */}
      <section className="panel p-5 mb-6">
        <h2 className="text-[13px] font-medium mb-3 text-[var(--text-primary)]">Add a profile</h2>
        <p className="text-[11px] text-[var(--text-muted)] mb-4 leading-relaxed">
          1. Drop a clean 6–30 s WAV under <code className="text-[var(--text-secondary)]">data/voice-refs/{workspaceId}/</code>
          (CPU works; GPU recommended).<br />
          2. Enter the relative path below — e.g. <code className="text-[var(--text-secondary)]">{workspaceId}/my-voice.wav</code>.<br />
          3. Attest consent before activating.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input value={newName} onChange={(e) => setNewName(e.target.value)}
            placeholder="Profile name (e.g. Calm Narrator)"
            className="input" />
          <input value={newPath} onChange={(e) => setNewPath(e.target.value)}
            placeholder={`${workspaceId}/my-voice.wav`}
            className="input font-mono text-[12px]" />
          <select value={newLang} onChange={(e) => setNewLang(e.target.value)}
            className="input">
            {['en','es','fr','de','it','pt','pl','tr','ru','nl','cs','ar','zh-cn','hu','ko','ja','hi'].map(l =>
              <option key={l} value={l}>{l}</option>,
            )}
          </select>
          <input value={newNotes} onChange={(e) => setNewNotes(e.target.value)}
            placeholder="Notes (optional)"
            className="input" />
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button onClick={() => create.mutate()}
            disabled={create.isPending || !newName.trim() || !newPath.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent-active)]/15 border border-[var(--accent-active)]/40 hover:bg-[var(--accent-active)]/25 text-[var(--accent-active)] text-[12px] disabled:opacity-40 focus-ring">
            {create.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Register profile
          </button>
          {create.isError && (
            <span className="text-[11px] text-[var(--accent-critical)] flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              {(create.error as Error).message}
            </span>
          )}
        </div>
      </section>

      {/* Test text */}
      <section className="panel p-4 mb-6 flex items-center gap-3">
        <Volume2 className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
        <input value={testText} onChange={(e) => setTestText(e.target.value)}
          placeholder="Text to speak when testing"
          className="input flex-1" />
        <audio ref={audioRef} className="hidden" controls />
      </section>

      {/* Profiles */}
      {profiles.isLoading && (
        <div className="text-[12px] text-[var(--text-muted)]">loading profiles…</div>
      )}

      {!profiles.isLoading && list.length === 0 && (
        <EmptyState
          icon={<MicOff className="w-8 h-8" />}
          title="No voice profiles yet"
          description="Drop a WAV in the voice-refs folder, register it above, and the brain will start speaking in that voice."
        />
      )}

      {list.length > 0 && (
        <div className="space-y-2">
          {list.map(p => (
            <div key={p.id} className="panel p-4 flex items-center gap-4">
              <div className={`w-9 h-9 rounded-md flex items-center justify-center ${
                p.isActive
                  ? 'bg-[var(--accent-active)]/15 text-[var(--accent-active)]'
                  : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]'
              }`}>
                <Mic className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-[var(--text-primary)]">{p.name}</span>
                  <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{p.language}</span>
                  {p.isActive && <span className="text-[10px] text-[var(--accent-active)]">· ACTIVE</span>}
                </div>
                <div className="text-[11px] font-mono text-[var(--text-muted)] truncate">{p.refAudioPath}</div>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => testVoice(p.id)}
                  disabled={playing === p.id || !h?.reachable}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--border)] hover:border-[var(--border-strong)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40 focus-ring">
                  {playing === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} test
                </button>
                {!p.consentAttested ? (
                  <button onClick={() => consent.mutate(p.id)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--accent-warning)]/40 text-[var(--accent-warning)] hover:bg-[var(--accent-warning)]/10 text-[11px] focus-ring">
                    attest consent
                  </button>
                ) : !p.isActive ? (
                  <button onClick={() => activate.mutate(p.id)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--accent-active)]/40 text-[var(--accent-active)] hover:bg-[var(--accent-active)]/10 text-[11px] focus-ring">
                    <CheckCircle2 className="w-3 h-3" /> activate
                  </button>
                ) : (
                  <span className="text-[11px] text-[var(--accent-healthy)] flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> in use
                  </span>
                )}
                <button onClick={() => remove.mutate(p.id)}
                  className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--accent-critical)] focus-ring"
                  title="Delete profile">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
