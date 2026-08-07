import { describe, it, expect, vi } from 'vitest'

// EMAIL_PASSWORD_CMD must not leak raw command stderr to the server's own
// stderr. `execSync`'s default stdio inherits the parent's file descriptors
// directly at the OS level, bypassing Node's process.stderr stream object, so an
// in-process spy on process.stderr.write cannot observe the leak either way.
// What can be asserted is the call contract that prevents it: stdio fully
// piped or ignored, never inherited.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn(actual.execSync) }
})

import { execSync } from 'node:child_process'
import { loadConfig } from '../../src/config.js'

describe('EMAIL_PASSWORD_CMD stdio safety', () => {
  it('runs the password command with stdio fully piped/ignored, never inherited', () => {
    const c = loadConfig({
      EMAIL_USER: 'a@x.example',
      PROVIDER: 'mailbox.org',
      // Writes to both streams; only stdout should ever be read as the password.
      EMAIL_PASSWORD_CMD: 'printf "leaked-diagnostic\\n" 1>&2; printf "secret\\n"',
    })

    expect(c.password).toBe('secret')
    expect(execSync).toHaveBeenCalledWith(
      'printf "leaked-diagnostic\\n" 1>&2; printf "secret\\n"',
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    )
  })
})
