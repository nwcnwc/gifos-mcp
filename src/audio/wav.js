// WAV helpers for 16-bit PCM. Speech engines and the meeting page trade
// this format; nothing here opens a network or a file.

export function wavFromPcm(pcm, rate = 16000, channels = 1) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const dataSize = data.length - (data.length % (2 * channels));
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  data.copy(buf, 44, 0, dataSize);
  return buf;
}

export function parseWav(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a wav file');
  }
  let rate = 16000, channels = 1, bits = 16, data = null, audioFormat = 1;
  let o = 12;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    const start = o + 8;
    if (id === 'fmt ' && size >= 16) {
      audioFormat = b.readUInt16LE(start);
      channels = b.readUInt16LE(start + 2);
      rate = b.readUInt32LE(start + 4);
      bits = b.readUInt16LE(start + 14);
    } else if (id === 'data') {
      data = b.subarray(start, start + size);
      break;
    }
    o = start + size + (size % 2);
  }
  if (!data) throw new Error('wav has no data chunk');
  if (audioFormat !== 1 || bits !== 16) throw new Error('wav must be 16-bit PCM');
  return { pcm: data, rate, channels, bits };
}

export function wavDurationMs(buf) {
  const w = parseWav(buf);
  const samples = Math.floor(w.pcm.length / 2 / w.channels);
  return Math.round(samples / w.rate * 1000);
}

// Downmix to mono and linearly resample to 16 kHz. Enough for speech models.
export function toMono16k(buf) {
  const w = parseWav(buf);
  const ch = w.channels;
  const n = Math.floor(w.pcm.length / 2 / ch);
  const mono = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += w.pcm.readInt16LE((i * ch + c) * 2);
    mono[i] = Math.max(-32768, Math.min(32767, Math.round(s / ch)));
  }
  if (w.rate === 16000) return wavFromPcm(Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength), 16000, 1);
  const outN = Math.max(1, Math.round(n * 16000 / w.rate));
  const out = new Int16Array(outN);
  for (let i = 0; i < outN; i++) {
    const x = i * w.rate / 16000;
    const i0 = Math.floor(x);
    const i1 = Math.min(n - 1, i0 + 1);
    const f = x - i0;
    out[i] = Math.round(mono[i0] * (1 - f) + mono[i1] * f);
  }
  return wavFromPcm(Buffer.from(out.buffer, out.byteOffset, out.byteLength), 16000, 1);
}

export function i16FromB64(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  const n = Math.floor(buf.length / 2);
  const o = new Int16Array(n);
  for (let i = 0; i < n; i++) o[i] = buf.readInt16LE(i * 2);
  return o;
}

export function f32FromI16(i16) {
  const o = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) {
    const v = i16[i];
    o[i] = v < 0 ? v / 32768 : v / 32767;
  }
  return o;
}

export function concatI16(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const all = new Int16Array(n);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}
