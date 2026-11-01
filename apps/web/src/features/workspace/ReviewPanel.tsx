import { applyLineFix, type CollabSession } from '@codesync/collab-client'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Markdown } from '../../components/Markdown'
import { Button, ErrorNotice, Loading } from '../../components/ui'
import { api } from '../../lib/api'
import { languageOfPath, type Review, type ReviewFinding } from '../../lib/types'
import type { CollabEditor } from '../presence/collabEditor'

const POLL_MS = 1_500
const MODES = [
  { value: 'REVIEW', label: 'Review' },
  { value: 'EXPLAIN', label: 'Explain' },
  { value: 'WHY_FAILING', label: 'Why failing' },
]

export interface ReviewPanelProps {
  session: CollabSession
  roomId: string
  projectId: string
  fileId: string | null
  path: string | undefined
  canEdit: boolean
  editor: CollabEditor | null
  onFindings: (fileId: string | null, findings: readonly ReviewFinding[]) => void
}

export function ReviewPanel({
  session,
  roomId,
  projectId,
  fileId,
  path,
  canEdit,
  editor,
  onFindings,
}: ReviewPanelProps) {
  const [mode, setMode] = useState('REVIEW')
  const [reviewId, setReviewId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const reviewed = useRef({ fileId: null as string | null, source: '' })
  const language = path ? languageOfPath(path) : null

  const quota = useQuery({
    queryKey: ['review-quota', reviewId],
    queryFn: () => api<{ limit: number; used: number }>('/reviews/quota'),
  })
  const start = useMutation({
    mutationFn: () => {
      const selection = editor?.selectionRange()
      const text = fileId ? session.files.get(fileId) : undefined
      reviewed.current = { fileId, source: text?.toString() ?? '' }
      const whole = !selection || selection.start === selection.end
      return api<{ review: Review }>('/reviews', {
        method: 'POST',
        body: {
          mode,
          language,
          roomId,
          projectId,
          fileId,
          ...(whole ? {} : { lineStart: selection.line, lineEnd: selection.endLine }),
        },
      })
    },
    onSuccess: ({ review }) => setReviewId(review.id),
  })
  const review = useQuery({
    queryKey: ['review', reviewId],
    enabled: reviewId !== null,
    queryFn: () => api<{ review: Review }>(`/reviews/${reviewId}`),
    refetchInterval: (query) => {
      const status = query.state.data?.review.status
      return status === 'DONE' || status === 'FAILED' ? false : POLL_MS
    },
  })
  const result = review.data?.review
  const findings = result?.status === 'DONE' ? result.findings : undefined

  useEffect(() => {
    onFindings(reviewed.current.fileId, findings ?? [])
  }, [findings, onFindings])

  // Passes the lines the review saw. Code changed since then is refused, not overwritten.
  const applyFix = (finding: ReviewFinding): void => {
    const text = fileId ? session.files.get(fileId) : undefined
    if (!text || finding.suggested_fix === null) return
    const expected = reviewed.current.source
      .split('\n')
      .slice(finding.line_start - 1, finding.line_end)
      .join('\n')
    const applied = applyLineFix(
      text,
      {
        lineStart: finding.line_start,
        lineEnd: finding.line_end,
        replacement: finding.suggested_fix,
      },
      expected,
    )
    setNotice(applied ? 'Fix applied.' : 'That code has changed. Run the review again.')
  }

  const busy =
    start.isPending ||
    (result !== undefined && result.status !== 'DONE' && result.status !== 'FAILED')

  return (
    <section aria-label="AI review" className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-2">
        <label className="text-sm">
          <span className="sr-only">Review mode</span>
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            className="rounded border border-line bg-surface px-2 py-1 text-sm"
          >
            {MODES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="primary"
          disabled={!fileId || !language || busy}
          onClick={() => start.mutate()}
        >
          Run
        </Button>
        {quota.data && (
          <span className="text-xs text-muted">
            {quota.data.used} of {quota.data.limit} today
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        <ErrorNotice error={start.error ?? review.error} />
        {notice && (
          <p role="status" className="text-sm text-muted">
            {notice}
          </p>
        )}
        {busy && <Loading label="Reviewing…" />}
        {result?.status === 'FAILED' && <ErrorNotice error="The review failed. Try again." />}
        {result?.explanation && <Markdown>{result.explanation}</Markdown>}
        {findings?.length === 0 && <p className="text-sm text-muted">No issues found.</p>}
        <ul className="flex flex-col gap-2">
          {findings?.map((finding, index) => (
            <li key={index} className="flex flex-col gap-1 rounded border border-line p-2">
              <button
                type="button"
                className="text-left text-xs text-muted underline"
                onClick={() => editor?.revealLine(finding.line_start)}
              >
                {finding.severity} · {finding.category} · line {finding.line_start}
              </button>
              <p className="text-sm">{finding.message}</p>
              {finding.suggested_fix !== null && (
                <>
                  <pre className="overflow-x-auto rounded bg-raised p-1 text-xs">
                    {finding.suggested_fix}
                  </pre>
                  <Button
                    disabled={!canEdit}
                    className="self-start !px-1.5 !py-0.5"
                    onClick={() => applyFix(finding)}
                  >
                    Apply fix
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
