// Every tool reaches the network through this interface and nothing else, which
// is what lets the MCP tests run in process with no server at all.

import type { Config } from '../config.js'
import { ToolError } from '../errors.js'
import type { RenderableEmail, RenderableSummary } from '../safety/render.js'
import type { UntrustedText } from '../safety/untrusted.js'
import type { ImapSession } from './client.js'
import { createDraft, type DraftArgs, type DraftResult } from './draft.js'
import { listFolders, type FolderSummary } from './folders.js'
import { deleteEmail, moveEmail, setFlags, type DeleteResult } from './mailbox-ops.js'
import { getAttachment, getEmail, type AttachmentResult } from './message.js'
import { searchEmails, type SearchArgs } from './search.js'
import { getSieveScript, listSieveScripts, type SieveScriptEntry } from './sieve.js'
import { SendState, sendEmail, type SendArgs, type SendResult } from './smtp.js'

export interface CoreApi {
  searchEmails(args: SearchArgs): Promise<{ total: number; items: RenderableSummary[] }>
  getEmail(folder: string, uid: number): Promise<RenderableEmail>
  getAttachment(folder: string, uid: number, partId: string): Promise<AttachmentResult>
  listFolders(): Promise<FolderSummary[]>
  createDraft(args: DraftArgs): Promise<DraftResult>
  moveEmail(folder: string, uid: number, destination: string): Promise<void>
  setFlags(folder: string, uid: number, flags: { seen?: boolean; flagged?: boolean }): Promise<void>
  deleteEmail(folder: string, uid: number): Promise<DeleteResult>
  sendEmail(args: SendArgs): Promise<SendResult>
  listSieveScripts(): Promise<SieveScriptEntry[]>
  getSieveScript(name: string): Promise<UntrustedText>
}

export function makeCoreApi(cfg: Config, session: ImapSession): CoreApi {
  const sendState = new SendState()

  return {
    searchEmails: (args) => searchEmails(session, args),
    getEmail: (folder, uid) => getEmail(session, folder, uid, cfg.maxBodyKb),
    getAttachment: (folder, uid, partId) => getAttachment(session, cfg, folder, uid, partId),
    listFolders: () => listFolders(session),
    // Unreachable in principle, since a tool that was never registered cannot be
    // called. Gating every optional tier here too is a second lock, holding even
    // if a future change registered a tool without also gating it.
    createDraft: cfg.capabilities.has('drafts') ? (args) => createDraft(session, cfg, args) : notEnabled,
    moveEmail: cfg.capabilities.has('manage')
      ? (folder, uid, dest) => moveEmail(session, folder, uid, dest)
      : notEnabled,
    setFlags: cfg.capabilities.has('manage')
      ? (folder, uid, flags) => setFlags(session, folder, uid, flags)
      : notEnabled,
    deleteEmail: cfg.capabilities.has('delete') ? (folder, uid) => deleteEmail(session, folder, uid) : notEnabled,
    sendEmail: cfg.capabilities.has('send') ? (args) => sendEmail(session, cfg, sendState, args) : notEnabled,
    listSieveScripts: cfg.capabilities.has('sieve-read') ? () => listSieveScripts(cfg) : notEnabled,
    getSieveScript: cfg.capabilities.has('sieve-read') ? (name) => getSieveScript(cfg, name) : notEnabled,
  }
}

async function notEnabled(): Promise<never> {
  throw new ToolError('server', 'capability not enabled')
}
