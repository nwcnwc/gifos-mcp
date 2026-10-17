// The MCP tools. Everything that touches a browser goes through `bot` (the
// MeetingBotDriver in driver.js, or a fake in the unit tests).
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { newRoom, linkFor, roomFromLink, publicView } from './meetings.js';
import { formatInvite, plainLink, PASSWORD_LINK_NOTE } from './invite.js';
import { LiveTranscript } from './voice/live.js';
import { CAMERA_GAP, CONTROLS_GAP, HAND_GAP, INTERJECT_GAP, MIC_GAP, SNAPSHOT_GAP, VOICE_GAP, meetBotVoice, scrub, voicePublic } from './voice/settings.js';

export const VERSION = '0.3.3';

const meetingId = z.string().min(3).max(40).describe('The meeting_id returned by create_meeting or join_meeting.');

export function createServer({ cfg, meetings, bot, live, captions, botName, botPassword }) {
  const server = new McpServer({ name: 'gifos-mcp', version: VERSION });
  const transcript = live || new LiveTranscript(cfg.home);
  const secret = [(cfg.voice && cfg.voice.key) || '', botPassword || ''];
  const choice = {
    respondToCommand: cfg.voice.respondToCommand,
    conversationVoice: cfg.voice.conversationVoice,
  };
  let handed = null;
  const currentVoice = () => ({ ...cfg.voice, respondToCommand: choice.respondToCommand, conversationVoice: choice.conversationVoice });
  async function applyVoice() {
    const settings = meetBotVoice(currentVoice());
    if (typeof bot.setVoice !== 'function') {
      handed = { applied: false, gap: VOICE_GAP };
      return handed;
    }
    try {
      handed = await bot.setVoice(settings);
      // Version 2 resolves with the switches it now holds. Report what it took.
      const took = handed && handed.result;
      if (handed && handed.applied && took && typeof took.speak === 'boolean' && took.speak !== settings.speak) {
        handed = { applied: false, gap: 'Meeting Bot did not turn speak ' + (settings.speak ? 'on' : 'off') + '.' };
      }
    } catch (e) {
      handed = { applied: false, gap: scrub('Meeting Bot refused the voice switches: ' + String((e && e.message) || e), secret) };
    }
    return handed;
  }

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
    const roomPassword = password || m.room_password || '';
    const sessionId = await bot.join(plainLink(m.link, roomPassword), roomPassword);
    await bot.transcribe(sessionId, true);
    const updated = meetings.update(m.meeting_id, {
      state: 'live', session_id: sessionId, transcribing: true, muted: false,
      started_at: new Date().toISOString(), ended_at: null, transcript: null,
    });
    // Meet Bot starts quiet. Its words come from the host-injected Smartest
    // and Text to speech roles, but it answers only after setVoice turns
    // speak (and respond_to_command) on. Each join hands them again, so a
    // restarted app does not stay quiet.
    await applyVoice();
    if (captions) await captions.start(updated);
    return updated;
  }

  server.registerTool('create_meeting', {
    title: 'Create a GifOS meeting',
    description: 'Creates a new GifOS meeting link. Nothing joins yet: share the link (for example in a calendar invite the user approves), then call start_meeting at meeting time. start_time is stored as given, for your own scheduling; this server does not schedule anything.',
    inputSchema: {
      topic: z.string().min(1).max(200).describe('What the meeting is about, e.g. "Demo meeting".'),
      start_time: z.string().max(64).optional().describe('When it should start, e.g. "2026-10-15T17:00:00-07:00". Informational only.'),
      room_password: z.string().max(200).optional().describe('Room password guests type to join. It is returned beside the link, never inside it.'),
    },
  }, guarded(async ({ topic, start_time, room_password }) => {
    const room = newRoom();
    const link = plainLink(linkFor(cfg.gifosUrl, room, cfg.relay), room_password || '');
    const m = meetings.add({
      topic, start_time: start_time || null, room, link,
      room_password: room_password || '',
    });
    const invite = formatInvite({ topic, link: m.link, roomPassword: room_password || '', startTime: start_time || '' });
    return ok({ meeting_id: m.meeting_id, link: invite.link, topic: m.topic, start_time: m.start_time,
      room_password: room_password || '',
      invite_email: invite.email,
      invite_calendar: invite.calendar,
      password_links: PASSWORD_LINK_NOTE,
      note: 'The bot is not in the meeting yet. Call start_meeting(meeting_id) at meeting time; this server must be running then. Put invite_email in the email and invite_calendar in the calendar event. The link stays plain. This server does not send either.' });
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
    const clean = plainLink(link, password || '');
    let m = meetings.byRoom(room);
    if (m && m.state === 'live') return ok({ ...publicView(m), note: 'Already in this meeting.' });
    if (!m) m = meetings.add({ topic: topic || '', room, link: clean, room_password: password || '' });
    else if (m.link !== clean) meetings.update(m.meeting_id, { link: clean, room_password: password || m.room_password || '' });
    return ok(publicView(await enter(meetings.get(m.meeting_id), password)));
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
      const text = scrub(await bot.transcript(m.session_id), secret);
      meetings.update(m.meeting_id, { transcript: text });
      transcript.ingestCaption(m.meeting_id, text, botName);
      return ok(text || '(no transcript lines yet)');
    }
    if (m.transcript != null) return ok(m.transcript || '(the transcript is empty)');
    return fail('Meeting ' + meeting_id + ' has not started, so there is no transcript.');
  }));

  async function depart(m) {
    if (captions) captions.stop(m.meeting_id);
    let text = scrub(m.transcript || '', secret);
    try { text = scrub(await bot.transcript(m.session_id), secret); } catch (e) { /* keep the last copy */ }
    transcript.ingestCaption(m.meeting_id, text, botName);
    await bot.leave(m.session_id);
    const done = meetings.update(m.meeting_id, { state: 'ended', session_id: null, transcribing: false,
      transcript: text, ended_at: new Date().toISOString() });
    return { done, lines: text ? text.split('\n').length : 0 };
  }

  server.registerTool('end_meeting', {
    title: 'End the meeting for the bot',
    description: 'Saves the transcript, then the bot leaves. Other participants can stay; GifOS meetings have no owner who can close them for everyone.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = need(meeting_id);
    if (m.state !== 'live' || !m.session_id) return ok({ ...publicView(m), note: 'The bot was not in this meeting.' });
    const left = await depart(m);
    return ok({ ...publicView(left.done), transcript_lines: left.lines });
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
      voice: voicePublic(currentVoice(), handed),
      bot: info,
    });
  }));

  server.registerTool('set_voice', {
    title: 'Hand Meet Bot its voice switches',
    description: 'Sets Meet Bot\'s two voice switches with MeetingBot.setVoice({ respond_to_command, speak }). speak is on unless conversation_voice is none. Meet Bot answers with the smartest and tts roles; when this process hosts a role, it calls the model. The page does not. The key is not an argument and is not returned.',
    inputSchema: {
      respond_to_command: z.boolean().optional().describe('When true, Meet Bot may answer commands it hears. When false, it does not.'),
      conversation_voice: z.enum(['none', 'grok', 'local']).optional().describe('none, grok (Grok Voice), or local (the configured LLM, then Kokoro).'),
    },
  }, guarded(async ({ respond_to_command, conversation_voice }) => {
    if (conversation_voice === 'local' && !cfg.voice.llmApp && (!cfg.voice.url || !cfg.voice.model)) {
      throw new Error('conversation_voice local needs GIFOS_LLM_URL and GIFOS_LLM_MODEL, or GIFOS_LLM_APP. A GIFOS_LLM_KEY alone selects the suggested xAI endpoint.');
    }
    if (respond_to_command !== undefined) choice.respondToCommand = !!respond_to_command;
    if (conversation_voice) choice.conversationVoice = conversation_voice;
    return ok(voicePublic(currentVoice(), await applyVoice()));
  }));

  server.registerTool('tail_transcript', {
    title: 'Tail the live transcript',
    description: 'New lines since `since` (the seq from the previous tail, or 0). Each line is {seq, ts, speaker, text, kind}. kind is speech for someone in the room, and spoken for a line this bot said. Lines come from Meet Bot. Works while the meeting is live and after it ends. The same bytes are the gifos://meeting/{id}/transcript resource.',
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
    description: 'Passes a spoken line through to Meet Bot (MeetingBot.interject), ahead of conversation voice. Meet Bot asks the tts provider. When this process hosts that role, it returns the audio and does not play it into the meeting. share_content remains chat.',
    inputSchema: {
      meeting_id: meetingId,
      text: z.string().min(1).max(2000).describe('What Meet Bot should say, in one or two sentences.'),
    },
  }, guarded(async ({ meeting_id, text }) => {
    const m = needLive(meeting_id);
    if (typeof bot.interject !== 'function') throw new Error(INTERJECT_GAP);
    const said = await bot.interject(m.session_id, text);
    if (!said || said.applied === false) throw new Error((said && said.gap) || INTERJECT_GAP);
    const speaker = botName || 'Meet Bot';
    const body = String(text).trim();
    const have = transcript.lines.some((l) => l.meeting_id === m.meeting_id && l.kind === 'spoken' && l.speaker === speaker && l.text === body);
    if (body && !have) transcript.append({ meeting_id: m.meeting_id, speaker, text: body, kind: 'spoken' });
    return ok({ meeting_id: m.meeting_id, spoken: true });
  }));

  // Hand, microphone, camera, and room state are a GifOS meeting-control
  // capability. The gifos-apps-source agent builds it on Meeting Bot.
  // These tools only forward window.MeetingBot and report a gap until then.
  async function control(name, gap, fn) {
    if (typeof bot[name] !== 'function') throw new Error(gap);
    const out = await fn();
    if (!out || out.applied === false) throw new Error((out && out.gap) || gap);
    return out;
  }

  server.registerTool('send_chat', {
    title: 'Send a chat message',
    description: 'Posts a chat line through Meet Bot (MeetingBot.say). This is the same chat channel as share_content. It does not speak.',
    inputSchema: {
      meeting_id: meetingId,
      text: z.string().min(1).max(2000).describe('The chat message, up to 2000 characters.'),
    },
  }, guarded(async ({ meeting_id, text }) => {
    const m = needLive(meeting_id);
    await bot.say(m.session_id, text);
    return ok({ meeting_id: m.meeting_id, sent: true, chars: text.length });
  }));

  server.registerTool('raise_hand', {
    title: 'Raise or lower the bot hand',
    description: 'Asks Meet Bot to raise its hand when on is true, and to lower it when on is false. Contract version 1 has no hand control, and then this reports the gap.',
    inputSchema: {
      meeting_id: meetingId,
      on: z.boolean().describe('true to raise, false to lower.'),
    },
  }, guarded(async ({ meeting_id, on }) => {
    const m = needLive(meeting_id);
    const raised = await control('raiseHand', HAND_GAP, () => bot.raiseHand(m.session_id, on));
    return ok({ meeting_id: m.meeting_id, hand: !!on, result: raised.result == null ? null : raised.result });
  }));

  server.registerTool('set_mic', {
    title: 'Turn the Meet Bot microphone on or off',
    description: 'Asks Meet Bot to unmute its microphone when on is true. Contract version 1 gives the bot no microphone, and then this reports the gap.',
    inputSchema: {
      meeting_id: meetingId,
      on: z.boolean().describe('true to unmute, false to mute.'),
    },
  }, guarded(async ({ meeting_id, on }) => {
    const m = needLive(meeting_id);
    const mic = await control('setMic', MIC_GAP, () => bot.setMic(m.session_id, on));
    return ok({ meeting_id: m.meeting_id, mic: !!on, result: mic.result == null ? null : mic.result });
  }));

  server.registerTool('set_camera', {
    title: 'Turn the Meet Bot camera on or off',
    description: 'Asks Meet Bot to show its camera when on is true, and to turn it off when on is false. Contract version 1 has no camera, and then this reports the gap.',
    inputSchema: {
      meeting_id: meetingId,
      on: z.boolean().describe('true to show the camera, false to turn it off.'),
    },
  }, guarded(async ({ meeting_id, on }) => {
    const m = needLive(meeting_id);
    const cam = await control('setCamera', CAMERA_GAP, () => bot.setCamera(m.session_id, on));
    return ok({ meeting_id: m.meeting_id, camera: !!on, result: cam.result == null ? null : cam.result });
  }));

  server.registerTool('get_meeting_state', {
    title: 'Who is in the meeting',
    description: 'Participants from Meet Bot, plus hand, microphone, and camera when the app reports them. Contract version 1 returns the people list only.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = needLive(meeting_id);
    const people = typeof bot.people === 'function' ? await bot.people(m.session_id) : null;
    let hand = null;
    let mic = null;
    let camera = null;
    let controls_gap = CONTROLS_GAP;
    if (typeof bot.meetingState === 'function') {
      const extra = await bot.meetingState(m.session_id);
      if (extra && extra.applied && extra.result) {
        const row = extra.result;
        controls_gap = null;
        if ('hand' in row) hand = !!row.hand;
        if ('mic' in row) mic = !!row.mic;
        if ('camera' in row) camera = !!row.camera;
      } else {
        controls_gap = (extra && extra.gap) || CONTROLS_GAP;
      }
    }
    return ok({
      meeting_id: m.meeting_id,
      transcribing: !!m.transcribing,
      muted: !!m.muted,
      people,
      hand,
      mic,
      camera,
      controls_gap,
    });
  }));

  server.registerTool('snapshot', {
    title: 'Snapshot of the Meet Bot page',
    description: 'Read-only. Returns who is in the meeting and, when the browser is up, a PNG of the Meet Bot page this server already runs. It does not join a second browser and it does not change the meeting.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = needLive(meeting_id);
    const people = typeof bot.people === 'function' ? await bot.people(m.session_id) : null;
    let png = null;
    let gap = SNAPSHOT_GAP;
    let shot = null;
    if (typeof bot.snapshot === 'function') {
      const taken = await bot.snapshot(m.session_id);
      png = (taken && taken.png) || null;
      gap = taken && taken.applied ? null : ((taken && taken.gap) || SNAPSHOT_GAP);
      shot = taken && taken.applied ? (taken.result == null ? null : taken.result) : null;
    }
    return ok({ meeting_id: m.meeting_id, people, png, snapshot: shot, gap });
  }));

  server.registerTool('leave_meeting', {
    title: 'Leave the meeting',
    description: 'Saves the transcript, then Meet Bot leaves. Call this when someone asks the bot to leave. Other participants can stay.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = need(meeting_id);
    if (m.state !== 'live' || !m.session_id) return ok({ ...publicView(m), note: 'The bot was not in this meeting.' });
    const left = await depart(m);
    return ok({ ...publicView(left.done), transcript_lines: left.lines });
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
      description: 'Newline-delimited JSON for one meeting, tailed from Meet Bot. Each line is {seq, ts, speaker, text, kind}. Subscribe for updates while the meeting is live. After the meeting, read it and do the follow-up yourself.',
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
