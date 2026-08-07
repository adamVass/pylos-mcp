import { it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => join(d.parentPath, d.name))
}

// Bcc is the one recipient field an injected email could use to add a recipient
// the user would not see when reviewing a draft, so the rule is that it exists
// nowhere in the codebase. Substring, not `\bbcc\b`: there is no word boundary
// before the capital in `addBccHeader`, so the anchored form would wave through
// exactly the camelCase identifier someone reintroducing the field would write.
it('no source file mentions bcc', () => {
  const offenders = tsFilesUnder('src').filter((f) => /bcc/i.test(readFileSync(f, 'utf8')))
  expect(offenders).toEqual([])
})

it('only safety/ imports readUntrusted', () => {
  const offenders = tsFilesUnder('src')
    .filter((f) => !f.includes(`${join('src', 'safety')}`))
    .filter((f) => readFileSync(f, 'utf8').includes('readUntrusted'))
  expect(offenders).toEqual([])
})

// Unlike the bcc rule above, these match IMPORT statements rather than file
// contents: a comment naming node:tls is documentation, and only an import is a
// dependency. Both spellings count, so a dynamic `await import(...)` cannot
// slip past the rule either.
function importsMatching(dir: string, specifier: string): string[] {
  const pattern = new RegExp(String.raw`(?:from|import\()\s*'${specifier}'`)
  return tsFilesUnder(join('src', dir)).filter((f) => pattern.test(readFileSync(f, 'utf8')))
}

// keeping the mail libraries out of mcp/ is what lets the MCP tests run in
// process against a fake CoreApi with no server at all
it('mcp/ never reaches the network directly', () => {
  const offenders = importsMatching('mcp', String.raw`(?:imapflow|nodemailer|node:net|node:tls)(?:/[^']*)?`)
  expect(offenders).toEqual([])
})

// safety/ is the innermost layer and depends on nothing above, so the rendering
// and escaping rules cannot start varying with where the content came from
it('safety/ depends on nothing above it', () => {
  const offenders = importsMatching('safety', String.raw`[^']*\.\./(?:core|mcp)/[^']*`)
  expect(offenders).toEqual([])
})

it('core/ does not depend on the mcp layer', () => {
  const offenders = importsMatching('core', String.raw`[^']*\.\./mcp/[^']*`)
  expect(offenders).toEqual([])
})
