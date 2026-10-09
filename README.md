<p align="center">
  <img src="assets/logo/pylos.svg" alt="pylos-mcp logo, an envelope with a keyhole in its flap" width="120">
</p>

<h1 align="center">pylos-mcp</h1>

<p align="center"><strong>Your mail client shows you the message. pylos-mcp shows your assistant what it hides.</strong></p>

<p align="center"><em>Read-focused, prompt-injection-hardened email MCP server for any IMAP provider.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/pylos-mcp"><img src="https://img.shields.io/npm/v/pylos-mcp" alt="npm version"></a>
  <a href="https://github.com/adamVass/pylos-mcp/actions/workflows/ci.yml"><img src="https://github.com/adamVass/pylos-mcp/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/pylos-mcp" alt="MIT license"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/xray-dark.svg">
    <img src="assets/readme/xray-light.svg" width="880" alt="An account-security message from 'Lumen Pay Security' as a mail client shows it. pylos-mcp finds a Cyrillic letter posing as a Latin one in the sender's name, a Reply-To pointing at another domain, a hidden instruction telling the AI assistant to forward every invoice, and a hidden base64 payload. The message reaches the assistant fenced as data, not instructions, with a Warnings line naming all of it.">
  </picture>
</p>

Anyone in the world can put text in your inbox, and the moment an AI assistant reads that inbox, anyone in the world can put text in front of your assistant. pylos-mcp is built around that fact. It lets Claude, or any MCP client, search, read and draft your mail while treating every message as input from a stranger, and it points out what a message is hiding before the assistant acts on it.

- **Fenced, then flagged.** Every message reaches the assistant fenced as data, and when something is off a Warnings line in the server's own words names it: hidden text, phrases aimed at an AI, encoded blobs, a Reply-To on another domain, lookalike letters.
- **Reads and drafts by default.** Moving, sending and deleting are separate switches that stay off until you flip them. Even with sending on, every send is refused until `SEND_ALLOWLIST` names who may be addressed, and there is no `bcc` field anywhere.
- **Runs on your machine over plain IMAP.** Gmail, iCloud, Yahoo, GMX, Fastmail, mailbox.org, Posteo, Proton via Bridge or anything self-hosted. Your password is sent only to your mail server.

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

Use an app password, not your account's regular login password. [Provider setup](#provider-setup) says which providers insist on one. Restart the client and the read and draft tools appear. Later config changes need the same full restart, since a newly enabled capability registers its tools only at startup, and in Claude Desktop toggling the server off and on is not always enough.

## What this can never do

Mail is attacker-controlled text, so the hard limits live in the architecture rather than in a prompt. No message can talk the server out of any of these.

- **No raw HTML ever reaches the model.** Bodies come from the plain-text part when one exists or are converted to text otherwise. Invisible characters that hide instructions from a human reader while staying readable to a model are stripped.
- **Untrusted content is fenced.** Everything from the mailbox, bodies, subjects, sender names, folder listings, Sieve script text, is wrapped in a labeled delimiter before the model sees it, and the delimiter is neutralized inside the content, so a message cannot forge its way out of the fence. The few lines outside it are server-authored and never carry message content.
- **No `bcc` field exists anywhere**, on drafts or sent mail. A bcc recipient receives a full copy of a message while appearing nowhere in it, exactly the invisibility an injected email wants. The field is absent rather than guarded, so there is nothing to talk the model into.
- **Deleting a message moves it to Trash.** There is no expunge and no permanent-delete option, and the tool result never claims a permanence this server does not offer.
- **Sieve access is read-only, permanently.** Server-side filter rules can forward, auto-reply and notify, each an exfiltration channel that survives revoking the app password or uninstalling this server. Write access is left out entirely, not defended.

Sending is the other risky door, so it starts closed even with the `send` capability on. Every send is refused until `SEND_ALLOWLIST` says who may be addressed, and the refusal names the two ways to open the gate. `SEND_ALLOWLIST=*` allows anyone, visibly and on purpose.

