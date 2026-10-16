# Many meetings, one Meet Bot

Design only. This document does not change the server. It describes how one Meet Bot, driven by one gifos-mcp process, sits in many meetings at once, how it joins on a schedule instead of sitting in a room all day, how a person manages that from the bot app, and how Grok Bot does the same job through MCP. A team or a small company is the first shape. Hundreds and then thousands of meetings are a later fleet. The dashboard a person looks at is built by Grok Bot from raw rows. This server does not draw one.

The public meeting network stays GifOS. This product joins rooms. It does not replace the media path.

## 1. What one host can do today

### Shape

One gifos-mcp process owns one headless Chromium profile and one Meeting Bot app in RUN mode. That app joins its secret admin meeting, then a work meeting for each `start_meeting` or `join_meeting`. The GifOS host page already models this as N sessions: `js/meet-host.js` opens one `run.html` document per meeting, in its own iframe, and routes each call by session id. The MCP store keeps one row per meeting (`scheduled`, `live`, `ended`) and the tools that take a `meeting_id` already address one session. Nothing in gifos-mcp refuses a second live meeting.

So the host can be in more than one meeting with the code that exists. That is not the same as a measured capacity. It also does not watch the clock. `create_meeting` stores `start_time` as text and does not join by itself. There is no end time. A restart marks live meetings `scheduled` again and waits for another `start_meeting`. Section 2 is the clock that replaces that.

Each work session is a full meeting document: its own WebRTC membership, its own timers, and its own view of the room. The iframe is kept at a couple of pixels and nearly transparent so the browser does not freeze it. It is still a meeting page. The admin session is not a work meeting and does not belong on the owner's list.

### Cost, as the code is arranged

These are the cost centers. None of them has a published meetings-per-machine number. A number waits on a measurement (section 6), not on a guess in this document.

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
- The bot's own voice stays out of that meeting's caption feed, as it does today, so a room does not answer itself. The line is still recorded for the owner, under a separate kind (section 4).

Today's host page is the global form of this rule: one writer for every meeting. That is the first GifOS-side change on the way to a team deployment. It lives in `meet-host.js` and `host-voice.js` (a generation and a play target per session). gifos-mcp keeps serving one Kokoro and queues it. Meeting Bot keeps calling `interject(id, text)` and `converse` with an id. The app frame still does not fetch.

### What a team can expect before the fleet

A handful of simultaneous rooms on the machine that already runs Grok Bot is the honest near-term shape: the browser, the bot, and the weights are already there. The ceiling is the N meeting documents and, if each one mounts Whisper, N caption engines. Kokoro is not that ceiling. Do not treat "it already joins a second meeting" as a capacity claim. The first code that follows this document should ship an explicit cap (`GIFOS_MAX_MEETINGS`) whose default is chosen after the measurement, and should refuse the next join with a clear tool error when the cap is reached.

## 2. Scheduled joins

The bot does not sit in a room all day. A join order has a start and an end. The process joins a little before the start, does the job, and after the end stays only while humans are still in the room and someone other than the bot has spoken or chatted within the last 10 minutes. Grok Bot fills the schedule, including a bulk load from calendars. This process keeps the schedule and fires it. It does not read a calendar itself.

### What a join order is

`join_meeting` and `create_meeting` gain optional `start` and `end`. `schedule_meeting` is the same order when the caller is filling the company list rather than asking for an immediate seat. An order with no `start` joins now. An order may omit `end`. The stored end is then `start` plus 8 hours, and the order is marked `end_defaulted` so the owner can see the time was filled in. After that end, the overrun rule applies: leave when no human remains, or after 10 minutes of silence from anyone but the bot, and otherwise stay. An explicit `end` is kept as given and uses the same overrun rule. There is no separate open-ended stay.

Fields stored with the order:

