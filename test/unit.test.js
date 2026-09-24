const { test } = require('node:test');
const assert = require('node:assert/strict');
const tc = require('../lib/timecode');
const { buildCsv, buildSrt, buildEdl, buildFcpXml } = require('../lib/exporters');
const { parseYouTubeId, parseStoryboardSpec } = require('../lib/youtube');

test('non-drop-frame timecodes', () => {
  assert.equal(tc.framesToTimecode(0, 24), '00:00:00:00');
  assert.equal(tc.secondsToTimecode(42.5, 25), '00:00:42:13');
  assert.equal(tc.timecodeToFrames('01:00:00:00', 24), 86400);
  assert.equal(tc.timecodeToFrames('00:00:01:24', 24), null, 'frame number must be below fps');
  assert.equal(tc.timecodeToFrames('garbage', 24), null);
});

test('drop-frame timecodes skip frames ;00 and ;01 except every 10th minute', () => {
  assert.equal(tc.framesToTimecode(1799, 29.97), '00:00:59;29');
  assert.equal(tc.framesToTimecode(1800, 29.97), '00:01:00;02');
  assert.equal(tc.framesToTimecode(17982, 29.97), '00:10:00;00');
  assert.equal(tc.timecodeToFrames('01:00:00;00', 29.97), 107892);
  for (const fps of [29.97, 59.94]) {
    for (const frames of [0, 1, 1799, 1800, 17981, 17982, 123456, 400000]) {
      assert.equal(tc.timecodeToFrames(tc.framesToTimecode(frames, fps), fps), frames, `${fps} @ ${frames}`);
    }
  }
});

test('SRT time format', () => {
  assert.equal(tc.secondsToSrtTime(3661.5), '01:01:01,500');
  assert.equal(tc.secondsToSrtTime(0), '00:00:00,000');
});

const project = { title: 'Cut & "3" <final>', tags: ['color', 'audio'] };
const threads = [
  { author: 'Alice', text: 'Too warm | fix\nplease', timecode: 5, timecode_end: null, status: 0, tags: '["audio"]',
    replies: [{ author: 'Bob', text: 'agree' }] },
  { author: 'Карина', text: 'Звук "плывёт"', timecode: 65.5, timecode_end: 70, status: 1, status_by: 'Ed', tags: null, replies: [] }
];

test('EDL export for DaVinci Resolve markers', () => {
  const edl = buildEdl({ project, threads, fps: 24, startFrames: 86400, colorBy: 'status' });
  const lines = edl.split('\r\n');
  assert.equal(lines[0], 'TITLE: Cut & "3" <final>');
  assert.equal(lines[1], 'FCM: NON-DROP FRAME');
  assert.equal(lines[3], '001  001      V     C        01:00:05:00 01:00:05:01 01:00:05:00 01:00:05:01  ');
  assert.equal(lines[4], ' |C:ResolveColorYellow |M:Alice: Too warm fix please #audio |D:1');
  assert.match(edl, /002 {2}001 {6}V {5}C {8}01:01:05:12 01:01:10:00/);
  assert.match(edl, /\|C:ResolveColorGreen \|M:Карина: Звук "плывёт" \|D:108/);

  const byTag = buildEdl({ project, threads, fps: 29.97, startFrames: 0, colorBy: 'tag' });
  assert.match(byTag, /FCM: DROP FRAME/);
  assert.match(byTag, /ResolveColorGreen \|M:Alice/, 'second tag in palette is green');
});

test('FCP XML export escapes text and places markers in frames', () => {
  const xml = buildFcpXml({ project, threads, fps: 23.976, startFrames: 0 });
  assert.match(xml, /<name>Cut &amp; &quot;3&quot; &lt;final&gt; \(review markers\)<\/name>/);
  assert.match(xml, /<ntsc>TRUE<\/ntsc>/);
  assert.equal((xml.match(/<marker>/g) || []).length, 2);
  assert.match(xml, /<in>120<\/in>\s*<out>-1<\/out>/);
  assert.match(xml, /<comment>Too warm \| fix\nplease\n↳ Bob: agree<\/comment>/);
});

test('SRT export', () => {
  const srt = buildSrt({ threads });
  assert.match(srt, /^1\n00:00:05,000 --> 00:00:08,000\n\[Alice\] Too warm \| fix\nplease #audio\n↳ Bob: agree\n/);
  assert.match(srt, /2\n00:01:05,500 --> 00:01:10,000\n\[Карина\] \(Accepted\) Звук "плывёт"/);
});

test('CSV export has BOM and escapes quotes', () => {
  const csv = buildCsv({ threads, fps: 25, startFrames: 0 });
  assert.ok(csv.startsWith('﻿In,Out,Author'));
  assert.match(csv, /"Звук ""плывёт"""/);
  assert.match(csv, /"00:01:05:13","00:01:09:24"/);
});

test('YouTube link parsing', () => {
  const id = 'dQw4w9WgXcQ';
  for (const url of [
    `https://youtu.be/${id}?si=abc`, `https://www.youtube.com/watch?feature=share&v=${id}`,
    `https://m.youtube.com/watch?v=${id}`, `https://youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`, `https://www.youtube.com/embed/${id}?start=3`
  ]) assert.equal(parseYouTubeId(url), id, url);
  for (const url of [
    `https://youtu.be/${id}"onmouseover=alert(1)`, 'javascript:alert(1)',
    `https://evil.com/watch?v=${id}`, `https://youtube.com.evil.com/watch?v=${id}`, 42, null
  ]) assert.equal(parseYouTubeId(url), null, String(url));
});

test('storyboard spec parsing', () => {
  const spec = 'https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L$L/$N.jpg?sqp=abc|48#27#100#10#10#0#default#rs$A|80#45#108#10#10#2000#M$M#rs$B|320#180#108#3#3#2000#M$M#rs$C';
  const levels = parseStoryboardSpec(spec, 213);
  assert.equal(levels.length, 3);
  assert.equal(levels[0].interval, 2130, 'level 0 spread over the duration');
  assert.equal(levels[2].url, 'https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L2/$N.jpg?sqp=abc');
  assert.deepEqual([levels[2].width, levels[2].cols, levels[2].name, levels[2].sigh], [320, 3, 'M$M', 'rs$C']);
  assert.deepEqual(parseStoryboardSpec('https://evil.example/x|1#1#1#1#1#1#a#b', 10), []);
});
