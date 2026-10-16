// Browser half of the participant body.
//
// The mic injection (window.__vbAC / __vbDst / __vbPlay), the remote-audio
// tap, and the energy gate follow the meet.js voice bot
// (test/swarm/voicebot/page.js in the GifOS repo, same author, MIT).
// Two changes: each remote participant's stream is tapped on its own
// (named from that person's tile), and playback can be stopped mid-sentence.
// Stage, row, and stadium videos are all tapped. The bot's own mic is not.
import { captureSelectors } from '../transcript/lanes.js';

export function seedScript({ name, relay, room, password, av }) {
  const items = { gifos_name: name, gifos_meet_bar: '0' };
  if (relay) items.gifos_relay = relay;
  if (password && room) items['gifos_vpw_' + room + (av ? '.' + av : '')] = password;
  return 'try{var o=' + JSON.stringify(items) + ';for(var k in o)localStorage.setItem(k,o[k]);}catch(e){}';
}

export function voiceInitScript(opts = {}) {
  const vadEnd = Math.max(1, Math.round(Number(opts.vadEndMs) || 450));
  const selectors = JSON.stringify(captureSelectors());
  return `(() => {
    const LANE_SELECTORS = ${selectors};
    const VAD_END = ${vadEnd};
    const TARGET = 16000;
    window.__vbStats = { streams: 0, rms: 0, peak: 0, frames: 0, err: '' };
    const note = (e) => { try { window.__vbStats.err = String(e && e.message || e).slice(0, 180); } catch (x) {} };

    function b64FromI16(i16) {
      const bytes = new Uint8Array(i16.length * 2);
      for (let i = 0; i < i16.length; i++) {
        const v = i16[i];
        bytes[i * 2] = v & 255;
        bytes[i * 2 + 1] = (v >> 8) & 255;
      }
      let s = '';
      const STEP = 8192;
      for (let i = 0; i < bytes.length; i += STEP) {
        const slice = bytes.subarray(i, i + STEP);
        let part = '';
        for (let j = 0; j < slice.length; j++) part += String.fromCharCode(slice[j]);
        s += part;
      }
      return btoa(s);
    }
    function f32ToI16(f32) {
      const o = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        let x = f32[i];
        if (x > 1) x = 1; else if (x < -1) x = -1;
        o[i] = x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
      }
      return o;
    }
    function downsample(f32, inRate) {
      if (!inRate || inRate === TARGET) return f32;
      const ratio = inRate / TARGET;
      const n = Math.floor(f32.length / ratio);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.floor(i * ratio), b = Math.min(f32.length, Math.floor((i + 1) * ratio));
        let sum = 0, c = 0;
        for (let j = a; j < b; j++) { sum += f32[j]; c++; }
        out[i] = c ? sum / c : 0;
      }
      return out;
    }
    function rms(f32) {
      let s = 0;
      for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i];
      return Math.sqrt(s / (f32.length || 1));
    }

    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      window.__vbAC = ac;
      window.__vbDst = ac.createMediaStreamDestination();
      window.__vbAllowBarge = false;
      window.__vbStopRequested = false;
      window.__vbPlaying = false;
      let current = null;
      let liveSources = [];
      window.__vbUnmute = () => {
        try {
          const mic = document.getElementById('mic');
          if (mic && mic.classList.contains('off')) mic.click();
        } catch (e) {}
        if (ac.state === 'suspended') ac.resume().catch(() => {});
      };
      window.addEventListener('load', () => {
        let n = 0;
        const iv = setInterval(() => {
          window.__vbUnmute();
          const mic = document.getElementById('mic');
          if ((mic && !mic.classList.contains('off')) || ++n > 40) clearInterval(iv);
        }, 500);
      });
      window.__vbStop = () => {
        window.__vbStopRequested = true;
        if (current) current.stop(true);
        for (let i = 0; i < liveSources.length; i++) { try { liveSources[i].stop(); } catch (e) {} }
        liveSources = [];
      };
      function voiceUrlOk(u) {
        try {
          const x = new URL(String(u || ''));
          return x.protocol === 'http:' && (x.hostname === '127.0.0.1' || x.hostname === 'localhost');
        } catch (e) { return false; }
      }
      function schedulePcm(bytes, rate, state) {
        if (!bytes || bytes.length < 2) return;
        const n = Math.floor(bytes.length / 2);
        const f32 = new Float32Array(n);
        const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
        for (let i = 0; i < n; i++) f32[i] = view.getInt16(i * 2, true) / 32768;
        const buf = ac.createBuffer(1, n, rate || 24000);
        buf.getChannelData(0).set(f32);
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.connect(window.__vbDst);
        liveSources.push(src);
        if (!state.t0) {
          state.t0 = ac.currentTime;
          state.ttfa = Math.round(performance.now() - state.started);
          state.next = ac.currentTime + 0.02;
          window.__vbPlaying = true;
        }
        const at = Math.max(state.next, ac.currentTime);
        try { src.start(at); } catch (e) { note(e); }
        state.next = at + buf.duration;
      }
      window.__vbPlay = (b64) => new Promise((resolve) => {
        window.__vbStopRequested = false;
        if (current) current.stop(true);
        let src = null, stopped = false, settled = false, t0 = 0, watch = 0;
        const finish = (interrupted) => {
          if (settled) return;
          settled = true;
          if (watch) clearInterval(watch);
          window.__vbPlaying = false;
          if (current && current.src === src) current = null;
          const spoken = t0 ? Math.max(0, Math.round((ac.currentTime - t0) * 1000)) : 0;
          resolve({ interrupted: !!interrupted, spoken_ms: spoken });
        };
        current = { src: null, stop(flag) { stopped = true; try { src && src.stop(); } catch (e) {} finish(!!flag); } };
        (async () => {
          try {
            window.__vbUnmute();
            if (ac.state === 'suspended') await ac.resume();
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const buf = await ac.decodeAudioData(bytes.buffer.slice(0));
            if (stopped || window.__vbStopRequested) { finish(true); return; }
            src = ac.createBufferSource();
            current.src = src;
            src.buffer = buf;
            src.connect(window.__vbDst);
            src.onended = () => finish(stopped);
            window.__vbPlaying = true;
            t0 = ac.currentTime;
            src.start();
            // Ask the server (and the local flag) often, so stop_speaking lands
            // even while this promise is what the driver is waiting on.
            watch = setInterval(() => {
              try {
                const ctrl = window.__vbCtrl;
                if (typeof ctrl === 'function') {
                  const p = ctrl();
                  if (p && typeof p.then === 'function') p.then((r) => { if (r && r.stop) window.__vbStopRequested = true; }).catch(() => {});
                }
              } catch (e) {}
              if (!window.__vbStopRequested) return;
              stopped = true;
              try { src.stop(); } catch (e) {}
              finish(true);
            }, 40);
            setTimeout(() => finish(stopped), Math.max(500, buf.duration * 1000 + 800));
          } catch (e) { note(e); finish(false); }
        })();
      });
      function armWatch(finish, stopSources) {
        return setInterval(() => {
          try {
            const ctrl = window.__vbCtrl;
            if (typeof ctrl === 'function') {
              const p = ctrl();
              if (p && typeof p.then === 'function') p.then((r) => { if (r && r.stop) window.__vbStopRequested = true; }).catch(() => {});
            }
          } catch (e) {}
          if (!window.__vbStopRequested) return;
          stopSources();
          finish(true);
        }, 40);
      }
      function beginStream() {
        window.__vbStopRequested = false;
        if (current) current.stop(true);
        liveSources = [];
        const state = { t0: 0, next: 0, ttfa: 0, started: performance.now() };
        let stopped = false, settled = false, watch = 0;
        const finish = (interrupted) => {
          if (settled) return;
          settled = true;
          if (watch) clearInterval(watch);
          window.__vbPlaying = false;
          if (current && current.state === state) current = null;
          const spoken = state.t0 ? Math.max(0, Math.round((ac.currentTime - state.t0) * 1000)) : 0;
          return { interrupted: !!interrupted, spoken_ms: spoken, ttfa_ms: state.ttfa || 0 };
        };
        const stopSources = () => {
          stopped = true;
          for (let i = 0; i < liveSources.length; i++) { try { liveSources[i].stop(); } catch (e) {} }
          liveSources = [];
        };
        const api = {
          state, finish, stopSources,
          get stopped() { return stopped; },
          resolve: null,
        };
        current = {
          state,
          stop(flag) { stopSources(); if (api.resolve) api.resolve(finish(!!flag)); },
        };
        watch = armWatch((flag) => { if (api.resolve) api.resolve(finish(flag)); }, stopSources);
        api.watch = () => watch;
        return api;
      }
      async function waitOut(api) {
        const endAt = api.state.next;
        while (!api.stopped && !window.__vbStopRequested && ac.currentTime + 0.05 < endAt) {
          await new Promise((r) => setTimeout(r, 30));
        }
        return api.finish(api.stopped || !!window.__vbStopRequested);
      }
      window.__vbPlayRemote = (url, body, token) => new Promise((resolve) => {
        if (!voiceUrlOk(url)) { note('voice url refused'); resolve({ fetch_error: true, interrupted: false, spoken_ms: 0, ttfa_ms: 0 }); return; }
        const api = beginStream();
        api.resolve = resolve;
        (async () => {
          try {
            window.__vbUnmute();
            if (ac.state === 'suspended') await ac.resume();
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + (token || '') },
              body: JSON.stringify(body || {}),
            });
            if (!res.ok || !res.body) {
              note('voice ' + res.status);
              const done = api.finish(false) || {};
              done.fetch_error = true;
              resolve(done);
              return;
            }
            const rate = Number(res.headers.get('x-audio-rate')) || 24000;
            const reader = res.body.getReader();
            let pending = new Uint8Array(0);
            while (!api.stopped && !window.__vbStopRequested) {
              const chunk = await reader.read();
              if (chunk.done) break;
              const merged = new Uint8Array(pending.length + chunk.value.length);
              merged.set(pending, 0);
              merged.set(chunk.value, pending.length);
              const even = merged.length - (merged.length % 2);
              schedulePcm(merged.subarray(0, even), rate, api.state);
              pending = merged.subarray(even);
            }
            try { reader.cancel(); } catch (e) {}
            resolve(await waitOut(api));
          } catch (e) {
            note(e);
            resolve({ fetch_error: true, interrupted: false, spoken_ms: 0, ttfa_ms: 0 });
          }
        })();
      });
      window.__vbPlayPull = () => new Promise((resolve) => {
        const api = beginStream();
        api.resolve = resolve;
        (async () => {
          try {
            window.__vbUnmute();
            if (ac.state === 'suspended') await ac.resume();
            const pull = window.__vbPull;
            if (typeof pull !== 'function') { note('voice pull is missing'); resolve(api.finish(false)); return; }
            let pending = new Uint8Array(0);
            let rate = 24000;
            while (!api.stopped && !window.__vbStopRequested) {
              const piece = await pull();
              if (!piece || piece.done) break;
              if (piece.stop) { api.stopSources(); resolve(api.finish(true)); return; }
              if (piece.rate) rate = piece.rate;
              if (!piece.b64) continue;
              const bin = atob(piece.b64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 255;
              const merged = new Uint8Array(pending.length + bytes.length);
              merged.set(pending, 0);
              merged.set(bytes, pending.length);
              const even = merged.length - (merged.length % 2);
              schedulePcm(merged.subarray(0, even), rate, api.state);
              pending = merged.subarray(even);
            }
            resolve(await waitOut(api));
          } catch (e) { note(e); resolve(api.finish(false)); }
        })();
      });
    } catch (e) { note(e); }

    // One capture context. Each remote tile's stream gets its own processor
    // so a voice stays attached to that person's name.
    let cap = null, procRate = TARGET;
    const ears = new Map();
    const names = new Map();
    const lanes = new Map();
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      try { cap = new AC({ sampleRate: TARGET }); } catch (e) { cap = new AC(); }
      procRate = cap.sampleRate || TARGET;
      const kick = () => { if (cap.state === 'suspended') cap.resume().catch(() => {}); };
      kick();
      cap.onstatechange = kick;
    } catch (e) { note(e); }

    function ourStream(st) {
      try { return !!(window.__vbDst && st && (st === window.__vbDst.stream || st.id === window.__vbDst.stream.id)); }
      catch (e) { return false; }
    }
    function liveAudio(st) {
      if (!st || !st.getAudioTracks) return false;
      return st.getAudioTracks().some((t) => t.readyState === 'live');
    }
    function scan() {
      const want = new Map();
      try {
        for (let s = 0; s < LANE_SELECTORS.length; s++) {
          const spec = LANE_SELECTORS[s];
          const nodes = document.querySelectorAll(spec.selector);
          for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const vid = node.tagName === 'VIDEO' ? node : node.querySelector('video');
            const root = (node.closest && (node.closest('.tile') || node.closest('.rowtile'))) || node;
            if (root.classList && root.classList.contains('me')) continue;
            const st = vid && vid.srcObject;
            if (!st || ourStream(st) || !liveAudio(st) || want.has(st.id)) continue;
            const nameEl = root.querySelector ? root.querySelector('.name') : null;
            const name = nameEl ? String(nameEl.textContent || '').replace(/\\s+/g, ' ').trim() : '';
            want.set(st.id, { stream: st, name: name || spec.lane, lane: spec.lane });
          }
        }
      } catch (e) { note(e); }
      return want;
    }
    function attach(id, stream, name, lane) {
      names.set(id, name);
      lanes.set(id, lane || 'row');
      if (!cap || ears.has(id)) return;
      try {
        const src = cap.createMediaStreamSource(stream);
        const proc = cap.createScriptProcessor(2048, 1, 1);
        const mute = cap.createGain();
        mute.gain.value = 0;
        src.connect(proc);
        proc.connect(mute);
        mute.connect(cap.destination);
        const bucket = { parts: [], n: 0, speechMs: 0, noise: 0.004 };
        proc.onaudioprocess = (ev) => {
          try {
            const ch0 = ev.inputBuffer.getChannelData(0);
            const ds = downsample(new Float32Array(ch0), procRate);
            if (!ds.length) return;
            const i16 = f32ToI16(ds);
            const e = rms(ds);
            window.__vbStats.rms = e;
            if (e > window.__vbStats.peak) window.__vbStats.peak = e;
            if (e < bucket.noise * 1.6) bucket.noise = bucket.noise * 0.9 + e * 0.1;
            if (bucket.noise < 0.0015) bucket.noise = 0.0015;
            const hot = e > Math.max(bucket.noise * 3.2, 0.006);
            const ms = ds.length / TARGET * 1000;
            if (hot) bucket.speechMs += ms; else bucket.speechMs = 0;
            if (bucket.speechMs >= 80 && window.__vbPlaying && window.__vbAllowBarge) {
              try { window.__vbStop(); } catch (err) {}
            }
            bucket.parts.push(i16);
            bucket.n += i16.length;
            if (bucket.n < TARGET / 10) return; // ~100 ms
            let n = 0;
            for (const c of bucket.parts) n += c.length;
            const all = new Int16Array(n);
            let o = 0;
            for (const c of bucket.parts) { all.set(c, o); o += c.length; }
            bucket.parts = []; bucket.n = 0;
            window.__vbStats.frames++;
            const fn = window.__vbFrame;
            if (typeof fn !== 'function') return;
            const p = fn({ streamId: id, name: names.get(id) || name || 'speaker', lane: lanes.get(id) || 'row', b64: b64FromI16(all) });
            if (p && typeof p.then === 'function') p.then((r) => { if (r && r.stop) { try { window.__vbStop(); } catch (e) {} } }).catch(() => {});
          } catch (err) { note(err); }
        };
        ears.set(id, { src, proc, mute, stream });
        names.set(id, name);
      } catch (e) { note(e); }
    }
    function detach(id) {
      const h = ears.get(id);
      if (!h) return;
      try { h.proc.onaudioprocess = null; h.proc.disconnect(); } catch (e) {}
      try { h.src.disconnect(); } catch (e) {}
      try { h.mute.disconnect(); } catch (e) {}
      ears.delete(id);
      names.delete(id);
      lanes.delete(id);
    }
    function sync() {
      try {
        if (cap && cap.state === 'suspended') cap.resume().catch(() => {});
        const want = scan();
        for (const [id, info] of want) attach(id, info.stream, info.name, info.lane);
        for (const id of [...ears.keys()]) if (!want.has(id)) detach(id);
        window.__vbStats.streams = ears.size;
      } catch (e) { note(e); }
    }
    setInterval(sync, 400);
    window.__vbResync = sync;
  })();`;
}

