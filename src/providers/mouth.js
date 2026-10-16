// Plays synthesized speech into the signed Meet Bot's meeting.
// The page gives a bot a microphone and then disables it. This script swaps
// that track for a local playback destination before the page disables it.
// While a clause is playing the track stays enabled. The caption flag is left
// muted, so the meeting does not write the bot's own voice down.
// The script never reads an API key.

export function mouthInitScript() {
  return `(() => {
  if (window.__gifosMouthInstalled) return;
  window.__gifosMouthInstalled = true;
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const orig = md.getUserMedia.bind(md);
  const AC = window.AudioContext || window.webkitAudioContext;
  let ac = null, dst = null, voiceTrack = null, current = null, settle = null;
  function ensure() {
    if (dst) return dst;
    ac = new AC();
    dst = ac.createMediaStreamDestination();
    voiceTrack = dst.stream.getAudioTracks()[0] || null;
    if (voiceTrack) voiceTrack.__gifosVoice = true;
    window.__gifosAC = ac;
    return dst;
  }
  const desc = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled');
  if (desc && desc.get && desc.set && desc.configurable !== false) {
    Object.defineProperty(MediaStreamTrack.prototype, 'enabled', {
      configurable: true,
      enumerable: desc.enumerable,
      get() { return desc.get.call(this); },
      set(v) {
        if (this && this.__gifosVoice && window.__gifosHoldVoice && v === false) return;
        desc.set.call(this, v);
      },
    });
  }
  md.getUserMedia = async function (constraints) {
    const stream = await orig(constraints);
    if (window.__gifosMb !== '1' || !constraints || !constraints.audio) return stream;
    const dest = ensure();
    const track = dest.stream.getAudioTracks()[0];
    if (!track) return stream;
    for (const t of stream.getAudioTracks()) {
      try { stream.removeTrack(t); } catch (e) {}
      try { t.stop(); } catch (e) {}
    }
    try { stream.addTrack(track); } catch (e) {}
    return stream;
  };
  window.__gifosQuiet = () => {
    window.__gifosHoldVoice = false;
    if (current) { try { current.stop(); } catch (e) {} current = null; }
    if (voiceTrack) { try { voiceTrack.enabled = false; } catch (e) {} }
    if (settle) { const done = settle; settle = null; done(false); }
  };
  window.__gifosPlayEncoded = (b64) => new Promise((resolve) => {
    try {
      ensure();
      window.__gifosHoldVoice = true;
      if (voiceTrack) voiceTrack.enabled = true;
      if (ac && ac.state === 'suspended') ac.resume();
      if (current) { try { current.stop(); } catch (e) {} }
      const bin = atob(String(b64 || ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 255;
      const copy = bytes.buffer.slice(0);
      ac.decodeAudioData(copy).then((buf) => {
        const src = ac.createBufferSource();
        current = src;
        settle = resolve;
        src.buffer = buf;
        src.connect(dst);
        src.onended = () => {
          if (current === src) current = null;
          if (settle === resolve) { settle = null; resolve(true); }
        };
        src.start();
      }).catch(() => { window.__gifosQuiet(); resolve(false); });
    } catch (e) {
      window.__gifosQuiet();
      resolve(false);
    }
  });
})();`;
}
