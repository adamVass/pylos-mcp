import { mkdir, open, unlink } from 'node:fs/promises'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FetchMessageObject, ImapFlow, MessageStructureObject } from 'imapflow'
import type { Config } from '../config.js'
import { formatAddress } from './address.js'
import type { ImapSession } from './client.js'
import { MESSAGE_GONE, ToolError } from '../errors.js'
import { sanitizeFilename, uniquePath } from '../safety/filename.js'
import { readLimitBytes } from '../safety/limits.js'
import { formatMb, type RenderableEmail } from '../safety/render.js'
import { makeUntrusted } from '../safety/untrusted.js'

interface MessagePart {
  id: string
  node: MessageStructureObject
}

/** bounds the exclusive-create retry so a pathological directory cannot spin it forever */
const MAX_NAME_ATTEMPTS = 50

export async function getEmail(
  session: ImapSession,
  folder: string,
  uid: number,
  maxBodyKb: number,
): Promise<RenderableEmail> {
  return session.withMailbox(folder, async (client) => {
    const message = await fetchMessage(client, uid)
    const parts = leafParts(message.bodyStructure)
    const bodyPart = chooseBodyPart(parts)

    return {
      folder,
      uid: message.uid,
      date: message.envelope?.date ?? null,
      sizeBytes: message.size ?? 0,
      from: makeUntrusted(formatAddress(message.envelope?.from?.[0])),
      to: makeUntrusted((message.envelope?.to ?? []).map(formatAddress).filter(Boolean).join(', ')),
      subject: makeUntrusted(message.envelope?.subject ?? ''),
      body: makeUntrusted(bodyPart ? await downloadText(client, uid, bodyPart, maxBodyKb) : ''),
      bodyIsHtml: bodyPart?.node.type === 'text/html',
      attachments: parts.filter((part) => part !== bodyPart && isAttachment(part.node)).map(toAttachment),
    }
  })
}

export interface AttachmentResult {
  path: string
  sizeBytes: number
  contentType: string
}

export async function getAttachment(
  session: ImapSession,
  cfg: Config,
  folder: string,
  uid: number,
  partId: string,
): Promise<AttachmentResult> {
  return session.withMailbox(folder, async (client) => {
    const part = await resolvePartForDownload(client, uid, partId, cfg.maxAttachmentMb)

    // an unwritable DOWNLOAD_DIR must fail before the download starts, or the
    // failure is discovered while holding an unread body stream and stalls the
    // shared connection
    await makeDownloadDir(cfg.downloadDir)
    const name = sanitizeFilename(partFilename(part.node) ?? 'attachment')

    const download = await client.download(String(uid), part.id, { uid: true })
    // a message expunged between the FETCH and this DOWNLOAD yields an object with
    // no stream rather than an error
    if (!download?.content) throw new ToolError('not_found', MESSAGE_GONE)

    const written = await writeExclusive(cfg.downloadDir, name, download.content, cfg.maxAttachmentMb)

    return {
      path: written.path,
      sizeBytes: written.sizeBytes,
      contentType: download.meta?.contentType ?? part.node.type,
    }
  })
}

function findPart(parts: MessagePart[], partId: string): MessagePart | undefined {
  return parts.find((part) => part.id === partId)
}

/**
 * The single path from a (uid, partId) reference to fetchable bytes, so the
 * declared-size cap cannot be lost by one caller drifting from the other.
 * `client` must already have the containing mailbox selected.
 */
export async function resolvePartForDownload(
  client: ImapFlow,
  uid: number,
  partId: string,
  maxAttachmentMb: number,
): Promise<MessagePart> {
  const message = await fetchMessage(client, uid)
  const parts = leafParts(message.bodyStructure)
  const part = findPart(parts, partId)
  if (!part) throw unknownPart(parts)

  enforceDeclaredSizeCap(part, maxAttachmentMb)
  return part
}

export function capBytes(maxAttachmentMb: number): number {
  return maxAttachmentMb * 1_000_000
}

export function capExceededMidTransfer(maxAttachmentMb: number): ToolError {
  return new ToolError(
    'cap_exceeded',
    `the part sent more bytes than the server declared and ran past the ${maxAttachmentMb} MB cap, so the transfer was stopped. Raise MAX_ATTACHMENT_MB if the attachment really is that large`,
  )
}

function capCounter(maxAttachmentMb: number): Transform {
  const limit = capBytes(maxAttachmentMb)
  let seen = 0

  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      seen += chunk.length
      if (seen > limit) callback(capExceededMidTransfer(maxAttachmentMb))
      else callback(null, chunk)
    },
  })
}

/**
 * The cap is decided from the size the server DECLARED in BODYSTRUCTURE, before
 * a single byte is requested. A part with no declared size is refused rather
 * than admitted: `size ?? 0` would wave through exactly the server this
 * ordering defends against. The declared size counts octets as transmitted, so
 * a base64 part measures about 4/3 of what lands on disk, and that
 * over-estimate is left alone because erring toward refusing is the safe
 * direction for a cap.
 */
function enforceDeclaredSizeCap(part: MessagePart, maxAttachmentMb: number): void {
  const declaredBytes = part.node.size
  if (declaredBytes === 0) {
    throw new ToolError('cap_exceeded', 'the server declared this part as empty, so there is nothing to download')
  }
  if (declaredBytes === undefined || !Number.isFinite(declaredBytes) || declaredBytes < 0) {
    throw new ToolError(
      'cap_exceeded',
      `the server did not declare a usable size for this part, so the ${maxAttachmentMb} MB cap cannot be checked before fetching it. Nothing was downloaded; save this attachment from your mail client instead`,
    )
  }
  if (declaredBytes <= capBytes(maxAttachmentMb)) return
  throw new ToolError(
    'cap_exceeded',
    `attachment is ${formatMb(declaredBytes)}, cap is ${maxAttachmentMb} MB. Raise MAX_ATTACHMENT_MB if you meant to download it`,
  )
}

