import type { MessageAddressObject } from 'imapflow'

export function formatAddress(address: MessageAddressObject | undefined): string {
  if (!address) return ''
  if (address.name && address.address) return `${address.name} <${address.address}>`
  return address.address ?? address.name ?? ''
}

export function checkAllowlist(recipients: string[], allowlist: string[]): string[] {
  return recipients.filter((recipient) => !isAllowed(recipient.toLowerCase(), allowlist))
}

/** the shapes isAllowed can match, checked at startup so no entry silently matches nobody */
export function isAllowlistEntry(entry: string): boolean {
  return entry === '*' || /^(\*|[^\s*]+)@[^\s@*]+$/.test(entry)
}

/**
 * `*` alone is the config token that visibly turns the safeguard off.
 * `*@domain` compares the part after the LAST `@` for exact equality, not a
 * suffix: `corp.example` must not admit `subcorp.example`, and a quoted local
 * part may legally contain an `@`, so `"a@corp.example"@evil.example` is an
 * evil.example address.
 */
function isAllowed(recipient: string, allowlist: string[]): boolean {
  const at = recipient.lastIndexOf('@')
  const domain = at === -1 ? null : recipient.slice(at + 1)

  return allowlist.some((entry) => {
    const pattern = entry.toLowerCase()
    if (pattern === '*') return true
    if (!pattern.startsWith('*@')) return pattern === recipient
    return domain !== null && domain === pattern.slice(2)
  })
}
