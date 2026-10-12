// imapflow cannot fetch one header field partially, so the whole block is capped
// instead: a sender can make References megabytes long, and 64 kB clears the 10
// to 20 kB of ARC, DKIM and relay headers real mail carries ahead of it
const MAX_HEADER_BYTES = 65_536

/** a fetch part for the capped header block, peeked so nothing is marked read */
export const HEADER_PART = { key: 'header', maxLength: MAX_HEADER_BYTES }

export function headerValues(block: Buffer, name: string): string[] {
  const prefix = `${name.toLowerCase()}:`
  const unfolded = new TextDecoder('utf-8', { fatal: false }).decode(block).replace(/\r?\n[ \t]/g, ' ')
  return unfolded
    .split(/\r?\n/)
    .filter((line) => line.slice(0, prefix.length).toLowerCase() === prefix)
    .map((line) => line.slice(prefix.length))
}

// BODY[HEADER] always ends with the blank line, so a block without one was cut by the cap
export function wasCut(block: Buffer): boolean {
  return !/\r?\n\r?\n$/.test(block.subarray(-4).toString('latin1'))
}