// Camera: a canvas plus the __vbDst mic, same shape as meet.js camInitScript.
// No avatar means a generated robot card. A provided image or gif is letterboxed
// and keeps a small robot chip so the tile still shows the AI badge.
export function camInitScript({ name, avatarDataUrl }) {
  const label = JSON.stringify(String(name || 'Assistant'));
  const url = avatarDataUrl ? JSON.stringify(avatarDataUrl) : 'null';
  return `(() => {
    const NAME = ${label};
    const URL = ${url};
    function addMic(stream) {
      try {
        if (window.__vbDst) {
          const t = window.__vbDst.stream.getAudioTracks()[0];
          if (t) { stream.addTrack(t.clone ? t.clone() : t); return; }
        }
      } catch (e) {}
      try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const d = ac.createMediaStreamDestination();
        const ts = d.stream.getAudioTracks();
        for (let i = 0; i < ts.length; i++) stream.addTrack(ts[i]);
      } catch (e) {}
    }
    const mk = async () => {
      const W = 960, H = 720;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d');
      let img = null;
      if (URL) {
        img = new Image();
        img.src = URL;
        await new Promise((r) => { if (img.complete && img.naturalWidth) r(); else { img.onload = img.onerror = r; } });
        try { document.documentElement.appendChild(img); img.style.cssText = 'position:fixed;left:-9999px;width:2px;height:2px'; } catch (e) {}
      }
      const paint = () => {
        x.fillStyle = '#142033';
        x.fillRect(0, 0, W, H);
        if (img && img.naturalWidth) {
          const iw = img.naturalWidth, ih = img.naturalHeight;
          const s = Math.min(W / iw, H / ih);
          const dw = iw * s, dh = ih * s;
          try { x.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh); } catch (e) {}
        } else {
          x.fillStyle = '#e8eefc';
          x.font = '200px sans-serif';
          x.textAlign = 'center';
          x.textBaseline = 'middle';
          x.fillText('🤖', W / 2, H / 2 - 10);
        }
        x.fillStyle = 'rgba(20,32,51,0.72)';
        x.fillRect(0, H - 84, W, 84);
        x.fillStyle = '#ffffff';
        x.font = '36px sans-serif';
        x.textAlign = 'center';
        x.textBaseline = 'middle';
        x.fillText(NAME, W / 2, H - 42);
      };
      paint();
      setInterval(paint, img ? 100 : 1000);
      const stream = c.captureStream(img ? 8 : 4);
      addMic(stream);
      return stream;
    };
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = mk;
      navigator.mediaDevices.getDisplayMedia = mk;
    }
    window.addEventListener('load', () => {
      let n = 0, blurDone = false;
      const iv = setInterval(() => {
        const cam = document.getElementById('cam');
        const none = document.getElementById('blur-none');
        if (!cam) return;
        if (none && !blurDone) { none.click(); blurDone = true; }
        if (cam.classList.contains('off')) cam.click();
        if (!cam.classList.contains('off') || ++n > 40) clearInterval(iv);
      }, 500);
    });
  })();`;
}
