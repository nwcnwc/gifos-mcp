# Proof: gifos-mcp end to end

These runs are from 2026-10-15 at commit `e17a899`, on Linux x64 with Node v22.23.1 and Playwright 1.61.1
(Chromium 149, headless). Each one was run with `nice -n 10`.

## What ran

| Suite | GifOS site | Meeting Bot | Runs | Result |
|---|---|---|---|---|
| `npm test` (unit: config, all 10 tools with a fake bot, `--http` transport) | none | none | 1 | 18 pass, 0 fail, 0 skipped |
| `npm run test:e2e`, real Whisper speech-to-text | `gifos-app` `release/0.9.23` (`4c9fef4`) | packed from `gifos-apps-source` `meet-bot` (`2c2b080`) | 5 | 17/17 checks each, 47 to 54 s per run |
| `npm run test:e2e`, real Whisper speech-to-text | `gifos-app` `meet-bot` (`3217209`) | that site's own store listing | 2 | 17/17 checks each, 49 and 73 s |
| `npm run test:e2e`, synthetic speech-to-text | `release/0.9.23` (`4c9fef4`) | packed from `2c2b080` | 2 | 17/17 checks each, about 17 s per run |
| `npx -y github:nwcnwc/gifos-mcp#e17a899` over stdio: list tools, `create_meeting` | gifos.app | none | 1 | OK |

## Setup

- GifOS was served on `127.0.0.1:19510`. A local GifOS 0.9.23 relay ran on `127.0.0.1:19511`.
- `gifos-mcp` installed Meeting Bot through the GifOS store page, the same way a person clicks Install. It drove
  the bot through its local control API (`window.MeetingBot`, contract version 1).
- Speech-to-text: `gifos-mcp` installed the store's Offline Captions (Whisper) app into Providers and assigned it
  to speech-to-text. The Whisper model came from its pinned download.
- "Alice" was a second headless Chromium whose fake microphone played an 11-second public-domain speech
  recording. She turned her mic on after joining.

## The flow each e2e run checks

`create_meeting` → `start_meeting` (install from store, start RUN, join, transcribe) → `status` → Alice joins and
sees the 🤖 bot badge and the 📝 transcribing chip → `get_transcript` contains Alice's words → `share_content`
shows in Alice's chat → `mute` removes the chip → `unmute` → `list_meetings` → `end_meeting` → the bot tile is
gone → `get_transcript` still returns the saved text.

The transcript from Whisper run 1, as `get_transcript` returned it:

```
Alice: fellow America.
Alice: As not!
Alice: what your country can do for you, ask what you can do for your country.
```

## Screenshots (Whisper run 1)

| Alice sees the bot | Shared text in Alice's chat |
|---|---|
| ![bot tile](docs/screenshots/alice-sees-bot.png) | ![chat](docs/screenshots/alice-chat.png) |

| The bot's Meeting Bot tab (RUN) | After `end_meeting` |
|---|---|
| ![run](docs/screenshots/bot-joined.png) | ![after](docs/screenshots/alice-after-end.png) |

## Stage B: two workers, live (2026-10-17)

`GIFOS_APP_DIR=../gifos-app npm run test:e2e:stage-b` with `GIFOS_WORKERS=2`, one room per worker, against
`gifos-app` `release/0.9.23` (`546b855`) and its own Meeting Bot listing, synthetic speech apps, Node v22.23.3,
Playwright 1.61.1.

| Where the two people ran | Result |
|---|---|
| Local headless Chromium | 18/18 checks, 72 s |
| Two other Linux machines (`E2E_HUMAN_WS`, ports forwarded so pages stay on 127.0.0.1) | 20/20 checks, 78 s (adds the mic-on check per person) |

Both meetings start at once and land on different workers. Each person sees only that worker's bot
(`<name>` and `<name>-w1`). Each transcript holds only its own room's person. Chat from the worker-1 bot is
stored under `<name>-w1`, and no bot name shows up as speech. Chat shared in one room does not reach the other.
`SIGKILL` on worker 1 drops its room to `scheduled` and the person there sees the bot leave, while worker 0's room
stays live. `start_meeting` seats the room again on the restarted worker 1.

Cost per worker (its Node process, Chromium, and every child), sampled over 5 s on a 12-core machine:

