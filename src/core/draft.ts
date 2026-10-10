import type { Readable } from 'node:stream'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import type { Config } from '../config.js'
import type { ImapSession } from './client.js'
import { ToolError } from '../errors.js'
import { readReplyHeaders, type ReplyRef } from './reply.js'
import { capBytes, capExceededMidTransfer, resolvePartForDownload } from './message.js'
import { downloadName } from './parts.js'

export interface PartRef {
  folder: string
  uid: number
  partId: string
}

export interface DraftArgs {
  subject: string
  body: string
  to?: string[]
  cc?: string[]
  attachments?: PartRef[]
  inReplyTo?: ReplyRef
}

export interface DraftResult {
  folder: string
  uid: number | null
  recipients: string[]
}

interface ComposedAttachment {
  filename: string
  content: Buffer
  contentType: string
}

const SOURCE_GONE = 'the source message of an attachment is no longer available. It may have been moved or deleted'

/**
 * Shared by every draft and send in flight, because the MCP SDK runs tool calls
 * concurrently and each holds its attachments in memory until the message is
 * appended or sent.
 */
export class ComposeBudget {
  reserved = 0
}

/** one composition's share of the budget, so release returns exactly what it took */
class Claim {
  private held = 0

  constructor(
    private readonly budget: ComposeBudget,
    private readonly maxAttachmentMb: number,
  ) {}

  // check and increment with no await between them, the inFlight pattern in smtp.ts
  take(bytes: number): void {
    const limit = capBytes(this.maxAttachmentMb)
    if (this.held + bytes > limit) {
      throw new ToolError(
        'cap_exceeded',
        `the attachments together are larger than MAX_ATTACHMENT_MB (${this.maxAttachmentMb} MB) allows for one message. Nothing was saved or sent`,
      )
    }
    if (this.budget.reserved + bytes > limit) {
      throw new ToolError(
        'cap_exceeded',
        'another message with attachments is being composed right now. Try again when it has finished',
      )
    }
    this.budget.reserved += bytes
    this.held += bytes
  }

  release(): void {
    this.budget.reserved -= this.held
    this.held = 0
  }
}

export async function createDraft(
  session: ImapSession,
  cfg: Config,
  args: DraftArgs,
  budget: ComposeBudget,
): Promise<DraftResult> {
  const recipients = [...(args.to ?? []), ...(args.cc ?? [])]
  if (cfg.draftsNoRecipients && recipients.length > 0) {
    throw new ToolError('policy', 'drafts are configured to carry no recipients (DRAFTS_NO_RECIPIENTS=true)')
  }

  // read before any attachment is fetched, so an unknown original costs no download
  const thread = args.inReplyTo ? await readReplyHeaders(session, args.inReplyTo) : undefined

  const { attachments, release } = await collectAttachments(session, cfg, args.attachments ?? [], budget)
  try {
    const message = await composeMessage(cfg, {
      ...thread,
      to: args.to,
      cc: args.cc,
      subject: args.subject,
      body: args.body,
      attachments,
    })

    const folder = await session.specialUse('\\Drafts', 'Drafts')

    // Selected, not merely connected: imapflow drops any APPEND flag the SELECTED
    // mailbox does not permit, whatever the destination is. Fetching an attachment
    // leaves its source folder selected, so appending through a bare client would
    // validate `\Draft` against that folder's permanent flags and could silently
    // save a draft that is not flagged as one.
    const appended = await session.withMailbox(folder, async (client) => {
      try {
        return await client.append(folder, message, ['\\Draft'])
      } catch {
        throw new ToolError('server', 'the server refused to save the draft to the Drafts folder')
      }
    })

    // imapflow answers `false` when it never sent the command at all, which is not
    // the same as an APPEND the server accepted without reporting a UID
    if (!appended) throw new ToolError('server', 'the draft was not saved. The APPEND was never sent')

    return { folder, uid: appended.uid ?? null, recipients }
  } finally {
    release()
  }
}

/**
 * Without the two disable flags, a `path` or `href` reaching an attachment
 * object would turn composing into a local-file read and an outbound HTTP
 * request. Nothing in either caller sets those fields today, so this is the
 * single lock that survives someone later adding one.
 */
export async function composeMessage(
  cfg: Config,
  message: {
    to?: string[]
    cc?: string[]
    subject: string
    body: string
    attachments: ComposedAttachment[]
    inReplyTo?: string
    references?: string[]
  },
): Promise<Buffer> {
  return new MailComposer({
    from: cfg.user,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    inReplyTo: message.inReplyTo,
    references: message.references,
    text: message.body,
    attachments: message.attachments,
    disableFileAccess: true,
    disableUrlAccess: true,
  })
    .compile()
    .build()
}

export async function collectAttachments(
  session: ImapSession,
  cfg: Config,
  refs: PartRef[],
  budget: ComposeBudget,
): Promise<{ attachments: ComposedAttachment[]; release: () => void }> {
  const claim = new Claim(budget, cfg.maxAttachmentMb)
  try {
    const attachments: ComposedAttachment[] = []
    for (const ref of refs) attachments.push(await fetchPart(session, cfg, ref, claim))
    return { attachments, release: () => claim.release() }
  } catch (err) {
    claim.release()
    throw err
  }
}

/**
 * The filename comes from the source message and is untrusted, yet passed
 * through unaltered: MailComposer RFC 2231-encodes it into the
 * Content-Disposition header, so a name carrying CRLF cannot forge a header,
 * and rewriting it would silently change data in a message the user sends.
 */
async function fetchPart(session: ImapSession, cfg: Config, ref: PartRef, claim: Claim): Promise<ComposedAttachment> {
  return session.withMailbox(ref.folder, async (client) => {
    const part = await resolvePartForDownload(client, ref.uid, ref.partId, cfg.maxAttachmentMb)
    const declared = part.node.size ?? 0
    claim.take(declared)

    const download = await client.download(String(ref.uid), part.id, { uid: true })
    // a message expunged between the FETCH and this DOWNLOAD yields an object with
    // no stream rather than an error
    if (!download?.content) throw new ToolError('not_found', SOURCE_GONE)

    return {
      filename: downloadName(part.node),
      content: await readAll(download.content, cfg.maxAttachmentMb, claim, declared),
      contentType: download.meta?.contentType ?? part.node.type,
    }
  })
}

/** checked while streaming, because the server's declared size is only a claim */
async function readAll(stream: Readable, maxAttachmentMb: number, claim: Claim, declared: number): Promise<Buffer> {
  const limit = capBytes(maxAttachmentMb)
  const chunks: Buffer[] = []
  let seen = 0

  try {
    // `for await` destroys the stream on an early exit, so the cap throw below
    // leaves no backpressure on the connection every later call shares
    for await (const chunk of stream) {
      seen += (chunk as Buffer).length
      if (seen > limit) throw capExceededMidTransfer(maxAttachmentMb)
      if (seen > declared) claim.take(Math.min((chunk as Buffer).length, seen - declared))
      chunks.push(chunk as Buffer)
    }
  } catch (err) {
    if (err instanceof ToolError) throw err
    throw new ToolError('server', 'the attachment transfer ended before the part was complete')
  }
  return Buffer.concat(chunks)
}
