// Suspicion detectors. Everything here annotates what a message contains and
// never decides whether to return it. Every note is built from this module's own
// labels and counts: quoting the content that tripped a detector would hand the
// warning line itself to the attacker.
import type { AnyNode, Element, ParentNode } from 'domhandler'
import { DomUtils, parseDocument } from 'htmlparser2'
import { DEPTH_OMITTED, MAX_HTML_DEPTH, stripInvisible } from './html.js'

export interface ContentFlag {
  detector: 'hidden_text' | 'instruction_patterns' | 'encoded_blob' | 'sender_mismatch' | 'mixed_script'
  note: string
}

export interface DetectOptions {
  hiddenText: boolean
  instructionPatterns: boolean
  encodedBlobs: boolean
  senderMismatch: boolean
  mixedScript: boolean
  stripHiddenText: boolean
  extraPatterns: string[] // lowercased literal phrases
}

interface HtmlInspection {
  flag?: ContentFlag
  strippedHtml?: string
}

type Mechanism = 'display:none' | 'visibility:hidden' | 'tiny font' | 'matching colors' | 'off-screen' | 'aria-hidden'

/**
 * A tripwire for the mechanical hiding tricks, deliberately not a rendering
 * engine: inline styles and attributes only, no stylesheet cascade. Literal
 * comparison for the color pair is part of that stance, so `#fff` versus
 * `#ffffff` stays unflagged rather than teaching this module CSS color math.
 */
function hiddenBy(el: Element): Mechanism | null {
  // htmlparser2 lowercases attribute NAMES but not their values
  if (el.attribs['aria-hidden']?.toLowerCase() === 'true') return 'aria-hidden'
  const style = el.attribs.style
  if (style === undefined) return null

  // `!important` rides along inside the declaration value and is near universal
  // in real email HTML. Left in place it makes every value below compare unequal,
  // so `display:none !important` would hide from the detector aimed at it.
  const decls = new Map<string, string>()
  for (const decl of style.toLowerCase().split(';')) {
    const colon = decl.indexOf(':')
    if (colon === -1) continue
    const value = decl
      .slice(colon + 1)
      .trim()
      .replace(/\s*!important$/i, '')
    decls.set(decl.slice(0, colon).trim(), value)
  }

  if (decls.get('display') === 'none') return 'display:none'
  if (decls.get('visibility') === 'hidden') return 'visibility:hidden'

  // The alternation is what admits `.5px`, a form CSS allows and mail uses.
  // It also keeps the empty string out, which `\d*` alone would let through.
  const fontSize = decls.get('font-size')
  if (fontSize !== undefined && /^(\d+|\d*\.\d+)(px|pt)?$/.test(fontSize) && Number.parseFloat(fontSize) <= 1) {
    return 'tiny font'
  }

  const color = decls.get('color')
  if (color !== undefined && color === decls.get('background-color')) return 'matching colors'

  if (offScreen(decls.get('text-indent'))) return 'off-screen'
  if (decls.get('position') === 'absolute' && (offScreen(decls.get('left')) || offScreen(decls.get('top')))) {
    return 'off-screen'
  }
  return null
}

// Real layout indents and positions in the tens of pixels. A value this far
// negative parks the text outside the viewport, which is the trick, not a style.
const OFF_SCREEN_PX = -999

function offScreen(value: string | undefined): boolean {
  if (value === undefined) return false
  const n = Number.parseFloat(value)
  return !Number.isNaN(n) && n <= OFF_SCREEN_PX
}

// Newsletters hide their preview text with `display:none` as a matter of course,
// so a detector with no floor warns on most legitimate mail. 100 clears typical
// preview text, which runs 35 to 90 characters.
const HIDDEN_TEXT_FLOOR = 100

// Iterative, so pruning a hostile document cannot itself overflow the stack.
function capDepth(root: ParentNode): void {
  const pending: [ParentNode, number][] = [[root, 0]]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [parent, depth] = next
    for (const child of parent.children) {
      if (!DomUtils.hasChildren(child)) continue
      if (depth + 1 < MAX_HTML_DEPTH) {
        pending.push([child, depth + 1])
        continue
      }
      for (const grandchild of [...child.children]) DomUtils.removeElement(grandchild)
      DomUtils.appendChild(child, parseDocument(DEPTH_OMITTED).children[0])
    }
  }
}

