import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Phone, PhoneOff } from 'lucide-react'
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client'
import { createWebCall } from '../lib/api.js'

/**
 * Voice Simulator — a live rehearsal call with Keren from the browser.
 *
 * This exercises the ENTIRE agent pipeline over a real LiveKit room — the recording-notice
 * pre-roll, Hebrew STT, the LLM with its calendar tools against the real calendar, TTS, the
 * speech guard — everything a phone call does except the SIP leg. Built so the Phase 4 flow can
 * be rehearsed from anywhere (Koren is abroad; the merge gate needs a conversation, not a SIM).
 *
 * The signature element is the call ring: one control that IS the state. Its audio bars are
 * driven by the agent's real audio level via WebAudio — when the bars move, sound is actually
 * arriving; nothing here animates on faith.
 */

type CallState = 'idle' | 'connecting' | 'waiting' | 'live' | 'ended' | 'error'

const STATUS_LINE: Record<CallState, string> = {
  idle: 'Start a call and speak Hebrew — Keren answers like it’s a real phone call.',
  connecting: 'Connecting to the room…',
  waiting: 'Waiting for Keren to pick up…',
  live: '', // composed live from speaking/listening below
  ended: 'Call ended. The full report lands in call-reports/ and call_learnings.',
  error: '',
}

const BAR_COUNT = 5

