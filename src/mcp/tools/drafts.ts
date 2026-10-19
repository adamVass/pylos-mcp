import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Account } from '../../core/api.js'
import { renderDraftSaved } from '../../safety/render.js'
import { accountField, pick } from '../accounts.js'
import { run } from '../run.js'
import { address, composeFields, MAX_RECIPIENTS, REPLY_NOTE, toComposeArgs } from './bounds.js'

const recipients = {
  to: z.array(address()).max(MAX_RECIPIENTS).optional(),
  cc: z.array(address()).max(MAX_RECIPIENTS).optional(),
}

// not idempotent: a repeat call saves a second draft
const DRAFT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}

const REVIEWED_BY_A_PERSON =
  'The draft is saved, never sent: it waits in the Drafts folder for the account owner to read it, correct the recipients and send it themselves.'

export function registerDraftTools(server: McpServer, accounts: Account[]): void {
  const { draftsNoRecipients } = accounts[0].cfg
  const account = accountField(accounts)
  const schema = z.object({ ...composeFields, ...recipients })
  const handler = (args: z.infer<typeof schema>): Promise<CallToolResult> => {
    const { name, core } = pick(accounts, args)
    return run(async () => {
      const saved = await core.createDraft({ ...toComposeArgs(args), to: args.to, cc: args.cc })
      return renderDraftSaved(saved.folder, saved.uid, saved.recipients, args.in_reply_to)
    }, name)
  }

  // strict turns an unexpected recipient key into a refusal instead of a silent drop
  server.registerTool(
    'create_draft',
    {
      description: draftsNoRecipients
        ? `Save a draft to the Drafts folder. This server is configured to save drafts without recipients: ` +
          `address it in your mail client. ${REVIEWED_BY_A_PERSON} ${REPLY_NOTE}`
        : `Save a draft to the Drafts folder. The result echoes the full recipient list so it can be checked. ` +
          `${REVIEWED_BY_A_PERSON} ${REPLY_NOTE}`,
      inputSchema: draftsNoRecipients
        ? z.object({ ...composeFields, ...account }).strict()
        : { ...composeFields, ...recipients, ...account },
      annotations: DRAFT_ANNOTATIONS,
    },
    handler,
  )
}
