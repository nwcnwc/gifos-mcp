// The MCP tools. Everything that touches a browser goes through `bot` (the
// MeetingBotDriver in driver.js, or a fake in the unit tests).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { newRoom, linkFor, roomFromLink, publicView } from './meetings.js';

export const VERSION = '0.1.0';

const meetingId = z.string().min(3).max(40).describe('The meeting_id returned by create_meeting or join_meeting.');

function ok(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}
function fail(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function createServer({ cfg, meetings, bot }) {
  const server = new McpServer({ name: 'gifos-mcp', version: VERSION });

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
      text: z.string().min(1).max(4000).describe('What to post into the meeting chat.'),
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
    });
  }));

  return server;
}