/** the `hiddenText` toggle is the caller's to check, not this function's */
export function inspectHtml(html: string, opts: DetectOptions): HtmlInspection {
  const doc = parseDocument(html)
  capDepth(doc)
  const mechanisms = new Set<Mechanism>()
  const hidden: Element[] = []
  const texts: string[] = []
  let hiddenChars = 0

  const walk = (nodes: AnyNode[]): void => {
    for (const node of nodes) {
      if (!DomUtils.isTag(node)) continue
      const mechanism = hiddenBy(node)
      if (mechanism === null) {
        walk(node.children)
        continue
      }
      // invisible characters come out before the count so zero-width padding
      // cannot carry a preheader over the floor
      const text = stripInvisible(DomUtils.textContent(node))
      const chars = text.replace(/\s+/g, ' ').trim().length
      // empty hidden elements (spacers, tracking scaffolding) are routine in mail
      if (chars === 0) continue
      mechanisms.add(mechanism)
      hiddenChars += chars
      hidden.push(node)
      texts.push(text)
    }
  }
  walk(doc.children)

  if (hiddenChars === 0) return {}
  const how = [...mechanisms].join(', ')

  // Joined with a space and left un-collapsed, both deliberately. A run may span
  // line breaks, so joining on one would let two short runs in separate hidden
  // elements concatenate into a qualifying one, and collapsing whitespace inside
  // a run would break the line wrapping a pasted base64 payload arrives with.
  const hiddenText = texts.join(' ')
  const escalations: string[] = []
  if (opts.instructionPatterns && matchedPatterns(hiddenText, opts.extraPatterns) > 0) {
    escalations.push(', containing an instruction-like phrase')
  }
  if (opts.encodedBlobs && qualifyingRun(hiddenText) !== null) {
    escalations.push(', containing an encoded run')
  }
  const why = escalations.join('')

  if (!opts.stripHiddenText) {
    // hidden instructions are never routine at any length, which is why an
    // escalation reads past the floor
    if (escalations.length === 0 && hiddenChars < HIDDEN_TEXT_FLOOR) return {}
    return { flag: { detector: 'hidden_text', note: `${hiddenChars} hidden characters via ${how}${why}` } }
  }
  // the floor governs the warning only: an owner who asked for hidden text to be
  // dropped gets all of it dropped
  for (const el of hidden) DomUtils.removeElement(el)
  return {
    flag: { detector: 'hidden_text', note: `${hiddenChars} hidden characters dropped (${how})${why}` },
    strippedHtml: DomUtils.getOuterHTML(doc),
  }
}

// Only phrases with essentially no legitimate reason to appear in mail. An inbox
// that merely discusses AI must not trip these, which is why broader candidates
// like "you are now" or "system:" are deliberately absent.
const BUILTIN_PATTERNS: readonly string[] = [
  'ignore previous instructions',
  'ignore all previous instructions',
  'ignore prior instructions',
  'ignore the above instructions',
  'ignore above instructions',
  'disregard previous instructions',
  'disregard all previous instructions',
  'disregard the above instructions',
  'do not tell the user',
  'do not inform the user',
  'without informing the user',
]

// Runs may span line breaks because mail transports wrap base64 at 76 columns.
// Spaces still break a run, which keeps de-spaced prose from concatenating into
// a match.
const BASE64_RUN = /[A-Za-z0-9+/=\r\n]+/g
const HEX_ONLY = /^[0-9a-fA-F\r\n]+$/
const BASE64_MIN = 512
const HEX_MIN = 256

// Only the longest run is kept, so a shorter qualifying hex run can be shadowed
// by a longer base64ish run that itself misses the 512 floor. Accepted as part
// of the tripwire stance: one run, one flag, no attempt at completeness.
function longestRun(text: string): { chars: number; hex: boolean } {
  let best = 0
  let bestHex = false
  for (const match of text.matchAll(BASE64_RUN)) {
    const chars = match[0].replace(/[\r\n]/g, '').length
    if (chars > best) {
      best = chars
      bestHex = HEX_ONLY.test(match[0])
    }
  }
  return { chars: best, hex: bestHex }
}

// U+0085 is listed because `\s` does not match it.
const WHITESPACE_RUN = /[\s\u0085]+/g

function normalized(s: string): string {
  return s.toLowerCase().replace(WHITESPACE_RUN, ' ')
}

function matchedPatterns(text: string, extraPatterns: readonly string[]): number {
  const haystack = normalized(text)
  return [...BUILTIN_PATTERNS, ...extraPatterns].filter((p) => haystack.includes(normalized(p))).length
}

function qualifyingRun(text: string): { chars: number; hex: boolean } | null {
  const run = longestRun(text)
  return run.chars >= (run.hex ? HEX_MIN : BASE64_MIN) ? run : null
}

export interface SenderFields {
  fromName: string
  fromAddress: string
  replyTo: string[]
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@')
  if (at === -1) return ''
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase()
}

