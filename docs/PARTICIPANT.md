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
| `leave_meeting` | Leaves. |

There is one participant session at a time. Joining again leaves the previous meeting. The notes bot is a separate browser and is unchanged.

Load the prompt `meeting_participant_etiquette` before taking part. It says: wait for `your_turn`, keep replies to one to three sentences, say you are an AI assistant, do not record or transcribe without disclosing it, keep the 🤖 badge, leave when asked, and do not speak over people.

## What people in the room see and hear

When another person is actually in the room, the server sends this in chat and says a shorter version out loud:

> I'm an AI assistant. I transcribe speech in this meeting so I can take part, and I'm telling you that here. I am not recording. I'll leave if you ask.

A line sent before the other person connects never reaches them, so the server says it when they appear, and it repeats the chat line for each new person. The spoken line is once per join.

The server does not transcribe its own voice. It also drops the short filler lines speech models invent on silence ("thank you", "thanks for watching", and similar).

## How hearing works

Each remote participant's audio track is tapped on its own. The track is the one on that person's tile, and the name is the name on that tile. A mixed room bus is not used, because a mix cannot be split back into speakers.

In a two-person meeting, and among people who are direct peers, that is the real microphone of each person. In a large room, someone who is only present inside a stadium or stage mix is not separated here. Their voice is skipped rather than assigned to the wrong name. That is the gap this server does not close without a change to GifOS itself.

`turn_hint` stays `wait` while anyone is talking (including you), while a transcript line is still being recognized, or while the room has been quiet for less than `GIFOS_TURN_PAUSE_MS` (default 700). It becomes `your_turn` after that pause. Speak then, not before.

## Speech engines

Speech-to-text runs on the server, not in the browser. The default is [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`ggml-base.en-q5_1`, two CPU threads, no GPU), kept warm so the model loads once. The first use downloads the binary and the model into `GIFOS_MCP_HOME/models`. Numbers are in [STT-BENCH.md](STT-BENCH.md).

| Variable | Default | Replaces |
|---|---|---|
| `GIFOS_STT_URL` | empty | POST a wav, get JSON `{"text":"..."}`. A URL ending in `/v1/audio/transcriptions` is sent as an OpenAI multipart request. |
| `GIFOS_STT_ENGINE` | `whisper.cpp` | `transformers` uses `@huggingface/transformers` on CPU if that package is installed. |
| `GIFOS_STT_MODEL` | `base.en` | `base.en` or `small.en` (quantized q5). |
| `GIFOS_STT_THREADS` | `2` | Capped at 8. |
| `GIFOS_WHISPER_BIN`, `GIFOS_WHISPER_MODEL` | downloaded | Point at a whisper.cpp build and a ggml model you already have. |

Text-to-speech default is [Piper](https://github.com/rhasspy/piper) with the `en_US-lessac-medium` voice, downloaded into the same models folder on first use. `espeak-ng` is the fallback when Piper cannot run (a binary on `PATH`, or the copy shipped inside Piper). `GIFOS_TTS_ENGINE=kokoro` uses the optional `kokoro-js` package.

| Variable | Default | Replaces |
|---|---|---|
| `GIFOS_TTS_URL` | empty | POST `{"text","voice"}` and read audio bytes back. A URL ending in `/v1/audio/speech` is the OpenAI speech body. |
| `GIFOS_TTS_ENGINE` | `piper` | `piper`, `espeak`, or `kokoro`. |
| `GIFOS_TTS_VOICE` | lessac medium | A Piper onnx model path, or the voice name your HTTP engine expects. |
| `GIFOS_PIPER_BIN` | downloaded | A Piper binary you already have. |
| `GIFOS_VAD_END_MS` | `450` | Trailing silence that closes one utterance. |
| `GIFOS_TURN_PAUSE_MS` | `700` | Quiet time before `turn_hint` becomes `your_turn`. |

`say`'s `voice` argument is a voice name for an HTTP engine, or a filesystem path of a Piper model. Anything else uses the default voice.

## Try it

```sh
export GIFOS_URL=https://your-gifos
export GIFOS_RELAY=wss://your-relay   # omit to use the site default
export GIFOS_MCP_HOME=$HOME/.gifos-mcp
node bin/gifos-mcp.js
```

Ask the assistant to join a meeting link as "Helper". The tile should read `Helper 🤖`. When you speak, `get_new_utterances` returns your words under your display name. `say` talks back through the tile's microphone.

The permanent check is `npm run test:participant` (it needs `GIFOS_URL`, `GIFOS_RELAY`, and `GIFOS_MCP_HOME`). It does not embed a host name. Unit tests cover the pause logic and the engine choice with no network: `npm test`.
