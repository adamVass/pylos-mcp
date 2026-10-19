import { type Config, ConfigError, loadConfig, prepareConfig, withoutEmptyValues } from './config.js'

export interface ParsedAccount {
  name?: string
  cfg: Config
}

export const MAX_ACCOUNTS = 10

const PER_ACCOUNT = new Set(
  'PROVIDER EMAIL_USER EMAIL_PASSWORD EMAIL_PASSWORD_CMD MS_CLIENT_ID MS_TENANT IMAP_HOST IMAP_PORT IMAP_STARTTLS SMTP_HOST SMTP_PORT SIEVE_HOST SIEVE_PORT CAPABILITIES SEND_ALLOWLIST SEND_SAVE_COPY AUTHSERV_ID TLS_CA_FILE'.split(
    ' ',
  ),
)
const GLOBAL = new Set(
  'MAX_BODY_KB MAX_ATTACHMENT_MB DOWNLOAD_DIR SEND_SESSION_CAP SEND_CONFIRM DRAFTS_NO_RECIPIENTS FLAG_HIDDEN_TEXT FLAG_INSTRUCTION_PATTERNS FLAG_ENCODED_BLOBS FLAG_SENDER_MISMATCH FLAG_MIXED_SCRIPT FLAG_DMARC_FAIL FLAG_EXTRA_PATTERNS STRIP_HIDDEN_TEXT'.split(
    ' ',
  ),
)

const NAME_RULE = /^[a-z0-9]{1,16}$/

type Env = Record<string, string | undefined>

function throwAll(problems: string[]): void {
  if (problems.length > 0) throw new ConfigError(problems.join('\n'))
}

function splitKey(key: string): { base: string; suffix?: string } {
  const at = key.indexOf('__')
  return at < 0 ? { base: key } : { base: key.slice(0, at), suffix: key.slice(at + 2) }
}

function inAccount<T>(name: string, fn: () => T): T | ConfigError {
  try {
    return fn()
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err
    return new ConfigError(`account "${name}": ${err.message}. Its account settings end in __${name.toUpperCase()}`)
  }
}

export function loadAccounts(rawEnv: Env): ParsedAccount[] {
  const env: Env = {}
  for (const [key, value] of Object.entries(withoutEmptyValues(rawEnv))) {
    const { base } = splitKey(key)
    if (value !== undefined && (key === 'ACCOUNTS' || PER_ACCOUNT.has(base) || GLOBAL.has(base))) env[key] = value
  }

  const accountsVar = env.ACCOUNTS
  if (accountsVar === undefined) {
    throwAll(
      Object.keys(env)
        .filter((key) => splitKey(key).suffix !== undefined)
        .map((key) => {
          const { base } = splitKey(key)
          return GLOBAL.has(base)
            ? `${key}: ${base} applies to all accounts. Drop the suffix`
            : `${key} is set, but ACCOUNTS is not. Set ACCOUNTS to configure several accounts, or drop the suffix`
        }),
    )
    // the raw environment, so a variable config.ts adds later is never filtered out here
    return [{ cfg: loadConfig(rawEnv) }]
  }

  const names = accountsVar.split(',').map((s) => s.trim())
  const problems: string[] = []
  for (const name of names) {
    if (!NAME_RULE.test(name)) problems.push(`ACCOUNTS entry "${name}" must be 1 to 16 lowercase letters or digits`)
  }
  for (const name of new Set(names.filter((n, i) => names.indexOf(n) !== i))) {
    problems.push(`ACCOUNTS names "${name}" twice`)
  }
  if (names.length > MAX_ACCOUNTS) {
    problems.push(`ACCOUNTS names ${names.length} accounts, at most ${MAX_ACCOUNTS} are supported`)
  }
  const suffixes = new Set(names.map((n) => n.toUpperCase()))
  const example = names.find((n) => NAME_RULE.test(n))?.toUpperCase()
  for (const key of Object.keys(env)) {
    const { base, suffix } = splitKey(key)
    if (PER_ACCOUNT.has(base) && suffix === undefined) {
      problems.push(
        `${key} is set without an account suffix. With ACCOUNTS set, every account setting ends in __ and the account's name${example === undefined ? '' : `, such as ${key}__${example}`}`,
      )
    } else if (GLOBAL.has(base) && suffix !== undefined) {
      problems.push(`${key}: ${base} applies to all accounts. Drop the suffix`)
    } else if (suffix !== undefined && !suffixes.has(suffix)) {
      problems.push(`${key} names no account in ACCOUNTS`)
    }
  }
  throwAll(problems)

  const prepared = names.map((name) => {
    const view: Env = {}
    for (const [key, value] of Object.entries(env)) {
      const { base, suffix } = splitKey(key)
      if (suffix === undefined ? GLOBAL.has(base) : suffix === name.toUpperCase()) view[base] = value
    }
    return { name, result: inAccount(name, () => prepareConfig(view)) }
  })
  throwAll(prepared.flatMap((p) => (p.result instanceof ConfigError ? [p.result.message] : [])))
  const ready = prepared.map((p) => ({ name: p.name, ...(p.result as ReturnType<typeof prepareConfig>) }))

  for (let i = 0; i < ready.length; i++) {
    for (let j = i + 1; j < ready.length; j++) {
      const [a, b] = [ready[i], ready[j]]
      if (a.config.user.toLowerCase() !== b.config.user.toLowerCase()) continue
      // token-store keys the Microsoft token file by login alone, whatever the IMAP host
      if (a.config.microsoft && b.config.microsoft) {
        problems.push(`accounts "${a.name}" and "${b.name}" sign in to Microsoft with the same EMAIL_USER`)
      } else if (a.config.imap.host.toLowerCase() === b.config.imap.host.toLowerCase()) {
        problems.push(
          `accounts "${a.name}" and "${b.name}" are the same mailbox: the same EMAIL_USER on the same IMAP host`,
        )
      }
    }
  }
  throwAll(problems)

  const resolved = ready.map((a) => ({ name: a.name, result: inAccount(a.name, a.resolve) }))
  throwAll(resolved.flatMap((r) => (r.result instanceof ConfigError ? [r.result.message] : [])))
  return resolved.map((r) => ({ name: r.name, cfg: { ...(r.result as Config), account: r.name } }))
}
