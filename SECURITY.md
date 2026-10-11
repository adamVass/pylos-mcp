# Security Policy

## Supported versions

Security fixes go to the latest release. Once a 2.0 ships, the last 1.x
release keeps receiving security fixes for six months.

pylos-mcp supports the Node.js versions that are still maintained, 22 and
later today. Dropping a version that has reached its end of life happens in a
minor release and is announced in the changelog.

## What stays stable

pylos-mcp follows semantic versioning. Within 1.x, these change only in a
major release:

- tool names, their parameters and what each tool does
- environment variable names, the values they accept and their defaults
- the capability tiers, which tools each one holds, and that only reading and
  drafting are on by default
- the guarantees listed in the README under "What this can never do"

New tools, parameters, settings, providers and warnings arrive in minor
releases. A new tool that changes or sends mail joins a tier that is off by
default.

Not covered, and free to change in any release: the wording and layout of tool
results, warning notes and error messages, which are written for the model and
not for parsing, the messages a detector flags, as detectors get better, and a
preset's server addresses when the provider changes them.

## Reporting a vulnerability

Report vulnerabilities privately through this repository's GitHub Security
Advisories, at https://github.com/adamVass/pylos-mcp/security/advisories/new,
not as a public issue. That keeps details out of public view until a fix is
available. Expect a first answer within a week. A confirmed vulnerability is
fixed in a new release and then disclosed in a published advisory, with a CVE
where one applies.

Include the affected version, the IMAP/SMTP/Sieve provider or server software
involved if relevant, and steps to reproduce. If reproduction depends on a
specific mailbox state, describe it rather than sharing credentials: this
project's own testing never touches a real mailbox (see below), and reports
should hold to the same standard.

## Design notes

Details behind the guarantees the README states, kept here so the README stays
readable.

The lines that reach the model unfenced are the metadata line above a message,
the one-sentence confirmation a tool returns after it acts, and the Warnings
line. Each is server-authored, stripped of hidden characters, collapsed onto a
single line and length-capped. The Warnings line reports only the server's own
labels and counts, never message content.

Each fence carries a random tag chosen fresh for every tool call, on both
markers and on a reminder line after the closing one. Content cannot start a
marker, and a sender who types a lookalike marker cannot know the tag it would
need.

The mixed-script warning knows only Cyrillic and Greek letters that look like
Latin ones. Fullwidth Latin and the mathematical alphanumeric letters are
outside it, the same tripwire stance the other detectors take.

HTML nested deeper than 500 levels is cut at that depth and marked as omitted.
Real mail stays far below it, and the parsers fail well above it.

Saved attachments are readable by their owner only. On macOS each one also
gets the quarantine flag that browsers and Mail set, before any of its bytes
are written, so opening a saved app goes through Gatekeeper. If the flag cannot
be set, the file is not saved.

A Microsoft sign-in keeps its refresh token in a file readable by its owner
only. That is the same protection a password in the MCP client's config file
has, no more. Access tokens stay in memory. The sign-in uses PKCE, so there is
no client secret to leak, and its listener runs on 127.0.0.1 for at most five
minutes and answers only its random start link and the redirect carrying its
own random state. Deleting the file and restarting the client signs out.
Microsoft's account pages revoke the app's access from the next renewal on,
account.microsoft.com for personal accounts and myapps.microsoft.com for work
accounts.

The npm package is published with npm provenance, and each GitHub release's
Claude Desktop bundle carries a signed build attestation next to it, as
`pylos-mcp.mcpb.sigstore.json`. `gh attestation verify pylos-mcp.mcpb --repo
adamVass/pylos-mcp` confirms a downloaded bundle was built by this
repository's release workflow from the tagged source.

Sieve write access is excluded rather than guarded because scanning uploaded
scripts for dangerous commands would only be safe if this project's parser
agreed with the mail server's parser exactly. Any disagreement between the two
is a bypass, so write access is not offered at all.

## Testing policy

Every test in this repository runs against a disposable local Dovecot
container or an in-process fake, never a real mail account. `npm test` runs
entirely offline, `npm run test:integration` starts and tears down its own
container. This applies to security-related reproduction as much as to
regular development: no contributor or maintainer connects this project's
tests to a live mailbox, in CI or otherwise.
