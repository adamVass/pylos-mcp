import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { ToolError } from '../errors.js'
import { boundErrorMessage } from '../safety/render.js'

/**
 * The error boundary for every tool. Without it the SDK's own handler answers a
 * thrown error with `error.message`, which for anything raised inside imapflow
 * or nodemailer is raw server text. Only a ToolError, whose message is written
 * by us, is passed through, and even that is bounded on the way out because a
 * ToolError message can embed server-influenced text.
 */
export async function run(fn: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: await fn() }] }
  } catch (err) {
    if (err instanceof ToolError) {
      return { content: [{ type: 'text', text: boundErrorMessage(err.message) }], isError: true }
    }
    console.error('[pylos-mcp]', err)
    return { content: [{ type: 'text', text: 'internal error. See server log' }], isError: true }
  }
}
