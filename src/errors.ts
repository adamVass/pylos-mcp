type ToolErrorCode = 'auth' | 'connect' | 'not_found' | 'cap_exceeded' | 'policy' | 'server'

export class ToolError extends Error {
  constructor(
    public code: ToolErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export const MESSAGE_GONE = 'message not found. It may have been moved or deleted'

export const TLS_CA_ADVICE = 'point TLS_CA_FILE at that CA certificate'
export const APP_PASSWORD_ADVICE = 'providers with 2FA require an app-specific password'

export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}
