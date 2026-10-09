# Changelog

Notable changes to pylos-mcp. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.4.1] - 2026-10-09

### Fixed

- A message whose Date header could not be parsed made `get_email` fail with an internal error, and took down every `search_emails` page it appeared on. Its date now shows as unknown.

### Changed

- The README opens with an animated example of what the server finds in one message, and the setup instructions now come before the security details.

## [0.4.0] - 2026-10-08

### Security

- The fence markers around mailbox content now carry a random tag chosen for each tool call, repeated on a reminder line after the content, so a lookalike closing marker typed into a message no longer reads as the real one.
- Markdown image syntax in message text is defused, so a client that renders Markdown no longer fetches an image through it.
- Saved attachments are readable by their owner only, and on macOS carry the quarantine flag, so a saved app goes through Gatekeeper before it runs.

### Added

- `get_email` warns with `mixed_script` when a word mixes Latin letters with Cyrillic or Greek lookalikes. `FLAG_MIXED_SCRIPT` turns it off.

### Changed

- Instruction-like phrases are matched regardless of extra spaces or line breaks, and are also looked for in subjects, sender lines and attachment names.
- Headings in HTML mail keep their original case instead of being converted to capitals.
- Table rows in HTML mail each get their own line, with cells separated, instead of running together into one word that could raise false warnings.
- Updated nodemailer to 10, which clears the last open audit advisory.

### Fixed

- A message nesting its HTML thousands of levels deep could not be read. Content past 500 levels is now cut and marked.

## [0.3.0] - 2026-10-08

A configuration that loaded on 0.2.0 can now fail at startup, if `SEND_ALLOWLIST` holds an entry that never matched anything or `TLS_CA_FILE` is unreadable. The error names the variable to fix. With `delete` off, `move_email` no longer accepts Trash as a destination.

### Security

- A message could forge the end of the untrusted-content fence by placing certain invisible characters, such as U+034F, variation selectors or Hangul fillers, between the `<` characters of the closing marker. Invisible characters are now matched by Unicode's Default_Ignorable_Code_Point property instead of a hand-maintained list, and the marker check also spans combining marks and format characters.
- `get_attachment` printed the saved path, which ends in a filename the sender chose, outside the fence. The path is now fenced, and the content type is printed only when it is a plain MIME type.
- A Reply-To display name carrying an address on the From domain could suppress the Reply-To mismatch warning. The warning now compares the actual Reply-To address.
- With `manage` on and `delete` off, `move_email` could still move a message into Trash. It now refuses Trash unless `delete` is enabled too.

### Fixed

- A body or Sieve script cut at the size limit could arrive without its truncation marker when HTML conversion or invisible-character stripping brought it back under the limit. The marker now follows whether the download itself was cut.
- A message declaring thousands of attachments produced an unbounded listing. `get_email` lists the first 50 and says how many more exist.
- `delete_email` on a message already in Trash reported a successful move. It now says the message is already there.
- The server now exits when the client closes its input, instead of lingering with an open IMAP connection.
- Attachments whose filenames exceeded the filesystem's limit could not be saved. Long names are now shortened, keeping the extension.
- A certificate issued for another hostname produced advice about `TLS_CA_FILE`, which cannot fix that. The error now names the mismatch.

### Changed

- `SEND_ALLOWLIST` entries that could never match, such as a bare domain, now fail at startup instead of silently refusing every send.
- An unreadable `TLS_CA_FILE` now fails at startup instead of at the first tool call.
- `EMAIL_PASSWORD_CMD` has 60 seconds to finish, so a command waiting on input no longer hangs startup.
- Updated the MCP SDK and transitive dependencies to clear security advisories. The remaining nodemailer advisory needs a major version upgrade and is left for the next release.

## [0.2.0] - 2026-09-01

### Added

- `get_email` warns with `sender_mismatch` when Reply-To is on a different domain from From, or when the display name carries an address on another domain. `FLAG_SENDER_MISMATCH` turns it off.
- `get_email` shows a fenced Reply-To line whenever it differs from From.

## [0.1.1] - 2026-08-10

### Fixed

- Empty environment variables are treated as unset, since bundle managers fill optional fields left blank with empty strings.

### Changed

- The MCP registry manifest is tracked in the repository.
- First release published from a version tag, with npm provenance.

## [0.1.0] - 2026-08-07

### Added

- Initial release: an IMAP email server for MCP clients that fences all mailbox content as untrusted data and never passes raw HTML to the model.
- Read tools are always on and drafting starts on. Managing, sending, deleting and read-only Sieve access each stay off until enabled.
- Sending is refused until `SEND_ALLOWLIST` names who may be addressed, and is capped per session.
- Warnings for hidden text, instruction-like phrases and long encoded runs.
- Provider presets for Gmail, iCloud, Yahoo, GMX, Fastmail, mailbox.org and Posteo.

[0.4.1]: https://github.com/adamVass/pylos-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/adamVass/pylos-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/adamVass/pylos-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/adamVass/pylos-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/adamVass/pylos-mcp/releases/tag/v0.1.1