| Field | Meaning |
|---|---|
| `schedule_id` | Stable id of the order. A series uses one id. One occurrence uses `meeting_id` once it is concrete. |
| `meeting_id` | Present once this occurrence has a row in the meeting store. Reports and events use it. |
| `topic`, `link` | Plain link. A missing link means this process mints a room, the way `create_meeting` does today. |
| `start`, `end` | Instants. Absent `start` means now. Absent `end` is stored as `start` plus 8 hours, with `end_defaulted: true`. Overrun begins at the stored end. |
| `timezone` | IANA name, such as `America/Los_Angeles`. The instant is what the clock fires on. The name is how a weekly rule and a display stay in the company's zone. |
| `early_margin` | How long before `start` the bot may join. Default is a small server margin (proposed: one minute), overridable per order. The bot is not in the room at the start of the work day. |
| `overrun` | Decided. After `end`, leave when no human remains, or when speech and chat from anyone but the bot have been quiet for 10 minutes. Otherwise stay. There is no hard cap. |
| `recurrence` | Empty for one occurrence. Otherwise a rule plus exceptions. |
| `record`, `transcribe` | Turned on when the bot joins, off when it leaves. |
| `commands`, `advice` | While this occurrence is live, the bot may take commands and offer advice. The first version uses the bot's global voice switches during that window. Per-order switches are an open question. |
| `external_id` | Caller's id from a calendar import. A second import with the same id updates the order. It does not create a twin. |

While the order is waiting, the state is `upcoming`. The bot is not in the room. States after that: `waiting_for_capacity`, `live`, `overrun`, `ended`, `missed`, `cancelled`, `left_early`.

### Join, work, leave

A clock in this process, started after the browser is up, looks at orders whose join time (`start` minus `early_margin`) has arrived.

1. **Join.** Enter the room, then transcribe, and record if the order asked. Commands and advice follow the switches in force for that window. Emit `meeting.joined` with the `schedule_id`.
2. **During.** The same per-meeting tools as a manual join: captions, chat, spoken lines, commands, advice. The bot is one participant. It does not hold the room open for people who have not arrived yet beyond the early margin. If nobody is there, it still stays until `end`, because the meeting may start late. It does not stay past the overrun rules.
3. **End.** At `end`, the phase becomes `overrun` and the leave rule is fixed. There is no per-order choice and no hard cap.
   - Leave as soon as no human remains in the room. The bot does not count as a human. Reason `empty`.
   - Leave when speech and chat from anyone but the bot have been absent for 10 minutes. The bot's own voice and its own chat do not reset that timer. Reason `quiet`.
   - Otherwise stay. Humans who are still in the room and have spoken or chatted within the last 10 minutes hold the seat, with no latest time.
4. **Leave.** Save the lines, drop the session, emit `meeting.left` with a reason: `empty`, `quiet`, `cancel`, or `manual`. Other participants stay. The next occurrence of a series is a new `meeting_id` and does not reuse this transcript.

A manual `leave_meeting` during the window or during overrun sets `left_early`. The clock does not rejoin that occurrence. A crash is different from a manual leave: on startup, an order that was `live` and whose `end` is still ahead is joined again. An order that was `overrun`, or was `live` when the process died and whose `end` has since passed, is joined again, then the same rule runs (leave if no human remains, otherwise the 10 quiet minutes start from the rejoin, because the process could not hear the room while it was down). An order that never joined and whose `end` has passed is not entered. An order still in the future stays `upcoming`.

Joining late: if the cap or a restart means the bot is not in the room at `start`, it still joins while `now` is before `end`, and the overrun rules are unchanged. If `now` is already at or past `end`, that occurrence is `missed` and is not entered for a leftover fragment. Section 7 asks whether late join should be stricter.

### Recurrence and time zones

A series stores a rule, not a year of rows. The rule is small: `daily`, `weekly`, or `monthly`, an interval, optional weekdays, and `until` or `count`. Exceptions record a skipped day or a one-off new start and end. The next occurrence is materialized into a concrete order when it falls inside a horizon (proposed: the next day), so a restart has a row to fire and does not have to re-expand the rule before the browser is up.

The rule is evaluated in `timezone`. A weekly Monday at 09:00 stays 09:00 in that zone across a daylight-saving change. Instants are stored in UTC. `list_schedule` can return those instants plus the same times formatted in a zone the caller names. An unknown zone name is rejected. If an offset on `start` and the named zone disagree, the instant is what fires and the tool result says which zone was stored.

Grok Bot owns calendars. It reads the company calendar with the owner's calendar connector, maps each event to an order, and calls `import_schedule`. This process does not call a calendar host, does not store a calendar token, and does not know which calendar product the company uses. `external_id` is the event id Grok Bot chooses, so a later sync updates start, end, and title. A cancelled calendar event is `cancel_schedule` with that `external_id`.

