export type LiveEngineStatus =
  | 'idle'
  | 'warming'
  | 'starting'
  | 'connected'
  | 'streaming'
  | 'reconnecting'
  | 'closed'
  | 'error'

export type LiveEngineEvent =
  | { type: 'status'; status: LiveEngineStatus; detail?: string }
  | { type: 'en_interim'; segmentId: string; rev: number; text: string }
  | { type: 'en_final'; segmentId: string; text: string }
  | { type: 'zh_interim'; segmentId: string; rev: number; text: string; sourceEn: string }
  /**
   * A FINAL translation. `segmentIds` lists every caption the server says the text covers, in
   * order (`segmentId` is the last of them, kept for older consumers). Absent on events from
   * pipelines that translate one caption at a time.
   */
  | { type: 'zh_final'; segmentId: string; segmentIds?: string[]; text: string; sourceEn: string }
  | { type: 'error'; code: string; message: string; recoverable: boolean }

export type LiveEngineListener = (event: LiveEngineEvent) => void

