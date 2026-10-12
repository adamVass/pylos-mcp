import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as path from 'node:path'
import { ToolError } from '../errors.js'
import { defaultTokenDir, deleteToken, readToken, tokenPath, writeToken } from './token-store.js'

export interface MicrosoftAuthConfig {
  clientId: string
  tenant: string
  scopes: string[]
}

/** for tests only: production passes none of these */
interface MicrosoftAuthDeps {
  authority?: string
  tokenDir?: string
  openBrowser?: (url: string) => void
  signInTimeoutMs?: number
}

const AUTHORITY = 'https://login.microsoftonline.com'
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
const REFRESH_MARGIN_MS = 5 * 60_000
const TOKEN_REQUEST_TIMEOUT_MS = 30_000
const NOT_OURS = 'Not a pylos sign-in.'

interface SignIn {
  server: Server
  timer: NodeJS.Timeout
  /** `127.0.0.1:<port>`, the only Host header the listener answers */
  host: string
  startPath: string
  startUrl: string
  authorizeUrl: string
  redirectUri: string
  state: string
  verifier: string
  epoch: number
  spent: boolean
  closed: boolean
}

interface Grant {
  accessToken: string
  expiresIn: number
  refreshToken?: string
}

export class MicrosoftAuth {
  private readonly authority: string
  private readonly file: string
  private readonly openBrowser: (url: string) => void
  private readonly signInTimeoutMs: number
  private access?: { token: string; expiresAt: number }
  private refreshing?: Promise<string>
  private signIn?: SignIn
  /** how the last sign-in ended without a token, reported once by the next call */
  private outcome?: ToolError
  /** bumped by forget() and a sign-in timeout, so a refresh or sign-in already under way stores nothing afterwards */
  private epoch = 0
  /** token-file reads, writes and deletes run one at a time, in call order */
  private disk: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly user: string,
    private readonly ms: MicrosoftAuthConfig,
    deps: MicrosoftAuthDeps = {},
  ) {
    this.authority = deps.authority ?? AUTHORITY
    this.file = tokenPath(deps.tokenDir ?? defaultTokenDir(), user)
    this.openBrowser = deps.openBrowser ?? openSystemBrowser
    this.signInTimeoutMs = deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS
  }

  async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - Date.now() > REFRESH_MARGIN_MS) return this.access.token
    if (this.signIn) throw signInNeeded(this.signIn.startUrl)
    const outcome = this.outcome
    if (outcome) {
      this.outcome = undefined
      throw outcome
    }
    // one refresh for every concurrent caller, since each one rotates the refresh token
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  async forget(): Promise<void> {
    this.epoch += 1
    this.access = undefined
    if (this.signIn) this.endSignIn(this.signIn)
    await this.serially(() => deleteToken(this.file))
  }

  private serially<T>(op: () => Promise<T>): Promise<T> {
    const run = this.disk.then(op, op)
    this.disk = run.catch(() => {})
    return run
  }

  private async refresh(): Promise<string> {
    const epoch = this.epoch
    const stored = await this.serially(() => readToken(this.file, this.ms))
    if (!stored) throw await this.startSignIn()
    const grant = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: stored.refreshToken })
    if ('error' in grant) {
      if (grant.error === 'invalid_grant' || grant.error === 'interaction_required') {
        await this.forget()
        throw await this.startSignIn()
      }
      throw new ToolError(
        'auth',
        `Microsoft refused to renew the sign-in (${errorLabel(grant.error)}). Ask again to retry`,
      )
    }
    return this.keep(grant, epoch, stored)
  }

  // the rotated refresh token is on disk before the access token is handed out,
  // so a crash between the two cannot leave only the superseded one stored
  private async keep(
    grant: Grant,
    epoch: number,
    previous?: { refreshToken: string; scopes: string[] },
  ): Promise<string> {
    const refreshToken = grant.refreshToken ?? previous?.refreshToken
    if (refreshToken === undefined) {
      throw new ToolError(
        'auth',
        'Microsoft did not grant offline access, so the sign-in cannot be kept. Ask again to retry',
      )
    }
    const saved = await this.serially(async () => {
      if (this.epoch !== epoch) return false
      try {
        await writeToken(this.file, {
          version: 1,
          clientId: this.ms.clientId,
          tenant: this.ms.tenant,
          // another process on the same account may need a scope this one does not
          scopes: [...new Set([...(previous?.scopes ?? []), ...this.ms.scopes])],
          refreshToken,
        })
      } catch {
        throw new ToolError('server', `could not save the Microsoft sign-in in ${path.dirname(this.file)}`)
      }
      return true
    })
    if (!saved || this.epoch !== epoch) {
      throw new ToolError('auth', 'The Microsoft sign-in was reset. Ask again to sign in afresh.')
    }
    this.access = { token: grant.accessToken, expiresAt: Date.now() + grant.expiresIn * 1000 }
    return grant.accessToken
  }

  private async startSignIn(): Promise<ToolError> {
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
    } catch {
      throw new ToolError('server', 'could not open a local port for the Microsoft sign-in')
    }
    // an unhandled 'error' event would crash the process
    server.on('error', () => {})
    // the stdio transport keeps the process alive, not this listener
    server.unref()

    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`
    const redirectUri = `http://${host}`
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(16).toString('base64url')
    // unguessable, because the page it redirects to carries the state
    const startPath = `/${randomBytes(16).toString('base64url')}`
    const authorizeUrl = `${this.endpoint('authorize')}?${new URLSearchParams({
      client_id: this.ms.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: this.ms.scopes.join(' '),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
      login_hint: this.user,
      prompt: 'select_account',
    })}`

    const signIn: SignIn = {
      server,
      timer: setTimeout(() => {
        // a code exchange still under way must store nothing, even mid-write
        this.epoch += 1
        this.endSignIn(signIn)
        // close() spares open connections, and a held one could still deliver a redirect
        server.closeAllConnections()
      }, this.signInTimeoutMs),
      host,
      startPath,
      // short, because the full authorize URL would not survive the 500-character error cap
      startUrl: `${redirectUri}${startPath}`,
      authorizeUrl,
      redirectUri,
      state,
      verifier,
      epoch: this.epoch,
      spent: false,
      closed: false,
    }
    signIn.timer.unref()
    server.on('request', (req, res) => {
      // answer() catches its own failures, this only keeps a surprise from becoming an unhandled rejection
      this.answer(signIn, req, res).catch(() => res.destroy())
    })
    this.signIn = signIn
    this.openBrowser(signIn.startUrl)
    return signInNeeded(signIn.startUrl)
  }

  private endSignIn(signIn: SignIn): void {
    signIn.closed = true
    clearTimeout(signIn.timer)
    signIn.server.close()
    if (this.signIn === signIn) this.signIn = undefined
  }

  private async answer(signIn: SignIn, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL
    try {
      url = new URL(req.url ?? '/', signIn.redirectUri)
    } catch {
      return reply(res, 400, NOT_OURS)
    }
    // a page reaching this port through a rebinding DNS name carries that name as Host
    if (signIn.closed || req.method !== 'GET' || req.headers.host !== signIn.host) return reply(res, 400, NOT_OURS)
    if (url.pathname === signIn.startPath) return reply(res, 302, '', { location: signIn.authorizeUrl })
    if (url.pathname !== '/' || url.searchParams.get('state') !== signIn.state || signIn.spent) {
      return reply(res, 400, NOT_OURS)
    }
    // single use, so a replayed redirect cannot start a second code exchange
    signIn.spent = true
    try {
      const code = url.searchParams.get('code')
      if (code === null) throw signInFailed(url.searchParams.get('error') ?? '')
      const grant = await this.tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: signIn.redirectUri,
        code_verifier: signIn.verifier,
      })
      if ('error' in grant) throw signInFailed(grant.error)
      await this.keep(grant, signIn.epoch)
      reply(res, 200, 'Signed in to pylos. You can close this tab.')
    } catch (err) {
      if (!signIn.closed) this.outcome = err instanceof ToolError ? err : signInFailed('')
      reply(res, 200, 'The Microsoft sign-in did not complete. You can close this tab and ask again.')
    } finally {
      this.endSignIn(signIn)
    }
  }

  private endpoint(name: 'authorize' | 'token'): string {
    return `${this.authority}/${encodeURIComponent(this.ms.tenant)}/oauth2/v2.0/${name}`
  }

  // only `error` is read from a refusal: error_description is server free text,
  // and server text never reaches the model
  private async tokenRequest(params: Record<string, string>): Promise<Grant | { error: string }> {
    let body: Record<string, unknown>
    try {
      const res = await fetch(this.endpoint('token'), {
        method: 'POST',
        body: new URLSearchParams({ client_id: this.ms.clientId, scope: this.ms.scopes.join(' '), ...params }),
        // a redirect would resend the refresh token to another host
        redirect: 'error',
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      })
      if (res.status >= 500) throw new Error('server error')
      const json: unknown = await res.json()
      if (typeof json !== 'object' || json === null) throw new Error('not an object')
      body = json as Record<string, unknown>
    } catch {
      throw new ToolError('connect', 'could not reach Microsoft sign-in. Check the network and ask again')
    }
    if (typeof body.error === 'string') return { error: body.error }
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new ToolError('auth', 'Microsoft sign-in sent an unexpected answer. Ask again to retry')
    }
    return {
      accessToken: body.access_token,
      expiresIn: body.expires_in,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    }
  }
}

