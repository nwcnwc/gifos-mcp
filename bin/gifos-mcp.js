#!/usr/bin/env node
// gifos-mcp: GifOS Meet connector for Grok Bot.
//
//   gifos-mcp                 MCP over stdio (what Grok Bot launches)
//   gifos-mcp --http [port]   MCP over streamable HTTP on 127.0.0.1 (default port 19520)
import http from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, botCredentials } from '../src/config.js';
import { MeetingStore } from '../src/meetings.js';
import { MeetingBotDriver } from '../src/driver.js';
import { createServer, VERSION } from '../src/server.js';
import { LiveTranscript, watchCaptions } from '../src/voice/live.js';
import { scrub } from '../src/voice/settings.js';
import { log } from '../src/log.js';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write('gifos-mcp ' + VERSION + '\n\n' +
    '  gifos-mcp                 MCP over stdio\n' +
    '  gifos-mcp --http [port]   MCP over streamable HTTP on 127.0.0.1 (default 19520)\n\n' +
    'Environment: GIFOS_URL, GIFOS_RELAY, GIFOS_BOT_NAME, GIFOS_BOT_PASSWORD, GIFOS_STT_APP,\n' +
    'GIFOS_MCP_HOME, GIFOS_HEADLESS, GIFOS_CHROME, GIFOS_TIMEOUT_MS, GIFOS_MCP_HTTP_TOKEN,\n' +
    'GIFOS_LLM_URL, GIFOS_LLM_MODEL, GIFOS_LLM_APP, GIFOS_CONVERSATION_VOICE, GIFOS_RESPOND_TO_COMMAND,\n' +
    'GIFOS_VOICE, GIFOS_TRANSCRIPT_POLL_MS, GIFOS_TTS_ENGINE, GIFOS_TTS_APP, GIFOS_TTS_URL, GIFOS_TTS_VOICE, GIFOS_STT_URL.\n' +
    'GIFOS_LLM_KEY is stored in the GifOS computer\'s Settings → AI models. It is not passed to Meet Bot and it is not printed.\n' +
    'See https://github.com/nwcnwc/gifos-mcp#readme\n');
  process.exit(0);
}
if (argv.includes('--version')) { process.stdout.write(VERSION + '\n'); process.exit(0); }

const cfg = loadConfig();
const creds = botCredentials(cfg);
const meetings = new MeetingStore(cfg.home);
const reset = meetings.resetLive();
if (reset) log(reset + ' meeting(s) were live in the last run; they are back to scheduled');
const bot = new MeetingBotDriver(cfg, creds);
const live = new LiveTranscript(cfg.home);
const captions = watchCaptions({ meetings, bot, live, intervalMs: cfg.voice.pollMs, botName: creds.name });
const mcpArgs = { cfg, meetings, bot, live, captions, botName: creds.name };
const voiceNote = cfg.voice.conversationVoice + (cfg.voice.conversationVoice === 'local' && cfg.voice.model ? ' (' + cfg.voice.model + ')' : '');
log('gifos-mcp ' + VERSION + ' · GifOS ' + cfg.gifosUrl + ' · bot "' + creds.name + '" (' + creds.source + ') · voice ' +
  voiceNote + ' · commands ' + (cfg.voice.respondToCommand ? 'on' : 'off') + ' · data ' + cfg.home);

let closing = false;
async function shutdown(code) {
  if (closing) return;
  closing = true;
  captions.stopAll();
  await bot.close().catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const httpAt = argv.indexOf('--http');
if (httpAt >= 0) {
  const port = Number(argv[httpAt + 1]) || 19520;
  const token = process.env.GIFOS_MCP_HTTP_TOKEN || '';
  const srv = http.createServer(async (req, res) => {
    if (token && req.headers.authorization !== 'Bearer ' + token) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    if (!req.url || !req.url.startsWith('/mcp')) { res.writeHead(404).end(); return; }
    // Stateless: a fresh MCP server per request, sharing one bot and one store.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts: ['127.0.0.1:' + port, 'localhost:' + port],
    });
    const server = createServer(mcpArgs);
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      log('http request failed: ' + scrub(e.message, cfg.voice.key));
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  srv.listen(port, '127.0.0.1', () => log('listening on http://127.0.0.1:' + port + '/mcp'));
} else {
  const server = createServer(mcpArgs);
  await server.connect(new StdioServerTransport());
  process.stdin.on('close', () => shutdown(0));
  log('ready on stdio');
}

// Warm up so the first start_meeting does not wait for the browser.
if (cfg.prewarm) bot.ensureStarted().catch(() => { /* reported by status and retried on the next tool call */ });
