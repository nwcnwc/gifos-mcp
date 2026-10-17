// A supervisor with one real worker (src/worker.js) whose boot is fetching
// the Kokoro weights from a mirror that never answers. Forked by
// stage-b.test.js so the test can SIGKILL it during that boot. argv: home,
// weights host. Prints the worker pid once it is forked.
import { loadConfig } from '../../../src/config.js';
import { WorkerPool } from '../../../src/pool.js';

const [home, host] = process.argv.slice(2);
const cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_VOICE: '0', GIFOS_KOKORO_URL: host });
const pool = new WorkerPool(cfg, { name: 'notes-stageb', password: 'bot-pass-stage-b-41' }, { workers: 1, rooms: 1 });
pool.workers[0].spawn().catch(() => {});
process.stdout.write(pool.workers[0].child.pid + '\n');
setInterval(() => {}, 1000);
