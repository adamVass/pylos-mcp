// The only module in this server that transmits mail. Three gates stand between
// a tool call and a message leaving: the allowlist, the session cap, and the
// absence of any recipient field beyond To and Cc. All are checked before a
// socket is opened.

import { createTransport } from 'nodemailer'
import type { Config } from '../config.js'
import { APP_PASSWORD_ADVICE, TLS_CA_ADVICE, ToolError, errorCode } from '../errors.js'
import type { SentCopy } from '../safety/render.js'
import type { ImapSession } from './client.js'
import { collectAttachments, composeMessage, type ComposeBudget, type PartRef } from './draft.js'
import { markAnswered } from './mailbox-ops.js'
import { readReplyHeaders, type ReplyRef } from './reply.js'
import { secureOptions } from './tls.js'

/**
 * `inFlight` exists because the MCP SDK dispatches tool handlers through
 * `Promise.resolve().then()` and serializes nothing, so two send_email calls
 * are genuinely concurrent. A cap that counted only settled sends would let
 * every call in flight at `sent === cap - 1` through.
 */
export class SendState {
  sent = 0
  inFlight = 0
}

export function checkAllowlist(recipients: string[], allowlist: string[]): string[] {
  return recipients.filter((recipient) => !isAllowed(recipient.toLowerCase(), allowlist))
}

/**
 * `*` alone is the config token that visibly turns the safeguard off.
 * `*@domain` compares the part after the LAST `@` for exact equality, not a
 * suffix: `corp.example` must not admit `subcorp.example`, and a quoted local
 * part may legally contain an `@`, so `"a@corp.example"@evil.example` is an
 * evil.example address.
 */
/** the shapes isAllowed can match, checked at startup so no entry silently matches nobody */
export function isAllowlistEntry(entry: string): boolean {
  return entry === '*' || /^(\*|[^\s*]+)@[^\s@*]+$/.test(entry)
}

function isAllowed(recipient: string, allowlist: string[]): boolean {
  const at = recipient.lastIndexOf('@')
  const domain = at === -1 ? null : recipient.slice(at + 1)

  return allowlist.some((entry) => {
    const pattern = entry.toLowerCase()
    if (pattern === '*') return true
    if (!pattern.startsWith('*@')) return pattern === recipient
    return domain !== null && domain === pattern.slice(2)
  })
}

export interface SendArgs {
  to: string[]
  cc?: string[]
  subject: string
  body: string
  attachments?: PartRef[]
  inReplyTo?: ReplyRef
}

export interface SendResult {
  accepted: string[]
  /**
   * nodemailer resolves when only SOME recipients are refused, so without
   * `rejected` a partly failed send reads as a clean one.
   */
  rejected: string[]
  sent: number
  copy: SentCopy
  /** set only for a reply, and `answered` is false when the original could not be marked */
  reply?: { ref: ReplyRef; answered: boolean }
}

export async function sendEmail(
  session: ImapSession,
  cfg: Config,
  state: SendState,
  args: SendArgs,
  budget: ComposeBudget,
): Promise<SendResult> {
  const smtp = smtpTarget(cfg)
  const recipients = [...args.to, ...(args.cc ?? [])]

  // Both policy checks settle before any attachment is fetched, so a call that
  // was never going to be sent does no IMAP work and leaks nothing to the relay.
  // No allowlist means closed, not open: enabling send is the risky act, so the
  // guardrail stands until deliberately configured away.
  if (cfg.sendAllowlist === undefined) {
    throw new ToolError(
      'policy',
      'sending is closed: SEND_ALLOWLIST is not configured. Set SEND_ALLOWLIST=name@example.com,*@example.org to choose who can be addressed, or SEND_ALLOWLIST=* to allow anyone',
    )
  }
  const outsideAllowlist = checkAllowlist(recipients, cfg.sendAllowlist)
  if (outsideAllowlist.length > 0) {
    throw new ToolError(
      'policy',
      `recipients not in SEND_ALLOWLIST: ${outsideAllowlist.join(', ')}. Add them to SEND_ALLOWLIST, or set SEND_ALLOWLIST=* to allow anyone`,
    )
  }

  // Reserved against the cap, not merely counted after the fact. The check and
  // the reservation are one synchronous step with no await between them, which
  // is what makes them atomic on a single-threaded runtime.
  if (state.sent + state.inFlight >= cfg.sendSessionCap) {
    throw new ToolError(
      'policy',
      `session send cap reached (SEND_SESSION_CAP=${cfg.sendSessionCap}). Restart the server to send again`,
    )
  }
  let release = (): void => {}
  state.inFlight += 1

  // held until the copy is filed, because the composed message still holds the encoded bytes
  try {
    const reserved = await (async () => {
      try {
        // the allowlist and cap settled before any IMAP work, and no relay socket opens before this read
        const thread = args.inReplyTo ? await readReplyHeaders(session, args.inReplyTo) : undefined

        // fetched before the message is composed, because a message that went out
        // without one of its attachments cannot be recalled
        const collected = await collectAttachments(session, cfg, args.attachments ?? [], budget)
        release = collected.release

        // Composed once, transmitted and filed as the same bytes: the copy in Sent
        // is exactly what recipients received, Message-ID included.
        const message = await composeMessage(cfg, {
          ...thread,
          to: args.to,
          cc: args.cc,
          subject: args.subject,
          body: args.body,
          attachments: collected.attachments,
        })

        const info = await transport(cfg, smtp)
          .sendMail({
            envelope: { from: cfg.user, to: recipients },
            raw: message,
            disableFileAccess: true,
            disableUrlAccess: true,
          })
          .catch((err: unknown) => {
            throw sendFailure(err, `${smtp.host}:${smtp.port}`)
          })

        // Only once the server has taken the message: a send the relay refused must
        // not cost a slot. The total is captured WITH the increment rather than read
        // back later, or a concurrent send settling in between would make each call
        // report the other's position in the budget.
        const sent = (state.sent += 1)

        return { info, message, sent }
      } finally {
        // Released whichever way the send went, and before the copy is filed rather
        // than after: once the increment lands the cap is accounted on `sent`, so
        // holding the slot through the IMAP append would count the same message
        // twice and falsely refuse a concurrent send at the boundary.
        state.inFlight -= 1
      }
    })()

    // after the relay accepted and before the copy is filed, and never a reason to report the send as failed
    const reply = args.inReplyTo && { ref: args.inReplyTo, answered: await markAnswered(session, args.inReplyTo) }

    return {
      accepted: reserved.info.accepted.map(addressOf),
      // `rejected` only, never `rejectedErrors`: those carry the server's own
      // response text, which is what sendFailure exists to keep out.
      rejected: reserved.info.rejected.map(addressOf),
      sent: reserved.sent,
      copy: await saveCopy(session, cfg, reserved.message),
      reply,
    }
  } finally {
    release()
  }
}