### Clashes

Overlap is the point of many meetings. Two orders whose windows overlap are both kept, and both go live, until the number that would be seated at one instant exceeds the cap from section 1.

- **At schedule time.** `schedule_meeting` and `import_schedule` store the order and return `capacity: { cap, seated_at_start, over_by }`. `over_by` is how many orders, including this one, exceed the cap at this order's start. The default is to store and warn. `reject_if_over_capacity: true` refuses the write instead. The caller decides. This process does not drop some other meeting to make room.
- **Same room.** Two orders with the same room and an overlapping window are one session. The second write is a duplicate, matched on room and `external_id`. It updates the existing order or returns the existing `schedule_id`. It does not open a second iframe.
- **At join time.** If the cap is full, the order waits as `waiting_for_capacity`. It does not kick a meeting that is still inside its window. When a seat frees and `now` is still before `end`, it joins. If `end` arrives first, the occurrence is `missed` with reason `capacity`.
- **What the owner sees.** `list_schedule` can include `conflicts`: each instant where more orders overlap than the cap, with the `schedule_id`s involved. Overlap under the cap is not a conflict. A caller who wants every overlap passes `flag_overlaps: true`. The human is not expected to poll that list. The alerts below are what Grok Bot pushes.

### Capacity alerts

The Grok Bot human is told when the meeting bot is at capacity, and earlier, when the schedule already shows a clash. This process raises the facts. Grok Bot pushes them to the human. This process does not page anyone.

Three events, on the same stream as every other event (`tail_events` and `gifos://events`). Each one is also the body of `capacity_status`, so a client that connects late can still warn.

| type | When |
|---|---|
| `capacity.near` | Seated count has reached `GIFOS_CAPACITY_NEAR` (a seated count set below the cap), or a future instant inside the schedule horizon would. One room of headroom is still left. |
| `capacity.reached` | Seated count has reached the cap, a join is waiting or refused, or a future instant inside the horizon would seat more orders than the cap. This is the warning that a meeting will wait or be missed unless the human frees a seat or moves an order. |
| `capacity.cleared` | Live seats are back under the near threshold, and no instant inside the horizon is still near or over the cap. |

`when` on the payload is `live` or `scheduled`. A live crossing and a future clash are both raised. They are not folded into one silence. A future clash uses `at` for the instant the overlap starts, which is before that meeting's join time, so the warning lands before the occurrence can be missed. A clash that is still outside the horizon is raised when it enters the horizon, still ahead of the join.

The same level is not repeated on every clock tick. A new event is raised when the level changes, or when the set of affected or waiting ids changes. After a restart, if the condition still holds, one event is raised again so a client that was down still hears it.

Every alert names the rooms and the queue. `affected` is who is seated or who is planned to be seated at `at`. `waiting` is who cannot get in: phase `waiting_for_capacity`, a refused manual join, or an order that would be the one over the cap at that future instant. No passwords, no keys.

```json
{
  "seq": 1402,
  "ts": "2026-10-16T15:50:00.000Z",
  "type": "capacity.reached",
  "data": {
    "when": "scheduled",
    "at": "2026-10-16T16:00:00.000Z",
    "cap": 2,
    "near": 1,
    "seated": 2,
    "affected": [
      { "schedule_id": "sch_weekly_notes", "meeting_id": "m_ab12cd34ef", "topic": "Notes", "phase": "upcoming", "start": "2026-10-16T16:00:00.000Z", "end": "2026-10-16T16:30:00.000Z" },
      { "schedule_id": "sch_review", "topic": "Review", "phase": "upcoming", "start": "2026-10-16T16:00:00.000Z", "end": "2026-10-16T16:30:00.000Z" }
    ],
    "waiting": [
      { "schedule_id": "sch_design", "topic": "Design", "phase": "upcoming", "start": "2026-10-16T16:00:00.000Z", "end": "2026-10-16T17:00:00.000Z" }
    ]
  }
}
```

`meeting_id` on the envelope is empty for these events, because more than one meeting is involved. The ids are in `affected` and `waiting`. A future order that has not been materialized yet has a `schedule_id` and no `meeting_id`.