export function VoiceChat() {
  const [state, setState] = useState<CallState>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [muted, setMuted] = useState(false)
  const [agentSpeaking, setAgentSpeaking] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  const roomRef = useRef<Room | null>(null)
  /** One <audio> element PER remote track — the recording notice and Keren are separate tracks,
   * and attaching both to a single element makes the last one win (heard: total silence). */
  const audioContainerRef = useRef<HTMLDivElement | null>(null)
  const [needsAudioStart, setNeedsAudioStart] = useState(false)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number>(0)
  const barRefs = useRef<Array<HTMLDivElement | null>>([])
  const startedAtRef = useRef<number>(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const teardown = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    void audioCtxRef.current?.close().catch(() => undefined)
    audioCtxRef.current = null
    const room = roomRef.current
    roomRef.current = null
    void room?.disconnect()
  }, [])

  useEffect(() => () => teardown(), [teardown])

  /** Real audio level → the ring's bars. Truthful motion: bars move only when sound arrives. */
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
      setAgentSpeaking(level > 0.02)
      barRefs.current.forEach((bar, i) => {
        if (!bar) return
        // Center bars taller — a voice, not a spectrum. Each bar keys off a different band.
        const band = data[Math.floor(((i + 1) / (BAR_COUNT + 1)) * data.length * 0.5)] / 255
        const centerBias = 1 - Math.abs(i - (BAR_COUNT - 1) / 2) / BAR_COUNT
        bar.style.height = `${8 + Math.round(band * 40 * (0.6 + centerBias))}px`
      })
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const startCall = useCallback(async () => {
    setErrorMsg('')
    setState('connecting')
    try {
      // Ask for the mic FIRST, inside the click gesture — the browser prompt appears
      // immediately, and a denial produces an actionable message instead of a dead call.
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
        probe.getTracks().forEach((t) => t.stop())
      } catch {
        throw new Error(
          'Microphone is blocked. Click the lock icon in the address bar, allow the microphone, then try again.',
        )
      }

      const session = await createWebCall()
      const room = new Room()
      roomRef.current = room

      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
        if (track.kind !== Track.Kind.Audio) return
        // Each track gets its OWN element — the notice pre-roll and Keren's voice arrive as
        // separate tracks, and sharing one element means whichever attached last silences the
        // other. The notice track unpublishes itself after ~2s; TrackUnsubscribed cleans it up.
        const el = track.attach()
        audioContainerRef.current?.appendChild(el)
        // The ring's bars follow KEREN, not the pre-roll announcement.
        if (pub.trackName !== 'recording-notice') watchAgentAudio(track)
        setState('live')
        if (!timerRef.current) {
          startedAtRef.current = Date.now()
          timerRef.current = setInterval(
            () => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)),
            1000,
          )
        }
      })

      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) track.detach().forEach((el) => el.remove())
      })

      // Browser autoplay policy can silently refuse to play incoming audio. LiveKit tells us —
      // and the fix must come from a click, so we surface a button instead of praying.
      room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
        setNeedsAudioStart(!room.canPlaybackAudio)
      })

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
        err instanceof Error && /HTTP 401|Invalid credentials|Unauthorized/i.test(err.message)
          ? 'This dashboard is not authorized against the backend it is pointed at. Check the API key (localStorage auth_token / VITE_API_KEY).'
          : err instanceof Error
            ? err.message
            : 'Could not start the call'
      setErrorMsg(message)
      setState('error')
    }
  }, [teardown, watchAgentAudio])

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

  const inCall = state === 'connecting' || state === 'waiting' || state === 'live'
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  const liveStatus = agentSpeaking ? 'Keren is speaking' : 'Listening — go ahead'
  const status = state === 'live' ? liveStatus : state === 'error' ? errorMsg : STATUS_LINE[state]

  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 24px' }}>
      <style>{`
        @keyframes vc-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(15, 163, 172, 0.25); }
          50% { box-shadow: 0 0 0 18px rgba(15, 163, 172, 0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .vc-ring { animation: none !important; }
        }
      `}</style>

      <div style={{ width: '100%', maxWidth: 520, textAlign: 'center' }}>
        <div
          style={{
            fontSize: 11,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--accent-hover)',
            marginBottom: 8,
          }}
        >
          Voice simulator
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          Call Keren from here
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, margin: '10px 0 36px' }}>
          The full agent pipeline over a real room — recording notice, calendar booking, everything
          except the phone line.
        </p>

        {/* The call ring — one control that IS the call state. */}
        <button
          onClick={inCall ? hangUp : startCall}
          aria-label={inCall ? 'Hang up' : 'Start call'}
          className={state === 'connecting' || state === 'waiting' ? 'vc-ring' : undefined}
          style={{
            width: 160,
            height: 160,
            borderRadius: '50%',
            border: `2px solid ${inCall ? (agentSpeaking ? 'var(--accent-fg)' : 'var(--border-strong)') : 'var(--accent-hover)'}`,
            background:
              state === 'live'
                ? 'radial-gradient(circle at 50% 45%, rgba(15, 163, 172,0.10), var(--surface-card) 70%)'
                : 'var(--surface-card)',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'border-color var(--duration-base) var(--ease-standard)',
            animation:
              state === 'connecting' || state === 'waiting'
                ? 'vc-pulse 1.8s var(--ease-standard) infinite'
                : undefined,
          }}
        >
          {state === 'live' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, height: 56 }} aria-hidden>
              {Array.from({ length: BAR_COUNT }, (_, i) => (
                <div
                  key={i}
                  ref={(el) => {
                    barRefs.current[i] = el
                  }}
                  style={{
                    width: 6,
                    height: 8,
                    borderRadius: 3,
                    background: 'var(--accent-fg)',
                    transition: 'height 90ms linear',
                  }}
                />
              ))}
            </div>
          ) : inCall ? (
            <PhoneOff size={44} strokeWidth={1.5} />
          ) : (
            <Phone size={44} strokeWidth={1.5} color="var(--accent-fg)" />
          )}
        </button>

        <div
          role="status"
          style={{
            marginTop: 24,
            minHeight: 22,
            fontSize: 14,
            color: state === 'error' ? 'var(--status-danger)' : 'var(--text-secondary)',
          }}
        >
          {status}
        </div>

        {needsAudioStart && inCall && (
          <button
            onClick={() => {
              void roomRef.current?.startAudio().then(() => setNeedsAudioStart(false))
            }}
            style={{
              marginTop: 12,
              padding: '10px 20px',
              borderRadius: 8,
              border: '1px solid var(--status-warning)',
              background: 'transparent',
              color: 'var(--status-warning)',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            🔊 The browser muted the call — click to hear Keren
          </button>
        )}

        {inCall && (
          <div style={{ marginTop: 6, fontVariantNumeric: 'tabular-nums', color: 'var(--text-tertiary)', fontSize: 13 }}>
            {mm}:{ss}
          </div>
        )}

        {inCall && (
          <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center', gap: 12 }}>
            <button
              onClick={toggleMute}
              aria-pressed={muted}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 16px',
                borderRadius: 8,
                border: '1px solid var(--border-default)',
                background: muted ? 'var(--surface-sunken)' : 'transparent',
                color: muted ? 'var(--status-warning)' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              {muted ? <MicOff size={16} strokeWidth={1.5} /> : <Mic size={16} strokeWidth={1.5} />}
              {muted ? 'Unmute' : 'Mute'}
            </button>
            <button
              onClick={hangUp}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 16px',
                borderRadius: 8,
                border: '1px solid transparent',
                background: 'var(--status-danger)',
                color: '#fff',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              <PhoneOff size={16} strokeWidth={1.5} />
              Hang up
            </button>
          </div>
        )}

        {state === 'ended' && (
          <button
            onClick={startCall}
            style={{
              marginTop: 20,
              padding: '8px 18px',
              borderRadius: 8,
              border: '1px solid var(--accent-hover)',
              background: 'transparent',
              color: 'var(--accent-fg)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Call again
          </button>
        )}

        {/* What this rehearsal actually exercises — informative, not decorative. */}
        <div
          style={{
            marginTop: 48,
            textAlign: 'left',
            background: 'var(--surface-card)',
            border: '1px solid var(--border-default)',
            borderRadius: 12,
            padding: '16px 20px',
            fontSize: 13,
            color: 'var(--text-secondary)',
            lineHeight: 1.7,
          }}
        >
          <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: 6 }}>
            This is a real session
          </div>
          The recording notice plays first, then Keren greets you in Hebrew. If booking tools are
          enabled for your tenant, she checks the real calendar and books real meetings — use a
          test email. Requires the agent worker to be running.
        </div>

        <div ref={audioContainerRef} style={{ display: 'none' }} />
      </div>
    </div>
  )
}
