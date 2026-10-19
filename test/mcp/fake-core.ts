import type { CoreApi } from '../../src/core/api.js'
import { makeUntrusted } from '../../src/safety/untrusted.js'
import { renderableEmail } from '../unit/helpers.js'

export const summary = () => ({
  folder: 'INBOX',
  uid: 7,
  date: new Date('2026-08-05T10:00:00Z'),
  sizeBytes: 4200,
  from: makeUntrusted('Alice <alice@x.example>'),
  subject: makeUntrusted('Quarterly report'),
  seen: false,
  flagged: true,
})

export const email = () =>
  renderableEmail({
    to: makeUntrusted('tester@example.com'),
    subject: makeUntrusted('Quarterly report'),
    body: makeUntrusted('Body text here'),
  })

export type Calls = Record<string, unknown[]>

export function fakeCore(calls: Calls): CoreApi {
  return {
    async searchEmails(args) {
      calls.searchEmails = [args]
      return { total: 3, items: [summary()] }
    },
    async getEmail(folder, uid) {
      calls.getEmail = [folder, uid]
      return email()
    },
    async getThread(folder, uid) {
      calls.getThread = [folder, uid]
      return { items: [summary()], omitted: 0, capped: false }
    },
    async getAttachment(folder, uid, partId) {
      calls.getAttachment = [folder, uid, partId]
      return { path: '/home/tester/Downloads/report.pdf', sizeBytes: 1_234_567, contentType: 'application/pdf' }
    },
    async listFolders() {
      calls.listFolders = []
      return [{ path: 'INBOX', specialUse: '\\Inbox', messages: 12 }, { path: 'Archive' }]
    },
    async createDraft(args) {
      calls.createDraft = [args]
      return { folder: 'Drafts', uid: 42, recipients: [...(args.to ?? []), ...(args.cc ?? [])] }
    },
    async moveEmail(folder, uid, destination) {
      calls.moveEmail = [folder, uid, destination]
    },
    async setFlags(folder, uid, flags) {
      calls.setFlags = [folder, uid, flags]
    },
    async deleteEmail(folder, uid) {
      calls.deleteEmail = [folder, uid]
      return { trashFolder: 'Trash' }
    },
    async sendEmail(args) {
      calls.sendEmail = [args]
      // `off`, since a saved copy would append a clause to every send result
      // asserted against this fake
      return {
        accepted: [...args.to, ...(args.cc ?? [])],
        rejected: [],
        sent: 2,
        copy: { status: 'off' },
        reply: args.inReplyTo && { ref: args.inReplyTo, answered: true },
      }
    },
    async listSieveScripts() {
      calls.listSieveScripts = []
      return [
        { name: makeUntrusted('filters'), active: true },
        { name: makeUntrusted('holiday'), active: false },
      ]
    },
    async getSieveScript(name) {
      calls.getSieveScript = [name]
      return {
        content: makeUntrusted('require "fileinto";\nif header :contains "subject" "spam" { fileinto "Trash"; }'),
        cutShort: false,
      }
    },
  }
}
