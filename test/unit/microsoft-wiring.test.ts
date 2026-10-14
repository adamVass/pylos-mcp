import { expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { ImapSession, type TokenSource } from '../../src/core/client.js'
import { ComposeBudget } from '../../src/core/draft.js'
import { SendState, sendEmail } from '../../src/core/smtp.js'
import { ToolError } from '../../src/errors.js'

const SIGN_IN = new ToolError(
  'auth',
  'Sign in to Microsoft in the browser window that just opened, or open http://127.0.0.1:5/start yourself. Then ask again.',
)

const asksForSignIn: TokenSource = {
  accessToken: async () => {
    throw SIGN_IN
  },
  forget: async () => {},
}

// port 1: nothing listens there, so reaching the network would fail differently
const cfg = loadConfig({
  EMAIL_USER: 'jane@outlook.example',
  PROVIDER: 'outlook',
  IMAP_HOST: '127.0.0.1',
  IMAP_PORT: '1',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1',
  CAPABILITIES: 'send',
  SEND_ALLOWLIST: '*',
})

// connectionError and sendFailure rebuild every error into generic auth text,
// which would drop the sign-in URL the user needs
it('a sign-in request reaches the caller unchanged from IMAP and from SMTP', async () => {
  const session = new ImapSession(cfg, asksForSignIn)
  await expect(session.withClient(async () => 'unreached')).rejects.toBe(SIGN_IN)

  const state = new SendState()
  await expect(
    sendEmail(session, cfg, state, { to: ['a@x.example'], subject: 's', body: 'b' }, new ComposeBudget()),
  ).rejects.toBe(SIGN_IN)
  expect(state).toMatchObject({ sent: 0, inFlight: 0 })
})