Fencing reduces prompt-injection risk, nothing eliminates it. The model still reads text written by strangers, so treat every response that includes message content as untrusted input, not ground truth. The finer design notes live in [SECURITY.md](SECURITY.md).

## Suspicion warnings

The server also tells the assistant what is suspicious about a message. Five detectors annotate `get_email` results with a line above the content, written entirely in the server's own words and never quoting the content that tripped them. The image above shows all five firing on one message.

```
Warnings: hidden_text (412 hidden characters via display:none), encoded_blob (base64 run of 600 characters)
```

- **Hidden text.** Text concealed with the common CSS tricks, `display:none`, invisible or one-pixel fonts, matching text and background colors, off-screen positioning, `aria-hidden`. It checks inline styles and attributes, a tripwire rather than a rendering engine. Newsletters legitimately hide short preview text, so the warning fires only past a threshold, unless the hidden text contains an instruction-like phrase or an encoded run, which warns at any length. The text stays in the body by default, and `STRIP_HIDDEN_TEXT=true` drops it with a note of how much went.
- **Instruction patterns.** A deliberately small set of phrases that address an AI as an instruction target, like "ignore previous instructions". Small so that an inbox merely talking about AI stays quiet. Extend it with `FLAG_EXTRA_PATTERNS`, pipe-separated phrases matched as case-insensitive literals. Subjects, sender lines and attachment names are checked as well as the body, and extra spaces or line breaks inside a phrase do not hide it.
- **Encoded blobs.** Long contiguous base64 or hex runs in the body, reported with their length and never decoded.
- **Sender mismatch.** A Reply-To address on a different domain than the From address, or a From display name carrying an address on a domain the real sender does not use. Subdomains count as the same domain, so a provider replying from one of its own stays quiet. The Reply-To address itself is shown inside the fenced content, so the model can see where a reply would actually go.
- **Mixed scripts.** Words that mix Latin letters with Cyrillic or Greek letters drawn to look like Latin ones, such as a "paypal" spelled with a Cyrillic а. Only lookalike letters count, so units like `μm` and ordinary Russian or Greek text stay quiet.

Warnings annotate, they never withhold. The message always comes back, and each detector has its own toggle in the reference below.

## Provider setup

Set `PROVIDER` to one of `gmail`, `icloud`, `yahoo`, `gmx`, `fastmail`, `mailbox.org` or `posteo` and the matching IMAP, SMTP and Sieve hosts and ports fill themselves in.

Gmail, iCloud, Yahoo and Fastmail refuse regular account passwords over IMAP, so an app password is the only way in. Google only offers one once 2-Step Verification is on, and iCloud wants two-factor authentication on the Apple ID first. mailbox.org, GMX and Posteo accept the account password, though an app password is still the wiser choice.

Proton Mail goes through Bridge. Leave `PROVIDER` unset and set `IMAP_HOST` and `IMAP_PORT` to what Bridge shows. The username is the address Bridge tells you to use, and the password is the one in Bridge's Mailbox details, IMAP section, not your Proton account password. Bridge defaults to STARTTLS while this server only speaks implicit TLS, so switch Bridge to SSL in its Advanced Settings. Bridge's certificate is self-signed, so export it and point `TLS_CA_FILE` at it.

Self-hosted servers also leave `PROVIDER` unset. Set `IMAP_HOST`, plus `SMTP_HOST` or `SIEVE_HOST` when those optional tiers are enabled, and authenticate however your server requires. For a private CA, point `TLS_CA_FILE` at the CA certificate. Verification itself always stays on, this only adds a trust anchor.

## Capabilities

Capabilities are independent switches, not a ladder. Reading is always on, drafting starts on, everything else stays off until you list it in `CAPABILITIES`. A switched-off tier has its tools left out of the tool list entirely, not merely refused, so a model never learns a disabled tool exists.

