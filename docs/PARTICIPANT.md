# Joining a meeting as a participant

The notes bot (`start_meeting`, `get_transcript`) only listens and posts chat. Participant mode is the other body: your assistant sits in the meeting as a person. It has a name, a camera card, and a microphone. You are the brain. This server hears, speaks, and holds the mute button.

People who have no private speech stack can still use it. Speech-to-text and text-to-speech run on the same machine, with open-source defaults, and either one can be replaced with an HTTP endpoint.

## Tools

| Tool | What it does |
|---|---|
| `join_meeting_as_participant` | `url`, optional `password`, `display_name`, optional `avatar` (image or GIF path or URL). Joins `/run.html#v=…` or `/meet/…` with a live mic track and a camera track. The display name always keeps a 🤖 badge (GifOS keeps 40 characters, and the badge survives that cut). The default camera is a generated robot card. |
| `get_new_utterances` | New lines since `since` (an utterance id or a millisecond timestamp). Each line is `{id, speaker, text, t_start, t_end}` with millisecond timestamps. Also returns `{speaking_now, last_speech_end_ms, silence_ms, turn_hint}`. `turn_hint` is `your_turn` or `wait`. `wait_ms` long-polls up to 30 seconds. |
| `say` | Speaks `text` into the mic. Optional `voice`. `interruptible` defaults to true: if a remote person starts talking, playback stops and the result is `{interrupted: true, spoken_until_ms}`. |
| `stop_speaking` | Cuts the current line. |
| `send_chat` | Posts a chat line. |
| `raise_hand` | `on: true` raises, `on: false` lowers. |
| `set_mic`, `set_camera` | `on: true` or `false`. |
| `get_meeting_state` | Participants, who is talking, hand, mic, camera, and whether the join disclosure has been spoken. |
| `snapshot` | Read-only. Same facts as `get_meeting_state`, plus recent transcript lines. Saves a PNG of the current view under the meeting folder and appends a `snapshot` line to the transcript. |
| `leave_meeting` | Leaves. |

There is one participant session at a time. Joining again leaves the previous meeting. The notes bot is a separate browser and is unchanged.

Load the prompt `meeting_participant_etiquette` before taking part. It has two roles. The speaking loop may only call `say`, `stop_speaking`, and `snapshot`. The outer agent subscribes to the transcript resource and may call `send_chat`, `raise_hand`, `set_mic`, `set_camera`, and `leave_meeting`. Both roles wait for `your_turn`, keep replies to one to three sentences, say they are an AI assistant, do not record or transcribe without disclosing it, keep the 🤖 badge, and do not speak over people.

## What people in the room see and hear

When another person is actually in the room, the server sends this in chat and says a shorter version out loud:

> I'm an AI assistant. I transcribe speech in this meeting so I can take part, and I'm telling you that here. I am not recording. I'll leave if you ask.

A line sent before the other person connects never reaches them, so the server says it when they appear, and it repeats the chat line for each new person. The spoken line is once per join.

The server does not transcribe its own voice. It also drops the short filler lines speech models invent on silence ("thank you", "thanks for watching", and similar).

## How hearing works

Each remote participant's audio track is tapped on its own. The track is the one on that person's tile, and the name is the name on that tile. A mixed room bus is not used, because a mix cannot be split back into speakers.

The ear taps three buses: each row tile (`.tile[data-peer] video`), the stage (`#stagefeed video` and `video.stageface`), and the stadium (`#stadium .rowtile video`). A line is stored with `lane` set to `row`, `stage`, or `stadium`. The bot's own microphone is not tapped.

Lines are kept only while the transcribing label is showing. `transcribingLabel()` turns captions on and reads the tile. If the label never appears, speech is dropped.

`turn_hint` stays `wait` while anyone is talking (including you), while a transcript line is still being recognized, or while the room has been quiet for less than `GIFOS_TURN_PAUSE_MS` (default 700). It becomes `your_turn` after that pause. Speak then, not before.

## Voice sidecar

On the first `join_meeting_as_participant`, this process creates a Python venv under `GIFOS_MCP_HOME/voice-venv` and starts a sidecar on `127.0.0.1` with a random port and a bearer token. The same sidecar is reused until the process exits. It is not a shared server. Weights are downloaded into the cache on first use and are not in this repo.

`GET /health` reports the engines and a self-test real-time factor. `POST /tts` streams 16-bit PCM, one clause at a time: the first short clause (about four words when the opening sentence is long) is synthesized immediately, and the next clause is synthesized while the current one plays. `POST /stt` accepts a wav or a per-speaker PCM chunk and returns newline-delimited JSON with `partial` and `final` lines. Speech is segmented per speaker with Silero, and an utterance ends after 500 ms of silence. faster-whisper is given a numpy audio array, not a file path.

