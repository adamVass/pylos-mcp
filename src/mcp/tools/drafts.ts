import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Config } from '../../config.js'
import type { CoreApi } from '../../core/api.js'
import { renderDraftSaved } from '../../safety/render.js'
import { run } from '../run.js'
import {
  address,
  attachment,
  type AttachmentRef,
  MAX_ATTACHMENTS,
  MAX_RECIPIENTS,
  REPLY_NOTE,
  type ReplyRefInput,
  replyRef,
  toPartRefs,
} from './bounds.js'

const base = {
  subject: z.string(),
  body: z.string(),
  attachments: z
    .array(attachment)
    .max(MAX_ATTACHMENTS)
    .optional()
    .describe('Attachments are taken from messages already in the mailbox, by folder, uid and part id.'),
  in_reply_to: replyRef.optional(),
}

const recipients = {
  to: z.array(address()).max(MAX_RECIPIENTS).optional(),
  cc: z.array(address()).max(MAX_RECIPIENTS).optional(),
}

// not idempotent, because a second call with the same arguments is a second
// draft rather than a no-op
const DRAFT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}

interface DraftInput {
  subject: string
  body: string
  to?: string[]
  cc?: string[]
  attachments?: AttachmentRef[]
  in_reply_to?: ReplyRefInput
}

const REVIEWED_BY_A_PERSON =
  'The draft is saved, never sent: it waits in the Drafts folder for the account owner to read it, correct the recipients and send it themselves.'

export function registerDraftTools(server: McpServer, cfg: Config, core: CoreApi): void {
  const handler = (args: DraftInput): Promise<CallToolResult> =>
    run(async () => {
      const saved = await core.createDraft({
        subject: args.subject,
        body: args.body,
        to: args.to,
        cc: args.cc,
        attachments: toPartRefs(args.attachments),
        inReplyTo: args.in_reply_to,
      })
      return renderDraftSaved(saved.folder, saved.uid, saved.recipients, args.in_reply_to)
    })

  if (cfg.draftsNoRecipients) {
    // `strict` is what makes the absent recipient keys a refusal rather than a
    // silent drop, so a caller that addresses a draft anyway is told the address
    // went nowhere instead of believing it was saved
    server.registerTool(
      'create_draft',
      {
        description:
          `Save a draft to the Drafts folder. This server is configured to save drafts without recipients: ` +
          `address it in your mail client. ${REVIEWED_BY_A_PERSON} ${REPLY_NOTE}`,
        inputSchema: z.object(base).strict(),
        annotations: DRAFT_ANNOTATIONS,
      },
      (args) => handler(args),
    )
    return
  }

  server.registerTool(
    'create_draft',
    {
      description:
        `Save a draft to the Drafts folder. The result echoes the full recipient list so it can be checked. ` +
        `${REVIEWED_BY_A_PERSON} ${REPLY_NOTE}`,
      inputSchema: { ...base, ...recipients },
      annotations: DRAFT_ANNOTATIONS,
    },
    (args) => handler(args),
  )
}
