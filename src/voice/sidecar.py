#!/usr/bin/env python3
# Local voice sidecar. Listens on 127.0.0.1 only.
# Default TTS is Kokoro-82M int8 (kokoro-onnx, Apache-2.0).
# Default STT is faster-whisper base.en int8. Audio is a numpy array, never a file path.
# Models download into GIFOS_MCP_HOME on first use. Nothing in this file is a weight.
# espeak-ng is an optional phonemizer dependency (GPL data). It is never vendored.
# piper1-gpl is GPL-3.0 and is a subprocess only, and only when GIFOS_TTS=piper.

import array
import base64
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAKE = os.environ.get('GIFOS_VOICE_FAKE') == '1'
TOKEN = os.environ.get('GIFOS_VOICE_TOKEN', '')
HOME = os.environ.get('GIFOS_MCP_HOME') or os.path.join(os.path.expanduser('~'), '.gifos-mcp')
END_MS = int(os.environ.get('GIFOS_VAD_END_MS') or '500')
FAKE_GAP_S = float(os.environ.get('GIFOS_VOICE_FAKE_GAP_MS') or '180') / 1000.0
MAX_BODY = 20 * 1024 * 1024

KOKORO_MODEL_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx'
KOKORO_VOICES_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin'

LOCK = threading.Lock()
STREAMS = {}
STATE = {
    'stt': 'fake' if FAKE else 'faster-whisper',
    'tts': 'fake' if FAKE else 'kokoro',
    'stt_model': 'fake' if FAKE else 'base.en',
    'tts_voice': 'fake' if FAKE else 'af_heart',
    'vad': 'energy' if FAKE else 'silero',
    'self_test': {'tts_rtf': 0.05, 'stt_rtf': 0.05, 'ttfa_s': 0.02} if FAKE else None,
    'error': '',
}
WHISPER = None
KOKORO = None


def log(msg):
    sys.stderr.write('[voice] ' + str(msg) + '\n')
    sys.stderr.flush()


def env_name(*keys):
    for k in keys:
        v = os.environ.get(k, '').strip()
        if v:
            return v.lower()
    return ''


def choose_engines():
    if FAKE:
        return
    stt = env_name('GIFOS_STT', 'GIFOS_STT_ENGINE') or 'faster-whisper'
    tts = env_name('GIFOS_TTS', 'GIFOS_TTS_ENGINE') or 'kokoro'
    model = (os.environ.get('GIFOS_STT_MODEL') or 'base.en').strip() or 'base.en'
    if 'distil' in model or 'distil' in stt:
        raise SystemExit('distil-small.en is not used. Set GIFOS_STT_MODEL to tiny.en, base.en, or small.en.')
    if os.environ.get('GIFOS_STT_URL', '').strip():
        stt = 'http'
    elif stt in ('faster-whisper', 'faster_whisper', 'fasterwhisper'):
        stt = 'faster-whisper'
    elif stt in ('whisper.cpp', 'whisper', 'whisper-cpp'):
        stt = 'whisper.cpp'
    else:
        raise SystemExit('Unknown GIFOS_STT ' + stt)
    if os.environ.get('GIFOS_TTS_URL', '').strip():
        tts = 'http'
    elif tts in ('kokoro', 'kokoro-onnx'):
        tts = 'kokoro'
    elif tts == 'piper':
        tts = 'piper'
    elif tts in ('espeak', 'espeak-ng'):
        tts = 'espeak'
    else:
        raise SystemExit('Unknown GIFOS_TTS ' + tts)
    voice = (os.environ.get('GIFOS_TTS_VOICE') or '').strip()
    STATE['stt'] = stt
    STATE['tts'] = tts
    STATE['stt_model'] = model
    STATE['tts_voice'] = voice or ('af_heart' if tts == 'kokoro' else 'default')


def download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 1024:
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + '.part'
    log('download ' + os.path.basename(dest))
    req = urllib.request.Request(url, headers={'User-Agent': 'gifos-mcp-voice'})
    with urllib.request.urlopen(req, timeout=120) as res, open(tmp, 'wb') as out:
        while True:
            chunk = res.read(1024 * 256)
            if not chunk:
                break
            out.write(chunk)
    os.replace(tmp, dest)


