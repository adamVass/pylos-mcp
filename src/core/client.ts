import { ImapFlow, type ImapFlowOptions } from 'imapflow'
import type { Config } from '../config.js'
import { APP_PASSWORD_ADVICE, TLS_CA_ADVICE, ToolError, errorCode } from '../errors.js'
import { secureOptions } from './tls.js'

type SpecialUseFlag = '\\Drafts' | '\\Sent' | '\\Trash'

/**
 * Owns the single IMAP connection for the process. TLS is always on and always
 * verified: no option, env var or code path relaxes it.
 */
export class ImapSession {
  private client?: ImapFlow
  /** in-flight connect, so concurrent callers share one connection instead of racing */
  private pending?: Promise<ImapFlow>

  constructor(private readonly cfg: Config) {}

  /**
   * Reconnects if the cached connection has been lost, but never retries `fn`
   * itself: replaying a command that may have reached the server is not safe.
   */
  async withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.acquire()
    return fn(client)
  }

  async withMailbox<T>(path: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(path).catch((err: unknown) => {
        throw mailboxError(err, path)
      })
      try {
        return await fn(client)
      } finally {
        lock.release()
      }
    })
  }

  async specialUse(flag: SpecialUseFlag, fallback: string): Promise<string> {
    return this.withClient(async (client) => {
      const folders = await client.list()
      return folders.find((folder) => folder.specialUse === flag)?.path ?? fallback
    })
  }

  async close(): Promise<void> {
    // a connect started just before close() would otherwise complete into a
    // leaked live connection, so let it settle first and close whatever it left
    const pending = this.pending
    this.pending = undefined
    if (pending) await pending.catch(() => undefined)

    const client = this.client
    this.client = undefined
    if (!client) return
    try {
      await client.logout()
    } catch {
      // best effort: the server may already be gone, and the socket close below
      // is what actually matters
    }
    client.close()
  }

  private async acquire(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client
    this.client = undefined
    this.pending ??= this.connect().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private async connect(): Promise<ImapFlow> {
    const client = new ImapFlow(this.buildOptions())
    // ImapFlow is an EventEmitter, so an unhandled 'error' event would crash the
    // process. Failures surface through the rejected promises instead.
    client.on('error', () => {})
    client.on('close', () => {
      if (this.client === client) this.client = undefined
    })

    try {
      await client.connect()
    } catch (err) {
      client.close()
      throw connectionError(err, this.cfg.imap.host, this.cfg.imap.port)
    }

    this.client = client
    return client
  }

  private buildOptions(): ImapFlowOptions {
    const { host, port } = this.cfg.imap
    return {
      host,
      port,
      secure: true,
      servername: host,
      auth: { user: this.cfg.user, pass: this.cfg.password },
      // stdout is reserved for the MCP protocol, so imapflow must never write to it
      logger: false,
      emitLogs: false,
      tls: secureOptions(host, this.cfg.tlsCaFile),
    }
  }
}

function isAuthFailure(err: unknown): boolean {
  return (err as { authenticationFailed?: unknown } | null)?.authenticationFailed === true
}

/**
 * Built from the category and the configured host/port only: the underlying
 * error can carry the executed command or raw server text, neither of which is
 * safe to hand back.
 */
function connectionError(err: unknown, host: string, port: number): ToolError {
  if (isAuthFailure(err)) {
    return new ToolError('auth', `authentication failed. Check EMAIL_USER and the password, ${APP_PASSWORD_ADVICE}`)
  }

  const target = `${host}:${port}`
  switch (errorCode(err)) {
    case 'ECONNREFUSED':
      return new ToolError('connect', `nothing is listening on ${target}. Check IMAP_HOST and IMAP_PORT`)
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new ToolError('connect', `could not resolve the IMAP host in ${target}. Check IMAP_HOST`)
    case 'ETIMEDOUT':
    case 'ECONNRESET':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'CONNECT_TIMEOUT':
    case 'GREETING_TIMEOUT':
      return new ToolError('connect', `timed out connecting to ${target}. Check the network and any firewall`)
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return new ToolError(
        'connect',
        `the TLS certificate presented by ${target} could not be verified. If this is a private server with its own CA, ${TLS_CA_ADVICE}`,
      )
    default:
      return new ToolError('connect', `could not establish an IMAP connection to ${target}`)
  }
}

function mailboxError(err: unknown, path: string): ToolError {
  if ((err as { mailboxMissing?: unknown } | null)?.mailboxMissing === true) {
    return new ToolError('not_found', `no mailbox named "${path}" on the server`)
  }
  return new ToolError('server', `the server refused to open the mailbox "${path}"`)
}
