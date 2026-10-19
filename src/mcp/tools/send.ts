import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Account } from '../../core/api.js'
import type { Confirm } from '../../core/smtp.js'
import { renderConfirmation } from '../../safety/outgoing.js'
import { renderSent } from '../../safety/render.js'
import { accountField, pick } from '../accounts.js'
import { run } from '../run.js'
import { address, composeFields, MAX_RECIPIENTS, REPLY_NOTE, toComposeArgs } from './bounds.js'

export function sendPolicyClause(allowlist: string[] | undefined, account?: string): string {
  if (account === undefined) {
    if (allowlist === undefined) {
      return 'Sending is currently closed: SEND_ALLOWLIST is not configured, and every send will be refused until the account owner sets it.'
    }
    if (allowlist.includes('*')) {
      return 'The account owner has allowed sending to any recipient.'
    }
    return 'Only recipients covered by the configured SEND_ALLOWLIST can be addressed.'
  }
  const variable = `SEND_ALLOWLIST__${account.toUpperCase()}`
  if (allowlist === undefined) {
    return `From ${account}, sending is currently closed: ${variable} is not configured, and every send from it will be refused until the account owner sets it.`
  }
  if (allowlist.includes('*')) {
    return `From ${account}, the account owner has allowed sending to any recipient.`
  }
  return `From ${account}, only recipients covered by ${variable} can be addressed.`
}

// a person reads the whole message here, so the SDK's 60 second default is far too short
const CONFIRM_TIMEOUT_MS = 10 * 60_000

function reviewClause(sendConfirm: boolean): string {
  return sendConfirm
    ? 'the account owner is shown each message in a confirmation dialog and it is sent only if they accept. ' +
        'A client that cannot show the dialog has every send refused'
    : 'no one reviews it first'
}

/** undefined when the client cannot show a form, which core turns into a refusal */
function ownerConfirmation(
  server: McpServer,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Confirm | undefined {
  if (!server.server.getClientCapabilities()?.elicitation?.form) return undefined
  return async (proposal) => {
    const answer = await server.server.elicitInput(
      { mode: 'form', message: renderConfirmation(proposal), requestedSchema: { type: 'object', properties: {} } },
      { timeout: CONFIRM_TIMEOUT_MS, signal: extra.signal, relatedRequestId: extra.requestId },
    )
    return answer.action === 'accept'
  }
}

export function registerSendTools(server: McpServer, accounts: Account[]): void {
  const { sendConfirm, sendSessionCap } = accounts[0].cfg
  const acrossAccounts = accounts[0].name !== undefined
  const cap = acrossAccounts
    ? `At most ${sendSessionCap} messages can be sent per server session, across all accounts.`
    : `At most ${sendSessionCap} messages can be sent per server session.`
  const policy = accounts.map((a) => sendPolicyClause(a.cfg.sendAllowlist, a.name)).join(' ')

  server.registerTool(
    'send_email',
    {
      description:
        'Send an email. This transmits the message to external recipients immediately through the ' +
        `configured SMTP server. It cannot be recalled, and ${reviewClause(sendConfirm)}. Prefer create_draft ` +
        `unless the account owner has asked for the message to go out now. ${cap} ${policy} ${REPLY_NOTE}`,
      inputSchema: {
        to: z.array(address()).min(1).max(MAX_RECIPIENTS).describe('Recipients. At least one is required.'),
        cc: z.array(address()).max(MAX_RECIPIENTS).optional(),
        ...composeFields,
        ...accountField(accounts),
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
    (args, extra) => {
      const { name, core } = pick(accounts, args)
      return run(async () => {
        const sent = await core.sendEmail(
          { ...toComposeArgs(args), to: args.to, cc: args.cc },
          ownerConfirmation(server, extra),
        )
        return renderSent(
          sent.accepted,
          sent.rejected,
          sent.sent,
          sendSessionCap,
          sent.copy,
          sent.reply,
          acrossAccounts,
        )
      }, name)
    },
  )
}
