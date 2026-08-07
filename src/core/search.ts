import type { ImapFlow, FetchMessageObject, SearchObject } from 'imapflow'
import type { ImapSession } from './client.js'
import type { RenderableSummary } from '../safety/render.js'
import { makeUntrusted } from '../safety/untrusted.js'
import { formatAddress } from './address.js'

export interface SearchArgs {
  folder?: string
  query?: string
  from?: string
  to?: string
  subject?: string
  since?: Date
  before?: Date
  unreadOnly?: boolean
  limit: number
  offset: number
}

export async function searchEmails(
  session: ImapSession,
  args: SearchArgs,
): Promise<{ total: number; items: RenderableSummary[] }> {
  const folder = args.folder ?? 'INBOX'

  return session.withMailbox(folder, async (client) => {
    // imapflow answers a search the server rejected with `false` rather than
    // throwing, so an unusable filter surfaces as "no matches"
    const uids = (await client.search(criteria(args), { uid: true })) || []

    // The server returns matches in ascending UID order, so slicing first and
    // calling the result "newest" hands back the OLDEST messages.
    const page = [...uids].sort((a, b) => b - a).slice(args.offset, args.offset + args.limit)

    return { total: uids.length, items: page.length > 0 ? await summarize(client, folder, page) : [] }
  })
}

/**
 * A key present with an `undefined` value is not the same as an absent key:
 * imapflow compiles `seen: undefined` into UNSEEN, and an object whose only keys
 * are undefined into a criteria-less UID SEARCH the server rejects.
 */
function criteria(args: SearchArgs): SearchObject {
  const search: SearchObject = {}
  if (args.query) search.text = args.query
  if (args.from) search.from = args.from
  if (args.to) search.to = args.to
  if (args.subject) search.subject = args.subject
  if (args.since) search.since = args.since
  if (args.before) search.before = args.before
  if (args.unreadOnly) search.seen = false
  return search
}

async function summarize(client: ImapFlow, folder: string, uids: number[]): Promise<RenderableSummary[]> {
  const byUid = new Map<number, FetchMessageObject>()
  // metadata only, no BODY[] part, so nothing here marks a message \Seen
  for await (const message of client.fetch(
    uids.join(','),
    { envelope: true, flags: true, size: true },
    { uid: true },
  )) {
    byUid.set(message.uid, message)
  }

  // The server answers a FETCH in ascending order whatever order the set was sent
  // in, so the page order is re-imposed here. A message expunged between the
  // search and the fetch is simply absent.
  return uids.flatMap((uid) => {
    const message = byUid.get(uid)
    return message ? [toSummary(folder, message)] : []
  })
}

function toSummary(folder: string, message: FetchMessageObject): RenderableSummary {
  return {
    folder,
    uid: message.uid,
    date: message.envelope?.date ?? null,
    sizeBytes: message.size ?? 0,
    from: makeUntrusted(formatAddress(message.envelope?.from?.[0])),
    subject: makeUntrusted(message.envelope?.subject ?? ''),
    seen: message.flags?.has('\\Seen') ?? false,
    flagged: message.flags?.has('\\Flagged') ?? false,
  }
}
