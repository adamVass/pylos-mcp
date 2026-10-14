import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import type { MicrosoftAuthConfig } from './core/oauth.js'
import { isAllowlistEntry } from './core/address.js'
import type { DetectOptions } from './safety/detect.js'

type Capability = 'read' | 'drafts' | 'manage' | 'send' | 'delete' | 'sieve-read'

export interface Config {
  user: string
  password?: string // present iff microsoft is absent
  microsoft?: MicrosoftAuthConfig // present iff the preset signs in through Microsoft
  imap: { host: string; port: number; starttls: boolean }
  smtp?: { host: string; port: number } // present iff 'send' enabled
  sieve?: { host: string; port: number } // present iff 'sieve-read' enabled
  capabilities: Set<Capability> // always contains 'read'
  maxBodyKb: number
  maxAttachmentMb: number
  downloadDir: string // absolute: a leading ~ is expanded here, not by consumers
  sendSessionCap: number
  sendAllowlist?: string[] // lowercased here only as normalization, isAllowed case-folds anyway
  sendSaveCopy: boolean
  sendConfirm: boolean
  draftsNoRecipients: boolean
  tlsCaFile?: string
  authservIds: string[] // lowercase, compared and never interpreted
  detect: DetectOptions
}

export class ConfigError extends Error {}

interface Preset {
  imapHost: string
  smtpHost: string
  smtpPort: number
  auth: 'password' | 'microsoft'
  authservIds: string[]
}

// every preset speaks implicit TLS on 993
const PRESETS: ReadonlyMap<string, Preset> = new Map([
  [
    'mailbox.org',
    {
      imapHost: 'imap.mailbox.org',
      smtpHost: 'smtp.mailbox.org',
      smtpPort: 465,
      auth: 'password',
      authservIds: ['incoming_mbo'],
    },
  ],
  [
    'fastmail',
    {
      imapHost: 'imap.fastmail.com',
      smtpHost: 'smtp.fastmail.com',
      smtpPort: 465,
      auth: 'password',
      authservIds: ['.messagingengine.com'],
    },
  ],
  [
    'gmail',
    {
      imapHost: 'imap.gmail.com',
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      auth: 'password',
      authservIds: ['mx.google.com'],
    },
  ],
  [
    'yahoo',
    {
      imapHost: 'imap.mail.yahoo.com',
      smtpHost: 'smtp.mail.yahoo.com',
      smtpPort: 465,
      auth: 'password',
      authservIds: [],
    },
  ],
  [
    'icloud',
    { imapHost: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com', smtpPort: 465, auth: 'password', authservIds: [] },
  ],
  [
    'gmx',
    { imapHost: 'imap.gmx.net', smtpHost: 'mail.gmx.net', smtpPort: 465, auth: 'password', authservIds: ['gmx.net'] },
  ],
  [
    'posteo',
    { imapHost: 'posteo.de', smtpHost: 'posteo.de', smtpPort: 465, auth: 'password', authservIds: ['posteo.de'] },
  ],
  // Microsoft submits only over STARTTLS, which transport() fails closed on
  [
    'outlook',
    {
      imapHost: 'outlook.office365.com',
      smtpHost: 'smtp.office365.com',
      smtpPort: 587,
      auth: 'microsoft',
      authservIds: ['mx.microsoft.com'],
    },
  ],
])

/** pylos-mcp's own public client registration. Not a secret: a public client has none. */
export const MICROSOFT_CLIENT_ID = '45dd6df5-9736-4657-8111-fe9c810aba3b'
const OUTLOOK_IMAP_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All'
const OUTLOOK_SMTP_SCOPE = 'https://outlook.office.com/SMTP.Send'

const ALL_CAPABILITIES: readonly Capability[] = ['read', 'drafts', 'manage', 'send', 'delete', 'sieve-read']
const CAPABILITY_SET: ReadonlySet<string> = new Set(ALL_CAPABILITIES)

const positiveIntSchema = z.coerce.number().int().positive()

function requireString(varName: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new ConfigError(`${varName} is required`)
  }
  return value
}

function numericEnv(env: Record<string, string | undefined>, varName: string, defaultValue: number): number {
  const raw = env[varName]
  if (raw === undefined) return defaultValue
  const result = positiveIntSchema.safeParse(raw)
  if (!result.success) {
    throw new ConfigError(`${varName} must be a positive integer, got "${raw}"`)
  }
  return result.data
}

function booleanEnv(env: Record<string, string | undefined>, varName: string, defaultValue: boolean): boolean {
  const raw = env[varName]
  if (raw === undefined) return defaultValue
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new ConfigError(`${varName} must be "true" or "false", got "${raw}"`)
}

