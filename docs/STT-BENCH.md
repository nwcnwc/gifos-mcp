# Speech benchmarks

Measured on a stock 8-vCPU / 15 GB CPU-only agent box. No GPU. These are the numbers the default engines were chosen from.

## Text to speech

Default: Kokoro-82M int8 via kokoro-onnx (Apache-2.0). The model (~92 MB) and the voices file (~28 MB) download into the cache on first use. They are not in the repo. Phonemes come from espeak-ng, which is GPL data and stays an optional downloaded dependency.

| | Kokoro-82M int8 | Piper `en_US-lessac-medium` (optional) |
|---|---|---|
| Load | 0.7 s | |
| First audio, 20-character sentence | 0.24 s | under 70 ms |
| First audio, 80-character sentence | 0.62 s | |
| Real-time factor | ~0.15 | 0.017 |
| Resident memory | ~577 MB | |

Piper is not the default. piper1-gpl is GPL-3.0, so it runs only as a subprocess when `GIFOS_TTS=piper`. Check that voice's `MODEL_CARD` license. espeak-ng (`GIFOS_TTS=espeak`) is the floor and is also a subprocess. `GIFOS_TTS=http` with `GIFOS_TTS_URL` posts to an OpenAI-compatible `/v1/audio/speech`.

The sidecar speaks sentence by sentence. The first clause is synthesized as soon as the text arrives (a short opening clause, about four words, when the first sentence is long). The next clause is synthesized while the current one plays. The target time to first audio in a meeting is 0.3–0.6 s. A live run records the page's time-to-first-audio in `test/proof/participant.md`.

## Speech to text

Default: faster-whisper `base.en` int8, 4 threads, beam size 1, VAD on. Pass a numpy audio array. Do not pass a file path: PyAV 16 and newer raises `TypeError: metadata_errors` on paths.

| | faster-whisper `base.en` int8 |
|---|---|
| 11-second clip | ~0.44 s |
| Word error rate on the JFK line | 0% |
| Resident memory | ~386 MB |

The JFK line is: "And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country."

`GIFOS_STT_MODEL=tiny.en` is for a small box. `small.en` is the accuracy model. Do not use `distil-small.en`. `GIFOS_STT=http` with `GIFOS_STT_URL` posts to an OpenAI-compatible `/v1/audio/transcriptions`.

whisper.cpp remains an optional engine (`GIFOS_STT=whisper.cpp`). It is not the default.

Silero VAD runs per speaker inside the sidecar. An utterance ends after 500 ms of silence (`GIFOS_VAD_END_MS`).