The meeting page plays that PCM into the microphone. When the https page cannot fetch `127.0.0.1` itself, the participant process pulls the same stream and hands chunks to the page. Either way the audio comes from the local sidecar.

## Live transcript

Each meeting writes `GIFOS_MCP_HOME/meetings/<id>/transcript.jsonl` and a plain-text view beside it. A line is `{seq, ts, speaker, text, kind}` and `kind` is `speech`, `chat`, `bot`, `snapshot`, or `event`. The MCP resource is `gifos://meeting/<id>/transcript` (`application/x-ndjson`). A client can subscribe and receive `notifications/resources/updated`. `get_new_utterances` remains the polling fallback. `snapshot` stores its PNG under that meeting folder and logs the relative path.

## Speech engines

Numbers below were measured on a stock 8-vCPU / 15 GB CPU-only agent box. See [STT-BENCH.md](STT-BENCH.md).

Default text-to-speech is Kokoro-82M int8 through [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) (Apache-2.0). The model is about 92 MB and the voices file about 28 MB. Load was 0.7 s. First audio was 0.24 s for a 20-character sentence and 0.62 s for an 80-character sentence. Real-time factor was about 0.15. Resident memory was about 577 MB. Kokoro phonemizes with espeak-ng. That data is GPL and is an optional downloaded dependency. It is never vendored here.

Default speech-to-text is faster-whisper `base.en` int8, 4 threads, beam 1, VAD on. An 11-second clip took about 0.44 s with a word error rate of 0% on the JFK line ("And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country."). Resident memory was about 386 MB. `GIFOS_STT_MODEL=tiny.en` is the small-box model. `small.en` is the accuracy model. Do not use `distil-small.en`.

| Variable | Default | What it selects |
|---|---|---|
| `GIFOS_TTS` | `kokoro` | `kokoro`, `piper`, or `espeak`. `GIFOS_TTS_ENGINE` is the same switch. |
| `GIFOS_TTS_URL` | empty | OpenAI-compatible `POST /v1/audio/speech`, or a JSON `{text, voice}` endpoint. |
| `GIFOS_TTS_VOICE` | `af_heart` | Kokoro voice name, or a Piper onnx path when `GIFOS_TTS=piper`. |
| `GIFOS_STT` | `faster-whisper` | `faster-whisper` or `whisper.cpp`. `GIFOS_STT_ENGINE` is the same switch. |
| `GIFOS_STT_URL` | empty | OpenAI-compatible `POST /v1/audio/transcriptions`, or a wav-in JSON-out endpoint. |
| `GIFOS_STT_MODEL` | `base.en` | `tiny.en`, `base.en`, or `small.en`. |
| `GIFOS_STT_THREADS` | `4` | Capped at 8. |
| `GIFOS_VAD_END_MS` | `500` | Trailing silence that closes one utterance in the sidecar. |
| `GIFOS_TURN_PAUSE_MS` | `700` | Quiet time before `turn_hint` becomes `your_turn`. |
| `GIFOS_VOICE_PORT` | random | With `GIFOS_VOICE_TOKEN`, reuse a sidecar that is already listening on `127.0.0.1`. |

Piper is the fast fallback for a weak host (`GIFOS_TTS=piper`, for example `en_US-lessac-medium`). On that same box, first audio was under 70 ms and the real-time factor was 0.017. piper1-gpl is GPL-3.0, so Piper is a subprocess only, and only when you select it. Check the voice `MODEL_CARD` license before you ship a voice. espeak-ng is the floor (`GIFOS_TTS=espeak`), also a subprocess. whisper.cpp stays available as `GIFOS_STT=whisper.cpp` and is not the default.

`say`'s `voice` argument is a Kokoro voice name, or a Piper model path when Piper is selected. Anything else uses the default voice.

## Try it

```sh
export GIFOS_URL=https://your-gifos
export GIFOS_RELAY=wss://your-relay   # omit to use the site default
export GIFOS_MCP_HOME=$HOME/.gifos-mcp
node bin/gifos-mcp.js
```

Ask the assistant to join a meeting link as "Helper". The tile should read `Helper 🤖`. When you speak, `get_new_utterances` returns your words under your display name. `say` talks back through the tile's microphone.

The permanent check is `npm run test:participant` (it needs `GIFOS_URL`, `GIFOS_RELAY`, and `GIFOS_MCP_HOME`). It does not embed a host name. Unit tests cover the pause logic and the engine choice with no network: `npm test`.