**`capacity_status`** returns the same picture without waiting for the next event. `level` is `ok`, `near`, or `reached`. `live` is the seated set and the waiting set right now. `upcoming` is each instant inside the horizon where the level would be `near` or `reached`, with that instant's `affected` and `waiting`. Grok Bot calls this when it starts and whenever the human asks, and it treats `capacity.near`, `capacity.reached`, and `capacity.cleared` on the event stream as the push. The words the human reads are Grok Bot's.

### Persistence

The schedule lives in `GIFOS_MCP_HOME/schedule.json`, written the same way as `meetings.json`: a temp file, mode 0600, then rename. It holds orders, rules, exceptions, `external_id`s, and the phase of each materialized occurrence. Room passwords sit in that file under the same rule as section 5: present on disk, absent from every later tool result.

The line log is per `meeting_id`, so a restart does not mix last week's standup into this week's file. The series id is a field on the occurrence, which is how a report spans a series without sharing one transcript.

On startup the clock does not join the historical list. It joins only occurrences that are inside their window and were not `left_early` or `cancelled`. Then it waits for the next join time.

### Reports and events for a scheduled meeting

An occurrence uses the same `meeting_id` as `meeting_status`, `tail_lines`, and `meetings_report`. Those tools gain an optional `schedule_id`. One id is one occurrence. The series id returns every occurrence in the requested window, each with its own lines. A report row adds:

```json
{
  "schedule_id": "sch_weekly_notes",
  "occurrence_id": "sch_weekly_notes:2026-10-16",
  "meeting_id": "m_ab12cd34ef",
  "phase": "live",
  "timezone": "America/Los_Angeles",
  "start": "2026-10-16T16:00:00.000Z",
  "end": "2026-10-16T16:30:00.000Z",
  "overrun_quiet_minutes": 10
}
```

`phase` is the schedule state above. `meetings_report` still returns raw lines, not a written summary. Grok Bot writes "what happened in this occurrence" from those lines. The series form is how it writes "this week's standups" without this server composing the prose.

Events, on the same stream as section 4, carry `schedule_id` and `meeting_id` when both exist:

| type | When |
|---|---|
| `schedule.created` / `schedule.updated` / `schedule.cancelled` | The order changed. Data is the public order, with no password. |
| `schedule.due` | Join time has arrived. |
| `schedule.waiting` | The cap blocked the join. |
| `schedule.overrun` | `end` passed and the bot is staying. Data includes `overrun_quiet_minutes: 10`. There is no hard cap. |
| `schedule.missed` | Reason `capacity`, `late`, or `restart_after_window`. |
| `capacity.near` / `capacity.reached` / `capacity.cleared` | The human-facing capacity alerts. Payload is the one in the capacity section: `when`, `at`, `affected`, and `waiting`. |
| `meeting.joined` / `meeting.left` | As in section 4. `meeting.left` adds `reason`. |

`gifos://schedule/{schedule_id}` lists the public order and, for a series, the materialized occurrences. It does not include the password or the transcript body. The transcript stays on `gifos://meeting/{meeting_id}/transcript`.

## 3. Management screen in the Meeting Bot app

This screen is part of Meeting Bot (gifos-apps-source). gifos-mcp does not paint it. A person reaches it by showing the browser (`GIFOS_HEADLESS=0`) or by the existing CONTROL connection. The MCP tools in section 4 are the same operations for an owner who never opens the app.

What the RUN screen does today: `#run-meetings` is one text row per work meeting (id, link, recording, transcribing, names). The operator page then folds every meeting into one transcript tail, one Speaking / Listening / Quiet flag, and one Stop speaking button. CONTROL mode already has a row per meeting with leave, chat, speak, hand, mic, camera, and snapshot, driven through the admin meeting.

The management screen to add on the RUN side:

