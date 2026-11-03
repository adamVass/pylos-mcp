// The demo replaces only the mailbox. Fencing and every detector run on its
// messages unchanged, and nothing here can open a connection.

import { loadConfig } from '../config.js'
import { formatAddress } from '../core/address.js'
import type { Account, CoreApi } from '../core/api.js'
import { trustedDmarcFailed } from '../core/auth-results.js'
import type { SearchArgs } from '../core/search.js'
import { MESSAGE_GONE, ToolError } from '../errors.js'
import type { RenderableEmail, RenderableSummary } from '../safety/render.js'
import { makeUntrusted } from '../safety/untrusted.js'
import { DEMO_AUTHSERV_ID, DEMO_FOLDERS, DEMO_MAILBOX, DEMO_USER, type DemoMessage } from './mailbox.js'

const HOUR_MS = 3_600_000
const NO_ATTACHMENTS = 'the demo mailbox has no attachments'

export function openDemo(): { accounts: Account[]; close(): Promise<void> } {
  // the user's environment is never read, so no setting can point the demo at a real mailbox
  const cfg = loadConfig({
    EMAIL_USER: DEMO_USER,
    EMAIL_PASSWORD: 'demo',
    IMAP_HOST: 'demo.invalid',
    AUTHSERV_ID: DEMO_AUTHSERV_ID,
  })
  const startedAt = Date.now()
  const messages = DEMO_MAILBOX.map((m) => ({ ...m }))
  const received = (m: DemoMessage) => new Date(startedAt - m.hoursAgo * HOUR_MS)

  const find = (folder: string, uid: number): DemoMessage => {
    const message = messages.find((m) => m.folder === folder && m.uid === uid)
    if (!message) throw new ToolError('not_found', MESSAGE_GONE)
    return message
  }

  const summary = (m: DemoMessage): RenderableSummary => ({
    folder: m.folder,
    uid: m.uid,
    date: received(m),
    sizeBytes: Buffer.byteLength(m.body),
    from: makeUntrusted(formatAddress(m.from)),
    subject: makeUntrusted(m.subject),
    seen: m.seen === true,
    flagged: m.flagged === true,
  })

  const email = (m: DemoMessage): RenderableEmail => {
    const date = received(m)
    return {
      folder: m.folder,
      uid: m.uid,
      sent: new Date(date.getTime() - 60_000),
      received: date,
      sizeBytes: Buffer.byteLength(m.body),
      from: makeUntrusted(formatAddress(m.from)),
      fromName: makeUntrusted(m.from.name),
      fromAddress: makeUntrusted(m.from.address),
      replyTo: m.replyTo ? [makeUntrusted(m.replyTo)] : [],
      replyToAddresses: m.replyTo ? [makeUntrusted(m.replyTo)] : [],
      to: makeUntrusted(m.to),
      cc: makeUntrusted(''),
      subject: makeUntrusted(m.subject),
      body: makeUntrusted(m.body),
      bodyCutShort: false,
      bodyIsHtml: m.html === true,
      attachments: [],
      dmarcFailed:
        cfg.detect.dmarcFail && m.headers !== undefined && trustedDmarcFailed(Buffer.from(m.headers), cfg.authservIds),
    }
  }

  const core: CoreApi = {
    async searchEmails(args) {
      const folder = args.folder ?? 'INBOX'
      if (!DEMO_FOLDERS.some((f) => f.path === folder)) throw new ToolError('not_found', 'no folder with that name')
      const matches = messages
        .filter((m) => m.folder === folder && matchesSearch(m, args, received(m)))
        .sort((a, b) => b.uid - a.uid)
      return { total: matches.length, items: matches.slice(args.offset, args.offset + args.limit).map(summary) }
    },
    async getEmail(folder, uid) {
      return email(find(folder, uid))
    },
    async getThread(folder, uid) {
      const seed = find(folder, uid)
      const members = seed.thread === undefined ? [seed] : messages.filter((m) => m.thread === seed.thread)
      const items = members.sort((a, b) => received(a).getTime() - received(b).getTime()).map(summary)
      return { items, omitted: 0, capped: false }
    },
    async getAttachment() {
      throw new ToolError('not_found', NO_ATTACHMENTS)
    },
    async listFolders() {
      return DEMO_FOLDERS.map((f) => ({ ...f, messages: messages.filter((m) => m.folder === f.path).length }))
    },
    async createDraft(args) {
      if (args.attachments?.length) throw new ToolError('not_found', NO_ATTACHMENTS)
      if (args.inReplyTo) find(args.inReplyTo.folder, args.inReplyTo.uid)
      const recipients = [...(args.to ?? []), ...(args.cc ?? [])]
      const uid = messages.filter((m) => m.folder === 'Drafts').length + 1
      messages.push({
        folder: 'Drafts',
        uid,
        hoursAgo: (startedAt - Date.now()) / HOUR_MS,
        from: { name: 'Sam Rivera', address: DEMO_USER },
        to: recipients.join(', '),
        subject: args.subject,
        body: args.body,
        seen: true,
      })
      return { folder: 'Drafts', uid, recipients }
    },
    moveEmail: notInDemo,
    setFlags: notInDemo,
    deleteEmail: notInDemo,
    sendEmail: notInDemo,
    listSieveScripts: notInDemo,
    getSieveScript: notInDemo,
  }

  console.error('pylos-mcp: demo mode, serving a sample mailbox. Account settings are ignored.')
  return { accounts: [{ cfg, core }], close: async () => {} }
}

function matchesSearch(m: DemoMessage, args: SearchArgs, date: Date): boolean {
  const has = (field: string, needle?: string) =>
    needle === undefined || field.toLowerCase().includes(needle.toLowerCase())
  const sender = formatAddress(m.from)
  return (
    has(`${sender} ${m.to} ${m.subject} ${m.body}`, args.query) &&
    has(sender, args.from) &&
    has(m.to, args.to) &&
    has(m.subject, args.subject) &&
    (args.since === undefined || date >= args.since) &&
    (args.before === undefined || date < args.before) &&
    (!args.unreadOnly || m.seen !== true) &&
    (!args.flaggedOnly || m.flagged === true)
  )
}

async function notInDemo(): Promise<never> {
  throw new ToolError('server', 'capability not enabled')
}
