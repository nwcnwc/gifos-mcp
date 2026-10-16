# Many meetings, one Meet Bot

Design only. This document does not change the server. It describes how one Meet Bot, driven by one gifos-mcp process, sits in many meetings at once, how a person manages that from the bot app, and how Grok Bot does the same job through MCP. A team or a small company is the first shape. Hundreds and then thousands of meetings are a later fleet. The dashboard a person looks at is built by Grok Bot from raw rows. This server does not draw one.

The public meeting network stays GifOS. This product joins rooms. It does not replace the media path.

## 1. What one host can do today

### Shape

One gifos-mcp process owns one headless Chromium profile and one Meeting Bot app in RUN mode. That app joins its secret admin meeting, then a work meeting for each `start_meeting` or `join_meeting`. The GifOS host page already models this as N sessions: `js/meet-host.js` opens one `run.html` document per meeting, in its own iframe, and routes each call by session id. The MCP store keeps one row per meeting (`scheduled`, `live`, `ended`) and the tools that take a `meeting_id` already address one session. Nothing in gifos-mcp refuses a second live meeting.

So the host can be in more than one meeting with the code that exists. That is not the same as a measured capacity.

Each work session is a full meeting document: its own WebRTC membership, its own timers, and its own view of the room. The iframe is kept at a couple of pixels and nearly transparent so the browser does not freeze it. It is still a meeting page. The admin session is not a work meeting and does not belong on the owner's list.

### Cost, as the code is arranged

These are the cost centers. None of them has a published meetings-per-machine number. A number waits on a measurement (section 5), not on a guess in this document.

| Piece | How it is shared today | What grows with N |
|---|---|---|
| Chromium profile and the Meeting Bot tab | One per gifos-mcp process | The base cost. A second meeting does not start a second browser. |
| Work session | One `run.html` iframe per meeting, including the admin meeting | CPU and RAM per room: membership, audio receive, and whatever that document decodes. A 2 pixel frame still receives media. |
| Whisper (default speech-to-text) | The store app is assigned once on the GifOS computer. Each session document is its own page and can mount its own provider | A captions engine per transcribing meeting, unless a later change serves `stt` once from this process and tags each clip with the meeting id. The Whisper download is on the order of 77 MB. Runtime RAM is not measured here. |
| Kokoro | One install under `GIFOS_MCP_HOME/kokoro`, one engine in this process, voice `af_heart`. The q8 weights are about 90 MB on disk. Every hosted `tts` call hits that engine | Disk and model RAM stay one. Two overlapping speaks contend for one inference. The page does not get a second Kokoro. |
| Language model | One hosted `smartest` client in this process when no store app is set | One HTTP call at a time is what the host page asks for today. The key stays in this process. |
| Voice writer | One `HostVoice` on the host page. One generation counter. One `speechId` | A speak or a conversation turn in meeting B sets `speechId` to B and interrupts the utterance aimed at A. Playback cannot overlap. |

Listening scales better than speaking. Transcription, people, chat, hand, microphone, and camera are already per session id. Speaking is not.

### One writer per voice, per meeting

The rule to build toward:

- Inside one meeting, one voice has one writer. A new spoken line or a conversation turn in that meeting interrupts that meeting's current line. It does not play two clips into the same microphone.
- Across meetings, writers are independent. Meeting A's audio is played only into A's session. Starting B does not cancel A.
- The shared Kokoro (or one HTTP speech stand-in) is a queue. Each job carries the meeting id captured when the line was requested. The WAV is delivered to that id even if another meeting has since asked for speech. A job for a meeting the bot has left is dropped.
- The model call for a conversation turn is tagged the same way. The reply is spoken into the meeting that heard the prompt.
- The bot's own voice stays out of that meeting's caption feed, as it does today, so a room does not answer itself. The line is still recorded for the owner, under a separate kind (section 3).

