// SMPTE timecode helpers. All conversions go through integer frame counts.

const VALID_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];

function isDropFrame(fps) {
  return fps === 29.97 || fps === 59.94;
}

function isNtsc(fps) {
  return fps === 23.976 || fps === 29.97 || fps === 59.94;
}

function nominalFps(fps) {
  return Math.round(fps);
}

function secondsToFrames(seconds, fps) {
  return Math.round(seconds * fps);
}

function framesToTimecode(frames, fps) {
  const nominal = nominalFps(fps);
  const df = isDropFrame(fps);
  let n = Math.max(0, Math.round(frames));

  if (df) {
    // SMPTE drop-frame: skip frame numbers 0..N at the start of every minute except each 10th minute
    const dropFrames = Math.round(fps * 0.066666);           // 2 @ 29.97, 4 @ 59.94
    const framesPer10Min = Math.round(fps * 600);            // 17982 / 35964
    const framesPerMin = nominal * 60 - dropFrames;          // 1798 / 3596
    const tens = Math.floor(n / framesPer10Min);
    const rem = n % framesPer10Min;
    n += dropFrames * 9 * tens;
    if (rem > dropFrames) n += dropFrames * Math.floor((rem - dropFrames) / framesPerMin);
  }

  const f = n % nominal;
  const s = Math.floor(n / nominal) % 60;
  const m = Math.floor(n / (nominal * 60)) % 60;
  const h = Math.floor(n / (nominal * 3600));
  const pad = v => String(v).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${df ? ';' : ':'}${pad(f)}`;
}

// Parses HH:MM:SS:FF (or ;FF) into a frame count; returns null for malformed input
function timecodeToFrames(tc, fps) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[:;.](\d{2})$/.exec(String(tc || '').trim());
  if (!m) return null;
  const [h, min, s, f] = m.slice(1).map(Number);
  const nominal = nominalFps(fps);
  if (min > 59 || s > 59 || f >= nominal) return null;
  let frames = ((h * 60 + min) * 60 + s) * nominal + f;
  if (isDropFrame(fps)) {
    const dropFrames = Math.round(fps * 0.066666);
    const totalMinutes = h * 60 + min;
    frames -= dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}

function secondsToTimecode(seconds, fps) {
  return framesToTimecode(secondsToFrames(seconds, fps), fps);
}

// 00:01:02,345 — SubRip time format
function secondsToSrtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (v, n = 2) => String(v).padStart(n, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

module.exports = {
  VALID_FPS, isDropFrame, isNtsc, nominalFps,
  secondsToFrames, framesToTimecode, timecodeToFrames, secondsToTimecode, secondsToSrtTime
};
