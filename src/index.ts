#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadAccounts, type ParsedAccount } from './accounts.js'
import { ConfigError } from './config.js'
import { openAccounts } from './core/api.js'
import { buildServer } from './mcp/server.js'

/** exits before any ImapSession or transport exists, so a bad config never opens a socket */
function loadAccountsOrExit(): ParsedAccount[] {
  try {
    return loadAccounts(process.env)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('pylos-mcp: ' + err.message)
      process.exit(1)
    }
    throw err
  }
}

async function main(): Promise<void> {
  // one session per account, but the send cap and compose budget span all of them
  const { accounts, close } = openAccounts(loadAccountsOrExit())
  const server = buildServer(accounts)

  const shutdown = (): void => {
    close().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  // a client may close the pipe without a signal, and the open IMAP connection
  // would keep an orphan alive holding one of the account's connection slots
  process.stdin.once('end', shutdown)

  // stdout carries MCP protocol frames exclusively, so every diagnostic in this
  // codebase goes to stderr
  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  console.error('pylos-mcp: unexpected error', err)
  process.exit(1)
})
