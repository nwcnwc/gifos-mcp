// Tiny store apps for e2e runs: speech-to-text that hears any loud audio as
// one fixed line, a one-tone voice, and a one-line language model.
// Synthetic speech-to-text provider: a question, so conversation voice will answer it.
export const SYNTH_LINE = 'Can you hear this synthetic speech?';
export const SYNTH_STT = {
  'manifest.json': JSON.stringify({ gifos: '1.0', appId: 'stt-synthetic', name: 'Synthetic Speech', version: '1.0', entry: 'index.html', capabilities: {}, provides: { ai: ['stt'] } }),
  'index.html': '<!doctype html><meta charset="utf-8"><title>Synthetic Speech</title><script>gifos.provider.serve({ stt: function (req) {' +
    'var raw = req && req.bytes; var u = !raw ? new Float32Array(0) : (raw instanceof Float32Array ? raw : new Float32Array(raw.buffer || raw));' +
    'var acc = 0, n = 0; for (var i = 0; i < u.length; i += 16) { acc += u[i] * u[i]; n++; }' +
    'return { text: (n ? Math.sqrt(acc / n) : 0) > 0.02 ? ' + JSON.stringify(SYNTH_LINE) + ' : "" }; } });<\/script>',
};

// A short PCM wav the meeting page can decode, and a one-line language model.
export const SYNTH_TTS = {
  'manifest.json': JSON.stringify({ gifos: '1.0', appId: 'tts-synthetic', name: 'Synthetic Voice', version: '1.0', entry: 'index.html', capabilities: {}, provides: { ai: ['tts'] } }),
  'index.html': '<!doctype html><meta charset="utf-8"><title>Synthetic Voice</title><script>gifos.provider.serve({ tts: function () {' +
    'var rate=8000,n=160,data=n*2,buf=new ArrayBuffer(44+data),v=new DataView(buf);' +
    'function w(o,s){for(var i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));}' +
    'w(0,"RIFF");v.setUint32(4,36+data,true);w(8,"WAVE");w(12,"fmt ");v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);' +
    'v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);w(36,"data");v.setUint32(40,data,true);' +
    'for(var i=0;i<n;i++)v.setInt16(44+i*2,(Math.sin(i/8)*4000)|0,true);' +
    'return { bytes: buf, mime: "audio/wav" }; } });<\/script>',
};
export const SYNTH_LLM = {
  'manifest.json': JSON.stringify({ gifos: '1.0', appId: 'llm-synthetic', name: 'Synthetic LLM', version: '1.0', entry: 'index.html', capabilities: {}, provides: { ai: ['smartest'] } }),
  'index.html': '<!doctype html><meta charset="utf-8"><title>Synthetic LLM</title><script>gifos.provider.serve({ smartest: function () {' +
    'return { text: "Round trip reply." }; } });<\/script>',
};
