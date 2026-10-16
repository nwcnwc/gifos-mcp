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

- Launching headless Chromium, installing Meeting Bot and the speech-to-text and text-to-speech provider apps from the store, and calling `window.MeetingBot` (`src/driver.js`).
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

## Where the models live

GifOS holds the models. Settings → AI models writes `gifos_ai_config` in the computer's localStorage (not in a shareable backup). The rows this server sets are `smartest` (the text model; Settings has no row named `llm`), `tts`, and `stt`. Each row is either:

- A provider app: `{ app: fileId, appId, appName }`, written by `GifOS.providers.assign(role, { fileId, appId, name })`. The app must list the role under `provides.ai`, must not declare `capabilities.network` or `capabilities.api`, and its icon must sit in the Providers folder (`sys_providers`). `GifOS.providers.call(role, req)` mounts that app in a hidden sandbox and posts `{ ns: "gifos", type: "provider-request" }`.
- An endpoint: `{ url, key, model }`, "your own address and key". The host page fetches it. The app frame cannot: its CSP is `connect-src 'none'`.

Kokoro is the signed store app `offline-tts-kokoro`. On a fresh profile nothing is assigned, and Meet Bot's host refuses to speak until that app is installed and assigned (`Kokoro is not available on this computer.`). Speech-to-text is the same kind of assignment; transcription already installed `offline-stt-whisper` that way. This server now installs and assigns both during profile setup. It does not download weights, synthesize audio, or call a model. The first spoken line still waits on the provider's own download.

`MeetingBot.setVoice` receives roles, not addresses:

```js
MeetingBot.setVoice({
  respond_to_command: true,
  conversation_voice: "local", // "none" | "grok" | "local"
  llm: { provider: "smartest" },
  tts: { provider: "tts", engine: "kokoro", app: "offline-tts-kokoro", voice: "af_heart" },
  stt: { provider: "stt" }
})
```

`llm` and `tts` are included only for `conversation_voice: "local"`. `stt` is included when a speech-to-text app or `GIFOS_STT_URL` is set. The object never includes `llm.url`, `llm.key`, `tts.url`, or `stt.url`. The key is written into `gifos_ai_config` on the GifOS origin, which is where a person types it in Settings. It is not a tool result and it is not an argument of `setVoice`.

The published host (`js/host-voice.js` on gifos-app `cursor/meetbot-host-ops`) still stores a raw URL and fetches it from the host page. Meeting Bot v2 (`gifos-apps-source` `cursor/meetbot-voice-control`) copies `llm.url`, `llm.model`, and `llm.key` into the host and drops any other field. So the page would still have nothing to call if this server only assigned Settings. The driver adds an init script on the GifOS host page that wraps `HostVoice` after `host-voice.js` assigns it:

- A provider app becomes `gifos-provider://smartest` (no key). The wrapped fetch calls `GifOS.providers.call` and hands back one server-sent-event chunk. The wrapped speech function calls `GifOS.providers.call('tts')`.
- An endpoint is copied from `gifos_ai_config` into the host engine only.
- An https page never fetches an http URL itself. That call goes to `https://cors-proxy.gifos.app/` with header `x-gifos-target`. An https endpoint is fetched directly, so a key for that host is not sent to the proxy. An http page talking to localhost stays direct.

This script does not speak and does not contain a model client. Kokoro, or the assigned stand-in, does the speaking inside GifOS.

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

The chat call the host makes for an endpoint is streaming `POST {url}/chat/completions` with `model`, `messages`, and `stream: true`, and nothing else. No tools and no function calls. The key travels only as `Authorization: Bearer`, and only from the host page. Grok Voice (`"grok"`) is Meet Bot's own speech path. Kokoro is the default text-to-speech provider: the store app `offline-tts-kokoro`, voice `af_heart`, unless `GIFOS_TTS_APP` names another provider app, `GIFOS_TTS_URL` names an HTTP stand-in (`tts.engine` `"http"`, the URL stored in Settings, not in `setVoice`), or `GIFOS_TTS_ENGINE=none`. This server does not run Piper or any other speech program.

The key is not logged and not written into a tool result. A missing `setVoice` is reported as a gap. The page is left untouched.

Spoken `say` from the assistant, distinct from chat `share_content`:

```js
MeetingBot.interject(meetingId, text) // Promise<{ id, spoken: true }>
```

That line is the assistant cutting in. Meet Bot speaks it and it takes priority over conversation voice. This server does not synthesize it.

`set_voice` on the MCP side only changes the two switches. The URL, model, key, Kokoro choice, and speech or caption stand-ins always come from the environment, so a tool call cannot carry the key. Tool results name the engine (`kokoro`, `http`, or `none`) and, for Kokoro, the voice. They do not include `llm.url`, `llm.key`, `tts.url`, or `stt.url`.

| Env | Effect on the object above |
|---|---|
| `GIFOS_TTS_ENGINE` | `auto` or `kokoro` (the default) installs and assigns Kokoro. `none` assigns nothing for speech and wins over `GIFOS_TTS_URL`. Any other value is refused. |
| `GIFOS_TTS_APP` | Replaces `offline-tts-kokoro` with another store provider app. |
| `GIFOS_TTS_VOICE` | Replaces `af_heart` when the engine is Kokoro. |
| `GIFOS_TTS_URL` | An HTTP speech stand-in, stored as the `tts` endpoint in Settings. `setVoice` says `{ provider: "tts", engine: "http" }` and does not include the URL. |
| `GIFOS_STT_URL` | An HTTP caption stand-in, stored as the `stt` endpoint in Settings, and only when `GIFOS_STT_APP=none`. `setVoice` says `{ provider: "stt" }` and does not include the URL. v1 transcription still uses the store app. |
| `GIFOS_LLM_APP` | A store provider app assigned to `smartest`, instead of an OpenAI-compatible URL. Conversation voice `local` does not then require a URL. |

## Questions still open

1. The text model is assigned to Settings role `smartest`. Settings also has `cheapest`. This server does not set `cheapest`. Is `smartest` the role Meet Bot should use?
2. `js/runtime.js` fetches an AI endpoint directly and does not use the CORS proxy (a key would otherwise transit `https://cors-proxy.gifos.app`). Provider apps cannot fetch: a provider that declares network access is refused. For an http endpoint opened from `https://gifos.app`, this server's host script does use that proxy, because mixed content and a missing CORS preflight leave no other path. An https endpoint, including the suggested xAI host, is still fetched directly. Is sending an http endpoint's key through the public proxy acceptable, or should http endpoints be refused until the host broker grows its own proxy?
3. CONTROL.md v2 still documents raw `llm`, `tts`, and `stt` URLs on `setVoice`, and `js/meet-host.js` still pushes `stt.url` into the meeting session. This server has stopped sending them. The host script papers over that. Should `cursor/meetbot-host-ops` read `gifos_ai_config` itself, so this server can drop the script?
4. `GIFOS_LLM_APP` assigns a store provider to `smartest`. The requested setup is an OpenAI-compatible URL, model, and key. Is a provider app an allowed language model as well?
5. The first `say` after installing Kokoro waits while that app downloads its weights. Is that pause the expected one?

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