Today's host page is the global form of this rule: one writer for every meeting. That is the first GifOS-side change on the way to a team deployment. It lives in `meet-host.js` and `host-voice.js` (a generation and a play target per session). gifos-mcp keeps serving one Kokoro and queues it. Meeting Bot keeps calling `interject(id, text)` and `converse` with an id. The app frame still does not fetch.

### What a team can expect before the fleet

A handful of simultaneous rooms on the machine that already runs Grok Bot is the honest near-term shape: the browser, the bot, and the weights are already there. The ceiling is the N meeting documents and, if each one mounts Whisper, N caption engines. Kokoro is not that ceiling. Do not treat "it already joins a second meeting" as a capacity claim. The first code that follows this document should ship an explicit cap (`GIFOS_MAX_MEETINGS`) whose default is chosen after the measurement, and should refuse the next join with a clear tool error when the cap is reached.

## 2. Management screen in the Meeting Bot app

This screen is part of Meeting Bot (gifos-apps-source). gifos-mcp does not paint it. A person reaches it by showing the browser (`GIFOS_HEADLESS=0`) or by the existing CONTROL connection. The MCP tools in section 3 are the same operations for an owner who never opens the app.

What the RUN screen does today: `#run-meetings` is one text row per work meeting (id, link, recording, transcribing, names). The operator page then folds every meeting into one transcript tail, one Speaking / Listening / Quiet flag, and one Stop speaking button. CONTROL mode already has a row per meeting with leave, chat, speak, hand, mic, camera, and snapshot, driven through the admin meeting.

The management screen to add on the RUN side:

1. **The list.** One row per work meeting. The admin meeting is absent. Each row shows topic or room, how many people, whether the bot is transcribing, whether it is speaking or listening in that room, and the last hand / mic / camera state. An error for that meeting stays on that row.
2. **Status for one row.** Choosing a row shows that meeting's people, the recent speech lines, the recent chat lines, and the recent lines the bot spoke. It does not show another meeting's lines in the same list.
3. **Join another.** A link field and a password field. The password field is masked. Join calls the same `join(link, password)` the local API already has. On success the password control is cleared. The new row shows the plain link and never the password. A bad password is a one-line error that does not repeat the password.
4. **Leave.** One control on that row. The bot leaves that room. The other rows stay.
5. **Bot's eyes, for one meeting.** The session iframe for that meeting is shown at a readable size: the room as the bot is seated in it (tiles, chat, captions). Every other session stays at the tiny keepalive size. Opening eyes on a second meeting puts the first one back. Eyes is a local view for the operator. It does not add a camera tile in the room, and it does not open a second browser. The current `snapshot` tool is a PNG of the Meet Bot page and a read of hand / mic / camera. It is not this view. Eyes does not have to stream to MCP. If the owner wants a still image later, that is a separate frame grabbed from the open eyes view, still without a password or a key in the pixels' metadata.

Voice switches stay global for the first version: one conversation voice and one respond-to-commands switch for the whole bot. Per-meeting voice is a later question (section 6).

## 3. MCP tools for the owner

Grok Bot is the management UI. MCP returns structured rows. Grok Bot turns those rows into whatever dashboard, mail, or summary that owner wants. This server does not return HTML, a chart, or a written summary.

Tools already on this server that cover part of the job:

| Tool | Role today |
|---|---|
| `join_meeting(link, password?)` | Joins another GifOS room and starts transcribing. A second call does not drop the first meeting. |
| `leave_meeting(meeting_id)` | The bot leaves that room. Others stay. `end_meeting` is the same leave. A GifOS room has no end-for-everyone. |
| `list_meetings` | The server's rows, newest first, including scheduled and ended. |
| `status` | The connector: browser up, which meetings are live, voice gap. It is not a per-meeting status. |
| `get_transcript` | The whole caption text for one meeting. |
| `tail_transcript(meeting_id, since)` | Caption lines with `seq` greater than `since`. Kind is `speech` only. |
| `send_chat` / `say` | Chat, and a spoken line, for one live meeting. |