function listEnv(raw: string | undefined, separator = ','): string[] | undefined {
  return raw
    ?.split(separator)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function resolveProvider(provider: string | undefined): Preset | undefined {
  if (provider === undefined) return undefined
  const preset = PRESETS.get(provider)
  if (!preset) {
    throw new ConfigError(
      `PROVIDER "${provider}" is not recognized. Valid values are: ${[...PRESETS.keys()].join(', ')}`,
    )
  }
  return preset
}

const PASSWORD_CMD_TIMEOUT_MS = 60_000

function resolvePassword(env: Record<string, string | undefined>): string {
  const hasPassword = env.EMAIL_PASSWORD !== undefined
  const hasCmd = env.EMAIL_PASSWORD_CMD !== undefined

  if (hasPassword && hasCmd) {
    throw new ConfigError('set only one of EMAIL_PASSWORD or EMAIL_PASSWORD_CMD, not both')
  }
  // An empty password is not a password: loading it successfully would surface
  // much later as an IMAP auth rejection. Only the emptiness is checked, never
  // the value, so what is returned is whatever was configured.
  if (hasPassword) {
    const password = env.EMAIL_PASSWORD as string
    if (password.trim() === '') {
      throw new ConfigError('EMAIL_PASSWORD is set but empty. Set it to the account password')
    }
    return password
  }
  if (hasCmd) {
    let output: string
    try {
      output = execSync(env.EMAIL_PASSWORD_CMD as string, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // stdin is closed, so a command waiting on a prompt would hang startup forever
        timeout: PASSWORD_CMD_TIMEOUT_MS,
      })
    } catch (err) {
      // never echo the command or its output, either may contain secrets
      if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        throw new ConfigError(`EMAIL_PASSWORD_CMD did not finish within ${PASSWORD_CMD_TIMEOUT_MS / 1000} seconds`)
      }
      throw new ConfigError('EMAIL_PASSWORD_CMD failed')
    }
    const password = output.replace(/\n$/, '')
    if (password.trim() === '') {
      throw new ConfigError('EMAIL_PASSWORD_CMD produced no password. It must print the password on stdout')
    }
    return password
  }
  throw new ConfigError('set one of EMAIL_PASSWORD or EMAIL_PASSWORD_CMD to provide the account password')
}

function parseCapabilities(raw: string | undefined): Set<Capability> {
  const items = (raw ?? 'drafts')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const capabilities = new Set<Capability>()
  for (const item of items) {
    if (!CAPABILITY_SET.has(item)) {
      throw new ConfigError(
        `CAPABILITIES contains unknown value "${item}". Valid values are: ${ALL_CAPABILITIES.join(', ')}`,
      )
    }
    capabilities.add(item as Capability)
  }
  capabilities.add('read')
  return capabilities
}

function expandHome(dir: string): string {
  if (dir === '~') return os.homedir()
  if (dir.startsWith('~/')) return path.join(os.homedir(), dir.slice(2))
  return dir
}

// MCPB substitutes "" for optional fields left blank, so "" has to read as unset
function withoutEmptyValues(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const copy: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    copy[key] = value === '' ? undefined : value
  }
  return copy
}

function microsoftAuth(env: Record<string, string | undefined>, capabilities: Set<Capability>): MicrosoftAuthConfig {
  // checked before resolvePassword would run EMAIL_PASSWORD_CMD for a password that can never be used
  if (env.EMAIL_PASSWORD !== undefined || env.EMAIL_PASSWORD_CMD !== undefined) {
    throw new ConfigError('PROVIDER=outlook signs in through the browser. Remove EMAIL_PASSWORD and EMAIL_PASSWORD_CMD')
  }
  if (capabilities.has('sieve-read')) {
    throw new ConfigError('Microsoft does not offer Sieve. Remove sieve-read from CAPABILITIES')
  }
  const tenant = env.MS_TENANT ?? 'common'
  // it becomes a path segment of the sign-in URL, so no slashes and no dot segments
  if (tenant.length > 100 || !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/.test(tenant)) {
    throw new ConfigError(`MS_TENANT must be a tenant ID or domain, got "${tenant}"`)
  }
  const clientId = env.MS_CLIENT_ID ?? MICROSOFT_CLIENT_ID
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    throw new ConfigError(`MS_CLIENT_ID must be an application (client) ID, got "${clientId}"`)
  }
  return {
    clientId,
    tenant,
    scopes: ['offline_access', OUTLOOK_IMAP_SCOPE, ...(capabilities.has('send') ? [OUTLOOK_SMTP_SCOPE] : [])],
  }
}

/** password login only: config leaves `password` unset exactly when `microsoft` is set */
export function passwordOf(cfg: Config): string {
  if (cfg.password === undefined) throw new Error('password login attempted on a Microsoft sign-in account')
  return cfg.password
}

