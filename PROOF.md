# Proof: gifos-mcp end to end

These runs are from 2026-10-15 at commit `271634d`, on Linux x64 with Node v22.23.1 and Playwright 1.61.1
(Chromium 149, headless). Each one was run with `nice -n 10`.

## What ran

| Suite | Runs | Result |
|---|---|---|
| `npm test` (unit: config, all 10 tools with a fake bot, `--http` transport) | 1 | 18 pass, 0 fail, 0 skipped |
| `npm run test:e2e`, real Whisper speech-to-text (`E2E_STT=whisper`) | 5 | 18/18 PASS each, 55 to 81 s per run |
| `npm run test:e2e`, synthetic speech-to-text (`E2E_STT=synthetic`) | 3 | 18/18 PASS each, about 26 s per run |
| `npx -y github:nwcnwc/gifos-mcp` over stdio: list tools, `create_meeting` | 1 | OK |

## Setup

- GifOS: a `gifos-app` checkout of `release/0.9.23` (`006a702`), served on `127.0.0.1:19510`.
- Meeting Bot: packed from `gifos-apps-source` branch `meet-bot` (`47c3d2a`) and listed in that site's store.
  `gifos-mcp` installed it through the store page, the same way a person clicks Install.
- Speech-to-text: the store's Offline Captions (Whisper) app. `gifos-mcp` installed it into Providers and
  assigned it to speech-to-text. The Whisper model came from its pinned download.
- A local GifOS 0.9.23 relay on `127.0.0.1:19511`.
- "Alice" was a second headless Chromium whose fake microphone played an 11-second public-domain speech
  recording. She turned her mic on after joining.

## The flow each e2e run checks

`create_meeting` → `start_meeting` (install from store, RUN + CONTROL, join, transcribe) → `status` → Alice joins
and sees the 🤖 bot badge and the 📝 transcribing chip → `get_transcript` contains Alice's words →
`share_content` shows in Alice's chat → `mute` removes the chip → `unmute` → `list_meetings` → `end_meeting` →
the bot tile is gone → `get_transcript` still returns the saved text.

The transcript from Whisper run 1, as `get_transcript` returned it:

```
Alice: my fellow american
Alice: Ask not!
Alice: What your country can do for you
Alice: ask what you can do for your country.
```

## Screenshots (Whisper run 1)

| Alice sees the bot | Shared text in Alice's chat |
|---|---|
| ![bot tile](docs/screenshots/alice-sees-bot.png) | ![chat](docs/screenshots/alice-chat.png) |

| The bot's Meeting Bot window (RUN) | After `end_meeting` |
|---|---|
| ![run](docs/screenshots/bot-joined.png) | ![after](docs/screenshots/alice-after-end.png) |