| Tier | Default | Tools |
|---|---|---|
| `read` | always on | `search_emails`, `get_email`, `get_attachment`, `list_folders` |
| `drafts` | on | `create_draft` |
| `manage` | off | `move_email`, `set_flags` |
| `send` | off | `send_email` |
| `delete` | off | `delete_email` |
| `sieve-read` | off | `list_sieve_scripts`, `get_sieve_script` |

Enable more with a comma-separated list, for example `CAPABILITIES=drafts,manage,delete`.

Moving a message into Trash is a delete by another route, so `move_email` refuses Trash unless `delete` is on too.

## Configuration reference

All configuration is environment variables, validated at startup. Invalid configuration fails immediately with an actionable message, never partway through a conversation. An empty value counts as unset, since bundle managers fill optional fields users leave blank with empty strings.

| Variable | Default | Notes |
|---|---|---|
| `PROVIDER` | none | One of `gmail`, `icloud`, `yahoo`, `gmx`, `fastmail`, `mailbox.org`, `posteo`. Fills in IMAP, SMTP and Sieve hosts and ports. |
| `EMAIL_USER` | required | Account login. |
| `EMAIL_PASSWORD` | none | App password. Either this or `EMAIL_PASSWORD_CMD` is required. |
| `EMAIL_PASSWORD_CMD` | none | Command whose stdout is the password, such as a keychain lookup or `pass`, so the secret never sits in the client's config file. It has 60 seconds to finish. |
| `IMAP_HOST` / `IMAP_PORT` | preset / `993` | Explicit values for self-hosted servers. Set either to override the preset. |
| `SMTP_HOST` / `SMTP_PORT` | preset / `465` | Required only when `send` is enabled. |
| `SIEVE_HOST` / `SIEVE_PORT` | `IMAP_HOST` / `4190` | Used only when `sieve-read` is enabled. |
| `CAPABILITIES` | `drafts` | Comma-separated list of tiers beyond `read`, which is always included. |
| `MAX_BODY_KB` | `64` | Message body truncation limit. |
| `MAX_ATTACHMENT_MB` | `25` | Attachment size cap, checked against the size the server declares before any bytes are downloaded. |
| `DOWNLOAD_DIR` | `~/Downloads` | Where `get_attachment` writes files. |
| `SEND_SESSION_CAP` | `5` | Successful `send_email` calls allowed per server process lifetime. |
| `SEND_SAVE_COPY` | `true` | Append a copy of each sent message to the Sent folder, marked read. Turn off for providers that already file sent mail server-side (Gmail does), which would otherwise show duplicates. |
| `SEND_ALLOWLIST` | none (sending closed) | Comma-separated addresses or `*@domain` patterns, or `*` alone to allow anyone. With `send` enabled and no value set, every send is refused and the refusal explains this variable. An explicitly empty value also allows nobody. An entry that could never match, such as a bare domain, fails at startup. |
| `DRAFTS_NO_RECIPIENTS` | `false` | When `true`, `create_draft` rejects `to` and `cc` entirely. Drafts carry no addressing and get it added later in your mail client. |
| `FLAG_HIDDEN_TEXT` | `true` | Warn when message HTML hides text with inline styles or `aria-hidden`. |
| `FLAG_INSTRUCTION_PATTERNS` | `true` | Warn when the body, subject, sender line or attachment names contain phrases addressing an AI as an instruction target. |
| `FLAG_ENCODED_BLOBS` | `true` | Warn on long contiguous base64 or hex runs in the body. |
| `FLAG_SENDER_MISMATCH` | `true` | Warn when a Reply-To address sits on a different domain than the From address, or the From display name carries an address on another domain. |
| `FLAG_MIXED_SCRIPT` | `true` | Warn when a word mixes Latin letters with Cyrillic or Greek lookalikes. |
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

No test in this project connects to a real mailbox, in development or in CI. The integration run seeds its own Dovecot container with synthetic fixture messages and removes it when finished.
