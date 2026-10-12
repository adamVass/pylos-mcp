# Contributing

pylos-mcp is small on purpose, and the security posture in the README's "What this can never do" section is the reason it exists. Contributions are judged first by whether they preserve it. When in doubt, open an issue and ask, the worst outcome is a friendly no.

## Ground rules

- The boundaries in "What this can never do" define the project rather than limit it. No raw HTML to the model, no `bcc`, no expunge, no Sieve write access, no option that weakens TLS verification. If your use case genuinely needs one of those, that is a different project rather than a bad idea, and a fork is the right home for it. The codebase is small and MIT licensed precisely so that forking it is pleasant.
- No test may touch a real mail server. Unit and MCP tests run entirely offline, integration tests run against the disposable local Dovecot container. A PR whose tests need real credentials cannot go in.
- New behavior and every bug fix come with a test that fails without the change. Tests cover the edge cases and invariants that matter, one good test per behavior. Combinatorial padding slows the suite without adding confidence.
- New runtime dependencies need a strong case. For small things, plain code beats an import.

## Wishlist

Contributions that fit the project and are welcome, roughly in order of usefulness:

- OAuth 2 authentication for providers beyond Outlook and Microsoft 365
- Multiple accounts in one server process
- Richer pagination for large mailboxes

## Development

```
npm install
npm test                  # unit and MCP layer tests, entirely offline
npm run test:integration  # starts a disposable local Dovecot container, tests against it, tears it down
npm run build
```

No test in this project connects to a real mailbox, in development or in CI. The integration run seeds its own Dovecot container with made up messages and removes it when finished.

`npm test` must pass offline and `npm run test:integration` must pass against the container.
