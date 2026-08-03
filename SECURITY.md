# Security Policy

## Reporting a vulnerability

Do not open a public issue containing credentials, cookies, student data,
calendar export URLs, screenshots of private records, or authentication logs.
Use GitHub's private vulnerability reporting feature for this repository.

If a Moodle calendar URL was exposed, revoke/reset the calendar key in Moodle
immediately. If a password, TOTP seed, cookie, or token was exposed, rotate or
revoke it through the relevant official account page.

## Supported channel

Only the latest tagged release is supported during the pilot. Releases are
source-auditable, but pilot binaries are not yet code-signed. Broad distribution
is blocked until Authenticode signing and Google OAuth verification are in
place.

## Design boundaries

- Secrets never belong in chat, MCP results, logs, issues, screenshots, or
  calendar event content.
- Levnet mutations must use reviewed typed contracts and account-bound,
  single-use confirmation tokens.
- An ambiguous mutation outcome must be reconciled by a read, never blindly
  retried.
- Calendar deletion is driven only by complete successful source scans and a
  24-hour/two-scan grace period.
