import { decodeStateVector, encodeStateVectorFromUpdate } from 'yjs'
import type { PrismaClient } from './generated/prisma/client.js'

export interface SnapshotInput {
  projectId: string
  kind: 'AUTO' | 'RUN' | 'MANUAL'
  state: Uint8Array
  label?: string
  createdById?: string
}

interface TreeRow {
  id: string
  path: string
  kind: string
}

const clocks = (state: Uint8Array): Map<number, number> =>
  decodeStateVector(encodeStateVectorFromUpdate(state))

const sameTree = (a: TreeRow[], b: TreeRow[]): boolean =>
  a.length === b.length &&
  a.every((row, index) => {
    const other = b[index]
    return row.id === other?.id && row.path === other.path && row.kind === other.kind
  })

// Shared by collab (timed snapshots) and the API (runs, checkpoints, restores). The file list
// comes from PostgreSQL, because the tree inside the document only exists once a room has opened.
// Returns the new snapshot's id, or the latest one's when an automatic snapshot would repeat it.
export async function captureSnapshot(
  prisma: PrismaClient,
  { projectId, kind, state, label, createdById }: SnapshotInput,
): Promise<string> {
  const [previous, tree] = await Promise.all([
    prisma.snapshot.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, state: true, tree: true },
    }),
    prisma.file.findMany({
      where: { projectId },
      select: { id: true, path: true, kind: true },
      orderBy: { path: 'asc' },
    }),
  ])
  if (
    kind !== 'MANUAL' &&
    previous &&
    Buffer.compare(previous.state, state) === 0 &&
    sameTree(previous.tree as unknown as TreeRow[], tree)
  ) {
    return previous.id
  }

  // Authors are the clients whose clocks moved. A deletion moves no clock, so someone who only
  // deleted text is not listed.
  const before = previous ? clocks(previous.state) : new Map<number, number>()
  const moved = [...clocks(state)]
    .filter(([client, clock]) => clock > (before.get(client) ?? 0))
    .map(([client]) => BigInt(client))
  const authors = await prisma.yjsClient.findMany({
    where: { projectId, clientId: { in: moved } },
    select: { userId: true },
    distinct: ['userId'],
  })

  const snapshot = await prisma.snapshot.create({
    data: {
      projectId,
      kind,
      label: label ?? null,
      state: Buffer.from(state),
      tree,
      authorIds: authors.map((author) => author.userId),
      createdById: createdById ?? null,
    },
    select: { id: true },
  })
  return snapshot.id
}

// Keeps the newest automatic snapshot of each day. Manual checkpoints are never pruned.
export async function pruneSnapshots(prisma: PrismaClient, cutoff: Date): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "Snapshot"
    WHERE kind IN ('AUTO', 'RUN')
      AND "createdAt" < ${cutoff}
      AND id NOT IN (
        SELECT DISTINCT ON ("projectId", date_trunc('day', "createdAt")) id
        FROM "Snapshot"
        WHERE kind IN ('AUTO', 'RUN') AND "createdAt" < ${cutoff}
        ORDER BY "projectId", date_trunc('day', "createdAt"), "createdAt" DESC
      )`
}