def split_clauses(text):
    """First piece is a short clause when the opening sentence is long."""
    raw = ' '.join(str(text or '').split())
    if not raw:
        return []
    parts = []
    buf = ''
    for ch in raw:
        buf += ch
        if ch in '.!?':
            parts.append(buf.strip())
            buf = ''
    if buf.strip():
        parts.append(buf.strip())
    parts = [p for p in parts if p]
    if not parts:
        return []
    first = parts[0]
    words = first.split()
    if len(words) > 12:
        head = []
        rest_start = None
        for i, w in enumerate(words):
            head.append(w)
            bare = w.rstrip(',;:')
            head[-1] = bare
            if i >= 3 and (w.endswith((',', ';', ':')) or w in ('—', '–', '-')):
                rest_start = i + 1
                break
        if rest_start and rest_start < len(words):
            parts = [' '.join(head), ' '.join(words[rest_start:])] + parts[1:]
    return parts


def i16_bytes_from_f32(samples):
    out = array.array('h')
    for x in samples:
        if x > 1:
            x = 1.0
        elif x < -1:
            x = -1.0
        n = int(x * 32767) if x >= 0 else int(x * 32768)
        if n > 32767:
            n = 32767
        elif n < -32768:
            n = -32768
        out.append(n)
    return out.tobytes()