/**
 * Runs only after the relay accepted the message, and never throws: the message
 * already left, so a copy that could not be filed is a fact to report rather
 * than a failure to raise.
 */
async function saveCopy(session: ImapSession, cfg: Config, message: Buffer): Promise<SentCopy> {
  if (!cfg.sendSaveCopy) return { status: 'off' }
  try {
    const folder = await session.specialUse('\\Sent', 'Sent')
    const appended = await session.withMailbox(folder, (client) => client.append(folder, message, ['\\Seen']))
    return appended ? { status: 'saved', folder } : { status: 'failed' }
  } catch {
    return { status: 'failed' }
  }
}

function smtpTarget(cfg: Config): { host: string; port: number } {
  if (!cfg.smtp) throw new ToolError('server', 'SMTP is not configured. Set SMTP_HOST or PROVIDER')
  return cfg.smtp
}

function addressOf(recipient: string | { address: string }): string {
  return typeof recipient === 'string' ? recipient : recipient.address
}

function transport(cfg: Config, smtp: { host: string; port: number }) {
  return createTransport({
    host: smtp.host,
    port: smtp.port,
    // implicit TLS on 465, STARTTLS otherwise, and requireTLS makes that second
    // case fail closed instead of falling back to a cleartext session against a
    // server that does not offer the upgrade
    secure: smtp.port === 465,
    requireTLS: true,
    auth: { user: cfg.user, pass: cfg.password },
    // stdout is reserved for the MCP protocol, so nodemailer must never write to it
    logger: false,
    tls: secureOptions(smtp.host, cfg.tlsCaFile),
  })
}

/**
 * Built from the category and the configured host/port only: the underlying
 * error carries the server's own response text, which is attacker-controllable
 * on a relay the user does not run.
 */
function sendFailure(err: unknown, target: string): ToolError {
  switch (errorCode(err)) {
    case 'EAUTH':
    case 'ENOAUTH':
      return new ToolError(
        'auth',
        `the SMTP server rejected the credentials. Check EMAIL_USER and the password; ${APP_PASSWORD_ADVICE}`,
      )
    case 'EDNS':
      return new ToolError('connect', `could not resolve the SMTP host in ${target}. Check SMTP_HOST`)
    case 'ETIMEDOUT':
      return new ToolError('connect', `timed out talking to ${target}. Check the network and any firewall`)
    case 'ETLS':
    case 'EREQUIRETLS':
      return new ToolError(
        'connect',
        `TLS could not be established with ${target}. If this is a private server with its own CA, ${TLS_CA_ADVICE}. The message was not sent in the clear`,
      )
    case 'ECONNECTION':
    case 'ESOCKET':
      return new ToolError(
        'connect',
        `could not establish an SMTP connection to ${target}. Check SMTP_HOST and SMTP_PORT`,
      )
    case 'EENVELOPE':
      return new ToolError(
        'server',
        `${target} refused the sender or one of the recipients, so nothing was sent. Check the addresses`,
      )
    default:
      return new ToolError('server', `${target} did not accept the message, so nothing was sent`)
  }
}
