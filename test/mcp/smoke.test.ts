// End-to-end proof that the packaged entry point speaks MCP over real stdio,
// not the in-process transport server.test.ts uses. Config validation happens
// before any IMAP connection, so a fake password is enough.

import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ENTRY = path.join(ROOT, 'dist/index.js')

const DEFAULT_SIX = ['create_draft', 'get_attachment', 'get_email', 'get_thread', 'list_folders', 'search_emails']

// Reads the same package.json the compiled server reads its own version from, at
// the depth the published tarball actually has (dist/mcp/server.js, two levels
// below the package root), which is what catches a wrong relative path silently
// reporting the wrong version instead of failing loudly.
const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  version: string
  description: string
}
const packageVersion = packageJson.version

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
}, 120_000)

it('lists the default six tools over real stdio without connecting to IMAP', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: { PROVIDER: 'mailbox.org', EMAIL_USER: 'a@mailbox.org', EMAIL_PASSWORD: 'x' },
  })
  const client = new Client({ name: 'smoke-test', version: '0.0.0' })

  await client.connect(transport)
  try {
    // what directories and clients show for the server, so the logo stops falling back to an avatar
    expect(client.getServerVersion()).toEqual({
      name: 'pylos-mcp',
      version: packageVersion,
      description: packageJson.description,
      websiteUrl: 'https://github.com/adamVass/pylos-mcp',
      icons: [
        {
          src: 'https://raw.githubusercontent.com/adamVass/pylos-mcp/main/icon.png',
          mimeType: 'image/png',
          sizes: ['512x512'],
        },
      ],
    })

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(DEFAULT_SIX)
  } finally {
    await client.close()
  }
}, 15_000)

it('exits nonzero and names the missing variable when EMAIL_USER is absent', async () => {
  const child = spawn(process.execPath, [ENTRY], {
    // no process.env spread: EMAIL_USER must be genuinely absent, not shadowed by
    // whatever the invoking shell happens to have set
    env: { PROVIDER: 'mailbox.org', EMAIL_PASSWORD: 'x' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code))
  })

  expect(exitCode).not.toBe(0)
  expect(stderr).toContain('EMAIL_USER')
}, 10_000)