`tail_transcript` already stores a connector-wide `seq` and a `meeting_id` on each row. The file is one JSON line per caption, mode 0600. Chat lines and the bot's own spoken lines are not in that feed. Captions are polled from Meet Bot. A resource `gifos://meeting/{id}/transcript` can be subscribed to.

### Tools to add or tighten

Names below are the contract to implement later. They stay on the same loopback MCP server.

**`meeting_status(meeting_id)`**

One meeting, one object. Fields:

- `meeting_id`, `topic`, `state` (`scheduled`, `live`, `ended`)
- `link` (plain link, no password query or hash)
- `people`: `{ name, bot }` for each person the bot can see. No email, no account id, unless GifOS already exposes a display name
- `transcribing`, `speaking`, `listening`
- `hand`, `mic`, `camera` for the bot in that room
- `eyes`: `true` only when this meeting is the one on the eyes tile
- `counts`: how many speech, chat, and spoken lines are stored
- `last_error`: a short string for this meeting, or empty
- `started_at`, `ended_at`

No room password, no bot password, no model key, no speech URL.

**`tail_lines(meeting_id?, since?, kinds?)`**

Replaces the need to scrape `get_transcript` for a dashboard. `since` is the connector-wide seq, `0` or omitted to read from the start of the requested set. Omit `meeting_id` to read every meeting. `kinds` is any of `speech`, `chat`, `spoken`. Default is all three.

Each line:

```json
{ "seq": 1204, "ts": "2026-10-16T17:04:02.000Z", "meeting_id": "m_ab12cd34ef", "kind": "speech", "speaker": "A participant", "text": "We should ship the notes today." }
```

- `speech` is a caption of someone else, credited by display name. The bot's own voice is not this kind.
- `chat` is a meeting-chat line, with the sender as `speaker`.
- `spoken` is a line this bot spoke in that meeting (`say` / conversation voice). It is stored so the owner can read it. It is not fed back into that meeting's captions.

The response is `{ since, next, lines }`. The caller passes `next` back as `since`. Lines are raw. This server does not merge them into a paragraph.

**`meetings_report(since?, meeting_ids?)`**

The cross-meeting bundle a summary is built from. It is not the summary.

```json
{
  "since": 1000,
  "next": 1302,
  "meetings": [
    {
      "meeting_id": "m_ab12cd34ef",
      "topic": "Notes",
      "state": "live",
      "people": [{ "name": "A participant", "bot": false }],
      "counts": { "speech": 40, "chat": 3, "spoken": 2 },
      "lines": []
    }
  ]
}
```

`lines` is the same row shape as `tail_lines`, limited to the window after `since` and to the requested meetings. An empty `meeting_ids` means every meeting this server knows. Grok Bot writes the report, the per-person dashboard, and any mail. Two owners can ask for two different dashboards from the same rows.

**`tail_events(since?)` and `gifos://events`**

One ordered stream for the whole connector, so a dashboard can update without polling every meeting. Each event is `{ seq, ts, meeting_id, type, data }`. `seq` is the same counter as the lines, or a sibling counter that `tail_events` documents in the first event of a process. Types:

| type | data |
|---|---|
| `meeting.joined` | `topic`, `link`, `state` |
| `meeting.left` | `state` |
| `line.speech` / `line.chat` / `line.spoken` | the line fields |
| `meeting.state` | `transcribing`, `speaking`, `listening`, `hand`, `mic`, `camera`, `people` |
| `meeting.error` | `text` (already scrubbed) |

`gifos://events` is the same bytes as newline-delimited JSON. Subscribe still uses the resource-updated notification this server already sends for transcripts. `tail_events` is the cursor form for a client that does not hold a subscription. Either way the payload is the rows above. There is no second protocol and no webhook in the first version.

Per-meeting resources stay: `gifos://meeting/{id}/transcript` remains the speech feed. A later `.../lines` can carry all three kinds. Old clients that only understand `speech` keep working.

### What the tools refuse to be

