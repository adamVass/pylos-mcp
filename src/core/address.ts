import type { MessageAddressObject } from 'imapflow'

export function formatAddress(address: MessageAddressObject | undefined): string {
  if (!address) return ''
  if (address.name && address.address) return `${address.name} <${address.address}>`
  return address.address ?? address.name ?? ''
}
