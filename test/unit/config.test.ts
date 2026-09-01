import { describe, it, expect } from 'vitest'
import { loadConfig, ConfigError } from '../../src/config.js'

const BASE = { EMAIL_USER: 'a@mailbox.org', EMAIL_PASSWORD: 'pw', PROVIDER: 'mailbox.org' }

describe('loadConfig', () => {
  it('fills IMAP host/port from provider preset', () => {
    const c = loadConfig(BASE)
    expect(c.imap).toEqual({ host: 'imap.mailbox.org', port: 993 })
  })
  it('defaults capabilities to read+drafts', () => {
    expect([...loadConfig(BASE).capabilities].sort()).toEqual(['drafts', 'read'])
  })
  it('parses CAPABILITIES and always includes read', () => {
    const c = loadConfig({ ...BASE, CAPABILITIES: 'manage,sieve-read' })
    expect(c.capabilities.has('read')).toBe(true)
    expect(c.capabilities.has('drafts')).toBe(false)
    expect(c.sieve).toEqual({ host: 'imap.mailbox.org', port: 4190 })
  })
  it('rejects unknown capability names', () => {
    expect(() => loadConfig({ ...BASE, CAPABILITIES: 'send,sudo' })).toThrow(ConfigError)
  })
  it('requires SMTP settings when send is enabled and no preset provides them', () => {
    expect(() =>
      loadConfig({
        EMAIL_USER: 'a@x.example',
        EMAIL_PASSWORD: 'pw',
        IMAP_HOST: 'mail.x.example',
        CAPABILITIES: 'send',
      }),
    ).toThrow(ConfigError)
  })
  it('explicit IMAP_HOST/IMAP_PORT override the preset', () => {
    const c = loadConfig({ ...BASE, IMAP_HOST: 'other.example', IMAP_PORT: '1993' })
    expect(c.imap).toEqual({ host: 'other.example', port: 1993 })
  })
  it('requires a host from either PROVIDER or IMAP_HOST', () => {
    expect(() => loadConfig({ EMAIL_USER: 'a@x.example', EMAIL_PASSWORD: 'pw' })).toThrow(ConfigError)
  })
  it('rejects unknown PROVIDER values', () => {
    expect(() => loadConfig({ ...BASE, PROVIDER: 'aol' })).toThrow(ConfigError)
  })
  it('requires exactly one of EMAIL_PASSWORD / EMAIL_PASSWORD_CMD', () => {
    expect(() => loadConfig({ EMAIL_USER: 'a@x.example', PROVIDER: 'gmail' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...BASE, EMAIL_PASSWORD_CMD: 'echo x' })).toThrow(ConfigError)
  })
  // an empty password that loads fine fails later at the server as an opaque auth
  // error, pointing the reader at the credentials rather than the unset variable
  it('rejects an empty password from either source', () => {
    expect(() => loadConfig({ ...BASE, EMAIL_PASSWORD: '' })).toThrow(/EMAIL_PASSWORD/)
    expect(() => loadConfig({ ...BASE, EMAIL_PASSWORD: '   ' })).toThrow(/EMAIL_PASSWORD/)
    expect(() =>
      loadConfig({ EMAIL_USER: 'a@x.example', PROVIDER: 'mailbox.org', EMAIL_PASSWORD_CMD: 'printf ""' }),
    ).toThrow(/EMAIL_PASSWORD_CMD/)
  })
  it('EMAIL_PASSWORD_CMD runs the command and trims the trailing newline', () => {
    const c = loadConfig({
      EMAIL_USER: 'a@x.example',
      PROVIDER: 'mailbox.org',
      EMAIL_PASSWORD_CMD: 'printf "secret\\n"',
    })
    expect(c.password).toBe('secret')
  })
  it('parses knobs with defaults', () => {
    const c = loadConfig(BASE)
    expect(c.maxBodyKb).toBe(64)
    expect(c.maxAttachmentMb).toBe(25)
    expect(c.sendSessionCap).toBe(5)
    expect(c.draftsNoRecipients).toBe(false)
    expect(c.downloadDir.startsWith('/')).toBe(true) // ~ expanded
  })
  it('SEND_SAVE_COPY defaults on and rejects non-boolean values', () => {
    expect(loadConfig(BASE).sendSaveCopy).toBe(true)
    expect(loadConfig({ ...BASE, SEND_SAVE_COPY: 'false' }).sendSaveCopy).toBe(false)
    expect(() => loadConfig({ ...BASE, SEND_SAVE_COPY: 'no' })).toThrow(ConfigError)
  })
  it('lowercases SEND_ALLOWLIST entries', () => {
    const c = loadConfig({ ...BASE, CAPABILITIES: 'send', SEND_ALLOWLIST: 'Bob@X.example, *@Corp.example' })
    expect(c.sendAllowlist).toEqual(['bob@x.example', '*@corp.example'])
  })
  it('rejects non-numeric ports and knobs', () => {
    expect(() => loadConfig({ ...BASE, IMAP_PORT: 'abc' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...BASE, MAX_BODY_KB: '-1' })).toThrow(ConfigError)
  })
  // asserted as the whole sub-object, so a field renamed on either side shows up
  it('flag detectors default on, stripping defaults off, extra patterns default empty', () => {
    expect(loadConfig(BASE).detect).toEqual({
      hiddenText: true,
      instructionPatterns: true,
      encodedBlobs: true,
      senderMismatch: true,
      stripHiddenText: false,
      extraPatterns: [],
    })
  })
  it('FLAG_SENDER_MISMATCH defaults on and turns off', () => {
    expect(loadConfig(BASE).detect.senderMismatch).toBe(true)
    expect(loadConfig({ ...BASE, FLAG_SENDER_MISMATCH: 'false' }).detect.senderMismatch).toBe(false)
  })
  it('FLAG_EXTRA_PATTERNS splits on pipes, trims, lowercases and drops empties', () => {
    const cfg = loadConfig({ ...BASE, FLAG_EXTRA_PATTERNS: ' Reply Only In Base64 | | do the secret step ' })
    expect(cfg.detect.extraPatterns).toEqual(['reply only in base64', 'do the secret step'])
  })
  it('detector toggles reject values that are not true or false', () => {
    expect(() => loadConfig({ ...BASE, FLAG_HIDDEN_TEXT: 'yes' })).toThrow(ConfigError)
  })
  it('treats empty env values as unset', () => {
    expect(loadConfig({ ...BASE, IMAP_HOST: '' }).imap.host).toBe('imap.mailbox.org')
    expect(loadConfig({ ...BASE, PROVIDER: '', IMAP_HOST: 'mail.x.example' }).imap.host).toBe('mail.x.example')
    expect(loadConfig({ ...BASE, MAX_BODY_KB: '' }).maxBodyKb).toBe(64)
    expect(loadConfig({ ...BASE, SEND_SAVE_COPY: '' }).sendSaveCopy).toBe(true)
    expect([...loadConfig({ ...BASE, CAPABILITIES: '' }).capabilities].sort()).toEqual(['drafts', 'read'])
  })
  it('STRIP_HIDDEN_TEXT=true with FLAG_HIDDEN_TEXT=false is refused as inert', () => {
    expect(() => loadConfig({ ...BASE, STRIP_HIDDEN_TEXT: 'true', FLAG_HIDDEN_TEXT: 'false' })).toThrow(ConfigError)
    expect(loadConfig({ ...BASE, STRIP_HIDDEN_TEXT: 'true' }).detect.stripHiddenText).toBe(true)
  })
})