1. **The list.** One row per work meeting. The admin meeting is absent. Each row shows topic or room, how many people, whether the bot is transcribing, whether it is speaking or listening in that room, and the last hand / mic / camera state. An error for that meeting stays on that row.
2. **Status for one row.** Choosing a row shows that meeting's people, the recent speech lines, the recent chat lines, and the recent lines the bot spoke. It does not show another meeting's lines in the same list.
3. **Join another.** A link field and a password field. The password field is masked. Join calls the same `join(link, password)` the local API already has. On success the password control is cleared. The new row shows the plain link and never the password. A bad password is a one-line error that does not repeat the password.
4. **Leave.** One control on that row. The bot leaves that room. The other rows stay.
5. **Bot's eyes, for one meeting.** The session iframe for that meeting is shown at a readable size: the room as the bot is seated in it (tiles, chat, captions). Every other session stays at the tiny keepalive size. Opening eyes on a second meeting puts the first one back. Eyes is a local view for the operator. It does not add a camera tile in the room, and it does not open a second browser. The current `snapshot` tool is a PNG of the Meet Bot page and a read of hand / mic / camera. It is not this view. Eyes does not have to stream to MCP. If the owner wants a still image later, that is a separate frame grabbed from the open eyes view, still without a password or a key in the pixels' metadata.
6. **The day.** A second list is the upcoming orders: start and end in the company's zone, topic, phase, and a mark when that instant is over the cap. The bot is not shown as seated in a room whose phase is still `upcoming`.

Voice switches stay global for the first version: one conversation voice and one respond-to-commands switch for the whole bot. Per-meeting voice is a later question (section 7).

## 4. MCP tools for the owner

Grok Bot is the management UI. MCP returns structured rows. Grok Bot turns those rows into whatever dashboard, mail, or summary that owner wants. This server does not return HTML, a chart, or a written summary.

Tools already on this server that cover part of the job:

| Tool | Role today |
|---|---|
| `join_meeting(link, password?, start?, end?)` | Joins another GifOS room and starts transcribing. A second call does not drop the first meeting. With `start` and `end`, this is a join order (section 2) and the bot waits for the window. |
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
| `capacity.near` / `capacity.reached` / `capacity.cleared` | `when` (`live` or `scheduled`), `at`, `cap`, `near`, `seated`, `affected`, `waiting`. Raised for a full room now and for a clash the schedule already shows. |

`gifos://events` is the same bytes as newline-delimited JSON. Subscribe still uses the resource-updated notification this server already sends for transcripts. `tail_events` is the cursor form for a client that does not hold a subscription. Either way the payload is the rows above. There is no second protocol and no webhook in the first version. Grok Bot is the client that turns `capacity.near` and `capacity.reached` into a warning the human sees, and `capacity.cleared` into the all-clear.

**`capacity_status`** is the same snapshot as the latest capacity event, plus every future clash still inside the horizon. See section 2. A client calls it on connect so a warning is not lost when no new event is in flight.

Per-meeting resources stay: `gifos://meeting/{id}/transcript` remains the speech feed. A later `.../lines` can carry all three kinds. Old clients that only understand `speech` keep working.

### Schedule tools

These are the company list. They persist across restarts (section 2). They return the public order: times, zone, phase, topic, plain link, flags, `external_id`, capacity. They do not return the room password.

**`schedule_meeting`** creates one order or one series. Arguments are the fields in section 2. A missing link mints a room and returns `invite_email` and `invite_calendar` once, the same way `create_meeting` does. The response includes `capacity`.

**`list_schedule(from?, to?, timezone?, phase?, flag_overlaps?)`** returns orders in that window, soonest first, plus `conflicts` when the cap is exceeded. Recurrence is expanded inside the window. Each row is one occurrence with its `meeting_id` if it has been materialized.

**`update_schedule(schedule_id, occurrence?, patch)`** changes one occurrence or, when `occurrence` is omitted, the rule and the future occurrences. It does not rewrite a transcript that already exists.

**`cancel_schedule(schedule_id, occurrence?, leave_if_live?)`** cancels one occurrence or the series. The default also leaves if that occurrence is `live` or `overrun`.

**`import_schedule(orders)`** is the bulk path. Grok Bot has already read the calendar. Each item is a `schedule_meeting` body plus `external_id`. Existing ids are updates. Unknown ids are creates. The response is `{ created, updated, unchanged, conflicts }` and does not echo passwords. This process does not call out to a calendar.

`meeting_status` and `meetings_report` accept `schedule_id` as well as `meeting_id`. A series report is one block per occurrence, each with the window and phase from section 2, and that occurrence's lines only.

### What the tools refuse to be

- A dashboard, a theme, or a layout. The human's view is Grok Bot's.
- A written cross-meeting summary. The report tool returns rows. The model the owner is talking to writes the prose.
- A calendar client. Grok Bot imports events. This process stores join orders and fires them.
- A mailer. Invites stay text the caller sends.

## 5. Passwords

