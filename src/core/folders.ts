import type { ImapSession } from './client.js'

export interface FolderSummary {
  path: string
  specialUse?: string
  messages?: number
}

export async function listFolders(session: ImapSession): Promise<FolderSummary[]> {
  return session.withClient(async (client) => {
    const mailboxes = await client.list({ statusQuery: { messages: true } })
    return mailboxes.map((mailbox) => ({
      path: mailbox.path,
      specialUse: mailbox.specialUse,
      messages: mailbox.status?.messages,
    }))
  })
}
