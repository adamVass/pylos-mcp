import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { ToolError } from '../errors.js'
import { boundErrorMessage } from '../safety/render.js'

/**
 * The error boundary for every tool. Left to the SDK, a thrown error answers with
 * its raw message, which inside imapflow or nodemailer is server text, so only a
 * ToolError passes, and bounded, since its message can embed server text.
 * The account head is added here so no tool can leave it out.
 */
export async function run(fn: () => Promise<string>, account?: string): Promise<CallToolResult> {
  const head = account === undefined ? '' : `Account: ${account}\n`
  const errorHead =
    account === undefined ? '' : `Account: ${account} (its account settings end in __${account.toUpperCase()})\n`
  try {
    return { content: [{ type: 'text', text: head + (await fn()) }] }
  } catch (err) {
    if (err instanceof ToolError) {
      return { content: [{ type: 'text', text: errorHead + boundErrorMessage(err.message) }], isError: true }
    }
    console.error('[pylos-mcp]', err)
    return { content: [{ type: 'text', text: `${errorHead}internal error. See server log` }], isError: true }
  }
}
