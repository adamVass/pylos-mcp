import { ToolError } from '../errors.js'
import type { ImapSession } from './client.js'
import { HEADER_PART, headerValues, wasCut } from './headers.js'

export interface ReplyRef {
  folder: string
  uid: number
}

interface ReplyHeaders {
  inReplyTo: string
  references: string[]
}

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

export function threadHeaders(headerBlock: Buffer): ReplyHeaders {
  const messageId = validIds(headerValues(headerBlock, 'message-id').join(' '))[0]
  if (messageId === undefined) throw new ToolError('policy', NO_MESSAGE_ID)

  const references = validIds(headerValues(headerBlock, 'references').join(' '))
  const inReplyTo = validIds(headerValues(headerBlock, 'in-reply-to').join(' '))
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
    client.fetchOne(String(ref.uid), { bodyParts: [HEADER_PART] }, { uid: true }),
  )
  if (!original) throw new ToolError('not_found', ORIGINAL_GONE)

  return threadHeaders(original.headers ?? Buffer.alloc(0))
}