def rms_i16(buf):
    if not buf:
        return 0.0
    a = array.array('h')
    a.frombytes(buf[:len(buf) // 2 * 2])
    if not a:
        return 0.0
    acc = 0.0
    for n in a:
        f = n / 32768.0
        acc += f * f
    return (acc / len(a)) ** 0.5


def parse_wav(buf):
    if len(buf) < 44 or buf[:4] != b'RIFF' or buf[8:12] != b'WAVE':
        return None
    pos = 12
    rate = 16000
    channels = 1
    data = b''
    while pos + 8 <= len(buf):
        kind = buf[pos:pos + 4]
        size = int.from_bytes(buf[pos + 4:pos + 8], 'little')
        chunk = buf[pos + 8:pos + 8 + size]
        if kind == b'fmt ' and len(chunk) >= 16:
            channels = int.from_bytes(chunk[2:4], 'little') or 1
            rate = int.from_bytes(chunk[4:8], 'little') or 16000
        elif kind == b'data':
            data = chunk
            break
        pos += 8 + size + (size & 1)
    if channels > 1 and data:
        a = array.array('h')
        a.frombytes(data[:len(data) // 2 * 2])
        mono = array.array('h')
        for i in range(0, len(a) - channels + 1, channels):
            acc = 0
            for c in range(channels):
                acc += a[i + c]
            mono.append(int(acc / channels))
        data = mono.tobytes()
    return data, rate


def to_16k(pcm, rate):
    if rate == 16000 or not pcm or rate <= 0:
        return pcm
    src = array.array('h')
    src.frombytes(pcm[:len(pcm) // 2 * 2])
    if not src:
        return b''
    out_len = int(len(src) * 16000 / rate)
    out = array.array('h')
    for i in range(out_len):
        j = int(i * rate / 16000)
        if j >= len(src):
            j = len(src) - 1
        out.append(src[j])
    return out.tobytes()


def fake_sentence_pcm():
    # 0.1 s at 24 kHz. Non-zero so a player treats it as audio.
    n = 2400
    out = array.array('h')
    for i in range(n):
        out.append(8000 if (i // 12) % 2 == 0 else -8000)
    return out.tobytes(), 24000


def synth_kokoro(text, voice):
    global KOKORO
    if KOKORO is None:
        raise RuntimeError('kokoro is not loaded')
    name = voice or STATE['tts_voice'] or 'af_heart'
    with LOCK:
        samples, sr = KOKORO.create(text, voice=name, speed=1.0, lang='en-us')
    return i16_bytes_from_f32(samples), int(sr)


def synth_espeak(text, voice):
    cmd = ['espeak-ng', '-v', voice or 'en', '--stdout', text]
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError('espeak-ng failed: ' + proc.stderr.decode('utf-8', 'replace')[-200:])
    parsed = parse_wav(proc.stdout)
    if not parsed:
        raise RuntimeError('espeak-ng did not return a wav')
    return parsed


def piper_model():
    voice = os.environ.get('GIFOS_TTS_VOICE', '').strip()
    if voice and os.path.exists(voice):
        return voice
    cand = os.path.join(HOME, 'models', 'en_US-lessac-medium.onnx')
    if os.path.exists(cand):
        return cand
    raise RuntimeError('GIFOS_TTS=piper needs a voice onnx. Set GIFOS_TTS_VOICE or place en_US-lessac-medium.onnx in the model cache.')


def note_piper_license(model):
    folder = os.path.dirname(model)
    for name in ('MODEL_CARD', 'MODEL_CARD.md', os.path.basename(model) + '.MODEL_CARD'):
        path = os.path.join(folder, name)
        if os.path.exists(path):
            text = open(path, 'r', encoding='utf-8', errors='replace').read(800)
            log('piper MODEL_CARD ' + name + ' ' + ' '.join(text.split())[:180])
            return
    log('piper voice has no MODEL_CARD beside it. piper1-gpl is GPL-3.0 and stays a subprocess.')


def synth_piper(text, voice):
    model = piper_model()
    note_piper_license(model)
    bin_path = os.environ.get('GIFOS_PIPER_BIN', '').strip() or os.path.join(HOME, 'models', 'piper', 'piper')
    if not os.path.exists(bin_path):
        bin_path = 'piper'
    rate = 22050
    meta = model + '.json'
    if os.path.exists(meta):
        try:
            rate = int(json.load(open(meta, encoding='utf-8'))['audio']['sample_rate'])
        except Exception:
            rate = 22050
    proc = subprocess.run([bin_path, '--model', model, '--output_raw'], input=text.encode('utf-8'), capture_output=True, check=False)
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError('piper failed: ' + proc.stderr.decode('utf-8', 'replace')[-200:])
    return proc.stdout, rate


def synth_http(text, voice):
    url = os.environ.get('GIFOS_TTS_URL', '').strip()
    openai = url.rstrip('/').endswith('/v1/audio/speech')
    if openai:
        body = json.dumps({'model': 'tts-1', 'input': text, 'voice': voice or 'alloy', 'response_format': 'wav'}).encode()
    else:
        body = json.dumps({'text': text, 'voice': voice or ''}).encode()
    req = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as res:
        buf = res.read()
        ctype = res.headers.get('Content-Type', '')
    parsed = parse_wav(buf)
    if parsed:
        return parsed
    if 'json' in ctype:
        meta = json.loads(buf.decode('utf-8'))
        if meta.get('audio'):
            return base64.b64decode(meta['audio']), int(meta.get('rate') or 24000)
    return buf, 24000


def synthesize(text, voice):
    if FAKE:
        return fake_sentence_pcm()
    engine = STATE['tts']
    if engine == 'kokoro':
        return synth_kokoro(text, voice)
    if engine == 'piper':
        return synth_piper(text, voice)
    if engine == 'espeak':
        return synth_espeak(text, voice)
    if engine == 'http':
        return synth_http(text, voice)
    raise RuntimeError('no tts engine')


def ensure_kokoro():
    global KOKORO
    if KOKORO is not None or STATE['tts'] != 'kokoro':
        return
    folder = os.path.join(HOME, 'models', 'kokoro')
    model = os.path.join(folder, 'kokoro-v1.0.int8.onnx')
    voices = os.path.join(folder, 'voices-v1.0.bin')
    download(KOKORO_MODEL_URL, model)
    download(KOKORO_VOICES_URL, voices)
    from kokoro_onnx import Kokoro
    t0 = time.perf_counter()
    KOKORO = Kokoro(model, voices)
    log('kokoro loaded in %.2fs' % (time.perf_counter() - t0))


def ensure_whisper():
    global WHISPER
    if WHISPER is not None or STATE['stt'] != 'faster-whisper':
        return
    threads = int(os.environ.get('GIFOS_STT_THREADS') or '4')
    if threads < 1:
        threads = 1
    if threads > 8:
        threads = 8
    root = os.path.join(HOME, 'models', 'faster-whisper')
    os.makedirs(root, exist_ok=True)
    from faster_whisper import WhisperModel
    t0 = time.perf_counter()
    WHISPER = WhisperModel(STATE['stt_model'], device='cpu', compute_type='int8', cpu_threads=threads, download_root=root)
    log('faster-whisper %s loaded in %.2fs threads=%d' % (STATE['stt_model'], time.perf_counter() - t0, threads))


def as_float32(pcm):
    import numpy as np
    if not pcm:
        return np.zeros(0, dtype=np.float32)
    audio = np.frombuffer(pcm[:len(pcm) // 2 * 2], dtype=np.int16).astype(np.float32) / 32768.0
    return audio


def transcribe_array(pcm, rate):
    """pcm is raw s16le bytes. faster-whisper receives a numpy array, not a path."""
    pcm = to_16k(pcm, rate)
    if FAKE or STATE['stt'] == 'fake':
        if len(pcm) < 1600:
            return ''
        return 'the purple giraffe reads seven books'
    if STATE['stt'] == 'http':
        return transcribe_http(pcm)
    if STATE['stt'] == 'whisper.cpp':
        raise RuntimeError('whisper.cpp is optional and is not the sidecar default. Set GIFOS_STT=faster-whisper.')
    ensure_whisper()
    audio = as_float32(pcm)
    if audio.size == 0:
        return ''
    with LOCK:
        segments, _info = WHISPER.transcribe(
            audio, beam_size=1, language='en', vad_filter=True,
            vad_parameters={'min_silence_duration_ms': END_MS},
        )
        text = ' '.join(s.text.strip() for s in segments).strip()
    return text


def transcribe_http(pcm):
    url = os.environ.get('GIFOS_STT_URL', '').strip()
    wav = wav_bytes(pcm, 16000)
    openai = url.rstrip('/').endswith('/v1/audio/transcriptions')
    if openai:
        boundary = 'gifosvoice'
        body = b''.join([
            b'--' + boundary.encode() + b'\r\n',
            b'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n',
            b'Content-Type: audio/wav\r\n\r\n',
            wav, b'\r\n',
            b'--' + boundary.encode() + b'\r\n',
            b'Content-Disposition: form-data; name="model"\r\n\r\nbase\r\n',
            b'--' + boundary.encode() + b'--\r\n',
        ])
        req = urllib.request.Request(url, data=body, headers={'Content-Type': 'multipart/form-data; boundary=' + boundary})
    else:
        req = urllib.request.Request(url, data=wav, headers={'Content-Type': 'audio/wav'})
    with urllib.request.urlopen(req, timeout=120) as res:
        payload = res.read()
    try:
        return str(json.loads(payload.decode('utf-8')).get('text') or '').strip()
    except Exception:
        return payload.decode('utf-8', 'replace').strip()


def wav_bytes(pcm, rate):
    import struct
    data = pcm[:len(pcm) // 2 * 2]
    header = struct.pack('<4sI4s4sIHHIIHH4sI',
                         b'RIFF', 36 + len(data), b'WAVE', b'fmt ', 16, 1, 1, rate,
                         rate * 2, 2, 16, b'data', len(data))
    return header + data


def speech_regions(audio):
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    opts = VadOptions(min_silence_duration_ms=END_MS, min_speech_duration_ms=250, speech_pad_ms=80)
    return get_speech_timestamps(audio, opts, sampling_rate=16000)


def push_stream(stream_id, speaker, pcm, rate):
    pcm = to_16k(pcm, rate)
    slot = STREAMS.get(stream_id)
    if slot is None:
        slot = {'pcm': b'', 'speaker': speaker or 'speaker', 'partial': False, 't0': int(time.time() * 1000)}
        STREAMS[stream_id] = slot
    if speaker:
        slot['speaker'] = speaker
    slot['pcm'] += pcm
    events = []
    if FAKE or STATE['vad'] == 'energy':
        hot = rms_i16(pcm) > 0.02
        ms = (len(pcm) // 2) / 16000 * 1000
        if hot:
            slot['silence_ms'] = 0
            slot['speech'] = True
        else:
            slot['silence_ms'] = slot.get('silence_ms', 0) + ms
        spoken = len(slot['pcm']) // 2 / 16000
        if slot.get('speech') and not slot['partial'] and spoken >= 0.25 and hot:
            slot['partial'] = True
            events.append({'text': 'purple', 'final': False, 'speaker': slot['speaker']})
        if slot.get('speech') and slot.get('silence_ms', 0) >= END_MS:
            text = transcribe_array(slot['pcm'], 16000) if not FAKE else 'the purple giraffe reads seven books'
            events.append({'text': text, 'final': True, 'speaker': slot['speaker'], 't_start': slot['t0'], 't_end': int(time.time() * 1000)})
            STREAMS.pop(stream_id, None)
        return events
    audio = as_float32(slot['pcm'])
    try:
        regions = speech_regions(audio)
        STATE['vad'] = 'silero'
    except Exception as exc:
        STATE['vad'] = 'energy'
        log('silero unavailable, energy gate in use: ' + str(exc)[:160])
        return push_stream(stream_id, speaker, b'', 16000)
    if not regions:
        if len(slot['pcm']) > 16000 * 3:
            slot['pcm'] = b''
        return events
    last = regions[-1]
    end = int(last['end'])
    tail = len(audio) - end
    if tail >= int(0.001 * END_MS * 16000):
        piece = slot['pcm'][:end * 2]
        text = transcribe_array(piece, 16000)
        events.append({'text': text, 'final': True, 'speaker': slot['speaker'], 't_start': slot['t0'], 't_end': int(time.time() * 1000)})
        STREAMS.pop(stream_id, None)
        return events
    if not slot['partial'] and (end - int(last['start'])) >= 16000 * 2:
        slot['partial'] = True
        text = transcribe_array(slot['pcm'][int(last['start']) * 2:end * 2], 16000)
        events.append({'text': text, 'final': False, 'speaker': slot['speaker']})
    return events


def run_self_test():
    if STATE['tts'] == 'http':
        STATE['self_test'] = {'tts_rtf': None, 'stt_rtf': None, 'ttfa_s': None}
        return
    line = 'Hello there friend.'
    t0 = time.perf_counter()
    pcm, rate = synthesize(line, '')
    dt = time.perf_counter() - t0
    audio_s = (len(pcm) // 2) / float(rate or 1)
    rtf = (dt / audio_s) if audio_s else None
    STATE['self_test'] = {'tts_rtf': round(rtf, 3) if rtf is not None else None, 'stt_rtf': None, 'ttfa_s': round(dt, 3)}
    log('self-test ttfa %.3fs rtf %s audio %.2fs' % (dt, STATE['self_test']['tts_rtf'], audio_s))


def boot():
    choose_engines()
    if FAKE:
        return
    if STATE['tts'] == 'kokoro':
        ensure_kokoro()
    if STATE['stt'] == 'faster-whisper':
        ensure_whisper()
    try:
        run_self_test()
    except Exception as exc:
        STATE['error'] = str(exc)[:200]
        log('self-test failed: ' + STATE['error'])


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        return

    def cors(self):
        origin = self.headers.get('Origin') or 'null'
        self.send_header('Access-Control-Allow-Origin', origin)
        self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'authorization, content-type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Expose-Headers', 'x-audio-rate, x-audio-format, x-audio-channels, x-sentence-count')

    def authed(self):
        if not TOKEN:
            return False
        return self.headers.get('Authorization', '') == 'Bearer ' + TOKEN

    def deny(self):
        body = b'{"error":"unauthorized"}'
        self.send_response(401)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split('?', 1)[0] != '/health':
            self.send_error(404)
            return
        if not self.authed():
            self.deny()
            return
        body = json.dumps({
            'ok': not STATE['error'],
            'engines': {
                'stt': STATE['stt'],
                'tts': STATE['tts'],
                'stt_model': STATE['stt_model'],
                'tts_voice': STATE['tts_voice'],
            },
            'self_test': STATE['self_test'],
            'vad': {'kind': STATE['vad'], 'end_ms': END_MS},
            'error': STATE['error'],
        }).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        n = int(self.headers.get('Content-Length') or '0')
        if n < 0 or n > MAX_BODY:
            raise ValueError('body too large')
        return self.rfile.read(n) if n else b''

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        if path not in ('/tts', '/stt'):
            self.send_error(404)
            return
        if not self.authed():
            self.deny()
            return
        try:
            raw = self.read_body()
            if path == '/tts':
                self.handle_tts(raw)
            else:
                self.handle_stt(raw)
        except Exception as exc:
            log('request failed: ' + str(exc)[:300])
            if not self.wfile.closed:
                msg = json.dumps({'error': str(exc)[:300]}).encode()
                try:
                    self.send_response(500)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(msg)))
                    self.cors()
                    self.end_headers()
                    self.wfile.write(msg)
                except Exception:
                    pass

    def write_chunk(self, data):
        if not data:
            return
        self.wfile.write(('%x\r\n' % len(data)).encode('ascii') + data + b'\r\n')
        self.wfile.flush()

    def handle_tts(self, raw):
        req = json.loads(raw.decode('utf-8') or '{}')
        text = str(req.get('text') or '')
        voice = str(req.get('voice') or '')
        parts = split_clauses(text)
        if not parts:
            raise RuntimeError('text to speech was given empty text')
        # The first clause is synthesized before the response headers so the
        # sample rate is known. Later clauses are synthesized while earlier
        # PCM is written, which is while the page plays them.
        pending = synthesize(parts[0], voice)
        rate = pending[1] or 24000
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Transfer-Encoding', 'chunked')
        self.send_header('X-Audio-Format', 's16le')
        self.send_header('X-Audio-Channels', '1')
        self.send_header('X-Audio-Rate', str(rate))
        self.send_header('X-Sentence-Count', str(len(parts)))
        self.cors()
        self.end_headers()
        for i, _part in enumerate(parts):
            pcm, got_rate = pending
            if got_rate:
                rate = got_rate
            box = {}
            worker = None
            if i + 1 < len(parts):
                nxt = parts[i + 1]

                def run(p=nxt):
                    try:
                        box['pcm'] = synthesize(p, voice)
                    except Exception as exc:
                        box['error'] = exc

                worker = threading.Thread(target=run)
                worker.start()
            self.write_chunk(pcm)
            if worker is not None:
                worker.join()
                if 'error' in box:
                    raise box['error']
                pending = box['pcm']
                if FAKE and FAKE_GAP_S > 0:
                    time.sleep(FAKE_GAP_S)
        self.wfile.write(b'0\r\n\r\n')
        self.wfile.flush()

    def handle_stt(self, raw):
        ctype = (self.headers.get('Content-Type') or '').split(';')[0].strip().lower()
        events = []
        if ctype == 'application/json':
            req = json.loads(raw.decode('utf-8') or '{}')
            pcm = base64.b64decode(req.get('pcm_b64') or '')
            events = push_stream(str(req.get('stream_id') or 'default'), str(req.get('speaker') or ''), pcm, int(req.get('rate') or 16000))
        else:
            if ctype == 'audio/wav' or raw[:4] == b'RIFF':
                parsed = parse_wav(raw)
                pcm, rate = parsed if parsed else (raw, 16000)
            else:
                pcm, rate = raw, int(self.headers.get('X-Audio-Rate') or '16000')
            fake_text = self.headers.get('X-Fake-Text')
            if FAKE and fake_text:
                if len(pcm) > 8000:
                    events.append({'text': fake_text.split()[0] if fake_text.split() else fake_text, 'final': False})
                events.append({'text': fake_text, 'final': True})
            else:
                if len(pcm) >= 16000:
                    half = pcm[:len(pcm) // 2]
                    events.append({'text': transcribe_array(half, rate), 'final': False})
                events.append({'text': transcribe_array(pcm, rate), 'final': True})
        payload = ''.join(json.dumps(ev) + '\n' for ev in events).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.send_header('Content-Length', str(len(payload)))
        self.cors()
        self.end_headers()
        self.wfile.write(payload)


def main():
    boot()
    port = int(os.environ.get('GIFOS_VOICE_PORT') or '0')
    httpd = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    bound = httpd.server_address[1]
    sys.stdout.write('GIFOS_VOICE_READY %d\n' % bound)
    sys.stdout.flush()
    log('listening 127.0.0.1:%d stt=%s tts=%s' % (bound, STATE['stt'], STATE['tts']))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main()
