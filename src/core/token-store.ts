import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export interface StoredToken {
  version: 1
  clientId: string
  tenant: string
  scopes: string[]
  refreshToken: string
}

export function defaultTokenDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'pylos-mcp')
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'pylos-mcp')
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'pylos-mcp')
}

export function tokenPath(dir: string, user: string): string {
  const hash = createHash('sha256').update(user.toLowerCase()).digest('hex').slice(0, 16)
  return path.join(dir, `microsoft-${hash}.json`)
}

// a token for another app or tenant, or one missing a scope config now needs,
// cannot be used, and reading it as absent sends the user through sign-in again
export async function readToken(
  file: string,
  want: { clientId: string; tenant: string; scopes: string[] },
): Promise<StoredToken | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
  const token = parsed as Partial<StoredToken> | null
  if (
    token?.version !== 1 ||
    typeof token.refreshToken !== 'string' ||
    token.refreshToken === '' ||
    token.clientId !== want.clientId ||
    token.tenant !== want.tenant ||
    !Array.isArray(token.scopes)
  ) {
    return undefined
  }
  const granted = token.scopes
  return want.scopes.every((scope) => granted.includes(scope)) ? (token as StoredToken) : undefined
}

export async function writeToken(file: string, token: StoredToken): Promise<void> {
  const dir = path.dirname(file)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}`)
  // `wx` refuses to write through a file or link already at the temp name, and
  // the rename means no reader ever sees half a token
  await writeFile(temp, JSON.stringify(token), { mode: 0o600, flag: 'wx' })
  try {
    await rename(temp, file)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
}

export async function deleteToken(file: string): Promise<void> {
  await rm(file, { force: true })
}
