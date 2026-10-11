import type { FetchMessageObject, SearchObject } from 'imapflow'
import { ToolError } from '../errors.js'
import type { RenderableSummary } from '../safety/render.js'
import type { ImapSession } from './client.js'
import { HEADER_PART } from './headers.js'
import { threadHeaders } from './reply.js'
import { SUMMARY_QUERY, toSummary } from './search.js'

export const MAX_THREAD_MESSAGES = 50
// a sender can copy a thread's ids into any mail, so each folder's matches are capped before fetching
const MAX_MATCHES_PER_FOLDER = 200

const SEED_GONE = 'no message with that uid in the folder. It may have been moved or deleted'

export interface Thread {
  /** oldest first */
  items: RenderableSummary[]
  /** older members left out by the limit */
  omitted: number
  /** a folder had more matches than were fetched, so the total is a lower bound */
  capped: boolean
}

interface Member {
  summary: RenderableSummary
  messageId?: string
}

export async function getThread(
  session: ImapSession,
  folder: string,
  uid: number,
  otherFolders: readonly string[],
  limit = MAX_THREAD_MESSAGES,
  maxMatches = MAX_MATCHES_PER_FOLDER,
): Promise<Thread> {
  const seed = await session.withMailbox(folder, (client) =>
    client.fetchOne(String(uid), { ...SUMMARY_QUERY, bodyParts: [HEADER_PART] }, { uid: true }),
  )
  if (!seed) throw new ToolError('not_found', SEED_GONE)
  const chain = idChain(seed)
  if (chain.length === 0) return { items: [toSummary(folder, seed)], omitted: 0, capped: false }

  // the seed and then the asked folder go first, so theirs is the copy kept, and a
  // search the server rejects (imapflow answers `false`) still leaves the seed listed
  const members: Member[] = [{ summary: toSummary(folder, seed), messageId: seed.envelope?.messageId || undefined }]
  let capped = false
  for (const each of [folder, ...otherFolders.filter((other) => other !== folder)]) {
    const found = await membersIn(session, each, chain, maxMatches).catch((err: unknown) => {
      if (each !== folder && err instanceof ToolError && err.code === 'not_found') return { members: [], capped: false }
      throw err
    })
    members.push(...found.members)
    capped ||= found.capped
  }

  const seen = new Set<string>()
  const unique = members.filter(({ messageId }) => {
    if (messageId === undefined) return true
    if (seen.has(messageId)) return false
    seen.add(messageId)
    return true
  })
  const ordered = unique.map((member) => member.summary).sort((a, b) => timeOf(a.date) - timeOf(b.date))
  const omitted = Math.max(0, ordered.length - limit)
  return { items: ordered.slice(omitted), omitted, capped }
}

/** the seed's ancestors and its own id, validated as for a reply, or none when it has no usable Message-ID */
function idChain(seed: FetchMessageObject): string[] {
  try {
    return threadHeaders(seed.headers ?? Buffer.alloc(0)).references
  } catch {
    return []
  }
}

async function membersIn(
  session: ImapSession,
  folder: string,
  chain: string[],
  maxMatches: number,
): Promise<{ members: Member[]; capped: boolean }> {
  return session.withMailbox(folder, async (client) => {
    const uids = (await client.search({ or: criteria(chain) }, { uid: true })) || []
    const newest = [...uids].sort((a, b) => b - a).slice(0, maxMatches)
    const members: Member[] = []
    if (newest.length > 0) {
      for await (const message of client.fetch(newest.join(','), SUMMARY_QUERY, { uid: true })) {
        members.push({ summary: toSummary(folder, message), messageId: message.envelope?.messageId || undefined })
      }
    }
    return { members, capped: uids.length > newest.length }
  })
}

// In-Reply-To catches replies whose client dropped References, and the root in
// References catches the rest of the conversation below the seed
function criteria(chain: string[]): SearchObject[] {
  const header = (name: string, value: string): SearchObject => ({ header: { [name]: value } })
  return [
    ...chain.flatMap((id) => [header('message-id', id), header('in-reply-to', id)]),
    header('references', chain[0]),
  ]
}

function timeOf(date: Date | string | null): number {
  return date === null ? 0 : new Date(date).getTime() || 0
}
