import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Config } from '../../config.js'
import type { CoreApi } from '../../core/api.js'
import { renderDeleted } from '../../safety/render.js'
import { run } from '../run.js'
import { folder, uid } from './bounds.js'

export function registerDeleteTools(server: McpServer, _cfg: Config, core: CoreApi): void {
  server.registerTool(
    'delete_email',
    {
      description:
        'Move a message to the Trash folder. This never erases the message: it stays in Trash until removed ' +
        'some other way, from your mail client.',
      inputSchema: { folder, uid },
      // Nothing is erased, which argues for destructiveHint false, and the
      // argument loses: the message still leaves the folder the account owner
      // filed it in, and a hint here never says a tool does less than it does.
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
