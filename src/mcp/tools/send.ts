import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Config } from '../../config.js'
import type { CoreApi } from '../../core/api.js'
import { renderSent } from '../../safety/render.js'
import { run } from '../run.js'
import { address, attachment, MAX_ATTACHMENTS, MAX_RECIPIENTS, toPartRefs } from './bounds.js'

export function sendPolicyClause(allowlist: string[] | undefined): string {
  if (allowlist === undefined) {
    return 'Sending is currently closed: SEND_ALLOWLIST is not configured, and every send will be refused until the account owner sets it.'
  }
  if (allowlist.includes('*')) {
    return 'The account owner has allowed sending to any recipient.'
  }
  return 'Only recipients covered by the configured SEND_ALLOWLIST can be addressed.'
}

export function registerSendTools(server: McpServer, cfg: Config, core: CoreApi): void {
  server.registerTool(
    'send_email',
    {
      description:
        'Send an email. This transmits the message to external recipients immediately through the ' +
        'configured SMTP server; it cannot be recalled, and no one reviews it first. Prefer create_draft ' +
        `unless the account owner has asked for the message to go out now. At most ${cfg.sendSessionCap} ` +
        `messages can be sent per server session. ${sendPolicyClause(cfg.sendAllowlist)}`,
      inputSchema: {
        to: z.array(address()).min(1).max(MAX_RECIPIENTS).describe('Recipients. At least one is required.'),
        cc: z.array(address()).max(MAX_RECIPIENTS).optional(),
        subject: z.string(),
        body: z.string(),
        attachments: z
          .array(attachment)
          .max(MAX_ATTACHMENTS)
          .optional()
          .describe('Attachments are taken from messages already in the mailbox, by folder, uid and part id.'),
      },
      // the only tool whose effect cannot be undone from a mail client, so it
      // carries both hints a client would use to insist on a human first
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args) =>
      run(async () => {
        const sent = await core.sendEmail({
          to: args.to,
          cc: args.cc,
          subject: args.subject,
          body: args.body,
          attachments: toPartRefs(args.attachments),
        })
        return renderSent(sent.accepted, sent.rejected, sent.sent, cfg.sendSessionCap, sent.copy)
      }),
  )
}