- A dashboard, a theme, or a layout. The human's view is Grok Bot's.
- A written cross-meeting summary. The report tool returns rows. The model the owner is talking to writes the prose.
- A scheduler. `start_time` stays informational. Grok Bot decides when to call `join_meeting`.
- A mailer. Invites stay text the caller sends.

## 4. Passwords

Three secrets exist. None of them is a log line, a status field, an event, a transcript line, or an error string.

| Secret | Where it is allowed | Where it is refused |
|---|---|---|
| Room password (guests type this) | The `join_meeting` / `create_meeting` argument. The invite text returned by that same `create_meeting` call, as its own line beside the plain link, because the owner is about to send it. A mode-0600 field in `meetings.json` so a restart can enter the room again. | The link. `list_meetings`, `meeting_status`, `status`, events, line text, screenshots, and the bot's on-screen meeting row. Later tool calls. stderr. |
| Bot password (derives the admin meeting) | `GIFOS_MCP_HOME/bot.json`, mode 0600, or the environment. | Every tool result, the management screen, the eyes view, and the admin chat payload that gifos-mcp logs. |
| Model key | This process, when it hosts `smartest`. | The page, Meet Bot, tool results, events, and logs. |

Rules for the implementation that follows:

- `plainLink` stays as it is: `password`, `pw`, `p`, `room_password`, and `pass` are stripped from the query and the hash, and a link that still contains the password is rejected.
- `publicView` stops copying `room_password` onto list and status results. Today it includes the field whenever one is stored. That is the echo this design removes.
- Scrub runs on every tool error and every event string, for the room password of every known meeting, the bot password, and the model key. A password of any non-empty length is scrubbed, not only a fixed pattern.
- The Join control in the app clears the field after the call. The management list never interpolates it into a label.
- Launch links are not a way to pass the room password. CONTROL.md already warns that a password in a URL lands in history and logs. The local API and MCP are the path.
- A failed join says that the room could not be entered. It does not quote the password.
- Eyes and snapshot images are of the meeting. They are not a place to overlay the password.

Restart: the stored room password is what lets the bot rejoin a room that was live when the process died. If that retention is not acceptable, the restart leaves the meeting `scheduled` and the owner passes the password to `join_meeting` again. Section 6 asks which of those two is required. Until that is decided, the design preference is to store it locally and never return it after the create call.

## 5. Path to a server fleet

The media stays on GifOS. Scale means more bot workers, not a larger meeting page and not this product becoming a call server.

### Stage A — one machine, many rooms

The team shape. One gifos-mcp, one Chromium, one Meeting Bot, N sessions, one Kokoro queue, one writer per meeting. Speech-to-text is one shared engine with clips tagged by meeting id, so N rooms do not mean N Whisper mounts. The eyes tile is the only session displayed large. A cap refuses further joins.

Measurement before the cap's default is chosen, on a clean profile, transcription on, conversation voice off, then again with two overlapping speaks:

- 1, 4, and 8 simultaneous work meetings
- RSS of the browser and of the gifos-mcp process
- CPU while people are talking, and while two meetings ask for speech together

Publish the cap from that run. Do not copy a number into this document in advance.

### Stage B — one machine, several workers

The small-company shape, when one Chromium is the limit and the meeting count is still on one box. A supervisor in gifos-mcp holds the MCP socket, the meeting index, the line log, and the event cursor. Workers are child processes. Each worker is one Chromium and one Meeting Bot with its own budget of rooms. A meeting is sticky to the worker that joined it. The supervisor routes `say`, `tail_lines`, and `leave_meeting` by `meeting_id`. Kokoro can stay inside each worker (simple, weights on local disk) or move to one speech queue on the machine that tags audio by meeting id and worker. The second is worth it only after stage A shows Kokoro, rather than the meeting pages, as the bottleneck.

The owner still sees one bot name if they want one. Distinct worker profiles do not mean distinct products. The admin-meeting credential can stay one pair, with one worker in RUN and the others joining work rooms only, or each worker can be its own bot. Section 6 asks which identity the room should see.

