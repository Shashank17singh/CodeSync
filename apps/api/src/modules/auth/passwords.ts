import { hash, verify, type Algorithm } from '@node-rs/argon2'

// OWASP's minimum for Argon2id. Passed explicitly so a library default can never weaken it.
// The literal 2 is Algorithm.Argon2id, a const enum that does not exist at runtime.
const ARGON2_OPTIONS = {
  algorithm: 2 as Algorithm,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
}

export const hashPassword = (password: string): Promise<string> => hash(password, ARGON2_OPTIONS)

export const verifyPassword = (passwordHash: string, password: string): Promise<boolean> =>
  verify(passwordHash, password)

let decoyHash: Promise<string> | undefined

// Spends the same time as a real check, so response timing cannot reveal whether an account
// exists.
export async function burnPasswordCheck(password: string): Promise<void> {
  decoyHash ??= hashPassword('decoy password that matches no account')
  await verify(await decoyHash, password)
}
