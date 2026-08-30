import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * The controls this player hands back to its parent.
 *
 * Marks need to move playback, and there must be exactly one audio element on
 * the screen — a second `<audio>` would play over the first and desynchronise
 * the scrubber. So the parent gets a handle into THIS element instead of its
 * own player.
 */
export type AudioPlayerHandle = {
  /** Move playback to `seconds`. Does not start or stop playback. */
  seekTo: (seconds: number) => void
  /** Current playback position in seconds, for creating a mark. */
  currentTime: () => number
}

type Props = {
  recordingId: string
  src: string
  /** Saved duration from DB; shown immediately and merged with browser metadata when ready. */
  durationSecFallback: number
  /** Filled with the handle above while this player is mounted. */
  controlsRef?: RefObject<AudioPlayerHandle | null>
}

function formatAudioClock(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '0:00'
  const s = Math.floor(totalSec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
  return `${m}:${String(r).padStart(2, '0')}`
}

/**
 * Lecture playback: fixed total duration (left = progress, right = length), scrub, play/pause.
 */
export function RecordingAudioPlayer({
  recordingId,
  src,
  durationSecFallback,
  controlsRef,
}: Props) {
  const ref = useRef<HTMLAudioElement>(null)
  const scrubRef = useRef(false)
  const [playing, setPlaying] = useState(false)
  const [currentSec, setCurrentSec] = useState(0)
  const [frozenTotalSec, setFrozenTotalSec] = useState(() => Math.max(0, durationSecFallback))

  const mergeTotalFromBrowser = useCallback(
    (el: HTMLAudioElement) => {
      const d = el.duration
      const db = Math.max(0, durationSecFallback)
      if (Number.isFinite(d) && d > 0 && d !== Infinity && d < 1e7) {
        setFrozenTotalSec(Math.max(Math.round(d), db))
      } else {
        setFrozenTotalSec(db)
      }
    },
    [durationSecFallback],
  )

  useEffect(() => {
    scrubRef.current = false
    setPlaying(false)
    setCurrentSec(0)
    setFrozenTotalSec(Math.max(0, durationSecFallback))
    const el = ref.current
    if (el) el.load()
  }, [recordingId, src, durationSecFallback])

  const totalSecDisplayRef = useRef(frozenTotalSec)
  useEffect(() => {
    totalSecDisplayRef.current = frozenTotalSec
  }, [frozenTotalSec])

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const onTimeUpdate = () => {
      if (!scrubRef.current) setCurrentSec(el.currentTime)
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnded = () => {
      setPlaying(false)
      scrubRef.current = false
      setCurrentSec(totalSecDisplayRef.current)
    }

    const onMeta = () => {
      mergeTotalFromBrowser(el)
      if (!scrubRef.current) setCurrentSec(el.currentTime)
    }

    el.addEventListener('timeupdate', onTimeUpdate)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('canplay', onMeta)

    if (el.readyState >= 1) mergeTotalFromBrowser(el)

    return () => {
      el.removeEventListener('timeupdate', onTimeUpdate)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('canplay', onMeta)
    }
  }, [recordingId, src, mergeTotalFromBrowser])

  const safeMax = Math.max(frozenTotalSec, 0.001)

  /*
   * Publish the handle.
   *
   * `seekTo` writes the same `el.currentTime` the scrubber writes and mirrors it
   * into `currentSec`, so the transport reflects the jump immediately instead of
   * waiting for the next `timeupdate`. Playback state is deliberately untouched:
   * jumping to a mark while paused must not start playing, and jumping while
   * playing must not stop it.
   */
  useEffect(() => {
    if (!controlsRef) return
    controlsRef.current = {
      seekTo: (seconds: number) => {
        const el = ref.current
        if (!el || !Number.isFinite(seconds)) return
        const clamped = Math.min(Math.max(0, seconds), Math.max(frozenTotalSec, 0.001))
        scrubRef.current = false
        el.currentTime = clamped
        setCurrentSec(clamped)
      },
      currentTime: () => ref.current?.currentTime ?? 0,
    }
    return () => {
      controlsRef.current = null
    }
  }, [controlsRef, frozenTotalSec])

  const togglePlay = () => {
    const el = ref.current
    if (!el) return
    if (el.paused) void el.play().catch(() => undefined)
    else el.pause()
  }

  const onRangeInput = (v: number) => {
    const el = ref.current
    if (!el) return
    scrubRef.current = true
    const clamped = Math.min(Math.max(0, v), safeMax)
    el.currentTime = clamped
    setCurrentSec(clamped)
  }

  const onRangeCommit = () => {
    scrubRef.current = false
    const el = ref.current
    if (el) setCurrentSec(el.currentTime)
  }

  return (
    <div className="recording-audio-player">
      <audio ref={ref} preload="metadata" src={src} className="recording-audio-player__element">
        Audio
      </audio>
      <div className="recording-audio-player__shell">
        <button
          type="button"
          className="recording-audio-player__round-btn"
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? (
            <span className="recording-audio-player__icon-pause" aria-hidden />
          ) : (
            <span className="recording-audio-player__icon-play" aria-hidden />
          )}
        </button>
        <div className="recording-audio-player__track-wrap">
          <div className="recording-audio-player__times">
            <span className="recording-audio-player__t recording-audio-player__t--current">
              {formatAudioClock(currentSec)}
            </span>
            <span className="recording-audio-player__t recording-audio-player__t--total">
              {formatAudioClock(frozenTotalSec)}
            </span>
          </div>
          <input
            type="range"
            className="recording-audio-player__range"
            min={0}
            max={safeMax}
            step={0.01}
            value={Math.min(currentSec, safeMax)}
            onInput={(e) => onRangeInput(Number(e.currentTarget.value))}
            onChange={onRangeCommit}
            onPointerDown={() => {
              scrubRef.current = true
            }}
            onPointerUp={onRangeCommit}
            onPointerCancel={onRangeCommit}
            aria-label="Seek playback"
          />
        </div>
      </div>
    </div>
  )
}
