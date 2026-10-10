import type { MessageStructureObject } from 'imapflow'
import { describe, expect, it } from 'vitest'
import { chooseBodyPart, htmlTwin, isHtmlDocument, isListed, leafParts } from '../../src/core/parts.js'

type Node = MessageStructureObject
const leaf = (part: string, type: string, extra: Partial<Node> = {}): Node => ({ part, type, ...extra }) as Node
const multi = (part: string | undefined, type: string, childNodes: Node[]): Node => ({ part, type, childNodes }) as Node
const pdf = (part: string) =>
  leaf(part, 'application/pdf', { disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' } })

function pick(root: Node) {
  const parts = leafParts(root)
  const body = chooseBodyPart(parts)
  return { parts, body, listed: parts.filter((p) => isListed(p, body)).map((p) => p.id) }
}

describe('choosing the body and listing the rest', () => {
  it('takes the plain alternative, hides its html twin, and lists the attachment', () => {
    const root = multi(undefined, 'multipart/mixed', [
      multi('1', 'multipart/alternative', [leaf('1.1', 'text/plain'), leaf('1.2', 'text/html')]),
      pdf('2'),
    ])
    const { parts, body, listed } = pick(root)
    expect(body?.id).toBe('1.1')
    expect(listed).toEqual(['2'])
    expect(htmlTwin(body!, parts)?.id).toBe('1.2')
  })

  // Apple Mail splits a body around an inline image, so B is real text the body does not show
  it('in a root alternative, a second text part in the body branch is listed and the html twin is not', () => {
    const root = multi(undefined, 'multipart/alternative', [
      multi('1', 'multipart/mixed', [
        leaf('1.1', 'text/plain'),
        leaf('1.2', 'image/png', { disposition: 'inline', dispositionParameters: { filename: 'x.png' } }),
        leaf('1.3', 'text/plain'),
      ]),
      leaf('2', 'text/html'),
    ])
    const { body, listed } = pick(root)
    expect(body?.id).toBe('1.1')
    expect(listed).toEqual(['1.2', '1.3'])
  })

  it('an html part inside related is still the twin of the plain alternative', () => {
    const root = multi(undefined, 'multipart/alternative', [
      leaf('1', 'text/plain'),
      multi('2', 'multipart/related', [leaf('2.1', 'text/html'), leaf('2.2', 'image/png', { disposition: 'inline' })]),
    ])
    expect(pick(root).listed).toEqual([])
  })

  it('a forwarded message is listed once, whole, and its text is never the body', () => {
    // imapflow walks the encapsulated message under the wrapper's own id
    const root = multi(undefined, 'multipart/mixed', [
      leaf('1', 'text/html'),
      multi('2', 'message/rfc822', [leaf('2', 'text/plain')]),
    ])
    const { parts, body, listed } = pick(root)
    expect(body?.id).toBe('1')
    expect(listed).toEqual(['2'])
    expect(parts.filter((p) => p.id === '2')).toHaveLength(1)
    expect(parts.find((p) => p.id === '2')?.node.type).toBe('message/rfc822')
  })

  it('the text parts of a multipart forward stay inside its .eml, named or not', () => {
    const root = multi(undefined, 'multipart/mixed', [
      leaf('1', 'text/plain'),
      multi('2', 'message/rfc822', [
        multi('2', 'multipart/mixed', [
          multi('2.1', 'multipart/alternative', [leaf('2.1.1', 'text/plain'), leaf('2.1.2', 'text/html')]),
          leaf('2.2', 'text/plain', { disposition: 'inline', dispositionParameters: { filename: 'notes.txt' } }),
          pdf('2.3'),
        ]),
      ]),
    ])
    expect(pick(root).listed).toEqual(['2', '2.3'])
  })

  it('named text and html attachments in the html branch are listed, the unnamed inline html is not', () => {
    const attached = (part: string, type: string, filename: string) =>
      leaf(part, type, { disposition: 'attachment', dispositionParameters: { filename } })
    const root = multi(undefined, 'multipart/alternative', [
      leaf('1', 'text/plain'),
      multi('2', 'multipart/mixed', [
        leaf('2.1', 'text/html'),
        attached('2.2', 'text/plain', 'notes.txt'),
        pdf('2.3'),
        attached('2.4', 'text/html', 'page.html'),
        leaf('2.5', 'text/html'),
      ]),
    ])
    expect(pick(root).listed).toEqual(['2.2', '2.3', '2.4'])
  })

  it('a watch-html rendering is hidden like the other renderings', () => {
    const root = multi(undefined, 'multipart/alternative', [
      leaf('1', 'text/plain'),
      leaf('2', 'text/watch-html'),
      leaf('3', 'text/html'),
    ])
    expect(pick(root).listed).toEqual([])
  })

  it('an html twin that carries a filename is still not listed', () => {
    const root = multi(undefined, 'multipart/alternative', [
      leaf('1', 'text/plain'),
      leaf('2', 'text/html', { disposition: 'inline', dispositionParameters: { filename: 'message.html' } }),
    ])
    expect(pick(root).listed).toEqual([])
  })
})

describe('isHtmlDocument', () => {
  it.each([
    ['a doctype document', '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN">\n<html><body>hi</body></html>', false],
    ['an html tag after blank lines', '\n\n  <html lang="en"><body>hi</body></HTML>', false],
    [
      'an XHTML document with an XML prolog',
      '<?xml version="1.0"?>\n<!DOCTYPE html>\n<html><body>hi</body></html>',
      false,
    ],
    ['a document cut before its closing tag', '<html><body>' + 'x'.repeat(50), true],
  ])('treats %s as HTML', (_name, text, cutShort) => {
    expect(isHtmlDocument(text, cutShort)).toBe(true)
  })

  it.each([
    ['prose that starts with the tag', '<html> is the root element. Use <head> for metadata and <body> for content.'],
    ['a custom element', '<html-widget>hello</html-widget> and </html>'],
    ['a tag that is not first', 'Hello <html><body>x</body></html>'],
  ])('leaves %s as plain text', (_name, text) => {
    expect(isHtmlDocument(text, false)).toBe(false)
  })
})
