// Stage B worker: one child process, one Chromium, one Meet Bot, a budget of
// rooms. The supervisor (pool.js) holds the MCP socket, the schedule, and
// the meeting index. It sends one call at a time per message over the IPC
// channel and routes by session id. A worker never sees the schedule file or
// a room password other than the one on the join it was handed.
import { fileURLToPath } from 'node:url';
import { SpeechQueue } from './voice/queue.js';

// What the supervisor may call. Anything else is refused, so a message can
// not reach close(), start(), or a private helper by name.
export const WORKER_METHODS = [
  'ensureStarted', 'join', 'leave', 'transcribe', 'say', 'people', 'list', 'transcript',
  'setVoice', 'interject', 'raiseHand', 'setMic', 'setCamera', 'meetingState', 'snapshot', 'info',
];

function errorText(e) {
  return String((e && e.message) || e || 'The worker call failed.');
}

// channel: { send(msg), on('message', fn) }, normally `process`.
// makeDriver(queue) builds the driver once the queue exists, so thinking in
// this worker is reported to the supervisor under this worker's session ids.
export function serveWorker(channel, makeDriver, extra = []) {
  const queue = new SpeechQueue({
    onThinking(id, on) { channel.send({ event: 'thinking', id: String(id), on: !!on }); },
  });
  const driver = makeDriver(queue);
  const allowed = new Set(WORKER_METHODS.concat(extra));
  channel.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'close') {
      try { if (typeof driver.close === 'function') await driver.close(); } catch (e) { /* exiting anyway */ }
      channel.send({ event: 'closed' });
      process.exit(0);
    }
    if (msg.type === 'ping') { channel.send({ event: 'pong' }); return; }
    if (msg.type !== 'call') return;
    const { id, method, args } = msg;
    if (method === 'leave' && args && args[0] != null) queue.leave(args[0]);
    if (!allowed.has(method) || typeof driver[method] !== 'function') {
      channel.send({ id, ok: false, error: 'The worker has no method ' + JSON.stringify(method) + '.' });
      return;
    }
    try {
      const value = await driver[method](...(Array.isArray(args) ? args : []));
      channel.send({ id, ok: true, value: value === undefined ? null : value });
    } catch (e) {
      channel.send({ id, ok: false, error: errorText(e) });
    }
  });
  channel.send({ event: 'up' });
  return { driver, queue };
}

// Started with child_process.fork. The supervisor passes its config and this
// worker's own profile and credentials in the first message, not in argv or
// the environment, so `ps` does not show the bot password.
async function main() {
  const [{ MeetingBotDriver }, { installKokoro }] = await Promise.all([
    import('./driver.js'),
    import('./voice/kokoro.js'),
  ]);
  process.once('message', async (boot) => {
    const { cfg, creds } = boot || {};
    let kokoro = null;
    if (cfg.voice && cfg.voice.tts && cfg.voice.tts.source === 'mcp') {
      kokoro = await installKokoro({ home: cfg.home, voice: cfg.voice.tts.voice });
    }
    serveWorker(process, (queue) => new MeetingBotDriver(cfg, creds, kokoro, { queue }));
  });
  process.send({ event: 'boot' });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.send) main();
