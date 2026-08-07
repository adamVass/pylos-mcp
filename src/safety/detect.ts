// Suspicion detectors. Everything here annotates what a message contains and
// never decides whether to return it. Every note is built from this module's own
// labels and counts: quoting the content that tripped a detector would hand the
// warning line itself to the attacker.
import type { AnyNode, Element } from 'domhandler'
import { DomUtils, parseDocument } from 'htmlparser2'
import { stripInvisible } from './html.js'

export interface ContentFlag {
  detector: 'hidden_text' | 'instruction_patterns' | 'encoded_blob'
  note: string
}

export interface DetectOptions {
  hiddenText: boolean
  instructionPatterns: boolean
  encodedBlobs: boolean
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

/** the `hiddenText` toggle is the caller's to check, not this function's */
export function inspectHtml(html: string, opts: DetectOptions): HtmlInspection {
  const doc = parseDocument(html)
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

function matchedPatterns(text: string, extraPatterns: readonly string[]): number {
  const haystack = text.toLowerCase()
  return [...BUILTIN_PATTERNS, ...extraPatterns].filter((p) => haystack.includes(p)).length
}

function qualifyingRun(text: string): { chars: number; hex: boolean } | null {
  const run = longestRun(text)
  return run.chars >= (run.hex ? HEX_MIN : BASE64_MIN) ? run : null
}

export function detectText(text: string, opts: DetectOptions): ContentFlag[] {
  const flags: ContentFlag[] = []

  if (opts.instructionPatterns) {
    const matched = matchedPatterns(text, opts.extraPatterns)
    if (matched > 0) {
      flags.push({
        detector: 'instruction_patterns',
        note: `${matched} instruction-like phrase${matched === 1 ? '' : 's'} matched`,
      })
    }
  }

  if (opts.encodedBlobs) {
    const run = qualifyingRun(text)
    if (run !== null) {
      flags.push({ detector: 'encoded_blob', note: `${run.hex ? 'hex' : 'base64'} run of ${run.chars} characters` })
    }
  }

  return flags
}