### Stage C — a fleet

Hundreds to thousands of concurrent rooms, and the form a company would run as a service. Roles:

| Role | Responsibility |
|---|---|
| Edge | The customer's MCP connection. Auth, the tool surface in section 3, no media. |
| Directory | Meeting index, line log, event cursor, which worker holds which meeting. |
| Worker | One Chromium, a budget of rooms, the Meet Bot, the per-meeting voice writer. Joins only on an assignment from the directory. |
| Secret store | Room passwords, bot passwords, model keys. Workers receive a secret for one join and do not log it. |
| Transcript store | The JSON lines. Still the customer's data. |

Isolation is a browser profile per customer, not per meeting. Two customers do not share a profile, a Kokoro cache if that cache can hold prompts, or a secret store. A worker crash marks that worker's meetings disconnected. Another worker rejoins with the stored room password. The password is not part of the assignment event that other customers could see.

The public GifOS origin, or a company's own GifOS origin, remains the meeting network. Workers speak WebRTC as normal participants. This fleet does not terminate media for the company.

Nothing in this design puts a private address, a customer name, or a real host into the repository. Examples stay on `https://gifos.app` or a caller's own origin passed as `GIFOS_URL`.

## 6. Open questions

1. **One writer per meeting, or one speaker for the whole bot?** This document recommends a writer per meeting, with Kokoro queued behind them, so two rooms can hear the bot at the same time. The alternative is today's behavior: the bot talks in only one room at a time and still listens in all of them. Which one is the team requirement?
2. **Shared speech-to-text, or one Whisper per meeting?** Sharing keeps N rooms from mounting N engines. A separate engine per meeting isolates a stall. Which failure is worse?
3. **Is the eyes tile the live session iframe, one meeting at a time?** That is the proposal. The alternative is a still image on demand and no live view.
4. **Does `create_meeting` still include the room password in `invite_email` and `invite_calendar`?** The proposal keeps it on that one response, because the owner is about to send the invite, and removes it from every later tool. The stricter rule is to omit it there too and let the caller remember the password they just supplied.
5. **May the room password sit in `meetings.json` (mode 0600) for rejoin after a restart?** The proposal stores it and never returns it. The alternative is to drop it and require `join_meeting` again with the password.
6. **One bot name in every room, or one name per worker once stage B exists?** A single name matches "the company's bot." Separate names make a stall in one worker obvious in the room.
7. **Are voice switches still global?** The proposal keeps one conversation voice for the bot. Per-meeting voice (silent in one room, local in another) needs a `set_voice` that takes a `meeting_id`.
8. **Who is allowed to call the management tools?** Today anyone who can reach the MCP socket can join a meeting and read every transcript. A company deployment needs a caller identity on the tools. Is that in scope for the first multi-meeting change, or only at stage C?
9. **Chat lines.** Meet Bot's `transcript(id)` is captions. Chat is a different event. Is the meeting page already willing to emit chat to the host as a `meet-event`, or does that wait on gifos-app?
10. **Cap policy when the machine is full.** Refuse the new join, or drop the oldest idle meeting? The proposal refuses the new join and leaves the owner to `leave_meeting` first.

## Who changes what, when this leaves design

| Repo | Change |
|---|---|
| gifos-mcp | Queue Kokoro by meeting id. Stop echoing the room password after `create_meeting`. Add `meeting_status`, `tail_lines`, `meetings_report`, and `tail_events`. Enforce the cap once it has a measured default. The supervisor and the fleet are later. |
| gifos-app | Per-session voice generation and play target in `meet-host.js` / `host-voice.js`. Eyes: resize one session iframe. Chat events, if they are not already posted. |
| gifos-apps-source | The RUN management screen: list, per-meeting status, paste link and password, leave, open eyes for one meeting. `interject` and conversation turns stay addressed by meeting id. |

No code in those repos follows from this document until the open questions that block stage A are answered: 1, 2, 4, and 5.
