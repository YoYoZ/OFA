const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { io } = require('socket.io-client');
const { startServer, tempDataDir, sleep } = require('./helpers');

const VIDEO = 'https://youtu.be/dQw4w9WgXcQ';
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 1)]);

let srv, req, adminCookie, adminPassword;

function seedLegacyDb(dataDir) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(dataDir, 'annotations.db'));
    db.serialize(() => {
      db.run('CREATE TABLE projects (id TEXT PRIMARY KEY, youtube_url TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
      db.run('CREATE TABLE annotations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, timecode REAL NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
      db.run(`INSERT INTO projects (id, youtube_url, created_at) VALUES ('legacy-1', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', '2020-01-01 00:00:00')`);
      db.run(`INSERT INTO annotations (id, project_id, author, text, timecode, created_at) VALUES ('legacy-a', 'legacy-1', 'Old', 'old note', 12.5, '2020-01-02 00:00:00')`, (err) => {
        if (err) return reject(err);
        db.close(resolve);
      });
    });
  });
}

async function createProject(body = {}) {
  const r = await req('POST', '/api/projects', { youtube_url: VIDEO, title: 'Main', tags_config: 'color, audio', ...body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { id: r.data.project_id, key: r.data.editor_token, ...r.data };
}

async function addComment(projectId, body = {}) {
  const r = await req('POST', `/api/projects/${projectId}/annotations`, { author: 'Alice', text: 'Too warm', timecode: 42.5, ...body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

before(async () => {
  const dataDir = tempDataDir();
  await seedLegacyDb(dataDir);
  srv = await startServer({ dataDir });
  req = srv.request;
  adminPassword = fs.readFileSync(path.join(dataDir, 'admin_password.txt'), 'utf8').trim();
  const r = await req('POST', '/api/admin/login', { password: adminPassword });
  assert.equal(r.status, 200);
  adminCookie = r.headers.get('set-cookie').split(';')[0];
});

after(() => srv.stop());

test('startup: generated password printed, healthz, legacy data migrated', async () => {
  assert.match(srv.output(), new RegExp(`generated admin password:\\s*\\n\\s*${adminPassword.replace(/[-]/g, '\\-')}`));
  assert.equal((await req('GET', '/healthz')).status, 200);
  const r = await req('GET', '/api/projects/legacy-1');
  assert.equal(r.status, 200);
  assert.equal(r.data.annotations[0].status, 0);
  assert.deepEqual(r.data.permissions, { review: true, moderate: false, admin: false }, 'legacy projects stay open for review');
  assert.equal(r.data.project.last_activity_at, '2020-01-02 00:00:00', 'activity = latest comment');
});

test('project creation returns reviewer and editor links; URLs are validated', async () => {
  const p = await createProject({ tags_config: 'color, audio, color, ,pacing' });
  assert.match(p.editor_url, new RegExp(`/project/${p.id}#key=${p.key}$`));
  assert.match(p.share_url, new RegExp(`/project/${p.id}$`));
  const r = await req('GET', `/api/projects/${p.id}`);
  assert.equal(r.data.project.youtube_url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(r.data.project.tags_config, '["color","audio","pacing"]');
  assert.equal(r.data.project.editor_token, undefined, 'reviewers never see the editor token');
  assert.deepEqual(r.data.permissions, { review: false, moderate: false, admin: false });

  const asEditor = await req('GET', `/api/projects/${p.id}`, undefined, { 'X-Editor-Key': p.key });
  assert.deepEqual(asEditor.data.permissions, { review: true, moderate: true, admin: false });
  assert.equal(asEditor.data.project.editor_token, p.key);

  for (const bad of ['javascript:alert(1)', 'https://evil.com/watch?v=dQw4w9WgXcQ', { a: 1 }]) {
    assert.equal((await req('POST', '/api/projects', { youtube_url: bad })).status, 400);
  }
});

test('annotation validation', async () => {
  const p = await createProject();
  const post = (body) => req('POST', `/api/projects/${p.id}/annotations`, { author: 'A', text: 'x', timecode: 1, ...body });
  assert.equal((await post({ timecode: '"><img src=x>' })).status, 400);
  assert.equal((await post({ timecode: -1 })).status, 400);
  assert.equal((await post({ author: { $: 1 } })).status, 400);
  assert.equal((await post({ timecode_end: 0.5 })).status, 400, 'range must end after start');
  assert.equal((await req('POST', '/api/projects/nope/annotations', { author: 'A', text: 'x', timecode: 1 })).status, 404);

  const range = await addComment(p.id, { timecode: 10, timecode_end: 15.5, tags: ['color', 'bogus', 5] });
  assert.equal(range.timecode_end, 15.5);
  assert.equal(range.tags, '["color"]');

  const reply = await addComment(p.id, { parent_id: range.id, timecode: undefined, text: 'agree' });
  assert.equal(reply.timecode, 10);
  assert.equal(reply.timecode_end, null);
  assert.equal((await post({ parent_id: reply.id })).status, 400, 'no reply to reply');
});

test('edit own comment; others and moderators cannot rewrite it', async () => {
  const p = await createProject();
  const a = await addComment(p.id);
  let r = await req('PATCH', `/api/annotations/${a.id}`, { text: 'hacked' });
  assert.equal(r.status, 403);
  r = await req('PATCH', `/api/annotations/${a.id}`, { text: 'by editor' }, { 'X-Editor-Key': p.key });
  assert.equal(r.status, 403);
  r = await req('PATCH', `/api/annotations/${a.id}`, { text: 'Much too warm', timecode: 40, timecode_end: 44, tags: ['audio'], edit_token: a.edit_token });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.text, 'Much too warm');
  assert.equal(r.data.timecode_end, 44);
  assert.equal(r.data.tags, '["audio"]');
  assert.ok(r.data.edited_at);
  r = await req('PATCH', `/api/annotations/${a.id}`, { timecode: 50 }, { 'X-Edit-Token': a.edit_token });
  assert.equal(r.data.timecode_end, null, 'range dropped when start moves past its end');
});

test('roles: reviewers cannot change status; editors can, with attribution', async () => {
  const p = await createProject();
  const a = await addComment(p.id);
  assert.equal((await req('PATCH', `/api/annotations/${a.id}/status`, { status: 1 })).status, 403);
  assert.equal((await req('PATCH', `/api/annotations/${a.id}/status`, { status: 1 }, { 'X-Editor-Key': 'wrong' })).status, 403);
  let r = await req('PATCH', `/api/annotations/${a.id}/status`, { status: 3, by: 'Editor Ed' }, { 'X-Editor-Key': p.key });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 3);
  assert.equal(r.data.status_by, 'Editor Ed');
  assert.ok(r.data.status_at);
  assert.equal((await req('PATCH', `/api/annotations/${a.id}/status`, { status: '1' }, { 'X-Editor-Key': p.key })).status, 400);
  r = await req('PATCH', `/api/annotations/${a.id}/status`, { status: 0 }, { 'X-Editor-Key': p.key });
  assert.equal(r.data.status_by, null, 'resetting clears attribution');
  // Admin session acts as editor everywhere
  r = await req('PATCH', `/api/annotations/${a.id}/status`, { status: 1 }, { Cookie: adminCookie });
  assert.equal(r.status, 200);
});

test('delete: author token, editor moderation, crash-safe token handling', async () => {
  const p = await createProject();
  const a = await addComment(p.id);
  const b = await addComment(p.id);
  assert.equal((await req('DELETE', `/api/annotations/${a.id}`, { edit_token: 12345 })).status, 403);
  assert.equal((await req('DELETE', `/api/annotations/${a.id}`, { edit_token: { a: 1 } })).status, 403);
  assert.equal((await req('DELETE', `/api/annotations/${a.id}`, {})).status, 403);
  assert.equal((await req('DELETE', `/api/annotations/${a.id}`, { edit_token: a.edit_token })).status, 200);
  assert.equal((await req('DELETE', `/api/annotations/${b.id}`, {}, { 'X-Editor-Key': p.key })).status, 200, 'editor removes any comment');
  assert.equal((await req('GET', '/healthz')).status, 200);
  assert.equal((await req('DELETE', '/api/annotations/legacy-a', {})).status, 200, 'tokenless legacy comments stay deletable');
});

test('bulk status and delete', async () => {
  const p = await createProject();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await addComment(p.id, { timecode: i })).id);
  const bulk = (body, key) => req('POST', `/api/projects/${p.id}/annotations/bulk`, body, key ? { 'X-Editor-Key': key } : {});
  assert.equal((await bulk({ ids, action: 'status', status: 1 })).status, 403);
  let r = await bulk({ ids, action: 'status', status: 1, by: 'Ed' }, p.key);
  assert.equal(r.data.affected, 3);
  r = await req('GET', `/api/projects/${p.id}`);
  assert.ok(r.data.annotations.every(a => a.status === 1 && a.status_by === 'Ed'));
  r = await bulk({ ids: ids.slice(0, 2), action: 'delete' }, p.key);
  assert.equal(r.status, 200);
  r = await req('GET', `/api/projects/${p.id}`);
  assert.equal(r.data.annotations.length, 1);
});

test('screenshots: upload by author, served back, removed with the comment', async () => {
  const p = await createProject();
  const a = await addComment(p.id);
  const upload = (buf, headers) => req('POST', `/api/annotations/${a.id}/screenshot`, buf, { 'Content-Type': 'image/jpeg', ...headers });
  assert.equal((await upload(JPEG, {})).status, 403);
  assert.equal((await upload(Buffer.alloc(300, 7), { 'X-Edit-Token': a.edit_token })).status, 400, 'non-JPEG rejected');
  const r = await upload(JPEG, { 'X-Edit-Token': a.edit_token });
  assert.equal(r.status, 200);
  assert.equal(r.data.has_screenshot, 1);
  const img = await fetch(`${srv.base}/api/annotations/${a.id}/screenshot`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await img.arrayBuffer()).length, JPEG.length);

  await req('DELETE', `/api/annotations/${a.id}`, { edit_token: a.edit_token });
  await sleep(100);
  assert.equal(fs.existsSync(path.join(srv.dataDir, 'screenshots', `${a.id}.jpg`)), false);
});

test('exports in all formats with start offset and status filter', async () => {
  const p = await createProject({ title: 'Ролик' });
  const a = await addComment(p.id, { timecode: 5, tags: ['audio'] });
  await addComment(p.id, { timecode: 65.5, timecode_end: 70, text: 'range' });
  await addComment(p.id, { parent_id: a.id, text: 'reply' });
  await req('PATCH', `/api/annotations/${a.id}/status`, { status: 1 }, { 'X-Editor-Key': p.key });

  let r = await req('GET', `/api/projects/${p.id}/export/edl?fps=24&start=01:00:00:00`);
  assert.equal(r.status, 200);
  assert.match(r.data, /01:00:05:00 01:00:05:01/);
  assert.match(r.data, /ResolveColorGreen \|M:Alice: Too warm #audio \|D:1/);
  assert.match(r.headers.get('content-disposition'), /filename\*=UTF-8''%D0%A0%D0%BE%D0%BB%D0%B8%D0%BA\.edl/);

  r = await req('GET', `/api/projects/${p.id}/export/srt`);
  assert.match(r.data, /00:01:05,500 --> 00:01:10,000/);
  assert.match(r.data, /↳ Alice: reply/);

  r = await req('GET', `/api/projects/${p.id}/export/xml?fps=25`);
  assert.equal((r.data.match(/<marker>/g) || []).length, 2);

  r = await req('GET', `/api/projects/${p.id}/export/csv?fps=25&statuses=0,3`);
  assert.equal(r.data.trim().split('\r\n').length, 2, 'header + the one pending comment');

  assert.equal((await req('GET', `/api/projects/${p.id}/export/premiere?fps=24`)).status, 200, 'legacy endpoint still works');
  assert.equal((await req('GET', `/api/projects/${p.id}/export/edl?fps=13`)).status, 400);
  assert.equal((await req('GET', `/api/projects/${p.id}/export/edl?start=bad`)).status, 400);
  assert.equal((await req('GET', `/api/projects/${p.id}/export/docx`)).status, 400);
});

test('project settings: editor only, broadcast to viewers', async () => {
  const p = await createProject();
  assert.equal((await req('PATCH', `/api/projects/${p.id}`, { title: 'X' })).status, 403);
  const r = await req('PATCH', `/api/projects/${p.id}`, { title: 'Renamed', description: 'Round 2', tags_config: ['a', 'b'] }, { 'X-Editor-Key': p.key });
  assert.equal(r.status, 200);
  assert.equal(r.data.title, 'Renamed');
  assert.equal(r.data.tags_config, '["a","b"]');
});

test('restore a deleted project from a browser backup', async () => {
  const p = await createProject();
  const root = await addComment(p.id, { timecode: 3, timecode_end: 6 });
  const reply = await addComment(p.id, { parent_id: root.id, author: 'Bob', text: 'ok' });
  const snapshot = (await req('GET', `/api/projects/${p.id}`, undefined, { 'X-Editor-Key': p.key })).data;
  snapshot.annotations.find(a => a.id === root.id).edit_token = root.edit_token;

  assert.equal((await req('POST', '/api/projects/restore', { project: snapshot.project, annotations: snapshot.annotations })).status, 409);
  await req('DELETE', `/api/admin/projects/${p.id}`, undefined, { Cookie: adminCookie });
  assert.equal((await req('GET', `/api/projects/${p.id}`)).status, 404);

  const r = await req('POST', '/api/projects/restore', {
    project: snapshot.project,
    annotations: [...snapshot.annotations, { id: 'bad', author: '', text: 'x', timecode: 1 }]
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.restored, 2);
  assert.equal(r.data.editor_token, p.key, 'editor keeps their key');

  const restored = await req('GET', `/api/projects/${p.id}`);
  assert.equal(restored.data.annotations.length, 2);
  assert.equal(restored.data.annotations.find(a => a.id === root.id).timecode_end, 6);
  // Own token survives, the reply (no token in backup) can no longer be deleted by strangers
  assert.equal((await req('DELETE', `/api/annotations/${reply.id}`, {})).status, 403);
  assert.equal((await req('PATCH', `/api/annotations/${root.id}`, { text: 'edited', edit_token: root.edit_token })).status, 200);
});

test('real-time events reach room members', async () => {
  const p = await createProject();
  const socket = io(srv.base, { transports: ['websocket'] });
  const events = [];
  await new Promise(res => socket.on('connect', res));
  socket.emit('join-project', p.id);
  socket.onAny((ev, payload) => events.push([ev, payload]));
  await sleep(100);

  const a = await addComment(p.id);
  await req('PATCH', `/api/annotations/${a.id}`, { text: 'edited', edit_token: a.edit_token });
  await req('PATCH', `/api/annotations/${a.id}/status`, { status: 1, by: 'Ed' }, { 'X-Editor-Key': p.key });
  await req('PATCH', `/api/projects/${p.id}`, { title: 'New' }, { 'X-Editor-Key': p.key });
  await req('DELETE', `/api/annotations/${a.id}`, { edit_token: a.edit_token });
  await req('DELETE', `/api/admin/projects/${p.id}`, undefined, { Cookie: adminCookie });
  await sleep(200);
  socket.close();

  assert.deepEqual(events.map(e => e[0]), [
    'annotation:created', 'annotation:updated', 'annotation:status', 'project:updated', 'thread:deleted', 'project:deleted'
  ]);
  assert.equal(events[2][1].status_by, 'Ed');
  assert.equal(events[0][1].edit_token, undefined, 'tokens are never broadcast');
});

test('admin: listing, pin, rotate editor key, bulk delete, auth checks', async () => {
  assert.equal((await req('GET', '/api/admin/projects')).status, 401);
  const p1 = await createProject({ title: 'Keep' });
  const p2 = await createProject({ title: 'Drop' });

  let r = await req('GET', '/api/admin/projects', undefined, { Cookie: adminCookie });
  assert.equal(r.status, 200);
  const listed = r.data.projects.find(x => x.id === p1.id);
  assert.equal(listed.editor_url.endsWith(`#key=${p1.key}`), true);
  assert.ok(r.data.storage.database > 0);

  r = await req('PATCH', `/api/admin/projects/${p1.id}`, { pinned: true, rotate_editor_token: true }, { Cookie: adminCookie });
  assert.equal(r.data.pinned, true);
  assert.notEqual(r.data.editor_token, p1.key);
  assert.equal((await req('GET', `/api/projects/${p1.id}`, undefined, { 'X-Editor-Key': p1.key })).data.permissions.moderate, false, 'old key revoked');

  r = await req('POST', '/api/admin/projects/delete', { ids: [p2.id, 'nope'] }, { Cookie: adminCookie });
  assert.equal(r.data.deleted, 1);

  // No CORS reflection for arbitrary origins
  r = await req('GET', '/api/admin/check', undefined, { Origin: 'https://evil.example' });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('admin: retention preview and cleanup respect activity and pins', async () => {
  const stale = await createProject({ title: 'Stale' });
  const pinned = await createProject({ title: 'Pinned' });
  const soon = await createProject({ title: 'Soon' });
  const fresh = await createProject({ title: 'Fresh' });
  // Age projects directly in the database
  const db = new sqlite3.Database(path.join(srv.dataDir, 'annotations.db'));
  const age = (id, days) => new Promise((res, rej) => db.run(
    `UPDATE projects SET last_activity_at = datetime('now', ?) WHERE id = ?`, [`-${days} days`, id], (e) => e ? rej(e) : res()));
  await age(stale.id, 400); await age(pinned.id, 400); await age(soon.id, 350);
  await new Promise(res => db.close(res));
  await req('PATCH', `/api/admin/projects/${pinned.id}`, { pinned: true }, { Cookie: adminCookie });

  assert.equal((await req('PUT', '/api/admin/settings', { retention_days: -1 }, { Cookie: adminCookie })).status, 400);
  let r = await req('PUT', '/api/admin/settings', { retention_days: 365, retention_warn_days: 30 }, { Cookie: adminCookie });
  assert.deepEqual(r.data, { retention_days: 365, retention_warn_days: 30 });

  r = await req('GET', '/api/admin/cleanup/preview', undefined, { Cookie: adminCookie });
  const dueIds = r.data.due.map(x => x.id), soonIds = r.data.soon.map(x => x.id);
  assert.ok(dueIds.includes(stale.id));
  assert.ok(!dueIds.includes(pinned.id) && !soonIds.includes(pinned.id));
  assert.ok(soonIds.includes(soon.id));
  assert.ok(!dueIds.includes(fresh.id) && !soonIds.includes(fresh.id));

  r = await req('GET', `/api/projects/${soon.id}`);
  assert.ok(r.data.project.expires_at, 'viewers see the expiry date');
  assert.equal(r.data.retention.days, 365);

  r = await req('POST', '/api/admin/cleanup/run', undefined, { Cookie: adminCookie });
  assert.ok(r.data.deleted >= 1);
  assert.equal((await req('GET', `/api/projects/${stale.id}`)).status, 404);
  assert.equal((await req('GET', `/api/projects/${pinned.id}`)).status, 200);
  assert.equal((await req('GET', `/api/projects/${soon.id}`)).status, 200);

  // Activity resets the clock
  await addComment(soon.id);
  r = await req('GET', `/api/projects/${soon.id}`);
  assert.ok(new Date(r.data.project.expires_at) > new Date(Date.now() + 360 * 86400000));

  await req('PUT', '/api/admin/settings', { retention_days: 0 }, { Cookie: adminCookie });
});

test('admin: database backup download', async () => {
  const res = await fetch(`${srv.base}/api/admin/backup`, { headers: { Cookie: adminCookie } });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
  await sleep(100);
  assert.deepEqual(fs.readdirSync(srv.dataDir).filter(f => f.startsWith('backup-tmp-')), [], 'temp file cleaned up');
});

test('admin: change password, other sessions logged out, survives restart', async () => {
  // Second admin session that must be logged out by the change
  const other = await req('POST', '/api/admin/login', { password: adminPassword });
  const otherCookie = other.headers.get('set-cookie').split(';')[0];

  assert.equal((await req('POST', '/api/admin/password', { current: 'wrong', next: 'newpassword1' }, { Cookie: adminCookie })).status, 403);
  assert.equal((await req('POST', '/api/admin/password', { current: adminPassword, next: 'short' }, { Cookie: adminCookie })).status, 400);
  assert.equal((await req('POST', '/api/admin/password', { current: adminPassword, next: 'newpassword1' }, { Cookie: adminCookie })).status, 200);

  assert.equal((await req('GET', '/api/admin/check', undefined, { Cookie: otherCookie })).data.authenticated, false);
  assert.equal((await req('GET', '/api/admin/check', undefined, { Cookie: adminCookie })).data.authenticated, true);
  assert.equal((await req('POST', '/api/admin/login', { password: adminPassword })).status, 401, 'bootstrap password disabled');

  // Restart: session and new password persist
  await srv.stop();
  srv = await startServer({ dataDir: srv.dataDir });
  req = srv.request;
  assert.doesNotMatch(srv.output(), /generated admin password/, 'no stale password banner');
  assert.equal((await req('GET', '/api/admin/check', undefined, { Cookie: adminCookie })).data.authenticated, true);
  assert.equal((await req('POST', '/api/admin/login', { password: 'newpassword1' })).status, 200);

  // Reset script brings the bootstrap password back and logs everyone out
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'reset-admin-password.js')], {
    cwd: srv.dataDir, env: { ...process.env, DATA_DIR: srv.dataDir, ADMIN_PASSWORD: '' }
  });
  assert.equal((await req('GET', '/api/admin/check', undefined, { Cookie: adminCookie })).data.authenticated, false);
  assert.equal((await req('POST', '/api/admin/login', { password: 'newpassword1' })).status, 401);
  assert.equal((await req('POST', '/api/admin/login', { password: adminPassword })).status, 200);
});
