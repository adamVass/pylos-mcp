import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CoreApi } from '../../core/api.js'
import { renderDeleted } from '../../safety/render.js'
import { run } from '../run.js'
import { folder, uid } from './bounds.js'

export function registerDeleteTools(server: McpServer, core: CoreApi): void {
  server.registerTool(
    'delete_email',
    {
      description:
        'Move a message to the Trash folder. This never erases the message: it stays in Trash until removed ' +
        'some other way, from your mail client.',
      inputSchema: { folder, uid },
      // destructive despite keeping the message: it still leaves the folder the owner filed it in
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) =>
      run(async () => {
        const { trashFolder } = await core.deleteEmail(args.folder, args.uid)
        return renderDeleted(args.uid, args.folder, trashFolder)
      }),
  )
}