async function fetchMessage(client: ImapFlow, uid: number): Promise<FetchMessageObject> {
  const message = await client.fetchOne(
    String(uid),
    { envelope: true, bodyStructure: true, flags: true, size: true },
    { uid: true },
  )
  if (!message) throw new ToolError('not_found', MESSAGE_GONE)
  return message
}

/**
 * Two shapes need care. A singlepart message's root node carries no part id at
 * all, but its body is addressable as "1" (imapflow rewrites that to TEXT). And
 * a forwarded message attached as .eml has childNodes despite being one
 * downloadable file, so `disposition: attachment` ends the descent, without
 * which the .eml disappears from the listing entirely.
 */
function leafParts(root: MessageStructureObject | undefined): MessagePart[] {
  if (!root) return []

  const parts: MessagePart[] = []
  const walk = (node: MessageStructureObject): void => {
    if (node.childNodes && node.childNodes.length > 0 && node.disposition !== 'attachment') {
      for (const child of node.childNodes) walk(child)
      return
    }
    parts.push({ id: node.part ?? '1', node })
  }

  walk(root)
  return parts
}

/**
 * Only an explicit `disposition: attachment` disqualifies a part from being the
 * body. A filename on its own must NOT: Exchange, Zimbra and several ticketing
 * systems send the real message text as
 * `Content-Disposition: inline; filename="message.txt"`.
 */
function chooseBodyPart(parts: MessagePart[]): MessagePart | undefined {
  const displayable = parts.filter((part) => part.node.disposition !== 'attachment')
  return (
    displayable.find((part) => part.node.type === 'text/plain') ??
    displayable.find((part) => part.node.type === 'text/html')
  )
}

function isAttachment(node: MessageStructureObject): boolean {
  return node.disposition === 'attachment' || partFilename(node) !== undefined
}

export function partFilename(node: MessageStructureObject): string | undefined {
  return node.dispositionParameters?.filename ?? node.parameters?.name
}

function toAttachment(part: MessagePart): RenderableEmail['attachments'][number] {
  return {
    partId: part.id,
    filename: makeUntrusted(partFilename(part.node) ?? ''),
    sizeBytes: part.node.size ?? 0,
    contentType: part.node.type,
  }
}

/** a body is meant to be truncated, so `maxBytes` carries none of the silent-corruption risk that rules it out for downloads */
async function downloadText(client: ImapFlow, uid: number, part: MessagePart, maxBodyKb: number): Promise<string> {
  const download = await client.download(String(uid), part.id, {
    uid: true,
    maxBytes: readLimitBytes(maxBodyKb),
  })
  if (!download?.content) throw new ToolError('not_found', MESSAGE_GONE)

  const chunks: Buffer[] = []
  for await (const chunk of download.content) chunks.push(chunk as Buffer)

  return decodeText(Buffer.concat(chunks), download.meta?.charset ?? part.node.parameters?.charset)
}

/**
 * An unrecognized charset label makes the TextDecoder CONSTRUCTOR throw, so the
 * fallback has to wrap construction rather than the decode call.
 */
function decodeText(bytes: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? 'utf-8', { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

async function makeDownloadDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    throw new ToolError('policy', `the download directory could not be created: ${dir}. Check DOWNLOAD_DIR`)
  }
}

/**
 * `uniquePath` picks a free name with an existsSync probe, which says nothing
 * about the moment of the open that follows. Creating with "wx" fails instead
 * of overwriting whatever appeared in between, and the retry asks for the next
 * candidate.
 */
async function writeExclusive(
  dir: string,
  filename: string,
  content: Readable,
  maxAttachmentMb: number,
): Promise<{ path: string; sizeBytes: number }> {
  try {
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
      const candidate = uniquePath(dir, filename)

      let handle
      try {
        handle = await open(candidate, 'wx')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw new ToolError(
          'policy',
          `could not write to the download directory ${dir}. Check DOWNLOAD_DIR and its permissions`,
        )
      }

      const stream = handle.createWriteStream()
      try {
        await pipeline(content, capCounter(maxAttachmentMb), stream)
      } catch (err) {
        // a partial file under the attachment's own name would look like a
        // finished download forever, and uniquePath would step politely around it
        await unlink(candidate).catch(() => undefined)
        if (err instanceof ToolError) throw err
        throw new ToolError('server', 'the attachment transfer ended before the file was complete')
      }

      return { path: candidate, sizeBytes: stream.bytesWritten }
    }

    throw new ToolError('policy', `could not find a free filename for "${filename}" in ${dir}`)
  } catch (err) {
    // an abandoned body stream holds backpressure on the connection every later
    // call shares, so tear it down before the error propagates
    content.destroy()
    throw err
  }
}

/**
 * Part ids are generated by imapflow from its own child counters, never copied
 * from server text, so they are safe to name. The requested id is left out
 * because it arrives as free-form tool input.
 */
function unknownPart(parts: MessagePart[]): ToolError {
  const ids = parts.filter((part) => isAttachment(part.node)).map((part) => part.id)
  return new ToolError(
    'not_found',
    ids.length > 0
      ? `no such part in this message. Valid attachment part ids are: ${ids.join(', ')}`
      : 'no such part in this message. It has no attachments',
  )
}
