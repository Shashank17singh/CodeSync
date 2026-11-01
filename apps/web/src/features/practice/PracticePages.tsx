import { useMutation, useQuery } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { Markdown } from '../../components/Markdown'
import { Badge, Button, ErrorNotice, Field, Loading } from '../../components/ui'
import { api } from '../../lib/api'
import {
  LANGUAGES,
  type Contest,
  type Language,
  type LeaderboardRow,
  type Problem,
  type ProblemSummary,
  type Submission,
} from '../../lib/types'

const PlainEditor = lazy(async () => ({
  default: (await import('./PlainEditor')).PlainEditor,
}))

const POLL_MS = 1_500
const SECOND_MS = 1_000
const JUDGING = new Set(['PENDING', 'JUDGING'])
const inputClass = 'rounded border border-line bg-surface px-3 py-2 text-sm'

const pretty = (value: string): string => value.replaceAll('_', ' ').toLowerCase()

export function ProblemListPage() {
  const [q, setQ] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const [tag, setTag] = useState('')
  const query = new URLSearchParams({
    ...(q ? { q } : {}),
    ...(difficulty ? { difficulty } : {}),
    ...(tag ? { tag } : {}),
  }).toString()
  const problems = useQuery({
    queryKey: ['problems', query],
    queryFn: () => api<{ problems: ProblemSummary[] }>(`/problems?${query}`),
  })
  const sets = useQuery({
    queryKey: ['problem-sets'],
    queryFn: () =>
      api<{ problemSets: Array<{ id: string; title: string }> }>('/problem-sets'),
  })
  const contests = useQuery({
    queryKey: ['contests'],
    queryFn: () => api<{ contests: Contest[] }>('/contests'),
  })

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_16rem]">
      <section aria-labelledby="problems" className="flex flex-col gap-3">
        <h1 id="problems" className="text-xl font-semibold">
          Problems
        </h1>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Search" value={q} onChange={(event) => setQ(event.target.value)} />
          <label className="flex flex-col gap-1 text-sm font-medium">
            Difficulty
            <select
              value={difficulty}
              onChange={(event) => setDifficulty(event.target.value)}
              className={`${inputClass} font-normal`}
            >
              <option value="">Any</option>
              <option value="EASY">Easy</option>
              <option value="MEDIUM">Medium</option>
              <option value="HARD">Hard</option>
            </select>
          </label>
          <Field label="Tag" value={tag} onChange={(event) => setTag(event.target.value)} />
        </div>
        <ErrorNotice error={problems.error} />
        {problems.isPending && <Loading />}
        {problems.data?.problems.length === 0 && (
          <p className="text-sm text-muted">No problems match these filters.</p>
        )}
        <ul className="flex flex-col gap-2">
          {problems.data?.problems.map((problem) => (
            <li key={problem.id}>
              <Link
                to={`/practice/${problem.slug}`}
                className="flex flex-wrap items-center gap-2 rounded border border-line bg-surface px-3 py-2 hover:bg-raised"
              >
                <span className="text-sm font-medium">{problem.title}</span>
                <Badge>{pretty(problem.difficulty)}</Badge>
                {problem.tags.map((item) => (
                  <span key={item} className="text-xs text-muted">
                    {item}
                  </span>
                ))}
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <aside className="flex flex-col gap-6">
        <section aria-labelledby="contests">
          <h2 id="contests" className="mb-2 font-semibold">
            Contests
          </h2>
          {contests.data?.contests.length === 0 && (
            <p className="text-sm text-muted">No contests in your rooms.</p>
          )}
          <ul className="flex flex-col gap-1">
            {contests.data?.contests.map((contest) => (
              <li key={contest.id}>
                <Link to={`/contests/${contest.id}`} className="text-sm underline">
                  {contest.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="leaderboards">
          <h2 id="leaderboards" className="mb-2 font-semibold">
            Leaderboards
          </h2>
          {sets.data?.problemSets.length === 0 && (
            <p className="text-sm text-muted">No problem sets yet.</p>
          )}
          <ul className="flex flex-col gap-1">
            {sets.data?.problemSets.map((set) => (
              <li key={set.id}>
                <Link to={`/practice/sets/${set.id}`} className="text-sm underline">
                  {set.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  )
}

export function ProblemPage() {
  const { slug = '' } = useParams()
  const [params] = useSearchParams()
  const contestId = params.get('contest')
  const [language, setLanguage] = useState<Language>('PYTHON')
  const [source, setSource] = useState('')
  const [submissionId, setSubmissionId] = useState<string | null>(null)
  const problem = useQuery({
    queryKey: ['problem', slug],
    queryFn: () => api<{ problem: Problem }>(`/problems/${slug}`),
  })
  const detail = problem.data?.problem

  useEffect(() => {
    if (detail) setSource(detail.starterCode[language] ?? '')
  }, [detail, language])

  const submit = useMutation({
    mutationFn: () =>
      api<{ submission: { id: string } }>(`/problems/${slug}/submissions`, {
        method: 'POST',
        body: { language, source, ...(contestId ? { contestId } : {}) },
      }),
    onSuccess: ({ submission }) => setSubmissionId(submission.id),
  })
  const submission = useQuery({
    queryKey: ['submission', submissionId],
    enabled: submissionId !== null,
    queryFn: () => api<{ submission: Submission }>(`/submissions/${submissionId}`),
    refetchInterval: (query) => {
      const verdict = query.state.data?.submission.verdict
      return verdict && !JUDGING.has(verdict) ? false : POLL_MS
    },
  })
  const result = submission.data?.submission

  if (problem.error) return <ErrorNotice error={problem.error} />
  if (!detail) return <Loading />
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <article className="flex min-w-0 flex-col gap-3">
        <h1 className="text-xl font-semibold">{detail.title}</h1>
        <Badge>{pretty(detail.difficulty)}</Badge>
        <Markdown>{detail.statementMd}</Markdown>
        {[
          ['Input', detail.inputFormat],
          ['Output', detail.outputFormat],
          ['Constraints', detail.constraints],
        ].map(([title, body]) => (
          <section key={title}>
            <h2 className="font-semibold">{title}</h2>
            <Markdown>{body as string}</Markdown>
          </section>
        ))}
        {detail.samples.map((sample) => (
          <section key={sample.ordinal} className="grid gap-2 sm:grid-cols-2">
            <div>
              <h2 className="text-sm font-semibold">Sample input {sample.ordinal}</h2>
              <pre className="overflow-x-auto rounded bg-raised p-2 text-xs">{sample.input}</pre>
            </div>
            <div>
              <h2 className="text-sm font-semibold">Sample output {sample.ordinal}</h2>
              <pre className="overflow-x-auto rounded bg-raised p-2 text-xs">{sample.output}</pre>
            </div>
          </section>
        ))}
      </article>
      <section aria-label="Solution" className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <label className="text-sm">
            <span className="sr-only">Language</span>
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value as Language)}
              className={inputClass}
            >
              {LANGUAGES.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="primary"
            disabled={!source.trim() || submit.isPending}
            onClick={() => submit.mutate()}
          >
            Submit
          </Button>
        </div>
        <div className="h-[28rem] overflow-hidden rounded border border-line">
          <Suspense fallback={<Loading label="Loading editor…" />}>
            <PlainEditor value={source} language={language} onChange={setSource} />
          </Suspense>
        </div>
        <ErrorNotice error={submit.error ?? submission.error} />
        {result && (
          <div className="flex flex-col gap-2">
            <p role="status" className="text-sm font-medium">
              Verdict: {pretty(result.verdict)}
            </p>
            {result.compileOutput && (
              <pre className="overflow-x-auto rounded bg-raised p-2 text-xs">
                {result.compileOutput}
              </pre>
            )}
            {result.results && (
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th scope="col">Test</th>
                    <th scope="col">Verdict</th>
                    <th scope="col">Time</th>
                    <th scope="col">Memory</th>
                  </tr>
                </thead>
                <tbody>
                  {result.results.map((row) => (
                    <tr key={row.ordinal} className="border-t border-line">
                      <td>{row.ordinal}</td>
                      <td>{pretty(row.verdict)}</td>
                      <td>{row.time_ms === null ? '–' : `${row.time_ms} ms`}</td>
                      <td>{row.memory_kb === null ? '–' : `${row.memory_kb} KB`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function Standings({
  rows,
  users,
}: {
  rows: LeaderboardRow[]
  users: Record<string, string>
}) {
  if (rows.length === 0) return <p className="text-sm text-muted">No submissions yet.</p>
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-xs text-muted">
        <tr>
          <th scope="col">Rank</th>
          <th scope="col">Name</th>
          <th scope="col">Solved</th>
          <th scope="col">Penalty</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.userId} className="border-t border-line">
            <td>{row.rank}</td>
            <td>{users[row.userId] ?? 'Unknown'}</td>
            <td>{row.solved}</td>
            <td>{row.penaltyMinutes} min</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function LeaderboardPage() {
  const { setId = '' } = useParams()
  const board = useQuery({
    queryKey: ['leaderboard', setId],
    queryFn: () =>
      api<{ leaderboard: LeaderboardRow[]; users: Record<string, string> }>(
        `/problem-sets/${setId}/leaderboard`,
      ),
  })
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-xl font-semibold">Leaderboard</h1>
      <ErrorNotice error={board.error} />
      {board.isPending && <Loading />}
      {board.data && <Standings rows={board.data.leaderboard} users={board.data.users} />}
    </div>
  )
}

export function countdown(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / SECOND_MS))
  const pad = (value: number): string => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  return `${pad(hours)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`
}

interface ContestDetail extends Contest {
  problemSet: { problems: Array<{ id: string; slug: string; title: string }> }
}

export function ContestPage() {
  const { contestId = '' } = useParams()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), SECOND_MS)
    return () => clearInterval(timer)
  }, [])
  const contest = useQuery({
    queryKey: ['contest', contestId],
    queryFn: () => api<{ contest: ContestDetail }>(`/contests/${contestId}`),
  })
  const board = useQuery({
    queryKey: ['contest-board', contestId],
    queryFn: () =>
      api<{ frozen: boolean; leaderboard: LeaderboardRow[]; users: Record<string, string> }>(
        `/contests/${contestId}/leaderboard`,
      ),
    refetchInterval: 15_000,
  })
  const detail = contest.data?.contest
  if (contest.error) return <ErrorNotice error={contest.error} />
  if (!detail) return <Loading />
  const starts = Date.parse(detail.startsAt)
  const ends = Date.parse(detail.endsAt)
  const clock =
    now < starts
      ? `Starts in ${countdown(starts - now)}`
      : now < ends
        ? `Ends in ${countdown(ends - now)}`
        : 'Finished'

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{detail.title}</h1>
      <p role="timer" className="font-mono text-lg">
        {clock}
      </p>
      {now >= starts && (
        <section aria-labelledby="contest-problems">
          <h2 id="contest-problems" className="mb-1 font-semibold">
            Problems
          </h2>
          <ul className="flex flex-col gap-1">
            {detail.problemSet.problems.map((problem) => (
              <li key={problem.id}>
                <Link
                  to={`/practice/${problem.slug}?contest=${detail.id}`}
                  className="text-sm underline"
                >
                  {problem.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="standings" className="flex flex-col gap-2">
        <h2 id="standings" className="font-semibold">
          Standings {board.data?.frozen && <Badge>frozen</Badge>}
        </h2>
        <ErrorNotice error={board.error} />
        {board.data && <Standings rows={board.data.leaderboard} users={board.data.users} />}
      </section>
    </div>
  )
}
