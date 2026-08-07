import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Config } from '../../config.js'
import type { CoreApi } from '../../core/api.js'
import { ToolError } from '../../errors.js'
import { renderFlagsUpdated, renderMoved } from '../../safety/render.js'
import { run } from '../run.js'
import { folder, uid } from './bounds.js'

export function registerManageTools(server: McpServer, _cfg: Config, core: CoreApi): void {
  server.registerTool(
    'move_email',
    {
      description:
        'Move a message to another folder in the same mailbox. Succeeds only once the server confirms the ' +
        'move; the message is left untouched if the destination folder does not exist.',
      inputSchema: {
        folder,
        uid,
        destination: z.string().min(1).describe('Folder to move the message into. Must already exist.'),
      },
      // IMAP never reuses a uid within a mailbox, so a repeat call finds nothing
      // to move and leaves the mailbox exactly as the first call left it
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) =>
      run(async () => {
        await core.moveEmail(args.folder, args.uid, args.destination)
        return renderMoved(args.uid, args.folder, args.destination)
      }),
  )

  server.registerTool(
    'set_flags',
    {
      description: 'Mark a message read/unread and/or flagged/unflagged. Provide at least one of seen or flagged.',
      inputSchema: {
        folder,
        uid,
        seen: z.boolean().optional().describe('true marks the message read, false marks it unread.'),
        flagged: z.boolean().optional().describe('true flags the message, false clears the flag.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) =>
      run(async () => {
        if (args.seen === undefined && args.flagged === undefined) {
          throw new ToolError('policy', 'set_flags needs at least one of seen or flagged')
        }
        await core.setFlags(args.folder, args.uid, { seen: args.seen, flagged: args.flagged })
        return renderFlagsUpdated(args.uid, { seen: args.seen, flagged: args.flagged })
      }),
  )
}