Three secrets exist. None of them is a log line, a status field, an event, a transcript line, or an error string.

| Secret | Where it is allowed | Where it is refused |
|---|---|---|
| Room password (guests type this) | The `join_meeting` / `create_meeting` / `schedule_meeting` / `import_schedule` argument. The invite text returned by the call that minted the room, as its own line beside the plain link, because the owner is about to send it. A mode-0600 field in `meetings.json` and `schedule.json` so a restart can enter the room again. | The link. `list_meetings`, `list_schedule`, `meeting_status`, `status`, events, line text, screenshots, and the bot's on-screen meeting row. Later tool calls. stderr. |
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

Restart: the stored room password is what lets the bot rejoin a room that is still inside its window when the process died. If that retention is not acceptable, the restart leaves the order `upcoming` or `missed` and the owner passes the password to `join_meeting` again. Section 7 asks which of those two is required. Until that is decided, the design preference is to store it locally and never return it after the call that created the invite.

## 6. Path to a server fleet

The media stays on GifOS. Scale means more bot workers, not a larger meeting page and not this product becoming a call server.

### Stage A — one machine, many rooms

The team shape. One gifos-mcp, one Chromium, one Meeting Bot, N sessions, one Kokoro queue, one writer per meeting, and one schedule file the clock fires. The bot is seated only inside each order's window, plus the overrun rule. Speech-to-text is one shared engine with clips tagged by meeting id, so N rooms do not mean N Whisper mounts. The eyes tile is the only session displayed large. A cap refuses further joins and leaves the extra orders `waiting_for_capacity` or `missed`.

Measurement before the cap's default is chosen, on a clean profile, transcription on, conversation voice off, then again with two overlapping speaks:

- 1, 4, and 8 simultaneous work meetings
- RSS of the browser and of the gifos-mcp process
- CPU while people are talking, and while two meetings ask for speech together

Publish the cap from that run. Do not copy a number into this document in advance.

### Stage B — one machine, several workers

The small-company shape, when one Chromium is the limit and the meeting count is still on one box. A supervisor in gifos-mcp holds the MCP socket, the schedule, the meeting index, the line log, and the event cursor. Workers are child processes. Each worker is one Chromium and one Meeting Bot with its own budget of rooms. The clock assigns a join when the window opens, not at the start of the day. A meeting is sticky to the worker that joined it until it leaves. The supervisor routes `say`, `tail_lines`, and `leave_meeting` by `meeting_id`. Kokoro can stay inside each worker (simple, weights on local disk) or move to one speech queue on the machine that tags audio by meeting id and worker. The second is worth it only after stage A shows Kokoro, rather than the meeting pages, as the bottleneck.

The owner still sees one bot name if they want one. Distinct worker profiles do not mean distinct products. The admin-meeting credential can stay one pair, with one worker in RUN and the others joining work rooms only, or each worker can be its own bot. Section 7 asks which identity the room should see.

### Stage C — a fleet

Hundreds to thousands of concurrent rooms, and the form a company would run as a service. Roles:

| Role | Responsibility |
|---|---|
| Edge | The customer's MCP connection. Auth, the tool surface in section 4, no media. |
| Directory | The company schedule, meeting index, line log, event cursor, which worker holds which meeting. Assigns a worker at join time. |
| Worker | One Chromium, a budget of rooms, the Meet Bot, the per-meeting voice writer. Joins only on an assignment from the directory. |
| Secret store | Room passwords, bot passwords, model keys. Workers receive a secret for one join and do not log it. |
| Transcript store | The JSON lines. Still the customer's data. |

Isolation is a browser profile per customer, not per meeting. Two customers do not share a profile, a Kokoro cache if that cache can hold prompts, or a secret store. A worker crash marks that worker's meetings disconnected. Another worker rejoins with the stored room password. The password is not part of the assignment event that other customers could see.

The public GifOS origin, or a company's own GifOS origin, remains the meeting network. Workers speak WebRTC as normal participants. This fleet does not terminate media for the company.

Nothing in this design puts a private address, a customer name, or a real host into the repository. Examples stay on `https://gifos.app` or a caller's own origin passed as `GIFOS_URL`.

## 7. Open questions

