// The MCP tools. Everything that touches a browser goes through `bot` (the
// MeetingBotDriver in driver.js, or a fake in the unit tests).
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { newRoom, linkFor, roomFromLink, publicView } from './meetings.js';
import { voicePublic } from './config.js';
import { LiveTranscript } from './voice/live.js';
import { scrub } from './voice/llm.js';

export const VERSION = '0.2.0';

const meetingId = z.string().min(3).max(40).describe('The meeting_id returned by create_meeting or join_meeting.');

export function createServer({ cfg, meetings, bot, voice, live, captions, botName }) {
  const server = new McpServer({ name: 'gifos-mcp', version: VERSION });
  const transcript = live || new LiveTranscript(cfg.home);
  const secret = (cfg.voice && cfg.voice.key) || '';

  function ok(obj) {
    const raw = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    return { content: [{ type: 'text', text: scrub(raw, secret) }] };
  }
  function fail(message) {
    return { isError: true, content: [{ type: 'text', text: scrub(message, secret) }] };
  }

  // Wraps a handler: known meeting, readable errors.
  const guarded = (fn) => async (args) => {
    try { return await fn(args); } catch (e) { return fail(scrub(String((e && e.message) || e), secret)); }
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
    const updated = meetings.update(m.meeting_id, {
      state: 'live', session_id: sessionId, transcribing: true, muted: false,
      started_at: new Date().toISOString(), ended_at: null, transcript: null,
    });
    if (voice && voice.openMeeting) voice.openMeeting(m.meeting_id);
    if (captions) await captions.start(updated);
    return updated;
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
      transcript.ingestCaption(m.meeting_id, text, botName);
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
    if (voice) voice.closeMeeting(m.meeting_id);
    if (captions) captions.stop(m.meeting_id);
    let text = m.transcript || '';
    try { text = await bot.transcript(m.session_id); } catch (e) { /* keep the last copy */ }
    transcript.ingestCaption(m.meeting_id, text, botName);
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
      voice: voicePublic(cfg.voice),
      bot: info,
    });
  }));

  server.registerTool('tail_transcript', {
    title: 'Tail the live transcript',
    description: 'New lines since `since` (the seq from the previous tail, or 0). Each line is {seq, ts, speaker, text, kind}. kind is speech (someone in the room), voice (the speaking model), or say (an interjection from the say tool). Works while the meeting is live and after it ends. The same bytes are the gifos://meeting/{id}/transcript resource.',
    inputSchema: {
      meeting_id: meetingId,
      since: z.number().int().min(0).optional().describe('Return lines with a seq greater than this. Omit or pass 0 to read from the start.'),
    },
  }, guarded(async ({ meeting_id, since }) => {
    need(meeting_id);
    return ok(transcript.tail(meeting_id, since || 0));
  }));

  server.registerTool('say', {
    title: 'Speak in the meeting',
    description: 'Says text out loud in a live meeting, ahead of the speaking model. The speaking model has no tools and only makes conversation. Use say to interject. After the meeting, handle notes, mail, and calendar yourself; this server does not.',
    inputSchema: {
      meeting_id: meetingId,
      text: z.string().min(1).max(2000).describe('What to say, in one or two sentences.'),
    },
  }, guarded(async ({ meeting_id, text }) => {
    const m = needLive(meeting_id);
    if (!voice) throw new Error('Meeting voice is off. Set GIFOS_LLM_KEY to use xAI Grok, or set GIFOS_LLM_URL and GIFOS_LLM_MODEL for another OpenAI-compatible endpoint.');
    return ok(await voice.say(m.meeting_id, text));
  }));

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
  const off = transcript.onLine((row) => {
    if (!row || !row.meeting_id) return;
    const uri = 'gifos://meeting/' + row.meeting_id + '/transcript';
    if (!subs.has(uri)) return;
    server.server.sendResourceUpdated({ uri }).catch(() => {});
  });
  const origClose = server.close.bind(server);
  server.close = async () => { off(); return origClose(); };

  server.registerResource(
    'meeting-transcript',
    new ResourceTemplate('gifos://meeting/{id}/transcript', {
      list: async () => {
        const ids = new Set(transcript.meetings());
        for (const m of meetings.all()) {
          if (m.state === 'live' || ids.has(m.meeting_id)) ids.add(m.meeting_id);
        }
        return {
          resources: [...ids].filter((id) => /^m_[0-9a-f]+$/.test(id)).map((id) => ({
            uri: 'gifos://meeting/' + id + '/transcript',
            name: 'meeting-transcript',
            mimeType: 'application/x-ndjson',
          })),
        };
      },
    }),
    {
      title: 'Live meeting transcript',
      description: 'Newline-delimited JSON for one meeting. Each line is {seq, ts, speaker, text, kind}. kind is speech, voice, or say. Subscribe for updates while the meeting is live. After the meeting, read it and do the follow-up yourself.',
      mimeType: 'application/x-ndjson',
    },
    async (uri, vars) => {
      const id = vars && (vars.id || vars.meeting_id);
      const m = id && meetings.get(String(id));
      if (!m) throw new Error('Unknown meeting_id ' + JSON.stringify(id) + '.');
      return { contents: [{ uri: String(uri), mimeType: 'application/x-ndjson', text: transcript.ndjson(m.meeting_id) }] };
    },
  );

  return server;
}
