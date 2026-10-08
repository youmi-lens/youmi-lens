import type { DesktopI18nKey } from '../lib/desktopI18n'
import type { ProcessingPhase } from '../lib/lectureLifecycle'
import { processingStageStates, type ProcessingStageState } from '../lib/processingStages'
import '../styles/lecture-processing.css'

type T = (key: DesktopI18nKey, vars?: Record<string, string | number>) => string

/**
 * One panel for the whole processing lifecycle: waiting → transcribing →
 * summarizing → done, or failed with Retry.
 *
 * It performs no I/O. Retry and View Lecture are callbacks into the existing
 * handlers; the phase is derived by `lectureLifecycle` from the authoritative
 * server status.
 */
export function LectureProcessingPanel({
  t,
  phase,
  stalled = false,
  busy = false,
  onRetry,
  onViewLecture,
}: {
  t: T
  phase: ProcessingPhase
  /** In flight on the server but silent for a long time: Retry is offered. */
  stalled?: boolean
  busy?: boolean
  onRetry?: () => void
  onViewLecture?: () => void
}) {
  if (phase === 'failed') {
    return (
      <div className="lecture-processing" data-phase="failed" role="alert">
        <h2>{t('processing.failedTitle')}</h2>
        <p>{t('processing.failedBody')}</p>
        <div className="lecture-processing__actions">
          <button type="button" className="v2-btn v2-btn--record" onClick={onRetry} disabled={busy}>
            {t('common.retry')}
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'done') {
    return (
      <div className="lecture-processing" data-phase="done" role="status" aria-live="polite">
        <h2>{t('processing.doneTitle')}</h2>
        <p>{t('processing.doneBody')}</p>
        <div className="lecture-processing__actions">
          {onViewLecture ? (
            <button type="button" className="v2-btn v2-btn--record" onClick={onViewLecture} disabled={busy}>
              {t('recording.viewLecture')}
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  const stages = processingStageStates(phase)
  const rows: Array<{ key: string; label: string; state: ProcessingStageState }> = [
    { key: 'saved', label: t('processing.stageSaved'), state: 'done' },
    { key: 'transcribing', label: t('processing.stageTranscribing'), state: stages.transcribing },
    { key: 'summarizing', label: t('processing.stageSummarizing'), state: stages.summarizing },
  ]

  return (
    <div className="lecture-processing" data-phase={phase} data-stalled={stalled ? 'true' : undefined} role="status" aria-live="polite">
      <span className="lecture-processing__spinner" aria-hidden="true" />
      <h2>{stalled ? t('processing.stalledTitle') : t('processing.title')}</h2>
      <p>{stalled ? t('processing.stalledBody') : t('processing.body')}</p>
      <ol className="lecture-processing__stages">
        {rows.map((row) => (
          <li
            key={row.key}
            className="lecture-processing__stage"
            data-state={row.state}
            aria-current={row.state === 'active' ? 'step' : undefined}
          >
            <span className="lecture-processing__mark" aria-hidden="true">
              {row.state === 'done' ? '✓' : ''}
            </span>
            {row.label}
          </li>
        ))}
      </ol>
      {phase === 'waiting' ? <p className="lecture-processing__note">{t('processing.stageWaiting')}</p> : null}
      {stalled ? (
        <div className="lecture-processing__actions">
          <button type="button" className="v2-btn" onClick={onRetry} disabled={busy}>
            {t('common.retry')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
