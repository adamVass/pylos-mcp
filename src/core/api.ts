// Every tool reaches the network through this interface and nothing else, which
// is what lets the MCP tests run in process with no server at all.

import type { ParsedAccount } from '../accounts.js'
import type { Config } from '../config.js'
import { ToolError } from '../errors.js'
import type { RenderableEmail, RenderableSummary } from '../safety/render.js'
import { ImapSession } from './client.js'
import { MicrosoftAuth } from './oauth.js'
import { ComposeBudget, createDraft, type DraftArgs, type DraftResult } from './draft.js'
import { listFolders, type FolderSummary } from './folders.js'
import { deleteEmail, moveEmail, refuseTrash, setFlags, type DeleteResult } from './mailbox-ops.js'
import { getAttachment, getEmail, type AttachmentResult } from './message.js'
import { searchEmails, type SearchArgs } from './search.js'
import { getThread, type Thread } from './thread.js'
import { getSieveScript, listSieveScripts, type SieveScript, type SieveScriptEntry } from './sieve.js'
import { SendState, sendEmail, type Confirm, type SendArgs, type SendResult } from './smtp.js'

export interface CoreApi {
  searchEmails(args: SearchArgs): Promise<{ total: number; items: RenderableSummary[] }>
  getEmail(folder: string, uid: number): Promise<RenderableEmail>
  getThread(folder: string, uid: number): Promise<Thread>
  getAttachment(folder: string, uid: number, partId: string): Promise<AttachmentResult>
  listFolders(): Promise<FolderSummary[]>
  createDraft(args: DraftArgs): Promise<DraftResult>
  moveEmail(folder: string, uid: number, destination: string): Promise<void>
  setFlags(folder: string, uid: number, flags: { seen?: boolean; flagged?: boolean }): Promise<void>
  deleteEmail(folder: string, uid: number): Promise<DeleteResult>
  sendEmail(args: SendArgs, confirm?: Confirm): Promise<SendResult>
  listSieveScripts(): Promise<SieveScriptEntry[]>
  getSieveScript(name: string): Promise<SieveScript>
}

export interface Shared {
  sendState: SendState
  composeBudget: ComposeBudget
}

export function makeCoreApi(
  cfg: Config,
  session: ImapSession,
  shared: Shared = { sendState: new SendState(), composeBudget: new ComposeBudget() },
): CoreApi {
  const { sendState, composeBudget } = shared

  return {
    searchEmails: (args) => searchEmails(session, args),
    getEmail: (folder, uid) =>
      getEmail(session, folder, uid, cfg.maxBodyKb, cfg.detect.dmarcFail ? cfg.authservIds : []),
    // a sent reply lives in Sent, and the other side of the conversation usually in INBOX
    getThread: async (folder, uid) =>
      getThread(session, folder, uid, ['INBOX', await session.specialUse('\\Sent', 'Sent')]),
    getAttachment: (folder, uid, partId) => getAttachment(session, cfg, folder, uid, partId),
    listFolders: () => listFolders(session),
    // Unreachable in principle, since a tool that was never registered cannot be
    // called. Gating every optional tier here too is a second lock, holding even
    // if a future change registered a tool without also gating it.
    createDraft: cfg.capabilities.has('drafts') ? (args) => createDraft(session, cfg, args, composeBudget) : notEnabled,
    moveEmail: cfg.capabilities.has('manage')
      ? async (folder, uid, dest) => {
          if (!cfg.capabilities.has('delete')) await refuseTrash(session, dest)
          await moveEmail(session, folder, uid, dest)
        }
      : notEnabled,
    setFlags: cfg.capabilities.has('manage')
      ? (folder, uid, flags) => setFlags(session, folder, uid, flags)
      : notEnabled,
    deleteEmail: cfg.capabilities.has('delete') ? (folder, uid) => deleteEmail(session, folder, uid) : notEnabled,
    sendEmail: cfg.capabilities.has('send')
      ? (args, confirm) => sendEmail(session, cfg, sendState, args, composeBudget, confirm)
      : notEnabled,
    listSieveScripts: cfg.capabilities.has('sieve-read') ? () => listSieveScripts(cfg) : notEnabled,
    getSieveScript: cfg.capabilities.has('sieve-read') ? (name) => getSieveScript(cfg, name) : notEnabled,
  }
}

async function notEnabled(): Promise<never> {
  throw new ToolError('server', 'capability not enabled')
}

export interface Account {
  name?: string
  cfg: Config
  core: CoreApi
}

export function openAccounts(parsed: ParsedAccount[]): { accounts: Account[]; close(): Promise<void> } {
  const shared: Shared = { sendState: new SendState(), composeBudget: new ComposeBudget() }
  const sessions: ImapSession[] = []
  const accounts = parsed.map(({ name, cfg }) => {
    const tokens = cfg.microsoft ? new MicrosoftAuth(cfg.user, cfg.microsoft) : undefined
    const session = new ImapSession(cfg, tokens)
    sessions.push(session)
    return { name, cfg, core: makeCoreApi(cfg, session, shared) }
  })
  return {
    accounts,
    close: async () => {
      await Promise.allSettled(sessions.map((s) => s.close()))
    },
  }
}