export function loadConfig(rawEnv: Record<string, string | undefined>): Config {
  const env = withoutEmptyValues(rawEnv)

  const user = requireString('EMAIL_USER', env.EMAIL_USER)
  const preset = resolveProvider(env.PROVIDER)
  const capabilities = parseCapabilities(env.CAPABILITIES)

  const microsoft = preset?.auth === 'microsoft' ? microsoftAuth(env, capabilities) : undefined
  if (!microsoft && (env.MS_CLIENT_ID !== undefined || env.MS_TENANT !== undefined)) {
    throw new ConfigError('MS_CLIENT_ID and MS_TENANT apply only with PROVIDER=outlook')
  }
  const password = microsoft ? undefined : resolvePassword(env)

  const imapHost = env.IMAP_HOST ?? preset?.imapHost
  if (!imapHost) {
    throw new ConfigError('IMAP host is not configured. Set IMAP_HOST or PROVIDER')
  }
  const starttls = booleanEnv(env, 'IMAP_STARTTLS', false)
  const imap = { host: imapHost, port: numericEnv(env, 'IMAP_PORT', starttls ? 143 : 993), starttls }

  let smtp: { host: string; port: number } | undefined
  if (capabilities.has('send')) {
    const smtpHost = env.SMTP_HOST ?? preset?.smtpHost
    if (!smtpHost) {
      throw new ConfigError(
        'SMTP host is not configured. Set SMTP_HOST or PROVIDER (required because the "send" capability is enabled)',
      )
    }
    smtp = { host: smtpHost, port: numericEnv(env, 'SMTP_PORT', preset?.smtpPort ?? 465) }
  }

  let sieve: { host: string; port: number } | undefined
  if (capabilities.has('sieve-read')) {
    const sieveHost = env.SIEVE_HOST ?? imapHost
    sieve = { host: sieveHost, port: numericEnv(env, 'SIEVE_PORT', 4190) }
  }

  const maxBodyKb = numericEnv(env, 'MAX_BODY_KB', 64)
  const maxAttachmentMb = numericEnv(env, 'MAX_ATTACHMENT_MB', 25)
  const sendSessionCap = numericEnv(env, 'SEND_SESSION_CAP', 5)

  const downloadDir = expandHome(env.DOWNLOAD_DIR ?? '~/Downloads')

  const sendAllowlist = listEnv(env.SEND_ALLOWLIST)
  // an entry that can never match leaves the gate shut while looking open
  const unmatchable = sendAllowlist?.find((entry) => !isAllowlistEntry(entry))
  if (unmatchable !== undefined) {
    throw new ConfigError(`SEND_ALLOWLIST entry "${unmatchable}" is not an address, *@domain, or *`)
  }

  const sendSaveCopy = booleanEnv(env, 'SEND_SAVE_COPY', true)
  const sendConfirm = booleanEnv(env, 'SEND_CONFIRM', false)

  const draftsNoRecipients = booleanEnv(env, 'DRAFTS_NO_RECIPIENTS', false)

  // pipes, not commas: a phrase may contain a comma, and phrases are the whole
  // point of this variable
  const extraPatterns = listEnv(env.FLAG_EXTRA_PATTERNS, '|') ?? []

  const detect: DetectOptions = {
    hiddenText: booleanEnv(env, 'FLAG_HIDDEN_TEXT', true),
    instructionPatterns: booleanEnv(env, 'FLAG_INSTRUCTION_PATTERNS', true),
    encodedBlobs: booleanEnv(env, 'FLAG_ENCODED_BLOBS', true),
    senderMismatch: booleanEnv(env, 'FLAG_SENDER_MISMATCH', true),
    mixedScript: booleanEnv(env, 'FLAG_MIXED_SCRIPT', true),
    dmarcFail: booleanEnv(env, 'FLAG_DMARC_FAIL', true),
    stripHiddenText: booleanEnv(env, 'STRIP_HIDDEN_TEXT', false),
    extraPatterns,
  }
  if (detect.stripHiddenText && !detect.hiddenText) {
    throw new ConfigError(
      'STRIP_HIDDEN_TEXT=true does nothing while FLAG_HIDDEN_TEXT=false, because stripping runs inside the hidden-text detector. Enable FLAG_HIDDEN_TEXT or drop STRIP_HIDDEN_TEXT',
    )
  }

  const tlsCaFile = env.TLS_CA_FILE
  // read again per connection, this read only moves an unreadable file's failure to startup
  if (tlsCaFile !== undefined) {
    try {
      readFileSync(tlsCaFile)
    } catch {
      throw new ConfigError(`TLS_CA_FILE could not be read: ${tlsCaFile}`)
    }
  }

  const configuredIds = listEnv(env.AUTHSERV_ID) ?? []
  const authservIds = configuredIds.length > 0 ? configuredIds : (preset?.authservIds ?? [])
  const badId = authservIds.find((id) => !/^\.?[a-z0-9][a-z0-9_.-]*$/.test(id))
  if (badId !== undefined) {
    throw new ConfigError(`AUTHSERV_ID entry "${badId}" is not a server name, or a .domain suffix`)
  }

  return {
    user,
    password,
    microsoft,
    imap,
    smtp,
    sieve,
    capabilities,
    maxBodyKb,
    maxAttachmentMb,
    downloadDir,
    sendSessionCap,
    sendAllowlist,
    sendSaveCopy,
    sendConfirm,
    draftsNoRecipients,
    tlsCaFile,
    authservIds,
    detect,
  }
}
