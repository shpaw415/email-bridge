# Email Bridge — configuration guide

Email Bridge connects one or several mailboxes (IMAP + SMTP) so the agent can check unread mail, read, search, send, reply, forward and archive. Accounts are managed on the **Email dashboard tab**; the CLI picks the default account unless `--account` is passed. No secret ever lives in the manifest.

## What the plugin needs

1. One or more **accounts**: provider (gmail | yahoo | outlook | custom), address, app password — added on the Email dashboard tab (any mix of providers; the first account becomes the default, switchable).
2. Single-account alternative: the plugin settings `email-address` + `email-password` (used when no dashboard accounts exist).

## Adding accounts (preferred: Email dashboard tab)

Open the Email tab: add an account (provider, address, app password; custom servers only for provider `custom`), press **Tester** to prove auth (folder list), star the default with **Défaut**. Each account is stored under `~/.open-bot/pages-data/email-bridge/accounts.json` (chmod 600; the app password is needed for IMAP/SMTP login — never the login password).

App passwords: Gmail — Google Account → Security → 2-Step Verification → App passwords. Yahoo — Account Security → Generate app password. Outlook — account.microsoft.com → Security → Advanced → App passwords.

Single-account fallback from the shell (two separate calls):

```sh
ob-plugin settings email-bridge email-address=you@example.com
ob-plugin settings email-bridge email-password=XXXXXXXXXXXXXXXX
```

## Settings (Plugins tab → Email Bridge → Settings)

| Key | Type | Default | Notes |
|---|---|---|---|
| `provider` | enum | `gmail` | `gmail` \| `yahoo` \| `outlook` \| `custom` |
| `email-address` | string | empty | account to connect |
| `email-password` | secret | empty | app password |
| `imap-host` | string | empty | only for `custom` (e.g. `mail.mydomain.com`) |
| `imap-port` | number | `0` | only for `custom` (IMAP SSL is usually 993) |
| `imap-mode` | enum | `auto` | `auto`/`ssl` (implicit TLS, 993-style) \| `starttls` (port 143 servers) |
| `smtp-host` | string | empty | only for `custom` |
| `smtp-port` | number | `0` | only for `custom` (SSL 465, STARTTLS 587) |
| `smtp-mode` | enum | `auto` | `auto` \| `ssl` \| `starttls` |
| `insecure` | bool | `false` | accept self-signed TLS certificates (self-hosted servers only) |

## Ask → fill → verify order

1. Ask which provider and address. Do **not** ask them to create the app password alone.
2. Drive the setup on this thread's desktop: open the provider's app-password page (Gmail: https://myaccount.google.com/apppasswords ; Yahoo: account security ; Outlook: additional security) and click through it. Hand the screen over only for the account password, a 2FA code, or a captcha — then wait until they say they are done, and continue.
3. Save the 16-character app password on the account (Email tab). Never print it back.
4. Verify: `ob-plugin-email-bridge-email folders --account LABEL`, then a test send to the same address if they want.

## Proof it works

- `ob-plugin-email-bridge-email check` → lists unread messages with ids.
- `ob-plugin-email-bridge-email read <id>` → full body; reply/forward/mark from there.

Troubleshooting: auth errors usually mean the app password is wrong or 2FA/app-passwords are disabled on the account. `custom` provider errors usually mean wrong host/port or the server wants `starttls` instead of `ssl` (try `imap-mode=starttls` for port-143 servers, `smtp-mode=starttls` for port-587 servers).
