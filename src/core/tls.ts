import { readFileSync } from 'node:fs'
import { rootCertificates, type SecureVersion } from 'node:tls'
import { ToolError } from '../errors.js'

interface SecureOptions {
  rejectUnauthorized: true
  servername: string
  minVersion: SecureVersion
  ca: string[] | undefined
}

/**
 * The TLS settings every connection in this server uses, in one place because
 * three call sites are three chances for one of them to be relaxed and nobody to
 * notice. Fail closed, and never make any of these configurable.
 */
export function secureOptions(servername: string, tlsCaFile: string | undefined): SecureOptions {
  return {
    rejectUnauthorized: true,
    servername,
    minVersion: 'TLSv1.2',
    ca: trustAnchors(tlsCaFile),
  }
}

/**
 * TLS_CA_FILE *adds* a trust anchor to the system roots, never replaces them and
 * never disables verification. Passing `ca` to Node would otherwise replace the
 * default store, so the roots are spliced back in explicitly.
 *
 * Known gap, deliberately left: `rootCertificates` is the CA store Node ships,
 * so it does NOT carry anchors added through NODE_EXTRA_CA_CERTS, which setting
 * TLS_CA_FILE therefore drops. That is the fail-closed direction (fewer anchors,
 * never more), and reading the env var here would let this function widen trust
 * from a source the user did not point at this server.
 */
function trustAnchors(tlsCaFile: string | undefined): string[] | undefined {
  if (!tlsCaFile) return undefined

  let pem: string
  try {
    pem = readFileSync(tlsCaFile, 'utf8')
  } catch {
    throw new ToolError('connect', `TLS_CA_FILE could not be read: ${tlsCaFile}`)
  }
  return [...rootCertificates, pem]
}