// A dot-suffix either way is the same domain, so mail.acme.com stays quiet
// against acme.com without a public-suffix list. The dot carries that rule:
// without it, evilacme.com would pass as acme.com too.
function sameDomain(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

function foreignTo(domain: string, from: string): boolean {
  return domain !== '' && !sameDomain(domain, from)
}

// Address-shaped only: a bare domain-shaped token would flag names like
// "Node.js Weekly".
const ADDRESS_IN_NAME = /[^\s@<>]+@[^\s@<>]+/g

/**
 * The Sender header is deliberately not consulted, because it diverges from
 * From on every mailing list.
 */
export function detectSender(fields: SenderFields, opts: DetectOptions): ContentFlag | undefined {
  if (!opts.senderMismatch) return undefined

  const from = domainOf(fields.fromAddress)
  if (from === '') return undefined

  const notes: string[] = []
  if (fields.replyTo.some((address) => foreignTo(domainOf(address), from))) {
    notes.push('Reply-To domain differs from From')
  }
  if ((fields.fromName.match(ADDRESS_IN_NAME) ?? []).some((token) => foreignTo(domainOf(token), from))) {
    notes.push('display name carries an address on another domain')
  }

  return notes.length > 0 ? { detector: 'sender_mismatch', note: notes.join(', ') } : undefined
}

// Chrome's per-word IDN spoof rule (UTS #39 Latin lookalikes), so μm and WiFiроутер stay quiet.
const LOOKALIKES = new Set([
  // Cyrillic lowercase: а е о р с у х ѕ і ј һ ԁ ԛ ԝ
  ...'\u0430\u0435\u043e\u0440\u0441\u0443\u0445\u0455\u0456\u0458\u04bb\u0501\u051b\u051d',
  // Cyrillic uppercase: А В Е К М Н О Р С Т Х І Ј Ѕ
  ...'\u0410\u0412\u0415\u041a\u041c\u041d\u041e\u0420\u0421\u0422\u0425\u0406\u0408\u0405',
  // Greek lowercase: ο ν ρ ϲ
  ...'\u03bf\u03bd\u03c1\u03f2',
  // Greek uppercase: Α Β Ε Ζ Η Ι Κ Μ Ν Ο Ρ Τ Υ Χ
  ...'\u0391\u0392\u0395\u0396\u0397\u0399\u039a\u039c\u039d\u039f\u03a1\u03a4\u03a5\u03a7',
])
const WORD = /[\p{L}\p{M}]+/gu
const LATIN = /\p{Script=Latin}/u
const CYRILLIC_OR_GREEK = /[\p{Script=Cyrillic}\p{Script=Greek}]/u

function spoofedWords(text: string): number {
  let count = 0
  for (const [word] of text.matchAll(WORD)) {
    const letters = [...word]
    const foreign = letters.filter((c) => CYRILLIC_OR_GREEK.test(c))
    if (foreign.length > 0 && foreign.every((c) => LOOKALIKES.has(c)) && letters.some((c) => LATIN.test(c))) {
      count += 1
    }
  }
  return count
}

export type RegionName = 'From' | 'subject' | 'body' | 'attachment names'

export interface TextRegion {
  name: RegionName
  text: string
}

export function detectText(regions: TextRegion[], opts: DetectOptions): ContentFlag[] {
  const flags: ContentFlag[] = []

  if (opts.instructionPatterns) {
    let matched = 0
    const where: RegionName[] = []
    for (const region of regions) {
      const n = matchedPatterns(region.text, opts.extraPatterns)
      if (n === 0) continue
      matched += n
      where.push(region.name)
    }
    if (matched > 0) {
      flags.push({
        detector: 'instruction_patterns',
        note: `${matched} instruction-like phrase${matched === 1 ? '' : 's'} matched in ${where.join(', ')}`,
      })
    }
  }

  if (opts.mixedScript) {
    let words = 0
    const where: RegionName[] = []
    for (const region of regions) {
      const n = spoofedWords(region.text)
      if (n === 0) continue
      words += n
      where.push(region.name)
    }
    if (words > 0) {
      flags.push({
        detector: 'mixed_script',
        note: `${words} word${words === 1 ? '' : 's'} mixing Latin with lookalike Cyrillic or Greek letters in ${where.join(', ')}`,
      })
    }
  }

  // the README promises this one for the body alone
  const body = regions.find((r) => r.name === 'body')
  if (opts.encodedBlobs && body !== undefined) {
    const run = qualifyingRun(body.text)
    if (run !== null) {
      flags.push({ detector: 'encoded_blob', note: `${run.hex ? 'hex' : 'base64'} run of ${run.chars} characters` })
    }
  }

  return flags
}
