import { execSync } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import type { DetectOptions } from './safety/detect.js'

type Capability = 'read' | 'drafts' | 'manage' | 'send' | 'delete' | 'sieve-read'

export interface Config {
  user: string
  password: string
  imap: { host: string; port: number }
  smtp?: { host: string; port: number } // present iff 'send' enabled
  sieve?: { host: string; port: number } // present iff 'sieve-read' enabled
  capabilities: Set<Capability> // always contains 'read'
  maxBodyKb: number
  maxAttachmentMb: number
  downloadDir: string // absolute: a leading ~ is expanded here, not by consumers
  sendSessionCap: number
  sendAllowlist?: string[] // lowercased here only as normalization, isAllowed case-folds anyway
  sendSaveCopy: boolean
  draftsNoRecipients: boolean
  tlsCaFile?: string
  detect: DetectOptions
}

export class ConfigError extends Error {}

interface Preset {
  imapHost: string
  smtpHost: string
}

// all IMAP ports are 993, all SMTP ports are 465
const PRESETS: ReadonlyMap<string, Preset> = new Map([
  ['mailbox.org', { imapHost: 'imap.mailbox.org', smtpHost: 'smtp.mailbox.org' }],
  ['fastmail', { imapHost: 'imap.fastmail.com', smtpHost: 'smtp.fastmail.com' }],
  ['gmail', { imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com' }],
  ['yahoo', { imapHost: 'imap.mail.yahoo.com', smtpHost: 'smtp.mail.yahoo.com' }],
  ['icloud', { imapHost: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com' }],
  ['gmx', { imapHost: 'imap.gmx.net', smtpHost: 'mail.gmx.net' }],
  ['posteo', { imapHost: 'posteo.de', smtpHost: 'posteo.de' }],
])

const ALL_CAPABILITIES: readonly Capability[] = ['read', 'drafts', 'manage', 'send', 'delete', 'sieve-read']
const CAPABILITY_SET: ReadonlySet<string> = new Set(ALL_CAPABILITIES)

const positiveIntSchema = z.coerce.number().int().positive()

function requireString(varName: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new ConfigError(`${varName} is required`)
  }
  return value
}

function numericEnv(varName: string, raw: string | undefined, defaultValue: number): number {
  if (raw === undefined) return defaultValue
  const result = positiveIntSchema.safeParse(raw)
  if (!result.success) {
    throw new ConfigError(`${varName} must be a positive integer, got "${raw}"`)
  }
  return result.data
}

function booleanEnv(varName: string, raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new ConfigError(`${varName} must be "true" or "false", got "${raw}"`)
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
      })
    } catch {
      // never echo the command or its output, either may contain secrets
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

export function loadConfig(rawEnv: Record<string, string | undefined>): Config {
  const env = withoutEmptyValues(rawEnv)

  const user = requireString('EMAIL_USER', env.EMAIL_USER)
  const password = resolvePassword(env)

  const preset = resolveProvider(env.PROVIDER)

  const imapHost = env.IMAP_HOST ?? preset?.imapHost
  if (!imapHost) {
    throw new ConfigError('IMAP host is not configured. Set IMAP_HOST or PROVIDER')
  }
  const imap = { host: imapHost, port: numericEnv('IMAP_PORT', env.IMAP_PORT, 993) }

  const capabilities = parseCapabilities(env.CAPABILITIES)

  let smtp: { host: string; port: number } | undefined
  if (capabilities.has('send')) {
    const smtpHost = env.SMTP_HOST ?? preset?.smtpHost
    if (!smtpHost) {
      throw new ConfigError(
        'SMTP host is not configured. Set SMTP_HOST or PROVIDER (required because the "send" capability is enabled)',
      )
    }
    smtp = { host: smtpHost, port: numericEnv('SMTP_PORT', env.SMTP_PORT, 465) }
  }

  let sieve: { host: string; port: number } | undefined
  if (capabilities.has('sieve-read')) {
    const sieveHost = env.SIEVE_HOST ?? imapHost
    sieve = { host: sieveHost, port: numericEnv('SIEVE_PORT', env.SIEVE_PORT, 4190) }
  }

  const maxBodyKb = numericEnv('MAX_BODY_KB', env.MAX_BODY_KB, 64)
  const maxAttachmentMb = numericEnv('MAX_ATTACHMENT_MB', env.MAX_ATTACHMENT_MB, 25)
  const sendSessionCap = numericEnv('SEND_SESSION_CAP', env.SEND_SESSION_CAP, 5)

  const downloadDir = expandHome(env.DOWNLOAD_DIR ?? '~/Downloads')

  const sendAllowlist =
    env.SEND_ALLOWLIST !== undefined
      ? env.SEND_ALLOWLIST.split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : undefined

  const sendSaveCopy = booleanEnv('SEND_SAVE_COPY', env.SEND_SAVE_COPY, true)

  const draftsNoRecipients = booleanEnv('DRAFTS_NO_RECIPIENTS', env.DRAFTS_NO_RECIPIENTS, false)

  const hiddenText = booleanEnv('FLAG_HIDDEN_TEXT', env.FLAG_HIDDEN_TEXT, true)
  const instructionPatterns = booleanEnv('FLAG_INSTRUCTION_PATTERNS', env.FLAG_INSTRUCTION_PATTERNS, true)
  const encodedBlobs = booleanEnv('FLAG_ENCODED_BLOBS', env.FLAG_ENCODED_BLOBS, true)
  const senderMismatch = booleanEnv('FLAG_SENDER_MISMATCH', env.FLAG_SENDER_MISMATCH, true)
  const stripHiddenText = booleanEnv('STRIP_HIDDEN_TEXT', env.STRIP_HIDDEN_TEXT, false)

  // pipes, not commas: a phrase may contain a comma, and phrases are the whole
  // point of this variable
  const extraPatterns =
    env.FLAG_EXTRA_PATTERNS !== undefined
      ? env.FLAG_EXTRA_PATTERNS.split('|')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : []

  if (stripHiddenText && !hiddenText) {
    throw new ConfigError(
      'STRIP_HIDDEN_TEXT=true does nothing while FLAG_HIDDEN_TEXT=false, because stripping runs inside the hidden-text detector. Enable FLAG_HIDDEN_TEXT or drop STRIP_HIDDEN_TEXT',
    )
  }

  const tlsCaFile = env.TLS_CA_FILE

  return {
    user,
    password,
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
    draftsNoRecipients,
    tlsCaFile,
    detect: { hiddenText, instructionPatterns, encodedBlobs, senderMismatch, stripHiddenText, extraPatterns },
  }
}
