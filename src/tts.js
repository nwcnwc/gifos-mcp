// Open-source text-to-speech for the GifOS Meet connector.
//
// Kokoro is the default. It is the GifOS store provider offline-tts-kokoro
// (Kokoro-82M). The connector installs it and assigns it to Text → speech.
// Piper is the fast fallback for a machine that should not run Kokoro, and
// for the case where Kokoro cannot start. Piper is a local program, not a
// store app: set GIFOS_PIPER_BIN and GIFOS_PIPER_MODEL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KOKORO_APP = 'offline-tts-kokoro';
export const DEFAULT_KOKORO_VOICE = 'af_heart';
export const DEFAULT_PIPER_VOICE = 'en_US-lessac-medium';
// Kokoro-82M plus Chromium and the Whisper model is a poor fit below this.
export const KOKORO_MIN_CPUS = 4;
export const KOKORO_MIN_MEM = 8 * 1024 * 1024 * 1024;

const REQUESTS = new Set(['auto', 'kokoro', 'piper', 'none']);

export function machineProfile(nodeOs = os) {
  const cpus = typeof nodeOs.cpus === 'function' ? nodeOs.cpus() : [];
  return {
    cpus: Array.isArray(cpus) ? cpus.length : 0,
    totalMem: typeof nodeOs.totalmem === 'function' ? Number(nodeOs.totalmem()) : 0,
  };
}

export function machineCanRunKokoro(profile) {
  if (!profile) return false;
  return profile.cpus >= KOKORO_MIN_CPUS && profile.totalMem >= KOKORO_MIN_MEM;
}

export function normalizeTtsRequest(value) {
  const s = String(value == null || String(value).trim() === '' ? 'auto' : value).trim().toLowerCase();
  if (!REQUESTS.has(s)) {
    throw new Error('GIFOS_TTS_ENGINE must be auto, kokoro, piper, or none, got: ' + JSON.stringify(value));
  }
  return s;
}

function commandExists(bin, exists, pathEnv) {
  const name = String(bin || '').trim();
  if (!name) return false;
  if (name.includes('/') || name.includes('\\')) return !!exists(name);
  const dirs = String(pathEnv || '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => exists(path.join(dir, name)));
}

// Piper is ready when its voice file exists and its program can be found.
// This never runs the program.
export function piperIsAvailable({ bin = 'piper', model = '', exists = fs.existsSync, pathEnv = process.env.PATH } = {}) {
  if (!model || !exists(model)) return false;
  return commandExists(bin, exists, pathEnv);
}

function kokoroPlan(requested, reason) {
  return {
    engine: 'kokoro',
    requested,
    fallback: false,
    reason,
    app: KOKORO_APP,
    voice: DEFAULT_KOKORO_VOICE,
    // Ready only after the store app is installed and assigned. See activateTts.
    ready: false,
  };
}

function piperPlan({ requested, fallback, reason, piperAvailable }) {
  return {
    engine: 'piper',
    requested,
    fallback: !!fallback,
    reason,
    app: '',
    voice: DEFAULT_PIPER_VOICE,
    ready: !!piperAvailable,
  };
}

// Picks the engine. Kokoro wins unless the machine is small, the caller asked
// for Piper, Kokoro is known to be unavailable, or text-to-speech is off.
export function selectTtsEngine({ requested = 'auto', profile, kokoroAvailable = true, piperAvailable = false } = {}) {
  const ask = normalizeTtsRequest(requested);
  if (ask === 'none') {
    return { engine: 'none', requested: ask, fallback: false, reason: 'disabled', app: '', voice: '', ready: false };
  }
  if (ask === 'piper') return piperPlan({ requested: ask, fallback: false, reason: 'configured', piperAvailable });
  if (ask === 'auto' && !machineCanRunKokoro(profile)) {
    return piperPlan({ requested: ask, fallback: true, reason: 'weaker-machine', piperAvailable });
  }
  if (!kokoroAvailable) {
    return piperPlan({ requested: ask, fallback: true, reason: 'kokoro-unavailable', piperAvailable });
  }
  return kokoroPlan(ask, ask === 'auto' ? 'default' : 'configured');
}

function applyVoice(plan, voice) {
  const chosen = String(voice || '').trim();
  plan.voiceFromUser = !!chosen;
  if (chosen && plan.engine !== 'none') plan.voice = chosen;
  return plan;
}

function attachPiper(plan, { piperBin, piperModel }) {
  plan.piperBin = String(piperBin || 'piper').trim() || 'piper';
  plan.piperModel = String(piperModel || '').trim();
  return plan;
}

// The plan the rest of the connector stores. `voice` overrides the engine
// default. Piper paths are remembered so a later Kokoro failure can fall back
// without reading the environment again.
export function resolveTts(opts = {}) {
  const plan = selectTtsEngine(opts);
  applyVoice(plan, opts.voice);
  return attachPiper(plan, opts);
}

function failureText(error) {
  if (error && error.message) return String(error.message);
  return String(error || 'Kokoro failed');
}

// Kokoro was selected and then could not start (the store has no app, the
// install failed, the provider is not in the Providers folder). Switch to
// Piper when Piper is actually installed. Otherwise keep Kokoro and report
// it as not ready, so status does not claim a voice that is not there.
export function fallbackAfterKokoroFailure(plan, error, piperAvailable) {
  const failure = failureText(error);
  if (!piperAvailable) {
    return { ...plan, ready: false, fallback: false, reason: 'kokoro-failed', error: failure };
  }
  const next = piperPlan({
    requested: plan && plan.requested || 'auto',
    fallback: true,
    reason: 'kokoro-failed',
    piperAvailable: true,
  });
  if (plan && plan.voiceFromUser && plan.voice) next.voice = plan.voice;
  next.voiceFromUser = !!(plan && plan.voiceFromUser);
  attachPiper(next, plan || {});
  next.error = failure;
  return next;
}

// Installs Kokoro when the plan asks for it. A failure becomes the Piper
// fallback above. Piper and "none" do not touch the store.
export async function activateTts(plan, hooks = {}) {
  if (!plan || plan.engine !== 'kokoro') return plan;
  try {
    const fileId = await hooks.installKokoro(plan.app);
    return { ...plan, ready: true, fileId: fileId || '' };
  } catch (e) {
    const available = hooks.piperAvailable != null
      ? !!hooks.piperAvailable
      : piperIsAvailable({ bin: plan.piperBin, model: plan.piperModel });
    return fallbackAfterKokoroFailure(plan, e, available);
  }
}

// What `status` returns. A live plan from the driver (after install or
// fallback) wins; `requested` stays the value from configuration.
export function ttsPublic(plan, live) {
  if (!plan && !live) return null;
  const src = live || plan;
  return {
    engine: src.engine,
    requested: (plan && plan.requested) || src.requested,
    voice: src.voice || null,
    fallback: !!src.fallback,
    reason: src.reason || '',
    app: src.app || null,
    ready: !!src.ready,
  };
}
