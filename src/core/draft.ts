import type { Readable } from 'node:stream'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import type { Config } from '../config.js'
import type { ImapSession } from './client.js'
import { ToolError } from '../errors.js'
import { capBytes, capExceededMidTransfer, partFilename, resolvePartForDownload } from './message.js'

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

export async function createDraft(session: ImapSession, cfg: Config, args: DraftArgs): Promise<DraftResult> {
  const recipients = [...(args.to ?? []), ...(args.cc ?? [])]
  if (cfg.draftsNoRecipients && recipients.length > 0) {
    throw new ToolError('policy', 'drafts are configured to carry no recipients (DRAFTS_NO_RECIPIENTS=true)')
  }

  const attachments = await collectAttachments(session, cfg, args.attachments ?? [])

  const message = await composeMessage(cfg, {
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
}

/**
 * Without the two disable flags, a `path` or `href` reaching an attachment
 * object would turn composing into a local-file read and an outbound HTTP
 * request. Nothing in either caller sets those fields today, so this is the
 * single lock that survives someone later adding one.
 */
export async function composeMessage(
  cfg: Config,
  message: { to?: string[]; cc?: string[]; subject: string; body: string; attachments: ComposedAttachment[] },
): Promise<Buffer> {
  return new MailComposer({
    from: cfg.user,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
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
): Promise<ComposedAttachment[]> {
  const attachments: ComposedAttachment[] = []
  for (const ref of refs) {
    attachments.push(await fetchPart(session, cfg, ref))
  }
  return attachments
}

/**
 * The filename comes from the source message and is untrusted, yet passed
 * through unaltered: MailComposer RFC 2231-encodes it into the
 * Content-Disposition header, so a name carrying CRLF cannot forge a header,
 * and rewriting it would silently change data in a message the user sends.
 */
async function fetchPart(session: ImapSession, cfg: Config, ref: PartRef): Promise<ComposedAttachment> {
  return session.withMailbox(ref.folder, async (client) => {
    const part = await resolvePartForDownload(client, ref.uid, ref.partId, cfg.maxAttachmentMb)

    const download = await client.download(String(ref.uid), part.id, { uid: true })
    // a message expunged between the FETCH and this DOWNLOAD yields an object with
    // no stream rather than an error
    if (!download?.content) throw new ToolError('not_found', SOURCE_GONE)

    return {
      filename: partFilename(part.node) ?? 'attachment',
      content: await readAll(download.content, cfg.maxAttachmentMb),
      contentType: download.meta?.contentType ?? part.node.type,
    }
  })
}

/** these bytes are held in memory, so an understating server picks the heap it consumes */
async function readAll(stream: Readable, maxAttachmentMb: number): Promise<Buffer> {
  const limit = capBytes(maxAttachmentMb)
  const chunks: Buffer[] = []
  let seen = 0

  try {
    // `for await` destroys the stream on an early exit, so the cap throw below
    // leaves no backpressure on the connection every later call shares
    for await (const chunk of stream) {
      seen += (chunk as Buffer).length
      if (seen > limit) throw capExceededMidTransfer(maxAttachmentMb)
      chunks.push(chunk as Buffer)
    }
  } catch (err) {
    if (err instanceof ToolError) throw err
    throw new ToolError('server', 'the attachment transfer ended before the part was complete')
  }
  return Buffer.concat(chunks)
}
