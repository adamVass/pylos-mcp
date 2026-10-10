import { ToolError } from '../errors.js'
import type { ImapSession } from './client.js'

export interface ReplyRef {
  folder: string
  uid: number
}

export interface ReplyHeaders {
  inReplyTo: string
  references: string[]
}

// imapflow cannot fetch one header field partially, so the whole block is capped
// instead: a sender can make References megabytes long, and 64 kB clears the 10
// to 20 kB of ARC, DKIM and relay headers real mail carries ahead of it
export const MAX_HEADER_BYTES = 65_536

// RFC 5322 §3.6.4 lets a long chain drop its middle, so the root and the latest stay
const MAX_REFERENCES = 20
const MAX_ID_CHARS = 250

const ORIGINAL_GONE = 'the message to reply to was not found. It may have been moved or deleted'
const NO_MESSAGE_ID =
  'the message to reply to has no usable Message-ID, so a reply could not be threaded. Nothing was saved or sent'

const ID_TOKEN = /<[^<>]*>/g
// printable ASCII only: nodemailer negotiates SMTPUTF8 from envelope addresses
// alone, so a raw UTF-8 id would reach an ASCII-only relay unannounced. The
// first class leaves out @ so a token full of them is rejected in linear time
const MESSAGE_ID = /^<[\x21-\x3B\x3D\x3F\x41-\x7E]*@[\x21-\x3B\x3D\x3F-\x7E]*>$/

function validIds(value: string): string[] {
  return (value.match(ID_TOKEN) ?? []).filter((id) => id.length <= MAX_ID_CHARS && MESSAGE_ID.test(id))
}

function headerValue(block: Buffer, name: string): string {
  const prefix = `${name}:`
  const unfolded = new TextDecoder('utf-8', { fatal: false }).decode(block).replace(/\r?\n[ \t]/g, ' ')
  return unfolded
    .split(/\r?\n/)
    .filter((line) => line.slice(0, prefix.length).toLowerCase() === prefix)
    .map((line) => line.slice(prefix.length))
    .join(' ')
}

// BODY[HEADER] always ends with the blank line, so a block without one was cut by the cap
function wasCut(block: Buffer): boolean {
  return !/\r?\n\r?\n$/.test(block.subarray(-4).toString('latin1'))
}

export function threadHeaders(headerBlock: Buffer): ReplyHeaders {
  const messageId = validIds(headerValue(headerBlock, 'message-id'))[0]
  if (messageId === undefined) throw new ToolError('policy', NO_MESSAGE_ID)

  const references = validIds(headerValue(headerBlock, 'references'))
  const inReplyTo = validIds(headerValue(headerBlock, 'in-reply-to'))
  // a cut lost the newest end of the chain, which In-Reply-To still names
  const parents = wasCut(headerBlock)
    ? [...references.slice(0, 1), ...inReplyTo]
    : references.length > 0
      ? references
      : inReplyTo

  const chain = [...new Set(parents.filter((id) => id !== messageId)), messageId]
  return {
    inReplyTo: messageId,
    references: chain.length <= MAX_REFERENCES ? chain : [chain[0], ...chain.slice(-(MAX_REFERENCES - 1))],
  }
}

export async function readReplyHeaders(session: ImapSession, ref: ReplyRef): Promise<ReplyHeaders> {
  // BODY.PEEK, so reading the original never marks it read
  const original = await session.withMailbox(ref.folder, (client) =>
    client.fetchOne(String(ref.uid), { bodyParts: [{ key: 'header', maxLength: MAX_HEADER_BYTES }] }, { uid: true }),
  )
  if (!original) throw new ToolError('not_found', ORIGINAL_GONE)

  return threadHeaders(original.headers ?? Buffer.alloc(0))
}