function signInNeeded(startUrl: string): ToolError {
  return new ToolError(
    'auth',
    `Sign in to Microsoft in the browser window that just opened, or open ${startUrl} yourself. Then ask again.`,
  )
}

function signInFailed(code: string): ToolError {
  switch (code) {
    case 'consent_required':
      return new ToolError(
        'auth',
        'Your organization requires an administrator to approve pylos. See the README section on work accounts.',
      )
    case 'access_denied':
      return new ToolError(
        'auth',
        'Microsoft sign-in was cancelled or refused. On a work account an administrator may need to approve pylos first, see the README section on work accounts.',
      )
    default:
      return new ToolError('auth', `Microsoft sign-in did not complete (${errorLabel(code)}). Ask again to retry.`)
  }
}

// a code anyone holding the state can choose must not carry words to the model
const KNOWN_ERRORS = new Set([
  'invalid_request',
  'unauthorized_client',
  'access_denied',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
  'invalid_client',
  'invalid_grant',
  'unsupported_grant_type',
  'interaction_required',
  'login_required',
  'account_selection_required',
  'consent_required',
])

function errorLabel(code: string): string {
  return KNOWN_ERRORS.has(code) ? code : 'unknown error'
}

function reply(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close', ...headers })
  res.end(text)
}

// no shell, so nothing in the URL is ever interpreted, and no stdio, since stdout carries MCP frames
function openSystemBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}
