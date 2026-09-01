# Security Policy

## Supported versions

pylos-mcp is pre-1.0. Only the latest published release receives security
fixes. There is no support commitment for older versions. Once the project
reaches 1.0, this section will define a longer support window.

## Reporting a vulnerability

Report vulnerabilities privately through this repository's GitHub Security
Advisories (the "Security" tab, then "Report a vulnerability"), not as a
public issue. That keeps details out of public view until a fix is available.

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
