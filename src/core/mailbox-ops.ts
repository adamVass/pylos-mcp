import type { ImapFlow } from 'imapflow'
import { MESSAGE_GONE, ToolError } from '../errors.js'
import type { ImapSession } from './client.js'

const MOVE_FAILED = 'move failed. The destination folder may not exist'
const TRASH_NEEDS_DELETE =
  'moving a message to Trash is a delete, and the delete capability is off. Add delete to CAPABILITIES to allow it'
const ALREADY_IN_TRASH =
  'this message is already in Trash. pylos-mcp never erases mail, so removing it from Trash is done in your mail client'
const NO_SAFE_MOVE =
  'this server has no MOVE capability, and pylos-mcp will not emulate one with copy-then-delete: ' +
  'a copy that fails would still delete the source message'

/**
 * IMAP4rev2 folds MOVE in without a separate token (RFC 9051 Appendix E), so
 * both spellings count. The decision has to happen before `messageMove` is ever
 * called, for the reason on `moveEmail`.
 */
function hasMoveCapability(client: ImapFlow): boolean {
  if (client.capabilities.has('MOVE')) return true
  const rev2Active =
    client.enabled.has('IMAP4REV2') || (client.capabilities.has('IMAP4rev2') && !client.capabilities.has('IMAP4rev1'))
  return rev2Active
}

/**
 * A UID-addressed command that matches nothing is not a protocol error: the
 * server answers the same tagged OK it would for a real match, and messageMove
 * and messageFlagsAdd/Remove both resolve truthy either way, so a stale uid
 * would be reported as a success this server never gave. The same fetch also
 * makes this connection aware of a message a different connection just wrote.
 */
async function requireMessage(client: ImapFlow, uid: number): Promise<void> {
  const exists = await client.fetchOne(String(uid), { uid: true }, { uid: true })
  if (!exists) throw new ToolError('not_found', MESSAGE_GONE)
}

/**
 * Success only on the server's own confirmation: imapflow answers a rejected
 * MOVE with `false` rather than throwing, and a thrown error folds into the
 * same outcome.
 *
 * That guarantee depends on never reaching imapflow's own MOVE emulation for a
 * server without the extension: move.js's fallback runs COPY then an
 * UNCONDITIONAL EXPUNGE of the source, even when the COPY failed (copy.js
 * resolves `false` rather than throwing, and the fallback does not check it). A
 * destination that does not exist would therefore delete the source message.
 * `hasMoveCapability` refuses before that path can ever run.
 */
export async function moveEmail(session: ImapSession, folder: string, uid: number, destination: string): Promise<void> {
  const moved = await session.withMailbox(folder, async (client) => {
    if (!hasMoveCapability(client)) throw new ToolError('server', NO_SAFE_MOVE)
    await requireMessage(client, uid)
    try {
      return await client.messageMove(String(uid), destination, { uid: true })
    } catch {
      return false
    }
  })

  if (!moved) throw new ToolError('server', MOVE_FAILED)
}

/**
 * `\Seen` and `\Flagged` are two separate STORE commands, not one atomic
 * operation: if the first succeeds and the second fails, that first change has
 * already reached the server and cannot be undone from here. storeFlag's error
 * names the flag it was changing so the caller can tell which one failed.
 */
export async function setFlags(
  session: ImapSession,
  folder: string,
  uid: number,
  flags: { seen?: boolean; flagged?: boolean },
): Promise<void> {
  await session.withMailbox(folder, async (client) => {
    await requireMessage(client, uid)
    if (flags.seen !== undefined) await storeFlag(client, uid, '\\Seen', flags.seen)
    if (flags.flagged !== undefined) await storeFlag(client, uid, '\\Flagged', flags.flagged)
  })
}

async function storeFlag(client: ImapFlow, uid: number, flag: string, wanted: boolean): Promise<void> {
  let ok: unknown
  try {
    ok = wanted
      ? await client.messageFlagsAdd(String(uid), [flag], { uid: true })
      : await client.messageFlagsRemove(String(uid), [flag], { uid: true })
  } catch {
    ok = false
  }
  if (!ok) {
    const verb = wanted ? 'setting' : 'clearing'
    throw new ToolError('server', `${verb} ${flag} failed on the server`)
  }
}

export interface DeleteResult {
  trashFolder: string
}

/**
 * imapflow prefixes a path lacking the personal namespace, so `Trash` reaches
 * `INBOX.Trash` on servers that nest folders under INBOX. Both sides get the
 * same prefixing here, then case-folding, since some servers match names
 * case-insensitively.
 */
async function sameFolder(session: ImapSession, a: string, b: string): Promise<boolean> {
  return session.withClient(async (client) => {
    // set from the NAMESPACE reply at connect, but missing from imapflow's types
    const prefix = (client as { namespace?: { prefix?: string } }).namespace?.prefix ?? ''
    const full = (path: string) =>
      (path.toUpperCase() === 'INBOX' || path.startsWith(prefix) ? path : prefix + path).toLowerCase()
    return full(a) === full(b)
  })
}

function findTrash(session: ImapSession): Promise<string> {
  return session.specialUse('\\Trash', 'Trash')
}

/** without `delete`, moving to Trash is a delete under another name */
export async function refuseTrash(session: ImapSession, destination: string): Promise<void> {
  if (await sameFolder(session, destination, await findTrash(session))) {
    throw new ToolError('policy', TRASH_NEEDS_DELETE)
  }
}

export async function deleteEmail(session: ImapSession, folder: string, uid: number): Promise<DeleteResult> {
  const trashFolder = await findTrash(session)
  if (await sameFolder(session, folder, trashFolder)) throw new ToolError('policy', ALREADY_IN_TRASH)
  await moveEmail(session, folder, uid, trashFolder)
  return { trashFolder }
}
