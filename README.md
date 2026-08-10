<p align="center">
  <img src="assets/logo/pylos.svg" alt="pylos-mcp logo, an envelope with a keyhole in its flap" width="150">
</p>

<h1 align="center">pylos-mcp</h1>

<p align="center"><em>Read-focused, prompt-injection-hardened email MCP server for any IMAP provider.</em></p>

Anyone in the world can put text in your inbox, and the moment an AI assistant reads that inbox, anyone in the world can put text in front of your assistant. pylos-mcp is an email MCP server built around that fact. It lets Claude, or any MCP client, search, read and draft your mail while treating every message as what it really is, input from a stranger. Mailbox content is fenced as data before the model sees it, and there is no `bcc` field for an injected email to quietly copy someone with.

It runs on your machine and speaks plain IMAP, so it works with Gmail, iCloud, Yahoo, GMX, Fastmail, mailbox.org, Posteo, Proton via Bridge, or anything self-hosted, and your credentials never leave home. Out of the box it can read and draft. Anything riskier, moving, sending, deleting, is a separate switch that stays off until you flip it.

## What this can never do

Mail is attacker-controlled text, so the hard limits live in the architecture rather than in a prompt. No message can talk the server out of any of these.

- **No raw HTML ever reaches the model.** Bodies come from the plain-text part when one exists or are converted to text otherwise, and invisible characters that could hide instructions from a human reader while staying readable to a model are stripped along the way.
- **Untrusted content is fenced.** Everything that came from a mailbox, bodies, subjects, sender names, folder listings, Sieve script text, is wrapped in a labeled delimiter before the model sees it, and the delimiter sequence is neutralized wherever it appears inside the content, so a malicious email cannot forge a closing marker and write instructions outside the fence. The few lines that live outside the fence (the metadata line above a message, the one-sentence confirmations a tool returns after it acts, the Warnings line) are server-authored, stripped of hidden characters, collapsed onto a single line and length-capped, and the Warnings line never carries message content at all.
- **No `bcc` field exists anywhere**, not on drafts and not on sent mail. A bcc recipient receives a full copy of a message while appearing nowhere in it, and that invisibility is exactly what an injected email would want, a silent extra recipient that no review of the draft or of the sent copy could ever catch. The field is absent rather than guarded, so there is nothing to talk the model into.
- **Deleting a message moves it to Trash.** There is no expunge and no permanent-delete option, and the tool result never claims a permanence this server does not offer.
- **Sieve access is read-only, permanently.** Server-side filter rules can forward, auto-reply and notify, each an exfiltration channel that survives revoking the app password or uninstalling this server. Scanning uploaded scripts for dangerous commands would only be safe if this project's parser agreed with the mail server's parser exactly, and any disagreement between the two is a bypass, so write access is left out entirely rather than defended.

Sending is the other risky door, so it starts closed even once the `send` capability is on. Until `SEND_ALLOWLIST` says who may be addressed, every send is refused, and the refusal names the two ways to open the gate. Choosing `SEND_ALLOWLIST=*` allows anyone, visibly and on purpose.

Fencing reduces prompt-injection risk, nothing eliminates it. The model still reads text written by strangers, so treat every response that includes message content as untrusted input rather than ground truth.

## Quick start

