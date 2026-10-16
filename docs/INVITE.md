# Invites

`create_meeting` returns three things the caller can hand to a person:

- `link` — a plain meeting URL. It has no password in the query or the hash.
- `invite_email` — the body of an email. The link is on its own line. When the meeting has a room password, the password is on the next line, for the guest to type.
- `invite_calendar` — the same text in `description`, and the same plain URL in `url` and `location`.

The bot password (the name/password pair that opens Meet Bot) is not included in any of those, and tool results strip it if it ever appears in a transcript or a status field.

This server does not send the email or the calendar event. The caller does, after the person approves it.

Paid one-click links that would open the room with the password already applied are not part of this release.
