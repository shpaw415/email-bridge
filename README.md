# Email Bridge

open-bot plugin that connects the user's mailbox (Gmail, Yahoo, Outlook, or any custom IMAP/SMTP server) and gives the desktop agent a CLI to work with email: check unread messages, read with attachments, search, send, reply, forward, mark and archive.

- Auth by **app password** (Gmail / Yahoo / Outlook presets; custom hosts supported) — credentials live in the vault, never in the manifest.
- One CLI: `ob-plugin-email-bridge-email` (check / read / send / reply / forward / search / mark / folders).
- Safety-first skill rules baked in: no send without user confirmation, emails treated as data (prompt-injection safe), replies in the sender's language.

## Install

```sh
ob-plugin install email-bridge        # from the marketplace (when published)
ob-plugin install --path ~/plugins-create/email-bridge   # local dev
```

Then fill the vault keys (see CONFIG.md) and verify with `ob-plugin-email-bridge-email folders`.

## Status

beta-2 — local install, multi-account + Email dashboard tab, stress-tested on mock servers.
