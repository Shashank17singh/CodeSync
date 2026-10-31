// Token-based similarity using winnowing, the algorithm behind MOSS. Identifiers, literals and
// comments are normalised away, so renaming variables or reformatting does not hide copying.

const KGRAM_LENGTH = 5
const WINDOW_SIZE = 4

const KEYWORDS = new Set(
  (
    'and as assert auto bool break case catch char class const continue def default del delete do ' +
    'double elif else enum except extends false final finally float for from function if ' +
    'implements import in include int interface lambda let long namespace new not null or pass ' +
    'private protected public raise return short signed sizeof static string struct super switch ' +
    'template this throw throws true try typedef typename unsigned using var vector void while ' +
    'with yield'
  ).split(' '),
)

const TOKEN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\b\d[\d._a-zA-Z]*|[A-Za-z_]\w*|[^\s\w]/g

export function tokenize(source: string, language: string): string[] {
  const code =
    language === 'PYTHON' ? source.replace(/^\s*#[^\n]*$/gm, '').replace(/\s#[^\n]*$/gm, '') : source
  const tokens: string[] = []
  for (const [token] of code.matchAll(TOKEN)) {
    if (token.startsWith('//') || token.startsWith('/*')) continue
    const first = token[0] as string
    if (first === '"' || first === "'" || first === '`') tokens.push('S')
    else if (/\d/.test(first)) tokens.push('N')
    else if (/[A-Za-z_]/.test(first)) tokens.push(KEYWORDS.has(token) ? token : 'V')
    else tokens.push(token)
  }
  return tokens
}

function hashKgram(tokens: string[], start: number): number {
  let hash = 0x811c9dc5
  for (let index = start; index < start + KGRAM_LENGTH; index++) {
    const token = tokens[index] as string
    for (let char = 0; char < token.length; char++) {
      hash = Math.imul(hash ^ token.charCodeAt(char), 0x01000193)
    }
    hash = Math.imul(hash ^ 0x1f, 0x01000193)
  }
  return hash >>> 0
}

export function fingerprint(tokens: string[]): Set<number> {
  const hashes: number[] = []
  for (let start = 0; start + KGRAM_LENGTH <= tokens.length; start++) {
    hashes.push(hashKgram(tokens, start))
  }
  const prints = new Set<number>()
  if (hashes.length === 0) return prints
  // Taking the minimum of each window guarantees that any long enough match shares a fingerprint,
  // while keeping far fewer hashes than the document has.
  const windows = Math.max(1, hashes.length - WINDOW_SIZE + 1)
  for (let start = 0; start < windows; start++) {
    prints.add(Math.min(...hashes.slice(start, start + WINDOW_SIZE)))
  }
  return prints
}

// Relative to the smaller document, so copying a solution into a longer file still scores high.
export function similarity(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const print of small) if (large.has(print)) shared += 1
  return shared / small.size
}
