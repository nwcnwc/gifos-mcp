// The MCP tools. Everything that touches a browser goes through `bot` (the
// MeetingBotDriver in driver.js, or a fake in the unit tests).
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { newRoom, linkFor, roomFromLink, publicView } from './meetings.js';
import { etiquetteResult } from './participant/etiquette.js';
import { withAiBadge } from './participant/names.js';

export const VERSION = '0.2.0';

const meetingId = z.string().min(3).max(40).describe('The meeting_id returned by create_meeting or join_meeting.');

const SubscribeRequestSchema = z.object({
  method: z.literal('resources/subscribe'),
  params: z.object({ uri: z.string() }).passthrough(),
}).passthrough();
const UnsubscribeRequestSchema = z.object({
  method: z.literal('resources/unsubscribe'),
  params: z.object({ uri: z.string() }).passthrough(),
}).passthrough();

function ok(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}
function fail(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function createServer({ cfg, meetings, bot, participant }) {
  const server = new McpServer({ name: 'gifos-mcp', version: VERSION });
  const subs = new Set();
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    if (request && request.params && request.params.uri) subs.add(String(request.params.uri));
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    if (request && request.params && request.params.uri) subs.delete(String(request.params.uri));
    return {};
  });
  if (participant) {
    participant._transcriptNotify = (entry) => {
      if (!entry || !entry.meeting_id) return;
      const uri = 'gifos://meeting/' + entry.meeting_id + '/transcript';
      if (!subs.has(uri)) return;
      server.server.sendResourceUpdated({ uri }).catch(() => {});
    };
    if (!participant._transcriptHooked) {
      participant._transcriptHooked = true;
      const prev = participant.onTranscript;
      participant.onTranscript = (entry) => {
        if (typeof prev === 'function') prev(entry);
        if (typeof participant._transcriptNotify === 'function') participant._transcriptNotify(entry);
      };
    }
  }
  const part = () => {
    if (!participant) throw new Error('Participant mode is not available in this process.');
    return participant;
  };

  // Wraps a handler: known meeting, readable errors.
  const guarded = (fn) => async (args) => {
    try { return await fn(args); } catch (e) { return fail(String((e && e.message) || e)); }
  };
  const need = (id) => {
    const m = meetings.get(id);
    if (!m) throw new Error('Unknown meeting_id ' + JSON.stringify(id) + '. Use list_meetings to see known meetings.');
    return m;
  };
  const needLive = (id) => {
    const m = need(id);
    if (m.state !== 'live' || !m.session_id) throw new Error('Meeting ' + id + ' is ' + m.state + '. Call start_meeting first.');
    return m;
  };

  async function enter(m, password) {
    await bot.ensureStarted();
    const sessionId = await bot.join(m.link, password || '');
    await bot.transcribe(sessionId, true);
    return meetings.update(m.meeting_id, {
      state: 'live', session_id: sessionId, transcribing: true, muted: false,
      started_at: new Date().toISOString(), ended_at: null, transcript: null,
    });
  }

  server.registerTool('create_meeting', {
    title: 'Create a GifOS meeting',
    description: 'Creates a new GifOS meeting link. Nothing joins yet: share the link (for example in a calendar invite the user approves), then call start_meeting at meeting time. start_time is stored as given, for your own scheduling; this server does not schedule anything.',
    inputSchema: {
      topic: z.string().min(1).max(200).describe('What the meeting is about, e.g. "Demo meeting".'),
      start_time: z.string().max(64).optional().describe('When it should start, e.g. "2026-10-15T17:00:00-07:00". Informational only.'),
    },
  }, guarded(async ({ topic, start_time }) => {
    const room = newRoom();
    const m = meetings.add({ topic, start_time: start_time || null, room, link: linkFor(cfg.gifosUrl, room, cfg.relay) });
    return ok({ meeting_id: m.meeting_id, link: m.link, topic: m.topic, start_time: m.start_time,
      note: 'The bot is not in the meeting yet. Call start_meeting(meeting_id) at meeting time; this server must be running then.' });
  }));

  server.registerTool('start_meeting', {
    title: 'Start a meeting (the bot joins and transcribes)',
    description: 'The headless Meeting Bot joins the meeting created with create_meeting and starts transcribing. Participants see a 🤖 bot badge and a transcribing chip.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = need(meeting_id);
    if (m.mode === 'participant') return fail('Meeting ' + meeting_id + ' is a participant session. Use leave_meeting to leave it.');
    if (m.state === 'live') return ok({ ...publicView(m), note: 'Already live.' });
    return ok(publicView(await enter(m)));
  }));

  server.registerTool('join_meeting', {
    title: 'Join an existing GifOS meeting by link',
    description: 'The Meeting Bot joins a GifOS meeting someone else created (a /run.html#v=… or /meet/… link) and starts transcribing. Returns a meeting_id for the other tools.',
    inputSchema: {
      link: z.string().url().max(2048).describe('The GifOS meeting link.'),
      password: z.string().max(200).optional().describe('The meeting password, if the meeting has one.'),
      topic: z.string().max(200).optional(),
    },
  }, guarded(async ({ link, password, topic }) => {
    const room = roomFromLink(link);
    if (!room) return fail('That is not a GifOS meeting link (expected …/run.html#v=<room> or …/meet/<room>).');
    let m = meetings.byRoom(room);
    if (m && m.state === 'live') return ok({ ...publicView(m), note: 'Already in this meeting.' });
    if (!m) m = meetings.add({ topic: topic || '', room, link });
    return ok(publicView(await enter(m, password)));
  }));

  server.registerTool('mute', {
    title: 'Mute the bot (stop listening)',
    description: 'Stops the bot transcribing this meeting; the transcribing chip goes away. The bot never sends audio, so this is the only kind of mute it has.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = needLive(meeting_id);
    await bot.transcribe(m.session_id, false);
    return ok(publicView(meetings.update(m.meeting_id, { transcribing: false, muted: true })));
  }));

  server.registerTool('unmute', {
    title: 'Unmute the bot (listen again)',
    description: 'Turns transcription back on for this meeting.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = needLive(meeting_id);
    await bot.transcribe(m.session_id, true);
    return ok(publicView(meetings.update(m.meeting_id, { transcribing: true, muted: false })));
  }));

  server.registerTool('share_content', {
    title: 'Share text or a link into the meeting',
    description: 'Posts text (an agenda, a link, a summary) into the meeting chat as the bot. Screen sharing is not available: the bot has no screen or camera.',
    inputSchema: {
      meeting_id: meetingId,
      text: z.string().min(1).max(2000).describe('What to post into the meeting chat (up to 2000 characters).'),
    },
  }, guarded(async ({ meeting_id, text }) => {
    const m = needLive(meeting_id);
    await bot.say(m.session_id, text);
    return ok({ meeting_id: m.meeting_id, shared: true, chars: text.length });
  }));

  server.registerTool('get_transcript', {
    title: 'Get the meeting transcript',
    description: 'Returns the transcript as plain text, one "speaker: words" line per caption. Works while the meeting is live and after end_meeting.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = need(meeting_id);
    if (m.state === 'live' && m.session_id) {
      const text = await bot.transcript(m.session_id);
      meetings.update(m.meeting_id, { transcript: text });
      return ok(text || '(no transcript lines yet)');
    }
    if (m.transcript != null) return ok(m.transcript || '(the transcript is empty)');
    return fail('Meeting ' + meeting_id + ' has not started, so there is no transcript.');
  }));

  server.registerTool('end_meeting', {
    title: 'End the meeting for the bot',
    description: 'Saves the transcript, then the bot leaves. Other participants can stay; GifOS meetings have no owner who can close them for everyone.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = need(meeting_id);
    if (m.mode === 'participant') {
      if (participant && participant.meetingId === m.meeting_id) await participant.leave();
      const left = meetings.get(m.meeting_id) || m;
      if (left.state === 'live') meetings.update(m.meeting_id, { state: 'ended', ended_at: new Date().toISOString(), session_id: null });
      return ok({ ...publicView(meetings.get(m.meeting_id) || left), note: 'Left the meeting.' });
    }
    if (m.state !== 'live' || !m.session_id) return ok({ ...publicView(m), note: 'The bot was not in this meeting.' });
    let text = m.transcript || '';
    try { text = await bot.transcript(m.session_id); } catch (e) { /* keep the last copy */ }
    await bot.leave(m.session_id);
    const done = meetings.update(m.meeting_id, { state: 'ended', session_id: null, transcribing: false,
      transcript: text, ended_at: new Date().toISOString() });
    return ok({ ...publicView(done), transcript_lines: text ? text.split('\n').length : 0 });
  }));

  server.registerTool('list_meetings', {
    title: 'List meetings',
    description: 'Meetings this server created or joined, newest first, with their state (scheduled, live, ended).',
    inputSchema: {},
  }, guarded(async () => {
    return ok({ meetings: meetings.all().reverse().map(publicView) });
  }));

  server.registerTool('status', {
    title: 'Connector status',
    description: 'Is the headless GifOS browser up, which GifOS it uses, and which meetings the bot is in right now.',
    inputSchema: {},
  }, guarded(async () => {
    const info = await bot.info();
    return ok({
      version: VERSION,
      gifos_url: cfg.gifosUrl,
      stt_app: cfg.sttApp || null,
      live_meetings: meetings.all().filter((m) => m.state === 'live').map((m) => m.meeting_id),
      bot: info,
      participant: participant ? participant.info() : null,
    });
  }));

  const meetingUrl = z.string().url().max(2048).describe('The GifOS meeting link (…/run.html#v=… or …/meet/…).');

  server.registerTool('join_meeting_as_participant', {
    title: 'Join a GifOS meeting as a participant',
    description: 'Joins the meeting as a real participant with a live microphone and a camera card. The display name always keeps a robot badge so people can see an AI is present. On the first other person, the server says in chat and out loud that it is an AI assistant, that it transcribes speech so it can take part, and that it is not recording.',
    inputSchema: {
      url: meetingUrl,
      password: z.string().max(200).optional().describe('The meeting password, if the meeting has one.'),
      display_name: z.string().min(1).max(80).describe('The name on the tile. A robot badge is added if you leave it off. GifOS keeps 40 characters.'),
      avatar: z.string().max(2048).optional().describe('Image or GIF path or URL used as the camera. Default is a generated robot card.'),
    },
  }, guarded(async ({ url, password, display_name, avatar }) => {
    const joined = await part().join({ url, password, display_name, avatar });
    return ok({ ...joined, display_name: withAiBadge(joined.display_name || display_name) });
  }));

  server.registerTool('get_new_utterances', {
    title: 'New things people said',
    description: 'Transcript lines heard since the last call, one entry per speaker, plus who is talking now and turn_hint ("your_turn" or "wait"). Pass the last utterance id as since. wait_ms long-polls until a new line arrives or the wait ends (max 30000). The server listens to each remote person separately and does not transcribe its own voice.',
    inputSchema: {
      since: z.union([z.string().max(40), z.number()]).optional().describe('The last utterance id you have, or a timestamp in milliseconds. Omit it to read everything still buffered.'),
      wait_ms: z.number().int().min(0).max(30000).optional().describe('How long to wait for a new line. 0 returns immediately.'),
    },
  }, guarded(async ({ since, wait_ms }) => {
    return ok(await part().utterances({ since, wait_ms }));
  }));

  server.registerTool('say', {
    title: 'Speak in the meeting',
    description: 'Speaks text through the participant microphone using the local text-to-speech engine. If interruptible is true (the default) and someone else starts talking, playback stops and the result is {interrupted: true, spoken_until_ms}.',
    inputSchema: {
      text: z.string().min(1).max(2000).describe('What to say, kept short: one to three sentences.'),
      voice: z.string().max(200).optional().describe('Voice name or a local model path. The default voice is used when this is omitted.'),
      interruptible: z.boolean().optional().describe('Stop if a remote person starts talking. Default true.'),
    },
  }, guarded(async ({ text, voice, interruptible }) => {
    return ok(await part().say(text, voice, interruptible));
  }));

  server.registerTool('stop_speaking', {
    title: 'Stop speaking',
    description: 'Stops the current spoken line immediately.',
    inputSchema: {},
  }, guarded(async () => ok(await part().stop())));

  server.registerTool('send_chat', {
    title: 'Send a chat message',
    description: 'Posts a chat line as the participant.',
    inputSchema: {
      text: z.string().min(1).max(2000).describe('The chat message.'),
    },
  }, guarded(async ({ text }) => ok(await part().chat(text))));

  server.registerTool('raise_hand', {
    title: 'Raise or lower your hand',
    description: 'Raises the participant hand when on is true, and lowers it when on is false.',
    inputSchema: { on: z.boolean().describe('true to raise, false to lower.') },
  }, guarded(async ({ on }) => ok(await part().hand(on))));

  server.registerTool('set_mic', {
    title: 'Turn the microphone on or off',
    description: 'Unmutes the participant microphone when on is true. Muting stops the room hearing you; it does not stop you hearing them.',
    inputSchema: { on: z.boolean() },
  }, guarded(async ({ on }) => ok(await part().mic(on))));

  server.registerTool('set_camera', {
    title: 'Turn the camera on or off',
    description: 'Shows the camera card when on is true, and turns it off when on is false.',
    inputSchema: { on: z.boolean() },
  }, guarded(async ({ on }) => ok(await part().cam(on))));

  server.registerTool('get_meeting_state', {
    title: 'Who is in the meeting',
    description: 'Participants, who is talking, whether your hand, microphone, and camera are on, and whether the join disclosure has been spoken.',
    inputSchema: {},
  }, guarded(async () => ok(await part().meetingState())));

  server.registerTool('snapshot', {
    title: 'Snapshot of the meeting',
    description: 'Read-only. Returns who is here, who is talking, the turn, and recent transcript lines, and saves a PNG of the current view into the meeting folder. The speaking loop may call this. It does not change the meeting.',
    inputSchema: {},
  }, guarded(async () => ok(await part().snapshot())));

  server.registerTool('leave_meeting', {
    title: 'Leave the meeting',
    description: 'Leaves the meeting. Call this when someone asks you to leave.',
    inputSchema: {},
  }, guarded(async () => ok(await part().leave())));

  server.registerResource(
    'meeting-transcript',
    new ResourceTemplate('gifos://meeting/{id}/transcript', {
      list: async () => {
        const resources = [];
        if (participant && participant.meetingId && /^m_[0-9a-f]+$/.test(participant.meetingId)) {
          resources.push({
            uri: 'gifos://meeting/' + participant.meetingId + '/transcript',
            name: 'meeting-transcript',
            mimeType: 'application/x-ndjson',
          });
        }
        return { resources };
      },
    }),
    {
      title: 'Meeting transcript',
      description: 'Live JSONL for one meeting. Each line is {seq, ts, speaker, text, kind} and kind is speech, chat, bot, snapshot, or event.',
      mimeType: 'application/x-ndjson',
    },
    async (uri, vars) => {
      const id = vars && vars.id;
      const text = part().readTranscript(String(id || ''));
      return { contents: [{ uri: String(uri), mimeType: 'application/x-ndjson', text }] };
    },
  );

  server.registerPrompt('meeting_participant_etiquette', {
    title: 'Meeting participant etiquette',
    description: 'How to take part in a GifOS meeting as an AI assistant: wait for pauses, keep replies short, identify as an AI, disclose transcription, keep the robot badge, and leave when asked.',
  }, async () => etiquetteResult());

  return server;
}
