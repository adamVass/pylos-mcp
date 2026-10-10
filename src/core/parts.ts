import type { MessageStructureObject } from 'imapflow'

export interface MessagePart {
  id: string
  node: MessageStructureObject
  /** one entry per multipart/alternative ancestor, naming the child this part sits under */
  branches: { alternative: string; index: number }[]
  /** below a message/rfc822, so a forwarded message's text is never taken for this one's */
  insideMessage: boolean
}

/**
 * Three shapes need care. A singlepart message's root carries no part id, but
 * its body is addressable as "1" (imapflow rewrites that to TEXT). A forwarded
 * .eml marked as an attachment has childNodes, so that disposition ends the
 * descent. And imapflow walks an encapsulated message under its wrapper's own
 * id, so the first node with an id wins and the wrapper is listed whole.
 */
export function leafParts(root: MessageStructureObject | undefined): MessagePart[] {
  if (!root) return []

  const parts: MessagePart[] = []
  const ids = new Set<string>()
  const add = (node: MessageStructureObject, branches: MessagePart['branches'], insideMessage: boolean): void => {
    const id = node.part ?? '1'
    if (ids.has(id)) return
    ids.add(id)
    parts.push({ id, node, branches, insideMessage })
  }

  const walk = (node: MessageStructureObject, branches: MessagePart['branches'], insideMessage: boolean): void => {
    if (!node.childNodes || node.childNodes.length === 0 || node.disposition === 'attachment') {
      add(node, branches, insideMessage)
      return
    }
    const forwarded = node.type === 'message/rfc822'
    if (forwarded) add(node, branches, insideMessage)
    node.childNodes.forEach((child, index) => {
      const next =
        node.type === 'multipart/alternative' ? [...branches, { alternative: node.part ?? 'root', index }] : branches
      walk(child, next, insideMessage || forwarded)
    })
  }

  walk(root, [], false)
  return parts
}

/**
 * Only an explicit `disposition: attachment` disqualifies a part from being the
 * body. A filename on its own must NOT: Exchange, Zimbra and several ticketing
 * systems send the real message text as
 * `Content-Disposition: inline; filename="message.txt"`.
 */
function displayable(part: MessagePart): boolean {
  return part.node.disposition !== 'attachment' && !part.insideMessage
}

export function chooseBodyPart(parts: MessagePart[]): MessagePart | undefined {
  const candidates = parts.filter(displayable)
  return (
    candidates.find((part) => part.node.type === 'text/plain') ??
    candidates.find((part) => part.node.type === 'text/html')
  )
}

// an attachment is never another rendering, only inline text in a sibling branch is
const RENDERINGS = new Set(['text/plain', 'text/html', 'text/watch-html', 'text/x-amp-html'])

// in different branches of one alternative, so each is the other's rendering
function areTwins(a: MessagePart, b: MessagePart): boolean {
  const indexIn = new Map(b.branches.map((y) => [y.alternative, y.index]))
  return a.branches.some((x) => {
    const index = indexIn.get(x.alternative)
    return index !== undefined && index !== x.index
  })
}

export function htmlTwin(body: MessagePart, parts: MessagePart[]): MessagePart | undefined {
  return parts.find((part) => part.node.type === 'text/html' && displayable(part) && areTwins(part, body))
}

function isAttachment(node: MessageStructureObject): boolean {
  return node.disposition === 'attachment' || partFilename(node) !== undefined
}

export function partFilename(node: MessageStructureObject): string | undefined {
  return node.dispositionParameters?.filename ?? node.parameters?.name
}

export function downloadName(node: MessageStructureObject): string {
  return partFilename(node) ?? (node.type === 'message/rfc822' ? 'message.eml' : 'attachment')
}

/**
 * The one rule behind both the listing and the part ids an unknown-part error
 * names. The exclusions come before the filename check, because a name alone
 * makes a part an attachment, and a named html twin or a forward's named text
 * is still covered by the body or by the .eml.
 */
export function isListed(part: MessagePart, body: MessagePart | undefined): boolean {
  if (part === body) return false
  const { type, disposition } = part.node
  if (type === 'message/rfc822') return true
  const inlineText = type.startsWith('text/') && disposition !== 'attachment'
  if (part.insideMessage) return isAttachment(part.node) && !inlineText
  const otherRendering = body !== undefined && inlineText && RENDERINGS.has(type) && areTwins(part, body)
  if (otherRendering) return false
  return isAttachment(part.node) || inlineText
}

const HTML_START = /^(?:<\?xml[^>]*>\s*)?<(?:!doctype\s+html|html)[\s>]/i
const HTML_END = /<\/html>/i

/**
 * A client renders such a body as a page, so the detectors must see it as one.
 * A cut body has lost its closing tag, and padding past MAX_BODY_KB must not be
 * a way around inspection.
 */
export function isHtmlDocument(text: string, cutShort: boolean): boolean {
  return HTML_START.test(text.trimStart()) && (cutShort || HTML_END.test(text))
}
