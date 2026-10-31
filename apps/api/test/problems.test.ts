import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fingerprint, similarity, tokenize } from '../src/lib/winnow.js'
import { rankSubmissions } from '../src/lib/leaderboard.js'
import { MemoryRateLimiter } from '../src/modules/auth/rateLimit.js'
import {
  as,
  config,
  createRoomFixture,
  createTestApi,
  createUser,
  type TestApi,
} from './helpers.js'

const archive = (entries: Record<string, string>): Buffer =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)]))))

const problemBody = (overrides: object = {}) => ({
  slug: `sum-${crypto.randomUUID().slice(0, 8)}`,
  title: 'Sum',
  difficulty: 'EASY',
  tags: ['math'],
  statementMd: 'Add $a$ and $b$.',
  inputFormat: 'a b',
  outputFormat: 'a+b',
  constraints: '1 <= a, b <= 100',
  limits: { PYTHON: { timeMs: 1000, memoryMb: 128 } },
  starterCode: { PYTHON: 'print()' },
  published: true,
  ...overrides,
})

describe('practice mode', () => {
  let api: TestApi
  let faculty: string
  let student: string

  beforeAll(async () => {
    const limiter = new MemoryRateLimiter()
    limiter.hit = async () => ({ allowed: true, retryAfterMs: 0 })
    api = await createTestApi(undefined, { limiter })
    faculty = await createUser(api.prisma, 'Faculty')
    await api.prisma.user.update({ where: { id: faculty }, data: { role: 'FACULTY' } })
    student = await createUser(api.prisma, 'Student')
  })
  afterAll(() => api.close())

  const createProblem = async (overrides: object = {}) => {
    const body = problemBody(overrides)
    const response = await api.app.inject(
      as(faculty, { method: 'POST', url: '/problems', payload: body }),
    )
    expect(response.statusCode).toBe(201)
    return { ...response.json<{ problem: { id: string; slug: string } }>().problem, body }
  }

  const upload = (id: string, payload: Buffer, user = faculty) =>
    api.app.inject(
      as(user, {
        method: 'POST',
        url: `/problems/${id}/tests`,
        headers: { 'content-type': 'application/zip' },
        payload,
      }),
    )

  const withTests = async (overrides: object = {}) => {
    const problem = await createProblem(overrides)
    await upload(
      problem.id,
      archive({ 'sample1.in': '1 2\n', 'sample1.out': '3\n', '1.in': '4 5\n', '1.out': '9\n' }),
    )
    return problem
  }

  const submit = (slug: string, user = student, payload: object = {}) =>
    api.app.inject(
      as(user, {
        method: 'POST',
        url: `/problems/${slug}/submissions`,
        payload: { language: 'PYTHON', source: 'print(3)', ...payload },
      }),
    )

  const internal = (method: 'GET' | 'POST', path: string, payload?: object) =>
    api.app.inject({
      method,
      url: `/api/v1/internal/submissions/${path}`,
      headers: { 'x-service-token': config.internalServiceToken },
      ...(payload ? { payload } : {}),
    })

  const finish = (id: string, verdict: string) =>
    internal('POST', `${id}/result`, {
      verdict,
      failed_ordinal: verdict === 'ACCEPTED' ? null : 2,
      time_ms: 10,
      memory_kb: 100,
      compile_output: '',
      results: [],
    })

  const submitted = async (slug: string, user = student, payload: object = {}) =>
    (await submit(slug, user, payload)).json<{ submission: { id: string } }>().submission.id

  describe('problems', () => {
    it('is managed by faculty only', async () => {
      const response = await api.app.inject(
        as(student, { method: 'POST', url: '/problems', payload: problemBody() }),
      )
      expect(response.statusCode).toBe(403)
    })

    it('hides unpublished problems from students', async () => {
      const { slug } = await createProblem({ published: false })
      const read = (user: string) =>
        api.app.inject(as(user, { method: 'GET', url: `/problems/${slug}` }))
      expect((await read(student)).statusCode).toBe(404)
      expect((await read(faculty)).statusCode).toBe(200)
    })

    it('shows sample tests but never hidden tests, checkers or solutions', async () => {
      const { slug } = await withTests({
        referenceSolution: 'THE-REFERENCE-SOLUTION',
        referenceLanguage: 'PYTHON',
      })
      const response = await api.app.inject(as(student, { method: 'GET', url: `/problems/${slug}` }))
      const { problem } = response.json()
      expect(problem.samples).toEqual([{ ordinal: 1, input: '1 2\n', output: '3\n' }])
      expect(response.body).not.toContain('THE-REFERENCE-SOLUTION')
      expect(response.body).not.toContain('4 5')
    })

    it('filters the list', async () => {
      const tag = `tag${crypto.randomUUID().slice(0, 6)}`
      const { slug } = await createProblem({ tags: [tag], difficulty: 'HARD' })
      const response = await api.app.inject(
        as(student, { method: 'GET', url: `/problems?tag=${tag}&difficulty=HARD` }),
      )
      expect(response.json().problems.map((item: { slug: string }) => item.slug)).toEqual([slug])
    })

    it('requires a source for a custom checker', async () => {
      const response = await api.app.inject(
        as(faculty, {
          method: 'POST',
          url: '/problems',
          payload: problemBody({ checkerKind: 'CUSTOM' }),
        }),
      )
      expect(response.json().error.code).toBe('checker_required')
    })

    it('refuses limits beyond what the sandbox allows', async () => {
      const response = await api.app.inject(
        as(faculty, {
          method: 'POST',
          url: '/problems',
          payload: problemBody({ limits: { PYTHON: { timeMs: 1000, memoryMb: 4096 } } }),
        }),
      )
      expect(response.statusCode).toBe(400)
    })
  })

  describe('test upload', () => {
    it('pairs files, numbers naturally and puts samples first', async () => {
      const { id } = await createProblem()
      const response = await upload(
        id,
        archive({
          '10.in': 'j',
          '10.out': 'j',
          '2.in': 'b',
          '2.out': 'b',
          'sample1.in': 's',
          'sample1.out': 's',
        }),
      )
      expect(response.json()).toEqual({ tests: 3, samples: 1 })
      const rows = await api.prisma.testCase.findMany({
        where: { problemId: id },
        orderBy: { ordinal: 'asc' },
      })
      expect(rows.map((row) => Buffer.from(row.input).toString())).toEqual(['s', 'b', 'j'])
    })

    it('replaces the previous tests', async () => {
      const { id } = await withTests()
      await upload(id, archive({ '1.in': 'x', '1.out': 'y' }))
      expect(await api.prisma.testCase.count({ where: { problemId: id } })).toBe(1)
    })

    it.each([
      ['an unpaired input', { '1.in': 'x' }, 'unpaired_test'],
      ['an unpaired output', { '1.in': 'x', '1.out': 'y', '2.out': 'z' }, 'unpaired_test'],
      ['a traversal path', { '../1.in': 'x', '../1.out': 'y' }, 'invalid_test_name'],
      ['an unexpected file', { '1.in': 'x', '1.out': 'y', 'run.sh': 'z' }, 'invalid_test_name'],
    ])('refuses %s', async (_name, entries, code) => {
      const { id } = await createProblem()
      const response = await upload(id, archive(entries))
      expect(response.json().error.code).toBe(code)
    })

    it('is for faculty only', async () => {
      const { id } = await createProblem()
      const response = await upload(id, archive({ '1.in': 'x', '1.out': 'y' }), student)
      expect(response.statusCode).toBe(403)
    })
  })

  describe('submitting and judging', () => {
    it('queues only the id, so source and hidden tests stay out of the queue', async () => {
      const { slug } = await withTests()
      const id = await submitted(slug)
      expect(api.queue.judgeJobs.at(-1)).toBe(id)
    })

    it('refuses a problem with no tests', async () => {
      const { slug } = await createProblem()
      expect((await submit(slug)).json().error.code).toBe('no_tests')
    })

    it('gives the worker everything it needs, with bytes intact', async () => {
      const { slug } = await withTests()
      const id = await submitted(slug)
      const { proceed, package: data } = (await internal('GET', `${id}/package`)).json()
      expect(proceed).toBe(true)
      expect(data).toMatchObject({
        submission_id: id,
        language: 'PYTHON',
        time_limit_ms: 1000,
        memory_limit_mb: 128,
        checker_kind: 'EXACT',
      })
      expect(data.tests).toHaveLength(2)
      expect(Buffer.from(data.tests[1].output, 'base64').toString()).toBe('9\n')
    })

    it('records a verdict with the failing test', async () => {
      const { slug } = await withTests()
      const id = await submitted(slug)
      await finish(id, 'WRONG_ANSWER')
      const { submission } = (
        await api.app.inject(as(student, { method: 'GET', url: `/submissions/${id}` }))
      ).json()
      expect(submission).toMatchObject({ verdict: 'WRONG_ANSWER', failedOrdinal: 2 })
    })

    it('does not judge a finished submission again', async () => {
      const { slug } = await withTests()
      const id = await submitted(slug)
      await finish(id, 'ACCEPTED')
      expect((await internal('GET', `${id}/package`)).json()).toEqual({ proceed: false })
      expect((await finish(id, 'WRONG_ANSWER')).json()).toEqual({ recorded: false })
    })

    it('refuses the internal routes without the service token', async () => {
      const { slug } = await withTests()
      const id = await submitted(slug)
      const response = await api.app.inject({
        method: 'GET',
        url: `/api/v1/internal/submissions/${id}/package`,
      })
      expect(response.statusCode).toBe(403)
    })

    it('shows a submission only to its author and faculty', async () => {
      const { slug } = await withTests()
      const id = await submitted(slug)
      const other = await createUser(api.prisma)
      const read = (user: string) =>
        api.app.inject(as(user, { method: 'GET', url: `/submissions/${id}` }))
      expect((await read(student)).statusCode).toBe(200)
      expect((await read(faculty)).statusCode).toBe(200)
      expect((await read(other)).statusCode).toBe(404)
    })

    it('validates a problem with its reference solution', async () => {
      const { id, slug } = await withTests({
        referenceSolution: 'print(3)',
        referenceLanguage: 'PYTHON',
      })
      const response = await api.app.inject(
        as(faculty, { method: 'POST', url: `/problems/${id}/validate` }),
      )
      expect(response.statusCode).toBe(202)
      const stored = await api.prisma.submission.findFirstOrThrow({
        where: { problem: { slug } },
      })
      expect(stored.isValidation).toBe(true)
    })

    it('leaves validation runs out of a student history', async () => {
      const { id } = await withTests({ referenceSolution: 'x', referenceLanguage: 'PYTHON' })
      await api.app.inject(as(faculty, { method: 'POST', url: `/problems/${id}/validate` }))
      const { submissions } = (
        await api.app.inject(as(faculty, { method: 'GET', url: '/me/submissions' }))
      ).json()
      expect(submissions.some((item: { problemId: string }) => item.problemId === id)).toBe(false)
    })
  })

  describe('leaderboards and contests', () => {
    const contestWith = async (
      startsAgoMinutes: number,
      endsInMinutes: number,
      problemId: string,
    ) => {
      const fixture = await createRoomFixture(api)
      const { problemSet } = (
        await api.app.inject(
          as(faculty, {
            method: 'POST',
            url: '/problem-sets',
            payload: { title: 'Set', problemIds: [problemId] },
          }),
        )
      ).json()
      const now = Date.now()
      const response = await api.app.inject(
        as(fixture.owner, {
          method: 'POST',
          url: `/rooms/${fixture.roomId}/contests`,
          payload: {
            title: 'Contest',
            problemSetId: problemSet.id,
            startsAt: new Date(now - startsAgoMinutes * 60_000).toISOString(),
            endsAt: new Date(now + endsInMinutes * 60_000).toISOString(),
          },
        }),
      )
      return { fixture, contest: response.json().contest, problemSet }
    }

    it('accepts a contest submission only while it is running', async () => {
      const problem = await withTests()
      const finished = await contestWith(120, -60, problem.id)
      const late = await submit(problem.slug, finished.fixture.editor, {
        contestId: finished.contest.id,
      })
      expect(late.json().error.code).toBe('contest_closed')

      const running = await contestWith(10, 60, problem.id)
      const onTime = await submit(problem.slug, running.fixture.editor, {
        contestId: running.contest.id,
      })
      expect(onTime.statusCode).toBe(202)
    })

    it('refuses someone outside the room', async () => {
      const problem = await withTests()
      const { contest } = await contestWith(10, 60, problem.id)
      const response = await submit(problem.slug, student, { contestId: contest.id })
      expect(response.statusCode).toBe(404)
    })

    it('refuses a problem from outside the contest', async () => {
      const inside = await withTests()
      const outside = await withTests()
      const { fixture, contest } = await contestWith(10, 60, inside.id)
      const response = await submit(outside.slug, fixture.editor, { contestId: contest.id })
      expect(response.json().error.code).toBe('not_in_contest')
    })

    it('freezes results for participants in the last 15 minutes, but not for the owner', async () => {
      const problem = await withTests()
      const { fixture, contest } = await contestWith(60, 10, problem.id)
      const id = await submitted(problem.slug, fixture.editor, { contestId: contest.id })
      await finish(id, 'ACCEPTED')
      const read = async (user: string) =>
        (
          await api.app.inject(
            as(user, { method: 'GET', url: `/contests/${contest.id}/leaderboard` }),
          )
        ).json()

      const participant = await read(fixture.viewer)
      expect(participant.frozen).toBe(true)
      expect(participant.leaderboard).toEqual([])

      const owner = await read(fixture.owner)
      expect(owner.frozen).toBe(false)
      expect(owner.leaderboard[0]).toMatchObject({ userId: fixture.editor, solved: 1 })
    })

    it('shows live results before the freeze', async () => {
      const problem = await withTests()
      const { fixture, contest } = await contestWith(10, 60, problem.id)
      const id = await submitted(problem.slug, fixture.editor, { contestId: contest.id })
      await finish(id, 'ACCEPTED')
      const board = (
        await api.app.inject(
          as(fixture.viewer, { method: 'GET', url: `/contests/${contest.id}/leaderboard` }),
        )
      ).json()
      expect(board.frozen).toBe(false)
      expect(board.leaderboard).toHaveLength(1)
    })

    it('ranks a problem set without validation runs', async () => {
      const problem = await withTests({ referenceSolution: 'x', referenceLanguage: 'PYTHON' })
      await api.app.inject(as(faculty, { method: 'POST', url: `/problems/${problem.id}/validate` }))
      const id = await submitted(problem.slug)
      await finish(id, 'ACCEPTED')
      const { problemSet } = (
        await api.app.inject(
          as(faculty, {
            method: 'POST',
            url: '/problem-sets',
            payload: { title: 'Set', problemIds: [problem.id] },
          }),
        )
      ).json()
      const { leaderboard } = (
        await api.app.inject(
          as(student, { method: 'GET', url: `/problem-sets/${problemSet.id}/leaderboard` }),
        )
      ).json()
      expect(leaderboard.map((row: { userId: string }) => row.userId)).toEqual([student])
    })
  })

  describe('plagiarism', () => {
    const ORIGINAL = `
def add(numbers):
    total = 0
    for number in numbers:
        if number > 0:
            total += number
    return total

print(add(list(map(int, input().split()))))
`
    const RENAMED = `
# my own work
def combine(values):
    result = 0
    for item in values:
        if item > 0:
            result += item
    return result

print(combine(list(map(int, input().split()))))
`
    const DIFFERENT = `
import sys
data = sys.stdin.read().split()
print(sum(int(x) for x in data if int(x) > 0))
`

    it('finds a renamed copy, not an independent solution, and shows a percentage', async () => {
      const { id, slug } = await withTests()
      const [copier, honest] = [await createUser(api.prisma), await createUser(api.prisma)]
      await submitted(slug, student, { source: ORIGINAL })
      await submitted(slug, copier, { source: RENAMED })
      await submitted(slug, honest, { source: DIFFERENT })

      const run = await api.app.inject(
        as(faculty, { method: 'POST', url: `/problems/${id}/plagiarism` }),
      )
      expect(run.json()).toEqual({ compared: 3, matches: 1 })

      const { matches } = (
        await api.app.inject(as(faculty, { method: 'GET', url: `/problems/${id}/plagiarism` }))
      ).json()
      expect(matches[0].similarityPercent).toBeGreaterThan(80)
      const users = [matches[0].submissionA.userId, matches[0].submissionB.userId]
      expect(users.sort()).toEqual([student, copier].sort())
    })

    it('never compares a student with their own attempts', async () => {
      const { id, slug } = await withTests()
      const author = await createUser(api.prisma)
      await submitted(slug, author, { source: ORIGINAL })
      await submitted(slug, author, { source: RENAMED })
      const run = await api.app.inject(
        as(faculty, { method: 'POST', url: `/problems/${id}/plagiarism` }),
      )
      expect(run.json()).toEqual({ compared: 1, matches: 0 })
    })

    it('is for faculty only', async () => {
      const { id } = await withTests()
      const response = await api.app.inject(
        as(student, { method: 'GET', url: `/problems/${id}/plagiarism` }),
      )
      expect(response.statusCode).toBe(403)
    })
  })
})

