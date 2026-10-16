# Providers

gifos-mcp is the provider machine. It registers four roles with Meet Bot over the bot's admin room:

| Role | Engine | Where the key lives |
|---|---|---|
| `stt` | Whisper (faster-whisper) | This machine. No key. |
| `tts` | Kokoro | This machine. No key. |
| `llm` | OpenAI-compatible chat at `GIFOS_LLM_URL` | `GIFOS_LLM_KEY` stays in this process. It is an Authorization header only. |
| `say` | Grok Bot `say` | This machine. A say takes priority over conversation voice. |

The announcement the bot receives is the role names and engines. It does not include URLs or keys.

Meet Bot is the single AI participant. This server starts the signed store app headless, then drives it from a second copy of that app in CONTROL mode. Commands are `gb1` chat in the admin meeting derived from the bot name and password. The admin password is not a tool result.

## Switches

`set_switches`:

- `respond_to_command` — on or off. When off, a command heard in the room does not get a spoken reply. Grok Bot `say` still speaks.
- `conversation_voice` — `none`, `grok` (Grok Voice via the configured endpoint), or `local` (the configured chat model, then Kokoro).

Conversation voice yields while a command reply is speaking: the in-progress voice is aborted, and a new conversation line does not start until the command reply has finished.

A line is a command when it starts with `/` or `!`, or when its first word is `bot` or the bot's name. Those are answered immediately while `respond_to_command` is on. Anything else waits until the room has been quiet for the turn pause, then the selected voice speaks. The model streams into the clause splitter, and the first short clause is handed to the speaker before the rest of the answer has arrived.

That audio is played into the signed Meet Bot's own meeting. The bot's caption flag stays muted, so the meeting does not write the bot's voice down. If the bot is not in a meeting, the same clause is spoken through the participant microphone instead.

The first clause of a spoken line is short (about four words, earlier if there is a comma) so the first audio can start before the rest of the line is synthesized.

## Transcript

Local Whisper hears the stage, the row, and the stadium. Each kept line has `lane` set to one of those. Nothing is kept unless the bot tile is showing the transcribing label.
