import { headerValues } from './headers.js'

// Comments and quoted strings hold sender-chosen text such as the envelope
// address, which may contain `;`, `=` and escaped parentheses, so both go before
// anything is split. Anything left unclosed swallows the rest, which can only hide a result.
function withoutCommentsOrQuotes(value: string): string {
  let depth = 0
  let quoted = false
  let escaped = false
  let out = ''
  for (const ch of value) {
    if (escaped) escaped = false
    else if ((quoted || depth > 0) && ch === '\\') escaped = true
    else if (quoted) quoted = ch !== '"'
    else if (ch === '(') depth += 1
    else if (depth > 0) depth -= ch === ')' ? 1 : 0
    else if (ch === '"') quoted = true
    else out += ch
  }
  return out
}

function isTrusted(id: string, trustedIds: readonly string[]): boolean {
  return trustedIds.some((entry) => (entry.startsWith('.') ? id.endsWith(entry) : id === entry))
}

/**
 * RFC 8601 §5 has a receiving server strip inbound headers carrying its own
 * authserv-id, so only those are the server's word. The first one carrying a
 * DMARC result decides, because the server prepends above anything the sender wrote.
 */
export function trustedDmarcFailed(headerBlock: Buffer, trustedIds: readonly string[]): boolean {
  for (const value of headerValues(headerBlock, 'authentication-results')) {
    const [idPart = '', ...results] = withoutCommentsOrQuotes(value).split(';')
    const id = (idPart.trim().split(/\s+/)[0] ?? '').toLowerCase()
    if (!isTrusted(id, trustedIds)) continue
    for (const result of results) {
      const dmarc = /^\s*dmarc\s*=\s*([a-z]+)/i.exec(result)
      if (dmarc) return dmarc[1].toLowerCase() === 'fail'
    }
  }
  return false
}
