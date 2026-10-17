// A supervisor with one fake worker, forked by stage-b.test.js so the test
// can SIGKILL it the way an OOM kill or a crash would. Prints the worker pid
// once that worker holds a room.
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../src/config.js';
import { WorkerPool } from '../../../src/pool.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const cfg = loadConfig({ GIFOS_MCP_HOME: process.argv[2], GIFOS_VOICE: '0', GIFOS_TTS_ENGINE: 'none' });
const pool = new WorkerPool(cfg, { name: 'notes-stageb', password: 'bot-pass-stage-b-41' }, { workers: 1, rooms: 1, workerScript: FAKE });
await pool.join('https://gifos.app/run.html#v=roomA', '');
process.stdout.write(pool.workers[0].child.pid + '\n');
setInterval(() => {}, 1000);
