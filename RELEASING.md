# Releasing

Every step here is run manually by the repository owner. Nothing in CI publishes on its own.

## Sequence

1. Review and commit. The tree ships exactly what was reviewed.
2. Check the version. `package.json` carries the version npm will publish, and the release workflow's guard refuses a tag that disagrees with it.
3. Run `npm publish`. `prepublishOnly` builds first, and the `files` field limits the package to `dist`. `package.json` ships alongside it either way, `mcpName` included, which is what makes a registry listing possible later.

   Chosen vehicle: local `npm publish`. The workflow in `.github/workflows/release.yml` stays as the alternative: it publishes from Actions on a version tag and adds npm provenance attestation, which a local publish cannot produce and which cannot be added to a version after the fact. It cannot publish until `NPM_TOKEN` is configured, so switching vehicles later takes a token and a tag. A version tag pushed before the token exists produces a failed run rather than a publish.

4. Verify the one-liner. From a clean directory, `npx -y pylos-mcp` should start and immediately fail with the configuration error naming `EMAIL_USER`, which proves the published binary resolves and runs.

## Registry listings

The npm package is the source of truth. Listings point at it, so they all come after `npm publish`.

The one piece that cannot wait is the name. `package.json` carries `mcpName`, and the registry validates it against the package it finds on npm, so a version published without it can never be listed under that version. It is in the tree already as `io.github.adamVass/pylos-mcp`. That is the form GitHub-based authentication requires, and it has to match the authenticated account's username exactly, capital V included, because the registry compares the two as plain strings.

- Official MCP registry: submission goes through the `mcp-publisher` CLI, which authenticates the namespace and then creates or validates the `server.json` manifest as part of the flow. That manifest's `name` has to equal `mcpName`. It stays out of the tree because the rest of it restates the published version, so it is generated at publish time rather than kept in sync by hand.
- Smithery, PulseMCP, Glama, mcp.so: web submission forms that take the npm package name and the repository URL.
