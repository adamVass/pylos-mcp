import { execFile } from 'node:child_process'
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
import { makeUntrusted, type UntrustedText } from '../safety/untrusted.js'
import {
  chooseBodyPart,
  downloadName,
  htmlTwin,
  isHtmlDocument,
  isListed,
  leafParts,
  partFilename,
  type MessagePart,
} from './parts.js'

interface BodyText {
  text: string
  cutShort: boolean
}

const NO_BODY: BodyText = { text: '', cutShort: false }

function untrustedList(values: string[]): UntrustedText[] {
  return values.filter(Boolean).map((value) => makeUntrusted(value))
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
    // the listing keys off this structural choice, as unknownPart does, so the two never disagree
    const structuralBody = chooseBodyPart(parts)
    let bodyPart = structuralBody
    let body = bodyPart ? await downloadText(client, uid, bodyPart, maxBodyKb) : NO_BODY
    // some senders ship an empty plain alternative and put the message in the html one
    const twin = bodyPart?.node.type === 'text/plain' && body.text.trim() === '' ? htmlTwin(bodyPart, parts) : undefined
    if (twin) {
      bodyPart = twin
      body = await downloadText(client, uid, twin, maxBodyKb)
    }
    const replyTo = message.envelope?.replyTo ?? []

    return {
      folder,
      uid: message.uid,
      sent: message.envelope?.date ?? null,
      received: message.internalDate ?? null,
      sizeBytes: message.size ?? 0,
      from: makeUntrusted(formatAddress(message.envelope?.from?.[0])),
      fromName: makeUntrusted(message.envelope?.from?.[0]?.name ?? ''),
      fromAddress: makeUntrusted(message.envelope?.from?.[0]?.address ?? ''),
      replyTo: untrustedList(replyTo.map(formatAddress)),
      replyToAddresses: untrustedList(replyTo.map((entry) => entry.address ?? '')),
      to: makeUntrusted((message.envelope?.to ?? []).map(formatAddress).filter(Boolean).join(', ')),
      cc: makeUntrusted((message.envelope?.cc ?? []).map(formatAddress).filter(Boolean).join(', ')),
      subject: makeUntrusted(message.envelope?.subject ?? ''),
      body: makeUntrusted(body.text),
      bodyCutShort: body.cutShort,
      bodyIsHtml:
        bodyPart?.node.type === 'text/html' ||
        (bodyPart?.node.type === 'text/plain' && isHtmlDocument(body.text, body.cutShort)),
      attachments: parts.filter((part) => isListed(part, structuralBody)).map(toAttachment),
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
    const name = sanitizeFilename(downloadName(part.node))

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
    `the attachment's encoded size is ${formatMb(declaredBytes)}, cap is ${maxAttachmentMb} MB. Raise MAX_ATTACHMENT_MB if you meant to download it`,
  )
}

async function fetchMessage(client: ImapFlow, uid: number): Promise<FetchMessageObject> {
  const message = await client.fetchOne(
    String(uid),
    { envelope: true, bodyStructure: true, flags: true, size: true, internalDate: true },
    { uid: true },
  )
  if (!message) throw new ToolError('not_found', MESSAGE_GONE)
  return message
}

function toAttachment(part: MessagePart): RenderableEmail['attachments'][number] {
  return {
    partId: part.id,
    filename: makeUntrusted(partFilename(part.node) ?? ''),
    sizeBytes: part.node.size ?? 0,
    contentType: part.node.type,
    encoding: part.node.encoding,
  }
}

/**
 * A body is meant to be truncated, so `maxBytes` carries none of the
 * silent-corruption risk that rules it out for downloads. The cut is reported
 * because conversion and stripping can shrink a cut body back under the cap,
 * and the one byte past the limit tells a cut body from one ending exactly there.
 */
async function downloadText(client: ImapFlow, uid: number, part: MessagePart, maxBodyKb: number): Promise<BodyText> {
  const limit = readLimitBytes(maxBodyKb)
  const download = await client.download(String(uid), part.id, { uid: true, maxBytes: limit + 1 })
  if (!download?.content) throw new ToolError('not_found', MESSAGE_GONE)

  const chunks: Buffer[] = []
  for await (const chunk of download.content) chunks.push(chunk as Buffer)

  const bytes = Buffer.concat(chunks)
  const cutShort = bytes.length > limit
  return {
    text: decodeText(
      cutShort ? bytes.subarray(0, limit) : bytes,
      download.meta?.charset ?? part.node.parameters?.charset,
    ),
    cutShort,
  }
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

const XATTR_TIMEOUT_MS = 5_000

// Mail and browsers flag every download, so a saved .app would otherwise skip Gatekeeper. No shell, so the path is never interpreted.
function quarantine(path: string): Promise<void> {
  const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};pylos-mcp;`
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, path], { timeout: XATTR_TIMEOUT_MS }, (err) =>
      err ? reject(err) : resolve(),
    )
  })
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
        handle = await open(candidate, 'wx', 0o600)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw new ToolError(
          'policy',
          `could not write to the download directory ${dir}. Check DOWNLOAD_DIR and its permissions`,
        )
      }

      // before the first byte, so no unflagged copy of the file ever exists
      if (process.platform === 'darwin') {
        try {
          await quarantine(candidate)
        } catch {
          await handle.close().catch(() => undefined)
          await unlink(candidate).catch(() => undefined)
          throw new ToolError(
            'policy',
            'the attachment was not saved because macOS could not mark it as downloaded, which is what makes Gatekeeper check it before it opens',
          )
        }
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
  const body = chooseBodyPart(parts)
  const ids = parts.filter((part) => isListed(part, body)).map((part) => part.id)
  return new ToolError(
    'not_found',
    ids.length > 0
      ? `no such part in this message. Valid attachment part ids are: ${ids.join(', ')}`
      : 'no such part in this message. It has no attachments',
  )
}
