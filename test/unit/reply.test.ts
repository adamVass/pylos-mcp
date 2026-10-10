import { describe, expect, it } from 'vitest'
import { threadHeaders } from '../../src/core/reply.js'
import { ToolError } from '../../src/errors.js'

/** a header block as BODY.PEEK[HEADER] returns it, ending with its blank line */
const block = (...lines: string[]): Buffer => Buffer.from(`${lines.join('\r\n')}\r\n\r\n`)

const ORIGINAL = '<orig@x.example>'

function thread(headerBlock: Buffer, inReplyTo?: string, messageId: string | null = ORIGINAL) {
  const lead = [
    messageId === null ? '' : `Message-ID: ${messageId}\r\n`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}\r\n` : '',
  ]
  return threadHeaders(Buffer.concat([Buffer.from(lead.join('')), headerBlock]))
}

describe('threadHeaders', () => {
  it('answers the original and appends it to its References, unfolded and in order', () => {
    const headers = block('Subject: s', 'References: <a@x>\r\n <b@x>', 'X-Other: y', 'references: <c@x>')
    expect(thread(headers)).toEqual({ inReplyTo: ORIGINAL, references: ['<a@x>', '<b@x>', '<c@x>', ORIGINAL] })
  })

  it('reads adjacent ids as two and ignores text outside the brackets, comments included', () => {
    expect(thread(block('References: <a@x><b@x> (a comment) junk')).references).toEqual(['<a@x>', '<b@x>', ORIGINAL])
    expect(thread(block('Subject: s'), undefined, '<orig@x.example> (sent by a robot)').inReplyTo).toBe(ORIGINAL)
  })

  it('falls back to every In-Reply-To id when there are no References', () => {
    expect(thread(block('Subject: s'), '<p@x> <q@x>').references).toEqual(['<p@x>', '<q@x>', ORIGINAL])
  })

  it('a block without References or In-Reply-To starts the chain at the original', () => {
    expect(thread(block('Subject: s'))).toEqual({ inReplyTo: ORIGINAL, references: [ORIGINAL] })
  })

  // an empty block counts as cut, so the chain falls back to In-Reply-To
  it('an empty header block still threads through In-Reply-To', () => {
    expect(thread(Buffer.alloc(0), '<p@x>').references).toEqual(['<p@x>', ORIGINAL])
  })

  it('drops malformed, non-ASCII, line-breaking and overlong ids', () => {
    const long = `<${'a'.repeat(245)}@x.example>`
    const headers = block(`References: <no-at-sign> <ok@x> <ü@x.example> <bad\u0085@x> ${long}`)
    expect(thread(headers).references).toEqual(['<ok@x>', ORIGINAL])
  })

  it('keeps the original last even when References already carries it', () => {
    expect(thread(block(`References: ${ORIGINAL} <a@x>`)).references).toEqual(['<a@x>', ORIGINAL])
  })

  it('caps a long chain at the root plus the latest nineteen', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `<id${i}@x>`)
    const references = thread(block(`References: ${ids.join(' ')}`)).references
    expect(references).toHaveLength(20)
    expect(references[0]).toBe('<id0@x>')
    expect(references.slice(1, 19)).toEqual(ids.slice(12))
    expect(references[19]).toBe(ORIGINAL)
  })

  // the cap cut the newest end of the chain, which In-Reply-To still names
  it('a cut header block keeps the root and the In-Reply-To ids, never a half id', () => {
    const cut = Buffer.from('X-Pad: aaaa\r\nReferences: <root@x> <mid@x> <half@exa')
    expect(thread(cut, '<parent@x>').references).toEqual(['<root@x>', '<parent@x>', ORIGINAL])
  })

  it.each([
    ['no Message-ID', null],
    ['a malformed Message-ID', 'orig-without-brackets'],
    ['a Message-ID with a line break', '<orig\r\n@x.example>'],
    ['a non-ASCII Message-ID', '<oríg@x.example>'],
  ])('refuses to thread a message with %s', (_name, messageId) => {
    const run = () => thread(block('Subject: s'), undefined, messageId)
    expect(run).toThrow(ToolError)
    expect(run).toThrow(
      'the message to reply to has no usable Message-ID, so a reply could not be threaded. Nothing was saved or sent',
    )
  })

  it('refuses a block whose only Message-ID comes after the cut', () => {
    const cut = Buffer.from('X-Pad: aaaa\r\nMessage-ID: <orig@x.exa')
    expect(() => threadHeaders(cut)).toThrow(
      'the message to reply to has no usable Message-ID, so a reply could not be threaded. Nothing was saved or sent',
    )
  })
})
