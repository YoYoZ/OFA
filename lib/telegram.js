// Optional Telegram notifications. Enabled when TELEGRAM_BOT_TOKEN is set.
//
// People subscribe per project from the project page: OFA hands out a one-time
// t.me/<bot>?start=<code> link, the bot links that chat to the project with the
// role of the page it came from (editor or reviewer).
//
// Editors get digests of new comments and replies plus "review finished" notes.
// Reviewers get new cuts, replies to their comments and status changes on them.
// Comment notifications are batched: a digest goes out after a quiet period.
//
// Uses long polling (getUpdates), so no webhook or public URL is needed for the bot
// itself; PUBLIC_URL is used for links back to the project.

const crypto = require('crypto');

const STATUS_TEXT = { 0: 'reset to pending', 1: 'accepted ✓', 2: 'rejected ✗', 3: 'in progress ◔' };
const MAX_ITEMS = 15;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(s, n = 160) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function fmtTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  const pad = v => String(v).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function createTelegram({ token, apiBase = 'https://api.telegram.org', publicUrl = '', digestMs = 120000, db, log = console }) {
  const { dbRun, dbGet, dbAll } = db;
  const base = `${apiBase.replace(/\/+$/, '')}/bot${token}`;
  let username = null;
  let offset = 0;
  let stopped = false;
  let controller = null;
  const pending = new Map(); // `${chatId}:${projectId}` -> { items, timer, firstAt }

  async function call(method, body = {}, signal) {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(`Telegram ${method}: ${data.description || res.status}`);
      err.code = data.error_code;
      throw err;
    }
    return data.result;
  }

  async function send(chatId, html, extra = {}) {
    try {
      await call('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
    } catch (err) {
      // The person blocked the bot or deleted the chat: forget their subscriptions
      if (err.code === 403) await dbRun('DELETE FROM telegram_subs WHERE chat_id = ?', [chatId]);
      else log.warn(err.message);
    }
  }

  // ── links back to OFA ──────────────────────────────────────────────────────

  async function projectLink(projectId, role, versionNumber) {
    if (!publicUrl) return null;
    const p = await dbGet('SELECT editor_token FROM projects WHERE id = ?', [projectId]);
    const latest = await dbGet('SELECT MAX(number) AS n FROM versions WHERE project_id = ?', [projectId]);
    const q = versionNumber && latest && versionNumber !== latest.n ? `?v=${versionNumber}` : '';
    // Editors subscribed from the editor link; their private chat gets the editor link back
    const key = role === 'editor' && p && p.editor_token ? `#key=${p.editor_token}` : '';
    return `${publicUrl}/project/${projectId}${q}${key}`;
  }

  async function header(projectId, versionId) {
    const p = await dbGet('SELECT title FROM projects WHERE id = ?', [projectId]);
    const v = versionId ? await dbGet('SELECT number, label FROM versions WHERE id = ?', [versionId]) : null;
    const title = esc(p && p.title ? p.title : 'Untitled project');
    return { text: `🎬 <b>${title}</b>${v ? ` · v${v.number}${v.label ? ` ${esc(v.label)}` : ''}` : ''}`, versionNumber: v && v.number };
  }

  // ── subscriptions ──────────────────────────────────────────────────────────

  async function createLink(projectId, role, author) {
    if (!username) throw new Error('Telegram bot is not ready yet');
    const code = crypto.randomBytes(12).toString('base64url');
    await dbRun('DELETE FROM telegram_links WHERE created_at < ?', [Date.now() - 86400000]);
    await dbRun('INSERT INTO telegram_links (code, project_id, role, author, created_at) VALUES (?, ?, ?, ?, ?)',
      [code, projectId, role, author || null, Date.now()]);
    return `https://t.me/${username}?start=${code}`;
  }

  async function subscribersFor(projectId) {
    return dbAll('SELECT chat_id, role, author FROM telegram_subs WHERE project_id = ?', [projectId]);
  }

  async function handleStart(chatId, code) {
    if (!code) {
      return send(chatId, 'Hi! I send notifications from <b>Open Frame Annotator</b>.\n\nOpen a project and press <b>🔔 Telegram</b> to subscribe to it.\n/list — your subscriptions');
    }
    const link = await dbGet('SELECT * FROM telegram_links WHERE code = ?', [code]);
    if (!link || link.created_at < Date.now() - 86400000) {
      return send(chatId, 'This link has expired. Press <b>🔔 Telegram</b> on the project page again.');
    }
    await dbRun('DELETE FROM telegram_links WHERE code = ?', [code]);
    const project = await dbGet('SELECT title FROM projects WHERE id = ?', [link.project_id]);
    if (!project) return send(chatId, 'That project no longer exists.');
    await dbRun(`INSERT OR REPLACE INTO telegram_subs (chat_id, project_id, role, author, created_at) VALUES (?, ?, ?, ?, ?)`,
      [chatId, link.project_id, link.role, link.author, Date.now()]);
    const what = link.role === 'editor'
      ? 'new comments and replies (in digests), and when a reviewer finishes'
      : 'new cuts, replies to your comments and status changes on them';
    const url = await projectLink(link.project_id, link.role);
    return send(chatId, `🔔 Subscribed to <b>${esc(project.title || 'Untitled project')}</b>${link.role === 'editor' ? ' as the editor' : ''}.\nYou'll get ${what}.${url ? `\n\n<a href="${esc(url)}">Open project</a>` : ''}\n\n/list to manage subscriptions`);
  }

  async function handleList(chatId) {
    const subs = await dbAll(`SELECT s.project_id, s.role, p.title FROM telegram_subs s JOIN projects p ON p.id = s.project_id WHERE s.chat_id = ?`, [chatId]);
    if (!subs.length) return send(chatId, 'No subscriptions. Press <b>🔔 Telegram</b> on a project page to add one.');
    return send(chatId, `Your subscriptions (${subs.length}). Tap to unsubscribe:`, {
      reply_markup: {
        inline_keyboard: [
          ...subs.map(s => [{ text: `🔕 ${clip(s.title || 'Untitled project', 40)}${s.role === 'editor' ? ' (editor)' : ''}`, callback_data: `unsub:${s.project_id}` }]),
          [{ text: '🔕 Unsubscribe from all', callback_data: 'unsub:*' }]
        ]
      }
    });
  }

  async function handleCallback(q) {
    const chatId = q.message && q.message.chat.id;
    const data = String(q.data || '');
    if (chatId && data.startsWith('unsub:')) {
      const projectId = data.slice(6);
      if (projectId === '*') await dbRun('DELETE FROM telegram_subs WHERE chat_id = ?', [chatId]);
      else await dbRun('DELETE FROM telegram_subs WHERE chat_id = ? AND project_id = ?', [chatId, projectId]);
      await call('answerCallbackQuery', { callback_query_id: q.id, text: 'Unsubscribed' }).catch(() => {});
      return handleList(chatId);
    }
    return call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  }

  async function handleUpdate(u) {
    if (u.callback_query) return handleCallback(u.callback_query);
    const msg = u.message;
    if (!msg || !msg.text || !msg.chat || msg.chat.type !== 'private') return;
    const [cmd, arg] = msg.text.trim().split(/\s+/, 2);
    const name = cmd.split('@')[0].toLowerCase();
    if (name === '/start') return handleStart(msg.chat.id, arg);
    if (name === '/list') return handleList(msg.chat.id);
    if (name === '/stop') {
      await dbRun('DELETE FROM telegram_subs WHERE chat_id = ?', [msg.chat.id]);
      return send(msg.chat.id, '🔕 Unsubscribed from everything.');
    }
    return send(msg.chat.id, 'Commands: /list — subscriptions, /stop — unsubscribe from everything.');
  }

  async function poll() {
    while (!stopped) {
      try {
        controller = new AbortController();
        const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, controller.signal);
        for (const u of updates) {
          offset = u.update_id + 1;
          await handleUpdate(u).catch(err => log.warn(`Telegram update failed: ${err.message}`));
        }
      } catch (err) {
        if (stopped) break;
        log.warn(`Telegram polling: ${err.message}${err.code === 409 ? ' (another app is using this bot)' : ''}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  // ── digests ────────────────────────────────────────────────────────────────

  function queue(chatId, role, projectId, item) {
    const key = `${chatId}:${projectId}`;
    let entry = pending.get(key);
    if (!entry) { entry = { chatId, role, projectId, items: [], firstAt: Date.now(), timer: null }; pending.set(key, entry); }
    entry.items.push(item);
    clearTimeout(entry.timer);
    // Quiet period resets with every new item, but a digest never waits longer than 5× it
    const wait = Math.max(0, Math.min(digestMs, entry.firstAt + digestMs * 5 - Date.now()));
    entry.timer = setTimeout(() => flush(key).catch(err => log.warn(err.message)), wait);
    if (entry.timer.unref) entry.timer.unref();
  }

  async function flush(key) {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    clearTimeout(entry.timer);
    // The project may be gone, or the person unsubscribed in the meantime
    const sub = await dbGet('SELECT 1 FROM telegram_subs WHERE chat_id = ? AND project_id = ?', [entry.chatId, entry.projectId]);
    if (!sub) return;

    const comments = entry.items.filter(i => i.type === 'comment');
    const replies = entry.items.filter(i => i.type === 'reply');
    const statuses = entry.items.filter(i => i.type === 'status');
    const versionId = (entry.items.find(i => i.annotation) || {}).annotation?.version_id;
    const h = await header(entry.projectId, versionId);
    const lines = [h.text];

    if (comments.length) {
      const authors = [...new Set(comments.map(c => c.annotation.author))];
      lines.push('', `💬 <b>${comments.length} new comment${comments.length === 1 ? '' : 's'}</b> from ${esc(authors.join(', '))}`);
      comments.slice(0, MAX_ITEMS).forEach(c => lines.push(`• <code>${fmtTime(c.annotation.timecode)}</code> ${esc(clip(c.annotation.text))}`));
      if (comments.length > MAX_ITEMS) lines.push(`…and ${comments.length - MAX_ITEMS} more`);
    }
    if (replies.length) {
      lines.push('', `↩️ <b>${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}</b>`);
      replies.slice(0, MAX_ITEMS).forEach(r => lines.push(`• ${esc(r.annotation.author)} on “${esc(clip(r.parent.text, 60))}”: ${esc(clip(r.annotation.text))}`));
      if (replies.length > MAX_ITEMS) lines.push(`…and ${replies.length - MAX_ITEMS} more`);
    }
    if (statuses.length) {
      lines.push('', '📌 <b>Your comments</b>');
      // Only the last change per comment matters
      const last = new Map();
      statuses.forEach(s => last.set(s.annotation.id, s));
      [...last.values()].slice(0, MAX_ITEMS).forEach(s =>
        lines.push(`• “${esc(clip(s.annotation.text, 60))}” — ${STATUS_TEXT[s.status] || 'updated'}${s.by ? ` by ${esc(s.by)}` : ''}`));
    }
    const url = await projectLink(entry.projectId, entry.role, h.versionNumber);
    if (url) lines.push('', `<a href="${esc(url)}">Open project</a>`);
    await send(entry.chatId, lines.join('\n'));
  }

  const same = (a, b) => a && b && a.trim().toLowerCase() === b.trim().toLowerCase();

  // ── events from OFA ────────────────────────────────────────────────────────

  async function annotationCreated(annotation) {
    const subs = await subscribersFor(annotation.project_id);
    if (!subs.length) return;
    const parent = annotation.parent_id
      ? await dbGet('SELECT id, author, text FROM annotations WHERE id = ?', [annotation.parent_id])
      : null;
    for (const s of subs) {
      if (same(s.author, annotation.author)) continue; // no notes about your own words
      if (s.role === 'editor') {
        queue(s.chat_id, s.role, annotation.project_id, parent ? { type: 'reply', annotation, parent } : { type: 'comment', annotation });
      } else if (parent && same(s.author, parent.author)) {
        queue(s.chat_id, s.role, annotation.project_id, { type: 'reply', annotation, parent });
      }
    }
  }

  async function statusChanged(annotation, status, by) {
    if (annotation.parent_id) return;
    const subs = await subscribersFor(annotation.project_id);
    for (const s of subs) {
      if (s.role === 'editor' || !same(s.author, annotation.author) || same(s.author, by)) continue;
      queue(s.chat_id, s.role, annotation.project_id, { type: 'status', annotation, status, by });
    }
  }

  async function versionCreated(projectId, version, carried) {
    const subs = await subscribersFor(projectId);
    if (!subs.length) return;
    const h = await header(projectId, version.id);
    for (const s of subs) {
      if (s.role === 'editor') continue; // the editor uploaded it
      const url = await projectLink(projectId, s.role);
      await send(s.chat_id, [
        h.text, '', `🎞️ <b>New cut uploaded</b>${version.notes ? `\n${esc(clip(version.notes, 300))}` : ''}`,
        carried ? `${carried} open comment${carried === 1 ? ' was' : 's were'} carried over — check whether they're fixed.` : '',
        url ? `\n<a href="${esc(url)}">Watch v${version.number}</a>` : ''
      ].filter(Boolean).join('\n'));
    }
  }

  async function reviewDone(projectId, versionId, author) {
    const subs = (await subscribersFor(projectId)).filter(s => s.role === 'editor');
    if (!subs.length) return 0;
    const roots = await dbAll(`SELECT author, tags, status FROM annotations WHERE project_id = ? AND version_id = ? AND parent_id IS NULL`, [projectId, versionId]);
    const theirs = roots.filter(r => same(r.author, author));
    const open = roots.filter(r => !r.status || r.status === 3).length;
    const tags = {};
    for (const r of theirs) {
      let list = [];
      try { list = JSON.parse(r.tags || '[]'); } catch {}
      list.forEach(t => { tags[t] = (tags[t] || 0) + 1; });
    }
    const tagLine = Object.entries(tags).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${esc(t)} ${n}`).join(' · ');
    const h = await header(projectId, versionId);
    for (const s of subs) {
      // Flush pending comment digests first so the summary comes last
      const key = `${s.chat_id}:${projectId}`;
      if (pending.has(key)) await flush(key);
      const url = await projectLink(projectId, s.role, h.versionNumber);
      await send(s.chat_id, [
        h.text, '', `✅ <b>${esc(author)} finished reviewing</b>`,
        `${theirs.length} comment${theirs.length === 1 ? '' : 's'} from them · ${open} open in this cut`,
        tagLine ? `Tags: ${tagLine}` : '',
        url ? `\n<a href="${esc(url)}">Open project</a>` : ''
      ].filter(Boolean).join('\n'));
    }
    return subs.length;
  }

  async function projectDeleted(projectId) {
    for (const key of [...pending.keys()]) if (key.endsWith(`:${projectId}`)) { clearTimeout(pending.get(key).timer); pending.delete(key); }
    await dbRun('DELETE FROM telegram_subs WHERE project_id = ?', [projectId]);
    await dbRun('DELETE FROM telegram_links WHERE project_id = ?', [projectId]);
  }

  async function start() {
    const me = await call('getMe');
    username = me.username;
    await call('setMyCommands', { commands: [
      { command: 'list', description: 'Your subscriptions' },
      { command: 'stop', description: 'Unsubscribe from everything' }
    ] }).catch(() => {});
    poll();
    return username;
  }

  async function stop() {
    stopped = true;
    if (controller) controller.abort();
    // Deliver what is queued instead of dropping it
    await Promise.all([...pending.keys()].map(k => flush(k).catch(() => {})));
  }

  return {
    start, stop, createLink, annotationCreated, statusChanged, versionCreated, reviewDone, projectDeleted,
    get username() { return username; },
    _flushAll: () => Promise.all([...pending.keys()].map(k => flush(k)))
  };
}

module.exports = { createTelegram };
