import type { ProcessingPhase } from './lectureLifecycle'

export type ProcessingStageState = 'done' | 'active' | 'pending'

/**
 * The stages the backend can actually tell apart, and nothing else.
 *
 * `waiting` (pending / queued) → transcribing → summarizing → done. There is no
 * "preparing" step and no percentage: the server reports discrete states, so a
 * fraction or an extra step would be invented. "Recording saved" is always true
 * where this is shown — the panel only ever appears for a lecture whose audio is
 * persisted.
 */
export function processingStageStates(phase: ProcessingPhase): {
  transcribing: ProcessingStageState
  summarizing: ProcessingStageState
} {
  switch (phase) {
    case 'waiting':
      return { transcribing: 'pending', summarizing: 'pending' }
    case 'transcribing':
      return { transcribing: 'active', summarizing: 'pending' }
    case 'summarizing':
      return { transcribing: 'done', summarizing: 'active' }
    case 'done':
      return { transcribing: 'done', summarizing: 'done' }
    case 'failed':
      return { transcribing: 'pending', summarizing: 'pending' }
  }
}
