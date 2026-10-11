<p align="center">
  <img src="assets/logo/pylos.svg" alt="pylos-mcp logo, an envelope with a keyhole in its flap" width="120">
</p>

<h1 align="center">pylos-mcp</h1>

<p align="center"><strong>Your mail client shows you the message. pylos-mcp shows your assistant what it hides.</strong></p>

<p align="center"><em>An email MCP server for Gmail, Outlook and Microsoft 365, iCloud and any IMAP mailbox, built so that every message reaches your assistant as data, not instructions.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/pylos-mcp"><img src="https://img.shields.io/npm/v/pylos-mcp" alt="npm version"></a>
  <a href="https://github.com/adamVass/pylos-mcp/actions/workflows/ci.yml"><img src="https://github.com/adamVass/pylos-mcp/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/pylos-mcp" alt="MIT license"></a>
  <a href="https://www.bestpractices.dev/projects/15385"><img src="https://www.bestpractices.dev/projects/15385/badge" alt="OpenSSF Best Practices"></a>
</p>

<p align="center">
  <a href="https://github.com/adamVass/pylos-mcp/releases/latest/download/pylos-mcp.mcpb"><img src="https://img.shields.io/badge/Claude_Desktop-Download_bundle-D97757" alt="Download the Claude Desktop bundle"></a>
  <a href="https://cursor.com/install-mcp?name=pylos-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInB5bG9zLW1jcCJdLCJlbnYiOnsiUFJPVklERVIiOiJnbWFpbCIsIkVNQUlMX1VTRVIiOiJ5b3VAZXhhbXBsZS5jb20iLCJFTUFJTF9QQVNTV09SRCI6InlvdXItYXBwLXBhc3N3b3JkIn19"><img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Add to Cursor" height="20"></a>
  <a href="https://insiders.vscode.dev/redirect/mcp/install?name=pylos-mcp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22pylos-mcp%22%5D%2C%22env%22%3A%7B%22PROVIDER%22%3A%22gmail%22%2C%22EMAIL_USER%22%3A%22you%40example.com%22%2C%22EMAIL_PASSWORD%22%3A%22your-app-password%22%7D%7D"><img src="https://img.shields.io/badge/VS_Code-Install_server-0098FF" alt="Install in VS Code"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/xray-dark.svg">
    <img src="assets/readme/xray-light.svg" width="880" alt="An account security message from 'Lumen Pay Security' as a mail client shows it. pylos-mcp finds a Cyrillic letter posing as a Latin one in the sender's name, a Reply-To pointing at another domain, a hidden instruction telling the AI assistant to forward every invoice, and a hidden base64 payload. The message reaches the assistant fenced as data, not instructions, with a Warnings line naming all of it.">
  </picture>
</p>

Anyone in the world can put text in your inbox, and the moment an AI assistant reads that inbox, anyone in the world can put text in front of your assistant. pylos-mcp is built around that fact. It lets Claude, or any MCP client, search, read and draft your mail while treating every message as input from a stranger, and it points out what a message is hiding before the assistant acts on it.

- **Fenced, then flagged.** Every message is marked as data, and a Warnings line names what is off: hidden text, phrases aimed at an AI, lookalike letters, a failed DMARC check and more.
- **Reads and drafts by default.** Moving, sending and deleting stay off until you turn them on, sending only reaches addresses you list, and there is no `bcc` anywhere.
- **Runs on your machine, with your provider.** Gmail, Outlook and Microsoft 365, iCloud, Yahoo, GMX, Fastmail, mailbox.org, Posteo, Proton through Bridge, or a server of your own.

## Quick start

pylos-mcp runs locally through `npx` and needs Node.js 22 or later. Every route below starts from example values, so replace the address and password with your own. Use an app password, not your account's regular password. [Provider setup](#provider-setup) says where to get one.

