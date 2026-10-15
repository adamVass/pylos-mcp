// Sizes are metric, and every kB and MB conversion goes through these two.
export const BYTES_PER_KB = 1000
export const BYTES_PER_MB = 1_000_000

// Read this much past the cap: truncateAtKb has to see more bytes than it
// keeps, or content dropped at exactly the cap would arrive unmarked.
const SLACK_BYTES = 1000

export function readLimitBytes(kb: number): number {
  return kb * BYTES_PER_KB + SLACK_BYTES
}

/** `cutShort` keeps the marker on a source cut before conversion shrank it under the cap */
export function truncateAtKb(s: string, kb: number, cutShort = false): string {
  const limitBytes = kb * BYTES_PER_KB
  const marker = `\n[truncated at ${kb} kB]`
  if (Buffer.byteLength(s) <= limitBytes) return cutShort ? `${s}${marker}` : s

  const sliced = Buffer.from(s, 'utf8').subarray(0, limitBytes)
  // streaming holds back a multi-byte character the cut split, instead of
  // decoding it to U+FFFD that would then have to be trimmed off
  const decoded = new TextDecoder('utf-8').decode(sliced, { stream: true })

  return `${decoded}${marker}`
}
