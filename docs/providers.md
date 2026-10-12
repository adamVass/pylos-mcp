# Provider setup

[Back to the README](../README.md#provider-setup).

Set `PROVIDER` to one of `gmail`, `outlook`, `icloud`, `yahoo`, `gmx`, `fastmail`, `mailbox.org` or `posteo` and the matching servers and ports fill themselves in.

Gmail, iCloud, Yahoo and Fastmail refuse regular account passwords over IMAP, so an app password is the only way in. Google offers one once 2-Step Verification is on and the account's policy allows it, and iCloud wants two factor authentication on the Apple Account first. mailbox.org, GMX and Posteo accept the account password, though an app password is still the wiser choice.

## Outlook and Microsoft 365

Outlook.com and Microsoft 365 accounts use `PROVIDER=outlook` and no password, since Microsoft has switched password sign in off for mail clients. Outlook.com ships with IMAP off, so first turn it on under Settings, Mail, Forwarding and IMAP. The first time the assistant reads mail, your browser opens Microsoft's sign in page. Sign in, allow pylos-mcp to access your mail, then ask again. After that the sign in renews itself. No app registration of your own is needed.

pylos-mcp asks Microsoft for access to your mailbox over IMAP, which covers reading and changing mail, and to stay signed in. It asks for permission to send only once `send` is on, which is why enabling it later asks you to sign in once more. The sign in is kept in a file only you can read, in `~/Library/Application Support/pylos-mcp` on macOS, `%APPDATA%\pylos-mcp` on Windows and `$XDG_CONFIG_HOME/pylos-mcp`, usually `~/.config/pylos-mcp`, elsewhere. Deleting the file and restarting your MCP client signs pylos-mcp out.

### Work accounts

Most organizations let only an administrator approve an app like pylos-mcp. If the sign in page says you need admin approval, an administrator of your organization can approve it once for everyone by opening this link, which covers sending too. After approving, the page goes blank, which is expected.

```text
https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=45dd6df5-9736-4657-8111-fe9c810aba3b&redirect_uri=https%3A%2F%2Flogin.microsoftonline.com%2Fcommon%2Foauth2%2Fnativeclient&scope=https%3A%2F%2Foutlook.office.com%2FIMAP.AccessAsUser.All%20https%3A%2F%2Foutlook.office.com%2FSMTP.Send%20offline_access
```

Sending from a work account also needs SMTP AUTH allowed for the mailbox, which many organizations turn off. An administrator turns it on per mailbox in the Exchange admin center. Organizations that would rather use an app registered in their own tenant set `MS_CLIENT_ID` to its application ID and `MS_TENANT` to their tenant ID.

## Proton Mail and servers of your own

Proton Mail goes through Bridge. Leave `PROVIDER` unset and set `IMAP_HOST` and `IMAP_PORT` to what Bridge shows, with `IMAP_STARTTLS=true` for Bridge's default mode. The username is the address Bridge tells you to use, and the password is the one in Bridge's Mailbox details, not your Proton account password. Bridge signs its own certificate, so export it and point `TLS_CA_FILE` at it.

Your own server also leaves `PROVIDER` unset. Set `IMAP_HOST`, plus `SMTP_HOST` or `SIEVE_HOST` when those tiers are enabled. For a private CA, point `TLS_CA_FILE` at the CA certificate. Verification itself always stays on, this only adds a trust anchor.
