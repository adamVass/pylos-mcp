import { describe, it, expect } from 'vitest'
import { sanitizeFilename, uniquePath } from '../../src/safety/filename.js'
import { renderAttachmentSaved } from '../../src/safety/render.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

describe('sanitizeFilename', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\boot.ini', 'boot.ini'],
    ['.hidden', 'hidden'],
    ['file‮gnp.exe', 'filegnp.exe'], // bidi override stripped
    ['a/b:c*d?.txt', expect.stringMatching(/^b_c_d_\.txt$/)],
    ['', 'attachment'],
    ['...', 'attachment'],
  ])('sanitizes %s', (input, expected) => {
    expect(sanitizeFilename(input)).toEqual(expected)
  })

  // past the filesystem's name limit the open fails, and the attachment cannot be saved at all
  it('caps a long name in bytes, by whole characters, keeping the extension', () => {
    for (const stem of ['a'.repeat(300), 'д'.repeat(300)]) {
      const out = sanitizeFilename(`${stem}.pdf`)
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(200)
      expect(out.endsWith('.pdf')).toBe(true)
      expect(out).not.toContain('\uFFFD')
    }
  })

  // U+0085 NEL sits outside the 0x00-0x1F range this class already stripped, and
  // is a line break to plenty of tools
  it('strips U+0085 NEL, which is outside the 0x00-0x1F control range', () => {
    expect(sanitizeFilename('report\u0085.pdf')).toBe('report.pdf')
    expect(sanitizeFilename('\u0085quarterly\u0085.txt')).toBe('quarterly.txt')
  })

  // U+2067 RIGHT-TO-LEFT ISOLATE makes a file manager render
  // `report<U+2067>fdp.exe` as `reportexe.pdf`, the same extension spoof as the
  // override case above
  it('strips bidi isolates and the tag block, which spoof extensions on disk', () => {
    expect(sanitizeFilename('report⁧fdp.exe')).toBe('reportfdp.exe')
    expect(sanitizeFilename('invoice­؜.pdf')).toBe('invoice.pdf')
    expect(sanitizeFilename('note\u{E0041}.txt')).toBe('note.txt')
  })

  // a leading whitespace char, not a control char, blocks the `/^\.+/` dot-strip
  // anchor, and a subsequent trim then re-exposes the dots it should have removed
  it.each([
    [' .hidden', 'hidden'],
    ['  ..secret', 'secret'],
    [' .', 'attachment'],
    [' . .hidden', 'hidden'], // interleaved whitespace/dots, exercises the fixpoint loop
  ])('strips leading whitespace+dots regardless of interleaving: %s', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected)
  })

  // the printed path passes through the same defusing, so the file must already carry it
  it('a name with Markdown image syntax is saved under the name the result prints', () => {
    const path = `/tmp/${sanitizeFilename('see ![this](x).png')}`
    expect(path).toBe('/tmp/see !［this](x).png')
    expect(renderAttachmentSaved(path, 1, 'image/png')).toContain(`\n${path}\n`)
  })
})

describe('uniquePath', () => {
  it('uniquePath never overwrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pylos-'))
    writeFileSync(join(dir, 'a.txt'), 'x')
    const p = uniquePath(dir, 'a.txt')
    expect(basename(p)).toBe('a-1.txt')
    expect(p.startsWith(dir)).toBe(true)
  })
})
