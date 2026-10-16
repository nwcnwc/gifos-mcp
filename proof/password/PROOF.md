# Meeting password

A GifOS room password was accepted by `join_meeting`'s schema and handed to `bot.join`, but `create_meeting` and `start_meeting` had no password argument, nothing was stored, and `MeetingBotDriver.join` did not seed the meeting page. A bot that enters a locked room without the password sits alone at the door ("Just you").

No password is written in this file or in `before.txt` / `after.txt`.

## Before

Command: `node --test test/unit/password.test.js`

Result: 6 tests, 0 pass, 6 fail, 0 skipped (`proof/password/before.txt`, duration 578 ms).

Failures:

- `create_meeting` and `start_meeting` had no password argument.
- `create_meeting` did not store the password.
- `start_meeting` did not store the password it was given.
- `join_meeting` passed the password to the fake bot, then did not store it.
- The driver did not seed the password into the meeting page.
- The driver did not fill the password door modal.

## After

Same command: 6 pass, 0 fail, 0 skipped (`proof/password/after.txt`, duration 556 ms).

`npm test`: 24 pass, 0 fail, 0 skipped, duration 851 ms. No tests skipped.

## What changed

- `create_meeting` and `start_meeting` take an optional `password`. `join_meeting` still does, and now stores it.
- The password is written only in `GIFOS_MCP_HOME/meetings.json`. `save()` forces that file to mode 0600. `publicView` and `status` do not include it. Tool results say `locked: true` or `false`.
- `MeetingBotDriver.join` seeds `localStorage` key `gifos_vpw_<room>` (and `gifos_vpwat_<room>`) on the meeting page origin before `MeetingBot.join`, then passes the same password through. A verifier on the link becomes `gifos_vpw_<room>.<av>`.
- If the door modal is open (`#pw-modal` in join mode, title "This room is locked"), the driver fills `#pw-new` and presses Join.

## Locking

`window.MeetingBot` v1 can `join(link, password)`. It has no lock or set-password method (`start`, `status`, `create`, `join`, `list`, `people`, `transcribe`, `record`, `say`, `transcript`, `recording`, `leave` / `end`). This server does not call one. Seeding the key before the session iframe loads is what the page reads in `loadPw()`, so a room this bot founds is locked because the room key includes the password. A room someone else already opened without a password is not re-locked by that seed.
