// The bounds and shared schemas of the tool boundary, in one file so a limit
// cannot quietly apply to one tool and not another: a cap on send_email that
// create_draft does not have is a cap with a way around it.

import { z } from 'zod'
import type { PartRef } from '../../core/draft.js'

/** every attachment is fetched into memory to be composed, so the count is bounded */
export const MAX_ATTACHMENTS = 10

/**
 * Recipients per call, to and cc each. An unbounded list is a one-call mass
 * mailing if a model is ever talked into building one. SEND_ALLOWLIST and
 * SEND_SESSION_CAP still apply on top.
 */
export const MAX_RECIPIENTS = 50

export const MAX_SEARCH_RESULTS = 100
export const DEFAULT_SEARCH_RESULTS = 20

/** a sieve script name is a label the account owner typed, never a document */
export const MAX_SIEVE_NAME_CHARS = 512

// The schemas are the validation boundary: core is entitled to assume a folder
// is non-empty and a uid is a positive integer because nothing else can arrive.
export const folder = z.string().min(1)
export const uid = z.number().int().positive()

// `.email()` is doing security work, not validation politeness: it keeps a
// carriage return out of an address and therefore out of the envelope and the
// headers built from it.
//
// A factory rather than a shared instance, because the SDK's JSON Schema
// conversion deduplicates by identity: one instance used twice makes the second
// occurrence a `$ref` into the first, and a client that does not resolve internal
// references then sees `cc` with no `format: "email"` on it at all.
export const address = (): z.ZodString => z.string().email()

export const attachment = z.object({
  folder,
  uid,
  part_id: z.string().min(1),
})

export type AttachmentRef = z.infer<typeof attachment>

export function toPartRefs(refs: AttachmentRef[] | undefined): PartRef[] | undefined {
  return refs?.map((ref) => ({ folder: ref.folder, uid: ref.uid, partId: ref.part_id }))
}