**Claude Desktop.** Download [pylos-mcp.mcpb](https://github.com/adamVass/pylos-mcp/releases/latest/download/pylos-mcp.mcpb), open it, and fill in the form Desktop shows.

**Claude Code.** `--scope user` makes it available in every project. `EMAIL_PASSWORD_CMD` keeps the password out of your shell history and Claude's config: it runs a command that prints the password, here a macOS keychain lookup. Store the password there first with `security add-generic-password -s pylos-mcp -a you@example.com -w`, which asks for it.

```sh
claude mcp add pylos-mcp --scope user -e PROVIDER=gmail -e EMAIL_USER=you@example.com \
  -e EMAIL_PASSWORD_CMD="security find-generic-password -s pylos-mcp -w" -- npx -y pylos-mcp
```

**Cursor and VS Code.** Use the buttons above, then put your own values in the config they create.

<details>
<summary><b>Config files for Cursor, VS Code, Windsurf, Cline and other clients</b></summary>

Most clients, Cursor's `.cursor/mcp.json` and Claude Desktop's `claude_desktop_config.json` among them, take this entry:

```json
{
  "mcpServers": {
    "pylos-mcp": {
      "command": "npx",
      "args": ["-y", "pylos-mcp"],
      "env": {
        "PROVIDER": "gmail",
        "EMAIL_USER": "you@example.com",
        "EMAIL_PASSWORD": "your-app-password"
      }
    }
  }
}
```

VS Code's `.vscode/mcp.json` names the key `servers`:

```json
{
  "servers": {
    "pylos-mcp": {
      "command": "npx",
      "args": ["-y", "pylos-mcp"],
      "env": {
        "PROVIDER": "gmail",
        "EMAIL_USER": "you@example.com",
        "EMAIL_PASSWORD": "your-app-password"
      }
    }
  }
}
```

</details>

**Outlook and Microsoft 365** take `PROVIDER=outlook` and no password at all, so remove `EMAIL_PASSWORD` from the entry, or the server refuses to start. The first time the assistant reads mail, your browser opens Microsoft's sign in page.

Restart your client fully after any change, since tools register only at startup and toggling the server off and on is not always enough. Then ask the assistant to list your mail folders. A list means it works.

If the Claude Desktop extension shows "Server disconnected", the reason is in Desktop's `main.log` in `~/Library/Logs/Claude` on macOS or `%APPDATA%\Claude\logs` on Windows, on a line starting with `pylos-mcp:`.

## Capabilities

Capabilities are independent switches, not a ladder. Reading is always on, drafting starts on, and everything else stays off until you list it in `CAPABILITIES`. A tier that is off has its tools left out of the tool list entirely, so a model never learns they exist.

| Tier | Default | Tools |
|---|---|---|
| `read` | always on | `search_emails`, `get_email`, `get_thread`, `get_attachment`, `list_folders` |
| `drafts` | on | `create_draft` |
| `manage` | off | `move_email`, `set_flags` |
| `send` | off | `send_email` |
| `delete` | off | `delete_email` |
| `sieve-read` | off | `list_sieve_scripts`, `get_sieve_script` |

Enable more with a list, for example `CAPABILITIES=drafts,manage,delete`. Moving a message into Trash is a delete by another route, so `move_email` refuses Trash unless `delete` is on too.

`get_thread` lists the conversation a message belongs to: the messages it replies to, and the replies that name it or an earlier message in the thread, from its own folder, INBOX and Sent. It lists, and `get_email` reads, so every message still gets its own warnings. To answer a message, `create_draft` and `send_email` take `in_reply_to`, and the reply threads under the original in mail clients. Once a reply is sent, the original is marked as answered.

`search_emails` filters by free text, `from`, `to`, `subject`, `since` and `before` dates, and unread or flagged mail, and pages through long results. `get_email` shows when a message was sent and when it arrived, its Cc, and its Reply-To whenever that differs from From. With `manage` on, `set_flags` marks messages read, unread, flagged or unflagged.

`get_attachment` saves a file to `DOWNLOAD_DIR` without reading its contents into the conversation. Saved files are readable only by you, never replace an existing file, and on macOS carry the quarantine flag, so an app among them goes through Gatekeeper before it runs.

## How it compares

Email MCP servers usually exist to give an assistant access to mail. pylos-mcp is built for the case where the mail itself is the attacker. These are the gaps it closes.

| Where an email server can fall short | What pylos-mcp does |
|---|---|
| Message text, sometimes raw HTML, goes to the model as is, so a message's words can read like your requests | Converts mail to plain text, strips invisible characters and fences it as data, behind markers a message cannot forge |
| Hidden text, phrases aimed at an AI and lookalike letters reach the model unremarked | Names them on a Warnings line, along with a Reply-To on another domain and a failed DMARC check |
| A send tool can write to any address, sometimes with bcc | Sending is off by default, then refused until an allowlist names recipients, five sends per run by default, and no bcc field exists |
| An attach option that takes a path lets a message ask for any file on your disk | Attaches only files already in the mailbox, and no tool takes a path |
| Deleting can be permanent | Deleting moves to Trash, never expunges |
| Outlook and Microsoft 365 no longer accept passwords from mail clients, so servers that only take a password cannot reach them | Signs in through Microsoft's page in your browser, with no app registration of your own needed |
| A hosted server sees all your mail | Runs on your machine and connects only to your mail provider |

Fencing reduces prompt injection risk, and nothing eliminates it. The model still reads text written by strangers, so treat what the assistant says about your mail as a summary to check, not ground truth.

## Questions

**Does it work with Gmail?** Yes, over IMAP with an app password, which Google offers once 2-Step Verification is on and the account's policy allows it.

**Can the assistant send email on its own?** Only if you turn sending on and say who may be written to in `SEND_ALLOWLIST`: single addresses, a whole domain as `*@example.com`, or `*` for anyone. Out of the box it can read and write drafts, which you send yourself from your mail client.

**Is it safe to let an AI read my email?** Nothing makes it risk free, since a model can still be misled by what it reads. pylos-mcp narrows what a misled model can do and tells it what a message is hiding.

**Where does my mail go?** pylos-mcp connects to your mail provider, and with Outlook to Microsoft's sign in service. What the assistant reads goes to your AI client and, through it, to the model provider you use, as anything else you show your assistant does. Attachments you ask for are saved to your Downloads folder.

**Does it work with Claude Code, Cursor or VS Code?** Yes, and with any client that runs local MCP servers. See [Quick start](#quick-start).

## What this can never do

Mail is text an attacker controls, so the hard limits live in the architecture rather than in a prompt. No message can talk the server out of any of these.

- **No raw HTML ever reaches the model.** Bodies come from the plain text part when one exists, or are converted to text otherwise. Invisible characters that hide instructions from a reader while staying readable to a model are stripped.
- **Message content is fenced.** Bodies, subjects, sender names and Sieve scripts are wrapped in markers before the model sees them, and the markers are neutralized inside the content, so a message cannot forge its way out. The few lines outside them are written by the server. Where those repeat a short value from the mailbox, such as a folder name, it is cleaned and length capped first.
- **No `bcc` field exists anywhere**, on drafts or sent mail. A bcc recipient receives a full copy of a message while appearing nowhere in it, exactly the invisibility an injected email wants. The field is absent rather than guarded, so there is nothing to talk the model into.
- **Nothing from your disk is ever attached.** Drafts and sent mail can carry only attachments of messages already in the mailbox, named by folder, uid and part. No tool takes a file path, so a message asking the assistant to send your files has nothing to work with.
- **Deleting a message moves it to Trash.** There is no expunge and no permanent delete, and a server that cannot move messages is refused rather than worked around. What your provider later does with Trash is up to the provider.
- **Sieve access stays read only.** Filter rules on the server can forward, reply and notify, each a way out for your mail that survives revoking the app password or uninstalling this server. Write access is left out entirely, not defended.

Sending starts closed even with the `send` capability on. Every send is refused until `SEND_ALLOWLIST` says who may be written to, and the refusal names the two ways to open it. `SEND_ALLOWLIST=*` allows anyone, visibly and on purpose. The finer design notes live in [SECURITY.md](SECURITY.md).

## Suspicion warnings

The server also tells the assistant what is suspicious about a message. Six detectors annotate `get_email` results with a line above the content, written entirely in the server's own words and never quoting the content that tripped them. The image above shows five of them firing on one message.

```
Warnings: hidden_text (412 hidden characters via display:none), encoded_blob (base64 run of 600 characters)
```

- **Hidden text.** Text in the HTML body concealed with the common CSS tricks, such as `display:none`, invisible or tiny fonts, text matching its background, positioning off screen and `aria-hidden`. It checks inline styles and attributes, a tripwire rather than a rendering engine. Newsletters legitimately hide short preview text, so the warning fires only past a threshold, unless the hidden text contains an instruction or an encoded run, which warns at any length. `STRIP_HIDDEN_TEXT=true` drops it from the body, with a note of how much went.
- **Instruction patterns.** A deliberately small set of phrases that address an AI, like "ignore previous instructions", kept small so that an inbox merely talking about AI stays quiet. Subjects, sender lines and attachment names are checked as well as the body, and extra spaces or line breaks inside a phrase do not hide it. `FLAG_EXTRA_PATTERNS` adds your own.
- **Encoded blobs.** Long runs of base64 or hex in the body, reported with their length and never decoded.
- **Sender mismatch.** A Reply-To on a different domain than From, or a From display name carrying an address on another domain. Subdomains count as the same domain, and the Reply-To address is shown inside the fence, so the model can see where a reply would actually go.
- **Mixed scripts.** Words mixing Latin letters with Cyrillic or Greek ones drawn to look like them, such as a "paypal" spelled with a Cyrillic а. Only lookalike letters count, so units like `μm` and ordinary Russian or Greek text stay quiet.
- **DMARC failure.** Your mail server checks whether a message really comes from the domain in its From line and records the result in the message's headers. When that check failed, `dmarc_fail` says so. Only a header carrying your provider's own server name counts, and the topmost one with a DMARC result wins, since your provider adds its header above anything the sender wrote. The presets know that name for Gmail, Outlook and Microsoft 365, mailbox.org, GMX, Posteo and Fastmail, and `AUTHSERV_ID` sets it elsewhere.

Warnings annotate, they never withhold. The message always comes back, and each detector has its own switch in the reference below.

## Provider setup

Set `PROVIDER` to one of `gmail`, `outlook`, `icloud`, `yahoo`, `gmx`, `fastmail`, `mailbox.org` or `posteo` and the matching servers and ports fill themselves in.

Gmail, iCloud, Yahoo and Fastmail refuse regular account passwords over IMAP, so an app password is the only way in. Google offers one once 2-Step Verification is on and the account's policy allows it, and iCloud wants two factor authentication on the Apple Account first. mailbox.org, GMX and Posteo accept the account password, though an app password is still the wiser choice.

### Outlook and Microsoft 365

Outlook.com and Microsoft 365 accounts use `PROVIDER=outlook` and no password, since Microsoft has switched password sign in off for mail clients. Outlook.com ships with IMAP off, so first turn it on under Settings, Mail, Forwarding and IMAP. The first time the assistant reads mail, your browser opens Microsoft's sign in page. Sign in, allow pylos-mcp to access your mail, then ask again. After that the sign in renews itself.

pylos-mcp asks Microsoft for access to your mailbox over IMAP, which covers reading and changing mail, and to stay signed in. It asks for permission to send only once `send` is on, which is why enabling it later asks you to sign in once more. The sign in is kept in a file only you can read, in `~/Library/Application Support/pylos-mcp` on macOS, `%APPDATA%\pylos-mcp` on Windows and `$XDG_CONFIG_HOME/pylos-mcp`, usually `~/.config/pylos-mcp`, elsewhere. Deleting the file and restarting your MCP client signs pylos-mcp out.

<details>
<summary><b>Work accounts</b></summary>

Most organizations let only an administrator approve an app like pylos-mcp. If the sign in page says you need admin approval, an administrator of your organization can approve it once for everyone by opening this link, which covers sending too. After approving, the page goes blank, which is expected.

```text
https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=45dd6df5-9736-4657-8111-fe9c810aba3b&redirect_uri=https%3A%2F%2Flogin.microsoftonline.com%2Fcommon%2Foauth2%2Fnativeclient&scope=https%3A%2F%2Foutlook.office.com%2FIMAP.AccessAsUser.All%20https%3A%2F%2Foutlook.office.com%2FSMTP.Send%20offline_access
```

Sending from a work account also needs SMTP AUTH allowed for the mailbox, which many organizations turn off. An administrator turns it on per mailbox in the Exchange admin center. Organizations that would rather use an app registered in their own tenant set `MS_CLIENT_ID` to its application ID and `MS_TENANT` to their tenant ID.

</details>

<details>
<summary><b>Proton Mail and servers of your own</b></summary>

Proton Mail goes through Bridge. Leave `PROVIDER` unset and set `IMAP_HOST` and `IMAP_PORT` to what Bridge shows, with `IMAP_STARTTLS=true` for Bridge's default mode. The username is the address Bridge tells you to use, and the password is the one in Bridge's Mailbox details, not your Proton account password. Bridge signs its own certificate, so export it and point `TLS_CA_FILE` at it.

Your own server also leaves `PROVIDER` unset. Set `IMAP_HOST`, plus `SMTP_HOST` or `SIEVE_HOST` when those tiers are enabled. For a private CA, point `TLS_CA_FILE` at the CA certificate. Verification itself always stays on, this only adds a trust anchor.

</details>

## Configuration reference

All configuration is environment variables. They are checked when the server starts, so a typo fails at once with a message saying what to fix, rather than at the first tool call. An empty value counts as unset, since bundle managers fill optional fields left blank with empty strings.

<details>
<summary><b>All variables</b></summary>

| Variable | Default | Notes |
|---|---|---|
| `PROVIDER` | none | One of `gmail`, `outlook`, `icloud`, `yahoo`, `gmx`, `fastmail`, `mailbox.org`, `posteo`. Fills in IMAP, SMTP and Sieve hosts and ports. `outlook` signs in through the browser instead of a password. |
| `EMAIL_USER` | required | Account login. |
| `EMAIL_PASSWORD` | none | App password. Either this or `EMAIL_PASSWORD_CMD` is required, except with `outlook`, which takes neither. |
| `EMAIL_PASSWORD_CMD` | none | Command that prints the password, such as a keychain lookup or `pass`, so the secret never sits in the client's config file. It has 60 seconds to finish. |
| `MS_CLIENT_ID` | pylos-mcp's own | With `outlook` only. The application ID of an app registered in your organization's tenant. |
| `MS_TENANT` | `common` | With `outlook` only. Your tenant ID or domain, needed when `MS_CLIENT_ID` names an app registered for one tenant only. |
| `IMAP_HOST` / `IMAP_PORT` | preset / `993` | Explicit values for your own server. Set either to override the preset. |
| `IMAP_STARTTLS` | `false` | Connect in plain text and switch to TLS with STARTTLS before logging in, for servers that offer IMAP only that way. The default port becomes `143`. A server that will not switch is refused, so the login is never sent unencrypted. |
| `SMTP_HOST` / `SMTP_PORT` | preset / `465`, `587` for `outlook` | Required only when `send` is enabled. |
| `SIEVE_HOST` / `SIEVE_PORT` | `IMAP_HOST` / `4190` | Used only when `sieve-read` is enabled. |
| `CAPABILITIES` | `drafts` | Tiers beyond `read`, which is always included, separated by commas. |
| `MAX_BODY_KB` | `64` | Message body truncation limit. |
| `MAX_ATTACHMENT_MB` | `25` | Attachment size cap. A download is checked against the size the server declares before any bytes arrive. When composing, it caps all attachments of one message together, shared by every message being composed at once. |
| `DOWNLOAD_DIR` | `~/Downloads` | Where `get_attachment` writes files. |
| `SEND_SESSION_CAP` | `5` | Successful `send_email` calls allowed per server run, counted again from zero after a restart. |
| `SEND_SAVE_COPY` | `true` | Save a copy of each sent message to the Sent folder, marked read. Turn off for providers that already file sent mail themselves (Gmail does), which would otherwise show duplicates. |
| `SEND_ALLOWLIST` | none (sending closed) | Addresses or `*@domain` patterns separated by commas, or `*` alone to allow anyone. With `send` enabled and no value set, every send is refused and the refusal explains this variable. An explicitly empty value also allows nobody. An entry that could never match, such as a bare domain, fails at startup. |
| `DRAFTS_NO_RECIPIENTS` | `false` | When `true`, `create_draft` rejects `to` and `cc` entirely. Drafts carry no addressing and get it added later in your mail client. |
| `FLAG_HIDDEN_TEXT` | `true` | Warn when message HTML hides text with inline styles or `aria-hidden`. |
| `FLAG_INSTRUCTION_PATTERNS` | `true` | Warn when the body, subject, sender line or attachment names contain phrases addressing an AI. |
| `FLAG_ENCODED_BLOBS` | `true` | Warn on long runs of base64 or hex in the body. |
| `FLAG_SENDER_MISMATCH` | `true` | Warn when a Reply-To address sits on a different domain than the From address, or the From display name carries an address on another domain. |
| `FLAG_MIXED_SCRIPT` | `true` | Warn when a word mixes Latin letters with Cyrillic or Greek lookalikes. |
| `FLAG_DMARC_FAIL` | `true` | Warn when your own mail server's DMARC check failed. |
| `AUTHSERV_ID` | preset | Server names that start your provider's `Authentication-Results` headers, separated by commas, replacing the preset's. An entry starting with a dot matches any name ending in it. With none, `dmarc_fail` never fires. |
| `STRIP_HIDDEN_TEXT` | `false` | Drop detected hidden text from the body instead of only warning, with a note of how much was dropped. Needs `FLAG_HIDDEN_TEXT` on, and the combination with the detector off is refused at startup. |
| `FLAG_EXTRA_PATTERNS` | none | Phrases added to the instruction pattern set, separated by pipes, matched as literal text regardless of case. |
| `TLS_CA_FILE` | none | Path to a PEM CA certificate added as an extra trust anchor, for your own server with a private CA. Certificate verification cannot be turned off, this only extends what is trusted. Setting it trusts Node's bundled root store plus this file, so anchors added through `NODE_EXTRA_CA_CERTS` are not in that set. If you rely on those, point `TLS_CA_FILE` at the same certificate. |

</details>

## Maintenance expectations

pylos-mcp is built for the author's own daily use and maintained on that basis. Issues and pull requests are welcome, and [CONTRIBUTING.md](CONTRIBUTING.md) carries a wishlist of directions that would genuinely help. The scope stays narrow on purpose, so for anything wider than the security posture allows, a fork is the better home.

## Development

```
npm install
npm test                  # unit and MCP layer tests, entirely offline
npm run test:integration  # starts a disposable local Dovecot container, tests against it, tears it down
npm run build
```

No test in this project connects to a real mailbox, in development or in CI. The integration run seeds its own Dovecot container with made up messages and removes it when finished.
