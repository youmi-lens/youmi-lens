export type RecordingStatus = 'idle' | 'recording' | 'paused'

/**
 * Phase 2 (reserved): async worker job states on `recordings.ai_status`.
 * The default web app does not advance these from the browser; only inserts seed `pending`.
 */
export type AiJobStatus =
  | 'pending'
  | 'queued'
  | 'transcribing'
  | 'summarizing'
  | 'transcript_ready'
  | 'done'
  | 'failed'

export interface Recording {
  id: string
  /**
   * Legacy course label. NOT NULL in the database and read by every client
   * that predates Phase 1B (iPad, older Desktop, the server), so it stays
   * authoritative for them and is always written alongside `courseId`.
   */
  course: string
  /**
   * Owning course (`recordings.course_id`). Absent on rows written before the
   * Phase 1B migration and on databases where it has not been applied — in
   * that case the course is resolved from `course` by normalized name. NULL
   * means Unfiled.
   */
  courseId?: string | null
  title: string
  createdAt: number
  durationSec: number
  mime: string
  /** Cloud Storage object path. Its presence means audio can be ready before AI. */
  storagePath?: string
  /** Canonical text (normalized); summaries and primary UI use this. */
  transcript?: string
  /** Raw ASR/browser transcription before canonicalization. */
  transcriptRaw?: string
  summaryEn?: string
  summaryZh?: string
  /** Canonical in-class caption text. */
  liveTranscript?: string
  /** Assembled live caption stream before canonicalization. */
  liveTranscriptRaw?: string
  aiStatus?: AiJobStatus
  aiError?: string
  aiUpdatedAt?: number
  /** After-class job: transcript row is safe to show. */
  transcriptReady?: boolean
  /** Bilingual summaries completed. */
  summaryReady?: boolean
  /** Chinese summary text available (hosted path aligns with summary_zh). */
  translationReady?: boolean
  /** Server-only pipeline timing (ms since job start). */
  aiPipelineTiming?: {
    transcript_ready_ms?: number
    summary_ready_ms?: number
  }
  /* ── Cloud Library Stage 4 (account-level, cross-device) ──────────────────
     All optional: absent on a project without the columns (production before
     the migration), so the data layer reads/writes them without loss where
     present and degrades cleanly where absent. */
  /** Soft-delete timestamp (epoch ms). Undefined/null = active; set = trashed. Authoritative over the legacy localStorage trash. */
  deletedAt?: number | null
  /** Freshness of the deletion STATE (epoch ms) — a delete OR a restore stamps it. Lets a stale ACTIVE snapshot never resurrect a newer tombstone. */
  deletionUpdatedAt?: number | null
  /** Account-level notes text. */
  notes?: string
  /** Account-level marks, structured JSON (kept lossless — never flattened). */
  markedTimestamps?: unknown[]
  /** Field-freshness clocks (epoch ms). */
  titleUpdatedAt?: number | null
  notesUpdatedAt?: number | null
  marksUpdatedAt?: number | null
}

export interface RecordingDetail extends Recording {
  audioUrl?: string
  storagePath: string
}
