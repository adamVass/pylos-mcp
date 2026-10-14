import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Config } from '../../config.js'
import type { CoreApi } from '../../core/api.js'
import { renderDraftSaved } from '../../safety/render.js'
import { run } from '../run.js'
import { address, attachments, MAX_RECIPIENTS, quoteOriginal, REPLY_NOTE, replyRef, toPartRefs } from './bounds.js'

const base = {
  subject: z.string(),
  body: z.string(),
  attachments,
  in_reply_to: replyRef.optional(),
  quote_original: quoteOriginal,
}

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

export function registerDraftTools(server: McpServer, cfg: Config, core: CoreApi): void {
  const schema = z.object({ ...base, ...recipients })
  const handler = (args: z.infer<typeof schema>): Promise<CallToolResult> =>
    run(async () => {
      const saved = await core.createDraft({
        subject: args.subject,
        body: args.body,
        to: args.to,
        cc: args.cc,
        attachments: toPartRefs(args.attachments),
        inReplyTo: args.in_reply_to,
        quoteOriginal: args.quote_original,
      })
      return renderDraftSaved(saved.folder, saved.uid, saved.recipients, args.in_reply_to)
    })

  // strict turns an unexpected recipient key into a refusal instead of a silent drop
  server.registerTool(
    'create_draft',
    {
      description: cfg.draftsNoRecipients
        ? `Save a draft to the Drafts folder. This server is configured to save drafts without recipients: ` +
          `address it in your mail client. ${REVIEWED_BY_A_PERSON} ${REPLY_NOTE}`
        : `Save a draft to the Drafts folder. The result echoes the full recipient list so it can be checked. ` +
          `${REVIEWED_BY_A_PERSON} ${REPLY_NOTE}`,
      inputSchema: cfg.draftsNoRecipients ? z.object(base).strict() : { ...base, ...recipients },
      annotations: DRAFT_ANNOTATIONS,
    },
    handler,
  )
}
