import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, Mic, MicOff, PhoneOff, Volume2 } from 'lucide-react'
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type TranscriptionSegment,
  type Participant,
} from 'livekit-client'
import { createWebCall } from '../lib/api.js'

/**
 * Test agent (simulator) — a live rehearsal call with the agent from the browser.
 *
 * This is a REAL session over a LiveKit room: the recording-notice pre-roll, Hebrew STT, the LLM
 * with its calendar tools against the real calendar, TTS, the speech guard — everything a phone
 * call does except the SIP leg. The orb's core scales to the agent's actual audio level (WebAudio
 * analyser), so when it moves, sound is genuinely arriving — nothing animates on faith. The
 * transcript fills from LiveKit transcription events when the agent emits them.
 */

type CallState = 'idle' | 'connecting' | 'waiting' | 'live' | 'ended' | 'error'

interface Turn {
  id: string
  role: 'agent' | 'user' | 'sys'
  text: string
}

const CARD: React.CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r)',
  boxShadow: 'var(--shadow-card)',
}

export function Simulator() {
  const { t } = useTranslation()
  const [state, setState] = useState<CallState>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [muted, setMuted] = useState(false)
  const [agentSpeaking, setAgentSpeaking] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [needsAudioStart, setNeedsAudioStart] = useState(false)
  const [transcript, setTranscript] = useState<Turn[]>([])

  const roomRef = useRef<Room | null>(null)
  // One <audio> element PER remote track — the recording notice and the agent are separate tracks,
  // and sharing one element makes whichever attaches last win (result: silence).
  const audioContainerRef = useRef<HTMLDivElement | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number>(0)
  const coreRef = useRef<HTMLSpanElement | null>(null)
  const speakingRef = useRef(false)
  const startedAtRef = useRef<number>(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const active = state === 'connecting' || state === 'waiting' || state === 'live'

  const teardown = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    if (coreRef.current) coreRef.current.style.transform = 'scale(1)'
    void audioCtxRef.current?.close().catch(() => undefined)
    audioCtxRef.current = null
    const room = roomRef.current
    roomRef.current = null
    void room?.disconnect()
  }, [])

  useEffect(() => () => teardown(), [teardown])

  // Auto-scroll the transcript as new captions land.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [transcript])

  /** Real audio level → the orb core's scale. Truthful motion: it grows only when sound arrives. */
  const watchAgentAudio = useCallback((track: RemoteTrack) => {
    const stream = new MediaStream([track.mediaStreamTrack])
    const ctx = new AudioContext()
    audioCtxRef.current = ctx
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)

    const tick = () => {
      analyser.getByteFrequencyData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i]
      const level = sum / data.length / 255 // 0..1
      const speaking = level > 0.02
      if (speaking !== speakingRef.current) {
        speakingRef.current = speaking
        setAgentSpeaking(speaking)
      }
      if (coreRef.current) coreRef.current.style.transform = `scale(${(1 + level * 1.6).toFixed(3)})`
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const startCall = useCallback(async () => {
    setErrorMsg('')
    setTranscript([])
    setState('connecting')
    try {
      // Ask for the mic FIRST, inside the click gesture — the prompt appears immediately and a
      // denial produces an actionable message instead of a dead call.
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
        probe.getTracks().forEach((tr) => tr.stop())
      } catch {
        throw new Error('MIC_BLOCKED')
      }

      const session = await createWebCall()
      const room = new Room()
      roomRef.current = room

      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
        if (track.kind !== Track.Kind.Audio) return
        const el = track.attach()
        audioContainerRef.current?.appendChild(el)
        // The orb follows the agent's voice, not the recording-notice pre-roll.
        if (pub.trackName !== 'recording-notice') watchAgentAudio(track)
        setState('live')
        setTranscript((prev) =>
          prev.some((tt) => tt.id === 'sys-started') ? prev : [...prev, { id: 'sys-started', role: 'sys', text: t('simulator.started') }],
        )
        if (!timerRef.current) {
          startedAtRef.current = Date.now()
          timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000)
        }
      })

      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) track.detach().forEach((el) => el.remove())
      })

      // Live captions — upsert by segment id (partial → final updates in place).
      room.on(RoomEvent.TranscriptionReceived, (segments: TranscriptionSegment[], participant?: Participant) => {
        const role: 'agent' | 'user' = participant?.isLocal ? 'user' : 'agent'
        setTranscript((prev) => {
          const next = [...prev]
          for (const seg of segments) {
            const idx = next.findIndex((tt) => tt.id === seg.id)
            if (idx >= 0) next[idx] = { ...next[idx], text: seg.text }
            else next.push({ id: seg.id, role, text: seg.text })
          }
          return next
        })
      })

      // Browser autoplay policy can silently refuse incoming audio — LiveKit tells us, and the fix
      // must come from a click, so we surface a button instead of hoping.
      room.on(RoomEvent.AudioPlaybackStatusChanged, () => setNeedsAudioStart(!room.canPlaybackAudio))

      room.on(RoomEvent.ConnectionStateChanged, (s: ConnectionState) => {
        if (s === ConnectionState.Disconnected) {
          setState((prev) => (prev === 'live' || prev === 'waiting' ? 'ended' : prev))
          teardown()
        }
      })

      await room.connect(session.url, session.token)
      await room.localParticipant.setMicrophoneEnabled(true)
      setMuted(false)
      setElapsed(0)
      setState('waiting')
    } catch (err) {
      teardown()
      const message =
        err instanceof Error && err.message === 'MIC_BLOCKED'
          ? t('simulator.micBlocked')
          : err instanceof Error && /HTTP 401|Invalid credentials|Unauthorized/i.test(err.message)
            ? t('simulator.notAuthorized')
            : err instanceof Error && err.message
              ? err.message
              : t('simulator.genericError')
      setErrorMsg(message)
      setState('error')
    }
  }, [teardown, watchAgentAudio, t])

  const hangUp = useCallback(() => {
    setState('ended')
    teardown()
  }, [teardown])

  const toggleMute = useCallback(async () => {
    const room = roomRef.current
    if (!room) return
    const next = !muted
    await room.localParticipant.setMicrophoneEnabled(!next)
    setMuted(next)
  }, [muted])

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  const stateLabel =
    state === 'live'
      ? agentSpeaking
        ? t('simulator.speaking')
        : t('simulator.listening')
      : state === 'error'
        ? errorMsg
        : t(`simulator.${state}`)

  // Rings brighten when the agent is speaking; the core scales from real audio (set imperatively).
  const ringActive = active
  return (
    <div style={{ maxInlineSize: '980px', marginInline: 'auto', display: 'grid', gap: '16px', gridTemplateColumns: '1fr', alignItems: 'stretch' }} className="ov-bottom">
      {/* Stage */}
      <div style={{ ...CARD, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '24px', padding: '40px 24px', minBlockSize: '420px' }}>
        <div
          className={state === 'connecting' || state === 'waiting' ? 'sim-orb-active' : undefined}
          style={{ position: 'relative', inlineSize: '180px', blockSize: '180px', display: 'grid', placeItems: 'center' }}
        >
          {[180, 140, 100].map((d, i) => (
            <span
              key={d}
              aria-hidden
              style={{
                position: 'absolute',
                inlineSize: `${d}px`,
                blockSize: `${d}px`,
                borderRadius: '50%',
                border: `1px solid ${ringActive ? 'var(--accent-fg)' : 'var(--border-strong)'}`,
                opacity: ringActive ? (agentSpeaking ? 0.5 + i * 0.15 : 0.3 + i * 0.12) : 0.4,
                transition: 'opacity var(--duration-base) var(--ease-standard), border-color var(--duration-base) var(--ease-standard)',
              }}
            />
          ))}
          <span
            ref={coreRef}
            aria-hidden
            style={{
              inlineSize: '64px',
              blockSize: '64px',
              borderRadius: '50%',
              background: active ? 'var(--accent)' : 'var(--surface-sunken)',
              border: '1px solid var(--border-strong)',
              transition: 'transform 90ms linear, background var(--duration-base) var(--ease-standard)',
            }}
          />
        </div>

        <div style={{ textAlign: 'center' }}>
          <div role="status" style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '17px', color: state === 'error' ? 'var(--status-danger)' : 'var(--text-primary)' }}>
            {stateLabel}
          </div>
          <div style={{ fontSize: '12.5px', color: 'var(--text-tertiary)', marginBlockStart: '4px', maxInlineSize: '340px' }}>{t('simulator.note')}</div>
          {active && (
            <div style={{ marginBlockStart: '8px', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: '13px', color: 'var(--text-tertiary)' }}>
              {mm}:{ss}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
          {!active ? (
            <button onClick={startCall} style={btnPrimary}>
              <Play size={16} strokeWidth={2} /> {state === 'ended' ? t('simulator.callAgain') : t('simulator.start')}
            </button>
          ) : (
            <>
              <button
                onClick={toggleMute}
                aria-pressed={muted}
                aria-label={muted ? t('simulator.unmute') : t('simulator.mute')}
                style={{
                  inlineSize: '44px',
                  blockSize: '44px',
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  border: '1px solid var(--border-default)',
                  background: muted ? 'color-mix(in srgb, var(--status-warning) 14%, transparent)' : 'var(--surface-card)',
                  color: muted ? 'var(--status-warning)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                {muted ? <MicOff size={18} strokeWidth={1.7} /> : <Mic size={18} strokeWidth={1.7} />}
              </button>
              <button onClick={hangUp} style={btnDanger}>
                <PhoneOff size={16} strokeWidth={1.9} /> {t('simulator.end')}
              </button>
            </>
          )}
        </div>

        {needsAudioStart && active && (
          <button
            onClick={() => void roomRef.current?.startAudio().then(() => setNeedsAudioStart(false))}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '9px 16px', borderRadius: 'var(--r-full)', border: '1px solid var(--status-warning)', background: 'transparent', color: 'var(--status-warning)', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
          >
            <Volume2 size={15} strokeWidth={1.8} /> {t('simulator.audioBlocked')}
          </button>
        )}
      </div>

      {/* Live transcript */}
      <div style={{ ...CARD, display: 'flex', flexDirection: 'column', minBlockSize: '420px' }}>
        <div style={{ padding: '14px 18px', borderBlockEnd: '1px solid var(--border-default)', fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '15px' }}>
          {t('simulator.transcript')}
        </div>
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {transcript.length === 0 ? (
            <div style={{ margin: 'auto', fontSize: '13px', color: 'var(--text-tertiary)' }}>{active ? t('simulator.listening') : t('simulator.idle')}</div>
          ) : (
            transcript.map((turn) =>
              turn.role === 'sys' ? (
                <div key={turn.id} style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-tertiary)' }}>{turn.text}</div>
              ) : (
                <div key={turn.id} style={{ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: turn.role === 'agent' ? 'flex-start' : 'flex-end' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{turn.role === 'agent' ? t('simulator.agent') : t('simulator.you')}</span>
                  <span dir="auto" style={{ fontSize: '13.5px', lineHeight: 1.55, color: 'var(--text-primary)', background: turn.role === 'agent' ? 'var(--surface-sunken)' : 'var(--accent-tint)', border: '1px solid var(--border-default)', borderRadius: '12px', padding: '9px 13px', maxInlineSize: '85%' }}>
                    {turn.text}
                  </span>
                </div>
              ),
            )
          )}
        </div>
        <div style={{ padding: '12px 18px', borderBlockStart: '1px solid var(--border-default)', fontSize: '12px', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
          {t('simulator.realNote')}
        </div>
      </div>

      <div ref={audioContainerRef} style={{ display: 'none' }} />
    </div>
  )
}

const btnPrimary: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  padding: '11px 20px',
  borderRadius: 'var(--r-full)',
  border: 0,
  background: 'var(--accent)',
  color: 'var(--text-on-accent)',
  fontFamily: 'var(--font-body)',
  fontSize: '14px',
  fontWeight: 600,
  cursor: 'pointer',
}

const btnDanger: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  padding: '11px 20px',
  borderRadius: 'var(--r-full)',
  border: '1px solid color-mix(in srgb, var(--status-danger) 40%, transparent)',
  background: 'color-mix(in srgb, var(--status-danger) 12%, transparent)',
  color: 'var(--status-danger)',
  fontFamily: 'var(--font-body)',
  fontSize: '14px',
  fontWeight: 600,
  cursor: 'pointer',
}