describe('rankSubmissions', () => {
  const START = new Date('2026-01-01T00:00:00Z')
  const at = (minutes: number) => new Date(START.getTime() + minutes * 60_000)
  const entry = (userId: string, problemId: string, verdict: string, minutes: number) => ({
    userId,
    problemId,
    verdict,
    createdAt: at(minutes),
  })

  it('ranks more solved problems first', () => {
    const rows = rankSubmissions(
      [entry('a', 'p1', 'ACCEPTED', 100), entry('b', 'p1', 'ACCEPTED', 5), entry('a', 'p2', 'ACCEPTED', 120)],
      START,
    )
    expect(rows.map((row) => row.userId)).toEqual(['a', 'b'])
  })

  it('breaks ties on penalty, with 20 minutes per wrong attempt', () => {
    const rows = rankSubmissions(
      [
        entry('a', 'p1', 'WRONG_ANSWER', 1),
        entry('a', 'p1', 'ACCEPTED', 10),
        entry('b', 'p1', 'ACCEPTED', 25),
      ],
      START,
    )
    expect(rows[0]).toMatchObject({ userId: 'b', penaltyMinutes: 25, rank: 1 })
    expect(rows[1]).toMatchObject({ userId: 'a', penaltyMinutes: 30, rank: 2 })
  })

  it('does not penalise compile errors or anything after solving', () => {
    const [row] = rankSubmissions(
      [
        entry('a', 'p1', 'COMPILE_ERROR', 1),
        entry('a', 'p1', 'ACCEPTED', 10),
        entry('a', 'p1', 'WRONG_ANSWER', 11),
        entry('a', 'p1', 'ACCEPTED', 12),
      ],
      START,
    )
    expect(row).toMatchObject({ solved: 1, penaltyMinutes: 10 })
  })

  it('charges nothing for wrong attempts on an unsolved problem', () => {
    const [row] = rankSubmissions([entry('a', 'p1', 'WRONG_ANSWER', 1)], START)
    expect(row).toMatchObject({ solved: 0, penaltyMinutes: 0 })
  })

  it('gives equal scores the same rank', () => {
    const rows = rankSubmissions(
      [
        entry('a', 'p1', 'ACCEPTED', 5),
        entry('b', 'p1', 'ACCEPTED', 5),
        entry('c', 'p1', 'ACCEPTED', 6),
      ],
      START,
    )
    expect(rows.map((row) => row.rank)).toEqual([1, 1, 3])
  })
})

