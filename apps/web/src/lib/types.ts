import type { CollabRole } from '@codesync/shared'

export type Language = 'PYTHON' | 'CPP' | 'JAVA' | 'JAVASCRIPT'

export const LANGUAGES: ReadonlyArray<{ value: Language; label: string; extensions: string[] }> = [
  { value: 'PYTHON', label: 'Python', extensions: ['py'] },
  { value: 'CPP', label: 'C++', extensions: ['cpp', 'cc'] },
  { value: 'JAVA', label: 'Java', extensions: ['java'] },
  { value: 'JAVASCRIPT', label: 'JavaScript', extensions: ['js', 'mjs'] },
]

export const languageOfPath = (path: string): Language | null => {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return LANGUAGES.find((item) => item.extensions.includes(extension))?.value ?? null
}

export interface User {
  id: string
  email: string
  displayName: string
  avatarUrl: string | null
  role: string
  theme: 'system' | 'light' | 'dark'
  editorSettings: Partial<{
    fontSize: number
    tabSize: number
    keybindings: 'default' | 'vim' | 'emacs'
  }> | null
}

export interface RoomSummary {
  id: string
  name: string
  visibility: 'PUBLIC' | 'PRIVATE'
  role: CollabRole | null
  lockedAt: string | null
  updatedAt: string
}

export interface RoomDetail extends RoomSummary {
  profanityFilter: boolean
  ownerId: string
  projects: Array<{ id: string; name: string }>
}

export type ExecutionStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'OK'
  | 'COMPILE_ERROR'
  | 'RUNTIME_ERROR'
  | 'TIME_LIMIT_EXCEEDED'
  | 'MEMORY_LIMIT_EXCEEDED'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'INTERNAL_ERROR'

export interface Execution {
  id: string
  status: ExecutionStatus
  stdout: string | null
  stderr: string | null
  compileOutput: string | null
  message: string | null
  exitCode: number | null
  timeMs: number | null
  memoryKb: number | null
}

export interface ChatMessage {
  id: string
  authorId: string
  authorName: string
  body: string
  mentionedUserIds: string[]
  createdAt: string
  deletedAt?: string | null
  clientMsgId?: string
}

export interface CommentRow {
  id: string
  fileId: string
  authorId: string
  parentId: string | null
  anchorStart: string | null
  anchorEnd: string | null
  body: string
  resolvedAt: string | null
  createdAt: string
}

export interface ReviewFinding {
  line_start: number
  line_end: number
  severity: 'error' | 'warning' | 'info'
  category: string
  message: string
  suggested_fix: string | null
}

export interface Review {
  id: string
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED'
  findings: ReviewFinding[]
  explanation: string | null
}

export interface SnapshotRow {
  id: string
  kind: 'AUTO' | 'RUN' | 'MANUAL'
  label: string | null
  authorIds: string[]
  createdAt: string
}

export interface BlameRange {
  startLine: number
  endLine: number
  userId: string | null
}

export type Verdict =
  | 'PENDING'
  | 'JUDGING'
  | 'ACCEPTED'
  | 'WRONG_ANSWER'
  | 'TIME_LIMIT_EXCEEDED'
  | 'MEMORY_LIMIT_EXCEEDED'
  | 'RUNTIME_ERROR'
  | 'COMPILE_ERROR'
  | 'INTERNAL_ERROR'

export interface ProblemSummary {
  id: string
  slug: string
  title: string
  difficulty: 'EASY' | 'MEDIUM' | 'HARD'
  tags: string[]
}

export interface Problem extends ProblemSummary {
  statementMd: string
  inputFormat: string
  outputFormat: string
  constraints: string
  starterCode: Partial<Record<Language, string>>
  samples: Array<{ ordinal: number; input: string; output: string }>
}

export interface Submission {
  id: string
  verdict: Verdict
  failedOrdinal: number | null
  timeMs: number | null
  memoryKb: number | null
  compileOutput: string | null
  results:
    | Array<{ ordinal: number; verdict: Verdict; time_ms: number | null; memory_kb: number | null }>
    | null
}

export interface LeaderboardRow {
  rank: number
  userId: string
  solved: number
  penaltyMinutes: number
}

export interface Contest {
  id: string
  title: string
  startsAt: string
  endsAt: string
  freezeMinutes: number
}
