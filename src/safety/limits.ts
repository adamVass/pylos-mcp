// Sizes are metric: 1 kB = 1000 bytes.

// Read this much past the cap: truncateAtKb has to see more bytes than it
// keeps, or content dropped at exactly the cap would arrive unmarked.
const SLACK_BYTES = 1000

export function readLimitBytes(kb: number): number {
  return kb * 1000 + SLACK_BYTES
}

export function truncateAtKb(s: string, kb: number): string {
  const limitBytes = kb * 1000
  if (Buffer.byteLength(s) <= limitBytes) return s

  const sliced = Buffer.from(s, 'utf8').subarray(0, limitBytes)
  // a non-fatal decode replaces a trailing partial multi-byte char with U+FFFD
  // rather than throwing, so those come off the tail
  const decoded = new TextDecoder('utf-8').decode(sliced).replace(/�+$/, '')

  return `${decoded}\n[truncated at ${kb} kB]`
}