describe('winnowing', () => {
  const prints = (source: string, language = 'PYTHON') => fingerprint(tokenize(source, language))
  const LOOP = 'for i in range(10):\n    total = total + i * i\n    print(total)\nprint("done")\n'

  it('treats identical code as identical', () => {
    expect(similarity(prints(LOOP), prints(LOOP))).toBe(1)
  })

  it('ignores names, literals and comments', () => {
    const disguised =
      '# comment\nfor k in range(99):\n    s = s + k * k  # note\n    print(s)\nprint("other")\n'
    expect(similarity(prints(LOOP), prints(disguised))).toBe(1)
  })

  it('ignores C++ comments', () => {
    const plain = 'int main() { int a = 1; int b = 2; return a + b; }'
    const commented = '// hi\nint main() { /* x */ int c = 7; int d = 8; return c + d; }'
    expect(similarity(prints(plain, 'CPP'), prints(commented, 'CPP'))).toBe(1)
  })

  it('still finds copied code inside a longer file', () => {
    const padded = `${'while x:\n    y = y - 1\n'.repeat(1)}${LOOP}if a:\n    b = c\n`
    expect(similarity(prints(LOOP), prints(padded))).toBeGreaterThan(0.8)
  })

  it('handles code too short to fingerprint', () => {
    expect(similarity(prints('x'), prints(LOOP))).toBe(0)
  })
})