1. **One writer per meeting, or one speaker for the whole bot?** This document recommends a writer per meeting, with Kokoro queued behind them, so two rooms can hear the bot at the same time. The alternative is today's behavior: the bot talks in only one room at a time and still listens in all of them. Which one is the team requirement?
2. **Shared speech-to-text, or one Whisper per meeting?** Sharing keeps N rooms from mounting N engines. A separate engine per meeting isolates a stall. Which failure is worse?
3. **Is the eyes tile the live session iframe, one meeting at a time?** That is the proposal. The alternative is a still image on demand and no live view.
4. **Does `create_meeting` still include the room password in `invite_email` and `invite_calendar`?** The proposal keeps it on that one response, because the owner is about to send the invite, and removes it from every later tool. The stricter rule is to omit it there too and let the caller remember the password they just supplied.
5. **May the room password sit in `meetings.json` (mode 0600) for rejoin after a restart?** The proposal stores it and never returns it. The alternative is to drop it and require `join_meeting` again with the password.
6. **One bot name in every room, or one name per worker once stage B exists?** A single name matches "the company's bot." Separate names make a stall in one worker obvious in the room.
7. **Are voice switches still global?** The proposal keeps one conversation voice for the bot. Per-meeting voice (silent in one room, local in another) needs a `set_voice` that takes a `meeting_id`.
8. **Who is allowed to call the management tools?** Today anyone who can reach the MCP socket can join a meeting and read every transcript. A company deployment needs a caller identity on the tools. Is that in scope for the first multi-meeting change, or only at stage C?
9. **Chat lines.** Meet Bot's `transcript(id)` is captions. Chat is a different event. Is the meeting page already willing to emit chat to the host as a `meet-event`, or does that wait on gifos-app?
10. **Cap policy when the machine is full.** The proposal does not drop a meeting that is still in its window. A manual join is refused. A scheduled join waits, then joins if the seat frees before `end`, or is `missed`. Is that the rule, or should a higher-priority order be able to displace a lower one?
11. **Early margin.** The proposal is one minute, overridable per order. Is that the company default?
12. **Overrun.** Decided. After `end`, leave as soon as no human remains in the room. Leave if speech and chat from anyone but the bot have been quiet for 10 minutes. Otherwise stay. No hard cap.
13. **Late join.** The proposal still joins if the bot was late but `end` has not arrived. The alternative is to miss the occurrence unless it is seated by `start`.
14. **Over capacity at schedule time.** The proposal stores the order and returns `over_by`. The alternative is to reject the write unless the caller forces it.
15. **Recurrence shape.** The proposal is a small daily, weekly, or monthly rule, evaluated in the order's time zone, with exceptions. The alternative is to accept a calendar rule string that Grok Bot already has and store it opaquely.
16. **Editing a series.** `update_schedule` without an occurrence changes the future. Is that enough, or do owners need "this occurrence only" as the default?
17. **Open-ended orders.** Decided. An order may omit `end`. Every such meeting gets a scheduled end of 8 hours after `start`. After that end, the overrun rule applies: leave when no human remains, or after 10 minutes of silence from anyone but the bot, and otherwise stay.
18. **Commands and advice on the order.** The proposal uses the bot's global switches while the occurrence is live. The alternative is per-order `commands` and `advice` that do not change the other rooms.

## Who changes what, when this leaves design

| Repo | Change |
|---|---|
| gifos-mcp | Queue Kokoro by meeting id. Stop echoing the room password after the invite call. Add `meeting_status`, `tail_lines`, `meetings_report`, `tail_events`, and `capacity_status`. Add the schedule file, the clock, and `schedule_meeting`, `list_schedule`, `update_schedule`, `cancel_schedule`, and `import_schedule`. Raise `capacity.near`, `capacity.reached`, and `capacity.cleared` for a full room now and for a future clash. Enforce the cap once it has a measured default. The supervisor and the fleet are later. |
| gifos-app | Per-session voice generation and play target in `meet-host.js` / `host-voice.js`. Eyes: resize one session iframe. Chat events, if they are not already posted. |
| gifos-apps-source | The RUN management screen: list, per-meeting status, the day's orders, paste link and password, leave, open eyes for one meeting. `interject` and conversation turns stay addressed by meeting id. |

No code in those repos follows from this document until the open questions that block stage A are answered: 1, 2, 4, and 5. Questions 12 and 17 are decided. Stage A is not blocked on them.
