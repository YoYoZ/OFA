const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startServer, sleep } = require('./helpers');

const VIDEO = 'https://youtu.be/dQw4w9WgXcQ';
const VIDEO2 = 'https://youtu.be/9bZkp7q19f0';
const EDITOR_CHAT = 100;
const REVIEWER_CHAT = 200;

// Minimal fake of the Telegram Bot API: records sendMessage, serves queued updates
function fakeTelegram() {
  const sent = [];
  const updates = [];
  let nextId = 1;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      const method = req.url.split('/').pop();
      const data = body ? JSON.parse(body) : {};
      const reply = (result) => res.end(JSON.stringify({ ok: true, result }));
      if (method === 'getMe') return reply({ id: 1, is_bot: true, username: 'ofa_test_bot' });
      if (method === 'sendMessage') { sent.push(data); return reply({ message_id: sent.length }); }
      if (method === 'getUpdates') {
        const deadline = Date.now() + 800;
        while (!updates.some(u => u.update_id >= (data.offset || 0)) && Date.now() < deadline) await sleep(50);
        return reply(updates.filter(u => u.update_id >= (data.offset || 0)));
      }
      return reply(true);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}`,
    sent,
    push(update) { updates.push({ update_id: nextId++, ...update }); },
    say(chatId, text) { this.push({ message: { chat: { id: chatId, type: 'private' }, text } }); },
    to(chatId) { return sent.filter(m => m.chat_id === chatId); },
    close: () => new Promise(r => server.close(r))
  })));
}

async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(100); }
  return fn();
}

let tg, srv, req;

before(async () => {
  tg = await fakeTelegram();
  srv = await startServer({ env: {
    TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_API_BASE: tg.base, TELEGRAM_DIGEST_SECONDS: '1',
    PUBLIC_URL: 'https://ofa.example'
  } });
  req = srv.request;
});

after(async () => { await srv.stop(); await tg.close(); });

test('telegram: subscribe, digests, replies, statuses, review done, new cut, unsubscribe', async () => {
  assert.match(srv.output(), /Telegram notifications: @ofa_test_bot/);

  const created = await req('POST', '/api/projects', { youtube_url: VIDEO, title: 'Brand <film>', tags_config: 'color, audio' });
  const id = created.data.project_id, key = created.data.editor_token;
  const editor = { 'X-Editor-Key': key };
  assert.equal((await req('GET', `/api/projects/${id}`)).data.telegram, true);

  // Editor subscribes from the editor page
  let r = await req('POST', `/api/projects/${id}/telegram`, { author: 'Ed' }, editor);
  assert.equal(r.data.role, 'editor');
  const editorCode = r.data.url.match(/^https:\/\/t\.me\/ofa_test_bot\?start=([\w-]+)$/)[1];
  tg.say(EDITOR_CHAT, `/start ${editorCode}`);
  const welcome = await waitFor(() => tg.to(EDITOR_CHAT).find(m => /Subscribed/.test(m.text)));
  assert.match(welcome.text, /Subscribed to <b>Brand &lt;film&gt;<\/b> as the editor/);
  assert.match(welcome.text, new RegExp(`https://ofa\\.example/project/${id}#key=${key}`), 'editor gets the editor link');

  // The code works once
  tg.say(EDITOR_CHAT + 1, `/start ${editorCode}`);
  assert.ok(await waitFor(() => tg.to(EDITOR_CHAT + 1).find(m => /expired/.test(m.text))));

  // Reviewer subscribes from the plain link
  r = await req('POST', `/api/projects/${id}/telegram`, { author: 'Kate' });
  assert.equal(r.data.role, 'reviewer');
  tg.say(REVIEWER_CHAT, `/start ${r.data.url.split('start=')[1]}`);
  const rWelcome = await waitFor(() => tg.to(REVIEWER_CHAT).find(m => /Subscribed/.test(m.text)));
  assert.doesNotMatch(rWelcome.text, /#key=/, 'reviewers never get the editor key');

  // Kate comments twice → one digest for the editor, nothing for Kate
  const c1 = (await req('POST', `/api/projects/${id}/annotations`, { author: 'Kate', text: 'Too warm <here>', timecode: 12 })).data;
  await req('POST', `/api/projects/${id}/annotations`, { author: 'Kate', text: 'Music too loud', timecode: 75, tags: ['audio'] });
  const digest = await waitFor(() => tg.to(EDITOR_CHAT).find(m => /new comments<\/b>/.test(m.text)));
  assert.match(digest.text, /2 new comments<\/b> from Kate/);
  assert.match(digest.text, /<code>00:12<\/code> Too warm &lt;here&gt;/);
  assert.match(digest.text, /<code>01:15<\/code> Music too loud/);
  assert.equal(tg.to(REVIEWER_CHAT).filter(m => /new comment/.test(m.text)).length, 0, 'own comments are not echoed');

  // Editor replies and accepts → Kate gets one digest with both, editor gets nothing about own actions
  const before = tg.to(EDITOR_CHAT).length;
  await req('POST', `/api/projects/${id}/annotations`, { author: 'Ed', text: 'Fixed in grade', parent_id: c1.id });
  await req('PATCH', `/api/annotations/${c1.id}/status`, { status: 1, by: 'Ed' }, editor);
  const kateDigest = await waitFor(() => tg.to(REVIEWER_CHAT).find(m => /<b>\d+ repl/.test(m.text)));
  assert.match(kateDigest.text, /Ed on “Too warm &lt;here&gt;”: Fixed in grade/);
  assert.match(kateDigest.text, /accepted ✓ by Ed/);
  await sleep(1500);
  assert.equal(tg.to(EDITOR_CHAT).length, before, 'editor is not notified about their own reply');

  // Kate is done
  r = await req('POST', `/api/projects/${id}/review-done`, { author: 'Kate' });
  assert.equal(r.data.notified, 1);
  const done = await waitFor(() => tg.to(EDITOR_CHAT).find(m => /finished reviewing/.test(m.text)));
  assert.match(done.text, /Kate finished reviewing/);
  assert.match(done.text, /2 comments from them · 1 open in this cut/);
  assert.match(done.text, /Tags: audio 1/);
  assert.equal((await req('POST', `/api/projects/${id}/review-done`, { author: 'Kate' })).status, 429, 'no spamming');

  // New cut → reviewer hears about it with the carried count
  await req('POST', `/api/projects/${id}/versions`, { youtube_url: VIDEO2, notes: 'Lowered the music' }, editor);
  const cut = await waitFor(() => tg.to(REVIEWER_CHAT).find(m => /New cut/.test(m.text)));
  assert.match(cut.text, /v2/);
  assert.match(cut.text, /Lowered the music/);
  assert.match(cut.text, /1 open comment was carried over/);

  // /list → unsubscribe via button
  tg.say(REVIEWER_CHAT, '/list');
  const list = await waitFor(() => tg.to(REVIEWER_CHAT).find(m => m.reply_markup));
  const button = list.reply_markup.inline_keyboard[0][0];
  assert.equal(button.callback_data, `unsub:${id}`);
  tg.push({ callback_query: { id: 'q1', data: button.callback_data, message: { chat: { id: REVIEWER_CHAT } } } });
  await waitFor(() => tg.to(REVIEWER_CHAT).find(m => /No subscriptions/.test(m.text)));
  const count = tg.to(REVIEWER_CHAT).length;
  await req('POST', `/api/projects/${id}/versions`, { youtube_url: VIDEO }, editor);
  await sleep(1500);
  assert.equal(tg.to(REVIEWER_CHAT).length, count, 'unsubscribed chats get nothing');

  // Deleting the project drops its subscriptions
  const admin = await req('POST', '/api/admin/login', { password: require('fs').readFileSync(require('path').join(srv.dataDir, 'admin_password.txt'), 'utf8').trim() });
  const cookie = admin.headers.get('set-cookie').split(';')[0];
  await req('DELETE', `/api/admin/projects/${id}`, undefined, { Cookie: cookie });
  tg.say(EDITOR_CHAT, '/list');
  assert.ok(await waitFor(() => tg.to(EDITOR_CHAT).find(m => /No subscriptions/.test(m.text))));
});

test('telegram: disabled without a token', async () => {
  const plain = await startServer();
  try {
    const p = await plain.request('POST', '/api/projects', { youtube_url: VIDEO });
    assert.equal((await plain.request('GET', `/api/projects/${p.data.project_id}`)).data.telegram, false);
    assert.equal((await plain.request('POST', `/api/projects/${p.data.project_id}/telegram`, {})).status, 404);
    assert.equal((await plain.request('POST', `/api/projects/${p.data.project_id}/review-done`, { author: 'Kate' })).data.notified, 0);
  } finally {
    await plain.stop();
  }
});
