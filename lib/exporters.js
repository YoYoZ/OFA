// Builders for NLE / spreadsheet exports.
// Every builder takes: { project, threads, fps, startFrames, colorBy }
//   project  – { title, tags: string[] }
//   threads  – root annotations sorted by timecode, each with `replies: []`
//   startFrames – timeline start offset in frames (e.g. 01:00:00:00)
//   colorBy  – 'status' | 'tag'

const tc = require('./timecode');

const STATUS_LABELS = { 0: 'Pending', 1: 'Accepted', 2: 'Rejected', 3: 'In progress' };

// Default length of point comments in exports that need a duration (SRT, marker ranges)
const DEFAULT_SRT_SECONDS = 3;

// DaVinci Resolve marker colors
const RESOLVE_STATUS_COLORS = { 0: 'Yellow', 1: 'Green', 2: 'Red', 3: 'Blue' };
// Matches the order of the UI tag palette: blue, green, gold, red, purple, orange, teal, pink
const RESOLVE_TAG_COLORS = ['Blue', 'Green', 'Yellow', 'Red', 'Purple', 'Sand', 'Cyan', 'Pink'];

function parseTags(json) {
  if (!json) return [];
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

function oneLine(str) {
  return String(str).replace(/[\r\n\t|]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function markerLabel(a) {
  const tags = parseTags(a.tags);
  return `${a.author}: ${a.text}${tags.length ? ' #' + tags.join(' #') : ''}`;
}

function threadNote(a) {
  const lines = [a.text];
  for (const r of a.replies || []) lines.push(`↳ ${r.author}: ${r.text}`);
  return lines.join('\n');
}

function colorIndex(a, projectTags, colorBy, statusColors, tagColors) {
  if (colorBy === 'tag') {
    const first = parseTags(a.tags)[0];
    const idx = first ? projectTags.indexOf(first) : -1;
    if (idx >= 0) return tagColors[idx % tagColors.length];
  }
  return statusColors[a.status] || statusColors[0];
}

function durationFrames(a, fps) {
  if (a.timecode_end != null && a.timecode_end > a.timecode) {
    return Math.max(1, tc.secondsToFrames(a.timecode_end, fps) - tc.secondsToFrames(a.timecode, fps));
  }
  return 1;
}

// ── CSV (spreadsheet) ────────────────────────────────────────────────────────

function csvEscape(str) {
  return '"' + String(str ?? '').replace(/"/g, '""') + '"';
}

function buildCsv({ threads, fps, startFrames }) {
  const header = ['In', 'Out', 'Author', 'Comment', 'Tags', 'Status', 'Status by', 'Replies'];
  const rows = threads.map(a => {
    const inF = startFrames + tc.secondsToFrames(a.timecode, fps);
    const outF = inF + durationFrames(a, fps) - 1;
    return [
      tc.framesToTimecode(inF, fps),
      tc.framesToTimecode(Math.max(inF, outF), fps),
      a.author,
      a.text,
      parseTags(a.tags).join(', '),
      STATUS_LABELS[a.status] || STATUS_LABELS[0],
      a.status_by || '',
      (a.replies || []).map(r => `${r.author}: ${r.text}`).join('\n')
    ].map(csvEscape).join(',');
  });
  // BOM so Excel detects UTF-8 (Cyrillic etc.)
  return '﻿' + [header.join(','), ...rows].join('\r\n') + '\r\n';
}

// ── SRT (subtitles — shows comments on screen in any NLE) ───────────────────

function buildSrt({ threads }) {
  return threads.map((a, i) => {
    const end = a.timecode_end != null && a.timecode_end > a.timecode ? a.timecode_end : a.timecode + DEFAULT_SRT_SECONDS;
    const tags = parseTags(a.tags);
    const status = a.status ? ` (${STATUS_LABELS[a.status]})` : '';
    const lines = [`[${a.author}]${status} ${a.text}${tags.length ? ' #' + tags.join(' #') : ''}`];
    for (const r of a.replies || []) lines.push(`↳ ${r.author}: ${r.text}`);
    return `${i + 1}\n${tc.secondsToSrtTime(a.timecode)} --> ${tc.secondsToSrtTime(end)}\n${lines.join('\n').replace(/\r/g, '').replace(/\n{2,}/g, '\n')}\n`;
  }).join('\n');
}

// ── EDL with markers (DaVinci Resolve: Timelines → Import → Timeline Markers from EDL)

function buildEdl({ project, threads, fps, startFrames, colorBy }) {
  const title = oneLine(project.title || 'Open Frame Annotator').slice(0, 60) || 'Open Frame Annotator';
  const out = [`TITLE: ${title}`, `FCM: ${tc.isDropFrame(fps) ? 'DROP FRAME' : 'NON-DROP FRAME'}`, ''];
  threads.forEach((a, i) => {
    const inF = startFrames + tc.secondsToFrames(a.timecode, fps);
    const dur = durationFrames(a, fps);
    const tcIn = tc.framesToTimecode(inF, fps);
    const tcOut = tc.framesToTimecode(inF + dur, fps);
    const num = String(i + 1).padStart(3, '0');
    const color = colorIndex(a, project.tags, colorBy, RESOLVE_STATUS_COLORS, RESOLVE_TAG_COLORS);
    out.push(`${num}  001      V     C        ${tcIn} ${tcOut} ${tcIn} ${tcOut}  `);
    out.push(` |C:ResolveColor${color} |M:${oneLine(markerLabel(a)).slice(0, 250)} |D:${dur}`);
    out.push('');
  });
  return out.join('\r\n');
}

// ── FCP 7 XML (xmeml) — Premiere Pro: File → Import creates a sequence with markers

function xmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// Marker colors are not written: Premiere's XML color encoding is undocumented.
function buildFcpXml({ project, threads, fps, startFrames }) {
  const timebase = tc.nominalFps(fps);
  const ntsc = tc.isNtsc(fps) ? 'TRUE' : 'FALSE';
  const rate = `<rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>`;
  const lastFrame = threads.reduce((max, a) => {
    const end = tc.secondsToFrames(a.timecode_end != null ? a.timecode_end : a.timecode, fps);
    return Math.max(max, end);
  }, 0);
  const duration = lastFrame + tc.secondsToFrames(10, fps);
  const name = xmlEscape(project.title || 'Open Frame Annotator');

  const markers = threads.map(a => {
    const inF = tc.secondsToFrames(a.timecode, fps);
    const dur = durationFrames(a, fps);
    return `      <marker>
        <name>${xmlEscape(oneLine(markerLabel(a)).slice(0, 250))}</name>
        <comment>${xmlEscape(threadNote(a))}</comment>
        <in>${inF}</in>
        <out>${dur > 1 ? inF + dur : -1}</out>
      </marker>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="ofa-sequence">
    <name>${name} (review markers)</name>
    <duration>${duration}</duration>
    ${rate}
    <timecode>
      ${rate}
      <string>${tc.framesToTimecode(startFrames, fps)}</string>
      <frame>${startFrames}</frame>
      <displayformat>${tc.isDropFrame(fps) ? 'DF' : 'NDF'}</displayformat>
    </timecode>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            ${rate}
            <width>1920</width>
            <height>1080</height>
            <pixelaspectratio>square</pixelaspectratio>
          </samplecharacteristics>
        </format>
        <track></track>
      </video>
      <audio><track></track></audio>
    </media>
${markers}
  </sequence>
</xmeml>
`;
}

const FORMATS = {
  csv: { build: buildCsv, ext: 'csv', type: 'text/csv; charset=utf-8' },
  srt: { build: buildSrt, ext: 'srt', type: 'application/x-subrip; charset=utf-8' },
  edl: { build: buildEdl, ext: 'edl', type: 'text/plain; charset=utf-8' },
  xml: { build: buildFcpXml, ext: 'xml', type: 'application/xml; charset=utf-8' }
};

module.exports = { FORMATS, STATUS_LABELS, buildCsv, buildSrt, buildEdl, buildFcpXml };
