// Local Whisper hears three buses: the stage, the row, and the stadium.
// A line is kept only while the bot tile is showing the transcribing label.

export const LANES = ['stage', 'row', 'stadium'];

export function captureSelectors() {
  return [
    { lane: 'row', selector: '.tile[data-peer] video' },
    { lane: 'stage', selector: '#stagefeed video, video.stageface' },
    { lane: 'stadium', selector: '#stadium .rowtile video' },
  ];
}

export function normalizeLane(lane) {
  const s = String(lane || '');
  return LANES.includes(s) ? s : '';
}

// sources: [{ id, bus, audio }]. Every audible source on the three buses
// is captured. A bus with nobody on it is simply empty.
export function planCaptures(sources) {
  const plan = [];
  for (const src of sources || []) {
    if (!src || !src.audio) continue;
    const bus = normalizeLane(src.bus);
    if (!bus) continue;
    plan.push({ id: String(src.id || ''), bus });
  }
  return plan;
}

export function busesCovered(plan) {
  const have = new Set((plan || []).map((p) => p.bus));
  return {
    stage: have.has('stage'),
    row: have.has('row'),
    stadium: have.has('stadium'),
  };
}

// Fail closed: no transcribing label, no line.
export function lineAllowed(transcribingLabel, text) {
  if (!transcribingLabel) return false;
  return !!String(text || '').trim();
}
