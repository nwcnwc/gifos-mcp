# Meet Bot bridge

gifos-mcp does not take part in a meeting. The only AI in the room is the signed **Meeting Bot** app from the GifOS app store, running in the headless browser this server already launches. This process starts that app, keeps it running, and passes commands through. It does not open a second participant, and it does not call a model.

The published pattern for "the real meeting page plus the app" is `js/meet-host.js` in [gifos-app](https://github.com/nwcnwc/gifos-app) (branch `meet-bot`). The host page fetches `run.html`, stamps `window.__gifosMb = "1"`, and loads that document in a same-origin session iframe. Meeting Bot never touches WebRTC. A search of the published gifos-app branch tips did not find `test/swarm/meet.js`. The host file above is the drive this server relies on.

Meeting Bot's own source and contract are [gifos-apps-source `meeting-bot/`](https://github.com/nwcnwc/gifos-apps-source/tree/meet-bot/meeting-bot), contract `window.MeetingBot.version === 1`, written up in that folder's `CONTROL.md`.

## Audit: what this branch duplicated

These pieces were added on `cursor/meeting-voice-streaming` and repeat work that belongs to Meet Bot (or to the meeting page it already drives):

| Piece | What it did | Why it does not belong here |
|---|---|---|
| `src/voice/talk.js` | Waited out a pause, sent the transcript to a chat model, and decided when the bot speaks. | Turn-taking and conversation are Meet Bot modes. |
| `src/voice/llm.js` | Called `POST /chat/completions` on an OpenAI-compatible host, with the user's key. | The server must hand that endpoint to Meet Bot as its local-LLM setting. It must not run the stream. |
| `src/voice/speech.js` | Called `/audio/speech` or `/tts` and turned the reply into audio. | Speech synthesis is Meet Bot's voice (Grok Voice, or a local model plus Kokoro). |
| `src/voice/clauses.js` | Split the model stream so the first words could play early. | That is part of speaking, which this server does not do. |
| `src/voice/mouth.js` | Replaced the meeting page microphone and played audio into the session. | The meeting page is driven by Meet Bot through `GifOS.meetHost`, not by a script this server injects. |
| `MeetingBotDriver.playEncoded` / `quiet` | Pushed that audio into `iframe[data-gifos-meet]`. | Same duplication. The driver may only call `window.MeetingBot`. |
| `say` speaking in the Node process | The assistant's line was synthesized here and played into the meeting. | `say` is a command this server passes through. |

Those files are not in this tree. `set_voice` calls `MeetingBot.setVoice` with the object below, and `say` calls `MeetingBot.interject`. If either method is missing, the tool reports the gap and does nothing else.

What stays, because it is management rather than participation:

- Launching headless Chromium, installing Meeting Bot and the speech-to-text app from the store, and calling `window.MeetingBot` (`src/driver.js`).
- Meeting links, mute of transcription, chat via `share_content`, and `end_meeting` (`src/server.js`).
- A live tail of `MeetingBot.transcript` for the assistant (`tail_transcript` and `gifos://meeting/{id}/transcript`). The tail only reads lines the app already stored.

## Two pipes

```
assistant  --MCP-->  gifos-mcp  --window.MeetingBot-->  Meeting Bot app
                                                          |
                                                          | gifos.meet  (postMessage, ns "gifos")
                                                          v
                                                       GifOS host page
                                                          |
                                                          | ns "gifos-meet"
                                                          v
                                                       real run.html session
```

The app frame is sandboxed. `connect-src 'none'` (see `APP_CSP` in gifos-app `js/runtime.js`). Meeting Bot's own tests refuse `fetch` and `WebSocket` in `app.js`. The app cannot call an LLM. The host page is the GifOS origin and is the only place a meeting, a model call, or Kokoro can run. gifos-mcp's Node process is neither of those.

### 1. App to host (`gifos.meet`)

Injected into the app by the runtime. Each call is `postMessage` `{ ns: "gifos", type: "meet", op, ... }` and comes back as `{ ns: "gifos", type: "reply", id, ok, result }`.

| `gifos.meet` | Host op | What the published host does |
|---|---|---|
| `join(room, passwordOrLink, name, opts)` | `join` | `GifOS.meetHost.join`. `opts.bot` defaults true. `opts.control` marks the admin meeting (`capabilities.remote`). |
| `leave(id)` | `leave` | Leaves and drops the session iframe. |
| `sendChat(id, text)` | `sendChat` | Chat line in that session. |
| `transcribe(id, on)` | `transcribe` | `setTranscribe`. The bot tile shows the transcribing chip. |
| `startRecording` / `stopRecording` / `getRecording` | same names | Recording on the session. |
| `sendXfer(id, file)` | `sendXfer` | Data-channel file toward the admin meeting. |
| `list()` | `list` | Sessions on this page. |
| `setControl(id)` | `setControl` | Which session's chat may carry remote commands. |
| `onTranscriptLine` / `onParticipants` / `onChat` / `onXfer` | events | Host posts `{ ns: "gifos", type: "meet-event", event }` to the app window. |

Unknown `op` values get `Unknown meet op.` There is no voice op.

### 2. Host to the real meeting page (`gifos-meet`)

`GifOS.meetHost.join` creates `iframe[data-gifos-meet]`, loads `run.html` as srcdoc, and speaks `postMessage` with `ns: "gifos-meet"`:

| Direction | `op` | Meaning |
|---|---|---|
| session → host | `ready` | Page is up. Host then sends `join`. |
| host → session | `join` | `room`, `link`, `password`, `name`, `bot`, `control`. |
| session → host | `joined` | `room`, `link`. Host resolves `meetingId`. |
| host → session | `leave`, `sendChat`, `transcribe`, `startRecording`, `stopRecording`, `getRecording`, `sendXfer` | One call, with `ref`. |
| session → host | `result` | `{ ref, result }`. |
| session → host | `error` | `{ ref, error }` or a failed join. |
| session → host | `event` | Forwarded to the app as a meet-event. `type: "chat"` is tagged `control` only for the admin session. |

There is no voice op on this pipe either.

### 3. Local control API (`window.MeetingBot`, version 1)

This is the only API gifos-mcp calls. It lives on the app frame (`#appmount iframe`), not on the meeting session. Methods return Promises. `start` and `status` work before RUN mode. The rest reject with "The bot is not running" until `start({ mode: "run", name, password })` has connected.

| Method | This server uses it for |
|---|---|
| `start({ mode: "run", name, password })` | Bring the bot up. |
| `status()` | `status` tool. |
| `join(link, password?)` | `start_meeting`, `join_meeting`. Returns `{ id, room, link }`. |
| `transcribe(id, on)` | `mute` / `unmute`. |
| `say(id, text)` | `share_content`. This posts **chat**, up to 2000 characters. It does not speak. |
| `transcript(id)` | `get_transcript` and the live tail. `{ id, lines: [{ by, text, at }], text }`. |
| `end(id)` / `leave(id)` | `end_meeting`. The bot leaves. Everyone else stays. |
| `list`, `people`, `create`, `record`, `recording` | Present on the app. This server does not need them for voice. |

Remote control (a second copy of the app in CONTROL mode, `gb1 ` JSON on the admin meeting) mirrors those ops. gifos-mcp does not use it. The bot name and password stay in `GIFOS_MCP_HOME/bot.json` and are not a tool result.

## Voice settings to hand over

Meet Bot is specified to have two switches. gifos-mcp only stores them and passes them in. It does not act on them.

| Switch | Values | Env on this server |
|---|---|---|
| Respond to commands | on or off | `GIFOS_RESPOND_TO_COMMAND` (`0` off, anything else on) |
| Conversation voice | `none`, `grok` (Grok Voice), `local` (local LLM, then Kokoro) | `GIFOS_CONVERSATION_VOICE`. If unset: `local` when `GIFOS_LLM_KEY` or `GIFOS_LLM_URL` is set, otherwise `none`. `GIFOS_VOICE=0` forces `none`. |

Local LLM settings, suggested default xAI Grok:

| Field | Env | Suggested value |
|---|---|---|
| OpenAI-compatible base URL | `GIFOS_LLM_URL` | `https://api.x.ai/v1` when a key is set and the URL is empty |
| Model | `GIFOS_LLM_MODEL` | `grok-4.20-0309-non-reasoning` on that host. Set it yourself for any other host. |
| Key | `GIFOS_LLM_KEY` | No default. The user's own key. |

The object passed to `MeetingBot.setVoice`, once that method exists:

```js
MeetingBot.setVoice({
  respond_to_command: true,
  conversation_voice: "local", // "none" | "grok" | "local"
  llm: {
    url: "https://api.x.ai/v1",
    model: "grok-4.20-0309-non-reasoning",
    key: "<the GIFOS_LLM_KEY value>"
  },
  tts: {
    engine: "kokoro", // or "http" or "none"
    app: "offline-tts-kokoro",
    voice: "af_heart"
  },
  stt: { url: "<GIFOS_STT_URL, only when that variable is set>" }
})
```

`llm` and `tts` are included only for `conversation_voice: "local"`. `stt` is included only when `GIFOS_STT_URL` is set. The chat call Meet Bot makes from that setting must be streaming `POST {url}/chat/completions` with `model`, `messages`, and `stream: true`, and nothing else. No tools and no function calls. The key travels only as `Authorization: Bearer`. Grok Voice (`"grok"`) is Meet Bot's own speech path. Kokoro is configuration for `"local"`: the store app `offline-tts-kokoro`, voice `af_heart`, unless `GIFOS_TTS_URL` names an HTTP stand-in (`tts.engine` `"http"` and `tts.url`) or `GIFOS_TTS_ENGINE=none`. This server does not install Kokoro, does not download weights, and does not run Piper or any other speech program.

The key is not logged, not written into a tool result, and not sent to the page unless `typeof MeetingBot.setVoice === "function"`. A missing method is reported as a gap. The page is left untouched.

Spoken `say` from the assistant, distinct from chat `share_content`:

```js
MeetingBot.interject(meetingId, text) // Promise<{ id, spoken: true }>
```

That line is the assistant cutting in. Meet Bot speaks it and it takes priority over conversation voice. This server does not synthesize it.

`set_voice` on the MCP side only changes the two switches. The URL, model, key, Kokoro choice, and speech or caption stand-ins always come from the environment, so a tool call cannot carry the key. Tool results name the engine (`kokoro`, `http`, or `none`) and, for Kokoro, the voice. They do not include `llm.url`, `llm.key`, `tts.url`, or `stt.url`.

| Env | Effect on the object above |
|---|---|
| `GIFOS_TTS_ENGINE` | `auto` or `kokoro` (the default) passes Kokoro. `none` passes `{ engine: "none" }` and wins over `GIFOS_TTS_URL`. Any other value is refused. |
| `GIFOS_TTS_VOICE` | Replaces `af_heart` when the engine is Kokoro. |
| `GIFOS_TTS_URL` | For local voice, `tts` is `{ engine: "http", url }` instead of Kokoro. This process does not request that URL. |
| `GIFOS_STT_URL` | `stt: { url }` on every `setVoice` call. v1 transcription still uses the store app in `GIFOS_STT_APP`. This process does not request the URL. |

## Gaps Meet Bot must gain

Contract v1 does not have these. Until it does, `set_voice` and `say` report the gap and do not imitate the feature.

1. **`window.MeetingBot.setVoice(settings)`** as specified above. Reject unknown `conversation_voice` values. Do not echo `llm.key` in the resolved value or in `status()`.
2. **`window.MeetingBot.interject(id, text)`** for a spoken line from the assistant. `say` stays chat.
3. **Respond-to-commands switch.** When on, a command heard in the room is answered by Meet Bot. When off, conversation may continue but commands get no spoken reply. gifos-mcp does not decide what a command is.
4. **Conversation voice `none`.** Meet Bot stays quiet. Transcription can still be on.
5. **Conversation voice `grok`.** Grok Voice, inside the meeting page Meet Bot already hosts. Not a socket from this Node process.
6. **Conversation voice `local`.** Stream the configured OpenAI-compatible chat model with no tools, then speak with Kokoro. The first audio should start from the first clause of the stream. The HTTP call cannot run inside the app frame (`connect-src 'none'`, and `meeting-bot/app.js` must not grow a `fetch`). It has to run on the GifOS host page, which already owns the session iframe, then play into that session. A new `gifos.meet` op (and the matching `gifos-meet` session op) is the place for "here is the voice setting" if the app must not see the key in its own heap. Either way the setting is Meet Bot's, not this server's loop.
7. **Do not write the bot's own voice into the transcript.** v1 already refuses the bot machine's microphone. Spoken voice has to keep that property, or the model will answer itself.
8. **Optional: push new transcript lines.** v1 only returns `transcript(id)` when asked. This server polls that. A `meet-event` of type `transcript` would remove the poll. It is not required for the handoff.
9. **`raiseHand(id, on)`**, **`setMic(id, on)`**, **`setCamera(id, on)`**. v1 has no hand, microphone, or camera. Until these exist, the matching tool reports the gap and does not click the meeting page.
10. **`meetingState(id)`** returning `{ hand, mic, camera }` (and people, if the app already has them). v1 `people(id)` still answers who is in the room.
11. **`snapshot(id)`**. Optional. This server also saves a PNG of the Meet Bot page it already has open. It does not open a second browser to take the picture.

No other voice stack should be added to gifos-mcp to paper over these gaps.

## Non-voice tools

These ride the same `window.MeetingBot` call. They do not open a participant browser, and they do not speak.

| Tool | Meeting Bot | When the method is missing |
|---|---|---|
| `send_chat` | `say(id, text)` — chat, the same call as `share_content` | v1 has `say`. |
| `leave_meeting` | `end(id)`. The transcript is saved first. Same result as `end_meeting`. | v1 has `end`. |
| `get_meeting_state` | `people(id)`, then `meetingState(id)` when it exists | People come from v1. Hand, microphone, and camera are a gap. |
| `raise_hand` | `raiseHand(id, on)` | Gap. The hand is left as it is. |
| `set_mic` | `setMic(id, on)` | Gap. v1 says the bot has no microphone. |
| `set_camera` | `setCamera(id, on)` | Gap. v1 says the bot has no camera. |
| `snapshot` | `snapshot(id)` when it exists, plus a PNG of the Meet Bot page | The PNG is still saved from the page this server already runs. The missing method is reported. The meeting is not changed. |