| | RSS | CPU (one core = 100%) |
|---|---|---|
| One room, bot alone | 1.26–1.31 GB | 11–16% |
| One room, one person talking | 1.07–1.17 GB | 9–46% |

`say` is not in this run: the 0.9.23 Meeting Bot listing has no `MeetingBot.interject`, so it reports that gap.

## Rooms per Chromium: load run (2026-10-17)

`GIFOS_APP_DIR=../gifos-app E2E_ROOMS=1,4,8 npm run test:e2e:load` at `999da12`, against `gifos-app`
`release/0.9.23` (`546b855`) and its own Meeting Bot listing, one worker (one Chromium, one Meeting Bot),
transcription on with the synthetic speech-to-text app, conversation voice off. Node v22.22.1, Playwright 1.61.1,
a 32-core, 61 GB Linux machine. The people ran in two browsers, one on that machine and one on another machine
(port-forwarded), and are not counted. Cost is the `gifos-mcp` process and its whole tree (Chromium included),
sampled over 10 s. PSS splits pages shared between Chromium's processes; summed RSS counts them once per process.
Two runs, both 13/13 checks (every room live, `status` shows every session, each person sees one bot, every
transcript holds its own person and nobody else, every room ends).

| Rooms | Bot alone: PSS / RSS | Bot alone: CPU | One person talking in each: PSS / RSS | Talking: CPU | `gifos-mcp` alone RSS |
|---|---|---|---|---|---|
| 1 | 906–927 / 1415–1440 MB | 8% | 657–660 / 1215 MB | 82–83% | 153–156 MB |
| 4 | 745 / 1281–1282 MB | 16–17% | 744–794 / 1319–1365 MB | 142–165% | 159–162 MB |
| 8 | 836–843 / 1374–1378 MB | 25–28% | 928–962 / 1509–1544 MB | 211–233% | 169–171 MB |

CPU is percent of one core. Meeting Bot keeps every room in the same 9 processes, so memory hardly grows with
rooms (about 40 MB PSS per extra talking room from 1 to 8); CPU does, about 20% of a core per extra talking room
after the first room's ~80%. This run does not set the `GIFOS_MAX_MEETINGS` default: the synthetic speech-to-text
costs almost nothing, so the real Whisper cost per talking room, and two overlapping `say` calls (the 0.9.23
listing lacks `MeetingBot.interject`), are still to be measured.

### With Whisper (2026-10-17)

`E2E_STT=whisper E2E_SPEECH_WAV=<clip> E2E_EXPECT='budget|garden|morning|lunch' E2E_ROOMS=1,4,8 npm run test:e2e:load`
at `3b03cf3`, same machine, same `gifos-app` 0.9.23 tree, people split the same way. Transcription is the real
default, Offline Captions (Whisper). Each person's mic plays one 10.5 s spoken clip (made with this repo's Kokoro),
then 3 s of quiet, over and over; the site serves the clip, so the remote browser needs no copy. Two runs, both 13/13
checks: every one of the 8 rooms heard its own person in words ("Let us review the budget for the Garden Project
before we begin.", "the Garden project before lunch") and no room held anyone else's line. Run 1 sampled cost over
10 s, run 2 over 30 s.

| Rooms | Bot alone: PSS / RSS | Bot alone: CPU | One person talking in each: PSS / RSS | Talking: CPU | `gifos-mcp` alone RSS |
|---|---|---|---|---|---|
| 1 | 647–824 / 1160–1342 MB | 8–9% | 706–707 / 1258–1260 MB | 14–77% | 153–156 MB |
| 4 | 752–769 / 1288–1298 MB | 14–19% | 907–942 / 1469–1505 MB | 49–156% | 166–169 MB |
| 8 | 954–992 / 1492–1526 MB | 22–23% | 1428–2407 / 2008–2988 MB | 198–220% | 180–184 MB |

Whisper speech comes in bursts, so one sample window can land between them (one talking room read 77% over 10 s
and 14% over 30 s). At 8 talking rooms CPU is about 2 cores, the same as with the synthetic provider, still the
same 9 processes. Memory is new: with 8 rooms talking at once PSS reached 1.4 GB in run 1 and 2.4 GB in run 2,
where the synthetic provider stayed under 1 GB. Two runs do not show whether that levels off or keeps growing (a
caption backlog behind one shared engine would keep growing), so the `GIFOS_MAX_MEETINGS` default stays at 4 until
a longer run with 8 rooms talking answers it.
