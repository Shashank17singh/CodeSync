export interface ScoredSubmission {
  userId: string
  problemId: string
  verdict: string
  createdAt: Date
}

export interface LeaderboardRow {
  rank: number
  userId: string
  solved: number
  penaltyMinutes: number
  problems: Record<string, { solved: boolean; wrongAttempts: number; minutes: number | null }>
}

const WRONG_ATTEMPT_PENALTY_MINUTES = 20
// A compile error or a judging failure says nothing about the solution, so neither costs anything.
const NOT_PENALISED = new Set(['COMPILE_ERROR', 'INTERNAL_ERROR', 'PENDING', 'JUDGING'])

// ICPC rules: more problems first, then less penalty time. Penalty is the minutes to each first
// accepted answer, plus 20 for each wrong attempt before it. Attempts after solving do not count.
export function rankSubmissions(
  submissions: ScoredSubmission[],
  startedAt: Date | null,
): LeaderboardRow[] {
  const ordered = [...submissions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const rows = new Map<string, LeaderboardRow>()

  for (const submission of ordered) {
    const row: LeaderboardRow = rows.get(submission.userId) ?? {
      rank: 0,
      userId: submission.userId,
      solved: 0,
      penaltyMinutes: 0,
      problems: {},
    }
    rows.set(submission.userId, row)
    const problem = (row.problems[submission.problemId] ??= {
      solved: false,
      wrongAttempts: 0,
      minutes: null,
    })
    if (problem.solved || NOT_PENALISED.has(submission.verdict)) continue

    if (submission.verdict !== 'ACCEPTED') {
      problem.wrongAttempts += 1
      continue
    }
    const minutes = startedAt
      ? Math.floor((submission.createdAt.getTime() - startedAt.getTime()) / 60_000)
      : 0
    problem.solved = true
    problem.minutes = minutes
    row.solved += 1
    row.penaltyMinutes += minutes + problem.wrongAttempts * WRONG_ATTEMPT_PENALTY_MINUTES
  }

  const sorted = [...rows.values()].sort(
    (a, b) =>
      b.solved - a.solved || a.penaltyMinutes - b.penaltyMinutes || (a.userId < b.userId ? -1 : 1),
  )
  sorted.forEach((row, index) => {
    const previous = sorted[index - 1]
    const tied =
      previous && previous.solved === row.solved && previous.penaltyMinutes === row.penaltyMinutes
    row.rank = tied ? previous.rank : index + 1
  })
  return sorted
}
