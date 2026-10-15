// Text for people, never the model: the SEND_CONFIRM dialog the account owner
// reads, and the quoted original that recipients read. So nothing here goes
// through render.ts's sanitize. The dialog spells invisible characters out, and
// the quote keeps them, since both audiences see exactly what is sent.
import type { DetectOptions } from './detect.js'
import { inspectHtml } from './detect.js'
import { htmlToPlainText } from './html.js'
import { INVISIBLE_CLASS } from './invisible.js'
import { line, listedSize, type MessageRef, presentLine } from './render.js'
import { readUntrusted, type UntrustedText } from './untrusted.js'

export interface ProposedAttachment {
  filename: string
  declaredBytes?: number
  encoding?: string
  folder: string
  uid: number
}

export interface QuoteSource {
  from: UntrustedText
  /** the Date header, which the sender wrote */
  sent: Date | string | null
  body: UntrustedText
  bodyIsHtml: boolean
}

/** the attribution line and the `> ` quoted body, appended below a reply by core */
export function renderQuote(q: QuoteSource, detect: DetectOptions): string {
  const raw = readUntrusted(q.body)
  // Hidden text is dropped for fidelity, since conversion would make it visible.
  // No stripInvisible: people read this, and ZWNJ, ZWJ and variation selectors are real text.
  const text = q.bodyIsHtml ? htmlToPlainText(inspectHtml(raw, { ...detect, stripHiddenText: true }).html) : raw
  const lines = text
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n')
    .trimEnd()
    .split('\n')
    .map((l) => (l === '' ? '>' : `> ${l}`))
  const sent = q.sent === null ? null : new Date(q.sent)
  const date = sent && !Number.isNaN(sent.getTime()) ? sent.toUTCString() : 'an unknown date'
  const from = presentLine(q.from) || 'the sender'
  return [`On ${date}, ${from} wrote:`, ...lines].join('\n')
}

/** everything the account owner is shown before a send under SEND_CONFIRM */
export interface SendProposal {
  from: string
  to: string[]
  cc: string[]
  subject: string
  body: string
  attachments: ProposedAttachment[]
  inReplyTo?: MessageRef
  quotedFrom?: MessageRef
}

// Shown to the account owner, not the model, so invisible and direction-changing
// characters are spelled out rather than stripped: they are still in what gets sent.
const SPELLED_OUT = new RegExp(`[${INVISIBLE_CLASS}\\p{Cc}\\p{Cf}\\u2028\\u2029]`, 'gu')

function visible(s: string, keepLineBreaks = false): string {
  return s.replace(SPELLED_OUT, (c) =>
    keepLineBreaks && (c === '\n' || c === '\t')
      ? c
      : `[U+${c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}]`,
  )
}

/**
 * Every line the server writes comes before the body, so nothing in the body can
 * pose as a closing note from the server.
 */
export function renderConfirmation(p: SendProposal): string {
  const lookalikes = [...p.to, ...p.cc].filter((a) => /(^|\.)xn--/i.test(a.split('@')[1] ?? ''))
  const lines = [
    'Send this email? It goes out only if you accept, and cannot be recalled.',
    p.quotedFrom
      ? `The assistant wrote the recipients, subject and message below. The quoted original at the end was added by this server from ${line(p.quotedFrom.folder)} uid ${p.quotedFrom.uid}. Read all of it before accepting.`
      : 'The assistant wrote the recipients, subject and message below. Read all of it before accepting.',
    '',
    `From: ${p.from}`,
    `To: ${p.to.map((a) => visible(a)).join(', ')}`,
    ...(p.cc.length > 0 ? [`Cc: ${p.cc.map((a) => visible(a)).join(', ')}`] : []),
    `Subject: ${visible(p.subject)}`,
    ...p.attachments.map(
      (a) =>
        `Attachment: ${visible(a.filename)}, ${a.declaredBytes === undefined ? 'unknown size' : listedSize({ sizeBytes: a.declaredBytes, encoding: a.encoding })}, from ${line(a.folder)} uid ${a.uid}`,
    ),
    ...(p.inReplyTo ? [`In reply to: ${line(p.inReplyTo.folder)} uid ${p.inReplyTo.uid}`] : []),
    ...lookalikes.map((a) => `Note: ${visible(a)} has an internationalized domain, which can imitate a familiar one.`),
    '',
    '----- message -----',
    visible(p.body, true),
  ]
  return lines.join('\n')
}