Add the server to your MCP client's config. For Claude Desktop that file is `claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "pylos-mcp": {
      "command": "npx",
      "args": ["-y", "pylos-mcp"],
      "env": {
        "PROVIDER": "mailbox.org",
        "EMAIL_USER": "you@example.com",
        "EMAIL_PASSWORD": "your-app-password"
      }
    }
  }
}
```

Use an app password rather than your account's regular login password, the next section says which providers insist on one. Restart the client and the read and draft tools appear. Later config changes need the same treatment, a newly enabled capability only registers its tools after a full client restart, and in Claude Desktop toggling the server off and on is not always enough.

## Provider setup

Set `PROVIDER` to one of `gmail`, `icloud`, `yahoo`, `gmx`, `fastmail`, `mailbox.org` or `posteo` and the matching IMAP, SMTP and Sieve hosts and ports fill themselves in.

Gmail, iCloud, Yahoo and Fastmail refuse regular account passwords over IMAP, so an app password is the only way in. Google only offers one once 2-Step Verification is on, and iCloud wants two-factor authentication on the Apple ID first. mailbox.org, GMX and Posteo accept the account password, though a dedicated app password is still the wiser choice. Each provider's account settings cover creating one.

Proton Mail goes through Bridge. Leave `PROVIDER` unset and set `IMAP_HOST` and `IMAP_PORT` to what Bridge shows. The username is the address Bridge tells you to use, and the password is the one in Bridge's Mailbox details, IMAP section, not your Proton account password. Bridge defaults to STARTTLS while this server only speaks implicit TLS, so switch Bridge to SSL in its Advanced Settings. Bridge's certificate is self-signed, so export it and point `TLS_CA_FILE` at it.

Self-hosted servers also leave `PROVIDER` unset. Set `IMAP_HOST`, plus `SMTP_HOST` or `SIEVE_HOST` when those optional tiers are enabled, and authenticate however your server requires. For a private CA, point `TLS_CA_FILE` at the CA certificate. Verification itself always stays on, this only adds a trust anchor.

## Capabilities

Capabilities are independent switches, not a ladder. Reading is always on, drafting starts on, everything else stays off until you list it in `CAPABILITIES`. A switched-off tier has its tools left out of the tool list entirely rather than merely refused, so a model never even learns a disabled tool exists.

| Tier | Default | Tools |
|---|---|---|
| `read` | always on | `search_emails`, `get_email`, `get_attachment`, `list_folders` |
| `drafts` | on | `create_draft` |
| `manage` | off | `move_email`, `set_flags` |
| `send` | off | `send_email` |
| `delete` | off | `delete_email` |
| `sieve-read` | off | `list_sieve_scripts`, `get_sieve_script` |

Enable more with a comma-separated list, for example `CAPABILITIES=drafts,manage,delete`.

## Suspicion warnings

The server also tells you what is suspicious about a message. Three detectors annotate `get_email` results with a line above the content, written entirely in the server's own words and never quoting the content that tripped them.

```
Warnings: hidden_text (412 hidden characters via display:none), encoded_blob (base64 run of 600 characters)
```

- **Hidden text.** Text concealed with the common CSS tricks, `display:none`, invisible or one-pixel fonts, matching text and background colors, off-screen positioning, `aria-hidden`. It covers inline styles and attributes, a tripwire rather than a rendering engine. Newsletters legitimately hide short preview text, so the warning fires only past a threshold, unless the hidden text itself contains an instruction-like phrase or an encoded run, which warns at any length. The text stays in the body by default. `STRIP_HIDDEN_TEXT=true` drops it instead, with a note of how much was dropped.
- **Instruction patterns.** A deliberately small set of phrases that address an AI as an instruction target, like "ignore previous instructions". Small so that an inbox merely talking about AI stays quiet. Extend it with `FLAG_EXTRA_PATTERNS`, pipe-separated phrases matched as case-insensitive literals.
- **Encoded blobs.** Long contiguous base64 or hex runs in the body, reported with their length and never decoded.

Warnings annotate, they never withhold. The message always comes back, and each detector has its own toggle in the reference below.

## Configuration reference

All configuration is environment variables, validated at startup. Invalid configuration fails immediately with an actionable message, never partway through a conversation.

| Variable | Default | Notes |
|---|---|---|
| `PROVIDER` | none | One of `gmail`, `icloud`, `yahoo`, `gmx`, `fastmail`, `mailbox.org`, `posteo`. Fills in IMAP, SMTP and Sieve hosts and ports. |
| `EMAIL_USER` | required | Account login. |
| `EMAIL_PASSWORD` | none | App password. Either this or `EMAIL_PASSWORD_CMD` is required. |
| `EMAIL_PASSWORD_CMD` | none | Command whose stdout is the password, such as a keychain lookup or `pass`, so the secret never sits in the client's config file. |
| `IMAP_HOST` / `IMAP_PORT` | preset / `993` | Explicit values for self-hosted servers. Set either to override the preset. |
| `SMTP_HOST` / `SMTP_PORT` | preset / `465` | Required only when `send` is enabled. |
| `SIEVE_HOST` / `SIEVE_PORT` | `IMAP_HOST` / `4190` | Used only when `sieve-read` is enabled. |
| `CAPABILITIES` | `drafts` | Comma-separated list of tiers beyond `read`, which is always included. |
| `MAX_BODY_KB` | `64` | Message body truncation limit. |
| `MAX_ATTACHMENT_MB` | `25` | Attachment size cap, checked against the size the server declares before any bytes are downloaded. |
| `DOWNLOAD_DIR` | `~/Downloads` | Where `get_attachment` writes files. |
| `SEND_SESSION_CAP` | `5` | Successful `send_email` calls allowed per server process lifetime. |
| `SEND_SAVE_COPY` | `true` | Append a copy of each sent message to the Sent folder, marked read. Turn off for providers that already file sent mail server-side (Gmail does), which would otherwise show duplicates. |
| `SEND_ALLOWLIST` | none (sending closed) | Comma-separated addresses or `*@domain` patterns, or `*` alone to allow anyone. With `send` enabled and no value set, every send is refused and the refusal explains this variable. An explicitly empty value also allows nobody. |
| `DRAFTS_NO_RECIPIENTS` | `false` | When `true`, `create_draft` rejects `to` and `cc` entirely. Drafts carry no addressing and get it added later in your mail client. |
| `FLAG_HIDDEN_TEXT` | `true` | Warn when message HTML hides text with inline styles or `aria-hidden`. |
| `FLAG_INSTRUCTION_PATTERNS` | `true` | Warn when the body contains phrases addressing an AI as an instruction target. |
| `FLAG_ENCODED_BLOBS` | `true` | Warn on long contiguous base64 or hex runs in the body. |
| `STRIP_HIDDEN_TEXT` | `false` | Drop detected hidden text from the body instead of only warning, with a note of how much was dropped. Requires `FLAG_HIDDEN_TEXT` to stay on, the combination with the detector off is refused at startup. |
| `FLAG_EXTRA_PATTERNS` | none | Pipe-separated phrases added to the instruction-pattern set, matched as case-insensitive literal substrings. |
| `TLS_CA_FILE` | none | Path to a PEM CA certificate added as an extra trust anchor, for self-hosted servers with a private CA. Certificate verification cannot be turned off, this only extends what is trusted. Setting it trusts Node's bundled root store plus this file, which means anchors added through `NODE_EXTRA_CA_CERTS` are not in that set. If you rely on those, point `TLS_CA_FILE` at the same certificate. |

## Maintenance expectations

pylos-mcp is built for the author's own daily use and maintained on that basis. Issues and pull requests are welcome, and [CONTRIBUTING.md](CONTRIBUTING.md) carries a wishlist of directions that would genuinely help. The scope stays narrow on purpose, so if you need something wider than the security posture allows, fork away. The codebase is deliberately small enough to make that pleasant.

## Development

```
npm install
npm test                  # unit and MCP-layer tests, entirely offline
npm run test:integration  # starts a disposable local Dovecot container, tests against it, tears it down
npm run build
```

No test in this project connects to a real mailbox, in development or in CI. `npm test` runs in-process fakes, and `npm run test:integration` brings up its own local Dovecot container over Docker, seeded with synthetic fixture messages, and removes it when the run finishes.
