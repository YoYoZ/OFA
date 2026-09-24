// Shared helpers for all pages (plain script, exposes globals).

const TAG_PALETTE = ['#64b5f6', '#52b788', '#ffd700', '#e74c3c', '#9b59b6', '#e67e22', '#1abc9c', '#e91e63'];

const STATUS = {
  0: { key: 'pending',  label: 'Pending',     icon: '◯', color: '#ffd700' },
  3: { key: 'progress', label: 'In progress', icon: '◔', color: '#64b5f6' },
  1: { key: 'accepted', label: 'Accepted',    icon: '✓', color: '#52b788' },
  2: { key: 'rejected', label: 'Rejected',    icon: '✗', color: '#e74c3c' }
};
const STATUS_ORDER = [0, 3, 1, 2];

// Safe for both element content and quoted attribute values
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  const pad = v => String(v).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatRange(a) {
  return a.timecode_end != null ? `${formatTime(a.timecode)}–${formatTime(a.timecode_end)}` : formatTime(a.timecode);
}

// SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC
function parseDbDate(value) {
  if (!value) return null;
  const s = String(value);
  const d = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  return isNaN(d) ? null : d;
}

function timeAgo(value) {
  const d = value instanceof Date ? value : parseDbDate(value);
  if (!d) return '';
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days} d ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} y ago`;
}

function formatDate(value) {
  const d = value instanceof Date ? value : parseDbDate(value);
  return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}

function extractVideoId(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const [, kind, value] = url.pathname.split('/');
      if (['embed', 'v', 'shorts', 'live'].includes(kind)) id = value;
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

function parseTags(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

function tagColor(name, config) {
  const idx = (config || []).indexOf(name);
  return TAG_PALETTE[(idx >= 0 ? idx : 0) % TAG_PALETTE.length];
}

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function showToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-hide'), 2700);
  setTimeout(() => toast.remove(), 3000);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

// ── Identity: editor keys and comment edit tokens (kept per browser) ────────

const EditorKeys = {
  all() { return lsGet('editor_keys', {}); },
  get(projectId) { return this.all()[projectId] || null; },
  set(projectId, key) { const all = this.all(); if (key) all[projectId] = key; else delete all[projectId]; lsSet('editor_keys', all); },
  // Editor links look like /project/ID#key=TOKEN — store the key and strip it from the address bar
  captureFromHash(projectId) {
    const m = /(?:^#|&)key=([0-9a-f-]{36})/i.exec(window.location.hash);
    if (!m) return null;
    this.set(projectId, m[1]);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return m[1];
  }
};

const EditTokens = {
  all() { return lsGet('annotation_tokens', {}); },
  get(id) { return this.all()[id] || null; },
  set(id, token) { const all = this.all(); all[id] = token; lsSet('annotation_tokens', all); },
  merge(map) { lsSet('annotation_tokens', { ...this.all(), ...map }); }
};

// JSON API call; attaches the editor key for the given project
async function api(method, url, body, { projectId, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined && !(body instanceof Blob)) h['Content-Type'] = 'application/json';
  const key = projectId && EditorKeys.get(projectId);
  if (key) h['X-Editor-Key'] = key;
  const res = await fetch(url, {
    method, headers: h, credentials: 'same-origin',
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ── YouTube storyboard thumbnails ───────────────────────────────────────────

const Storyboard = {
  _cache: {},
  load(projectId) {
    if (!this._cache[projectId]) {
      this._cache[projectId] = fetch(`/api/projects/${encodeURIComponent(projectId)}/storyboard`)
        .then(r => r.ok ? r.json() : null)
        .then(sb => (sb && sb.levels && sb.levels.length ? sb : null))
        .catch(() => null);
    }
    return this._cache[projectId];
  },
  // Largest available level (usually 320×180)
  level(sb) {
    if (!sb) return null;
    return sb.levels.reduce((best, l) => (!best || l.width > best.width ? l : best), null);
  },
  frame(level, seconds) {
    const idx = Math.min(level.count - 1, Math.max(0, Math.floor((seconds * 1000) / level.interval)));
    const perSheet = level.cols * level.rows;
    const sheet = Math.floor(idx / perSheet);
    const pos = idx % perSheet;
    return {
      url: level.url.replace('$N', level.name.replace('$M', String(sheet))) + '&sigh=' + level.sigh,
      x: (pos % level.cols) * level.width,
      y: Math.floor(pos / level.cols) * level.height,
      w: level.width, h: level.height,
      sheetWidth: level.cols * level.width
    };
  },
  // Cropped sprite as plain <img> inside an overflow box (prints without "background graphics")
  html(sb, seconds, displayWidth, extraClass = '') {
    const level = this.level(sb);
    if (!level) return '';
    const f = this.frame(level, seconds);
    const scale = displayWidth / f.w;
    const height = Math.round(f.h * scale);
    return `<span class="sb-thumb ${extraClass}" style="width:${displayWidth}px;height:${height}px">` +
      `<img src="${escapeHtml(f.url)}" alt="" loading="lazy" referrerpolicy="no-referrer" ` +
      `style="width:${Math.round(f.sheetWidth * scale)}px;left:${-Math.round(f.x * scale)}px;top:${-Math.round(f.y * scale)}px"></span>`;
  }
};

// Screenshot if the comment has one, storyboard frame otherwise
function thumbnailHtml(annotation, sb, width, extraClass = '') {
  if (annotation.has_screenshot) {
    const v = encodeURIComponent(annotation.edited_at || annotation._shotVersion || '');
    return `<span class="sb-thumb shot ${extraClass}" style="width:${width}px;height:${Math.round(width * 9 / 16)}px">` +
      `<img src="/api/annotations/${encodeURIComponent(annotation.id)}/screenshot?v=${v}" alt="Frame" loading="lazy"></span>`;
  }
  return Storyboard.html(sb, annotation.timecode, width, extraClass);
}

// ── Browser backup (IndexedDB) ──────────────────────────────────────────────
// Every project a user opens is snapshotted locally, together with their editor key
// and comment tokens, so it can be exported or restored if the server loses it.

const Backup = {
  _dbPromise: null,
  _open() {
    if (!this._dbPromise) {
      this._dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open('ofa-backup', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('projects', { keyPath: 'id' });
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    }
    return this._dbPromise;
  },
  async _tx(mode, fn) {
    const db = await this._open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('projects', mode);
        const result = fn(tx.objectStore('projects'));
        tx.oncomplete = () => resolve(result && 'result' in result ? result.result : true);
        tx.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  },
  get(id) { return this._tx('readonly', s => s.get(id)); },
  async list() { return (await this._tx('readonly', s => s.getAll())) || []; },
  remove(id) { return this._tx('readwrite', s => s.delete(id)); },
  async put(entry) { return this._tx('readwrite', s => s.put(entry)); },

  // Merge a fresh server snapshot into the stored entry
  async saveSnapshot(project, annotations, extra = {}) {
    const prev = (await this.get(project.id)) || {};
    const tokens = EditTokens.all();
    const myTokens = { ...(prev.tokens || {}) };
    for (const a of annotations) if (tokens[a.id]) myTokens[a.id] = tokens[a.id];
    const { editor_token: _omit, ...publicProject } = project;
    return this.put({
      ...prev,
      id: project.id,
      project: publicProject,
      annotations,
      tokens: myTokens,
      editorKey: EditorKeys.get(project.id) || prev.editorKey || null,
      mine: annotations.filter(a => myTokens[a.id]).length,
      savedAt: new Date().toISOString(),
      lastOpened: extra.opened ? new Date().toISOString() : (prev.lastOpened || new Date().toISOString()),
      createdByMe: prev.createdByMe || !!extra.createdByMe
    });
  },

  async exportFile() {
    const entries = await this.list();
    const blob = new Blob([JSON.stringify({ app: 'open-frame-annotator', version: 1, exportedAt: new Date().toISOString(), projects: entries }, null, 2)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ofa-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return entries.length;
  },

  async importFile(file) {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.projects)) throw new Error('Not an Open Frame Annotator backup');
    let count = 0;
    for (const entry of data.projects) {
      if (!entry || typeof entry.id !== 'string' || !entry.project) continue;
      const prev = await this.get(entry.id);
      // Keep whichever snapshot is newer, but never lose tokens or keys
      const newer = !prev || (entry.savedAt || '') > (prev.savedAt || '') ? entry : prev;
      const tokens = { ...(prev && prev.tokens), ...entry.tokens };
      await this.put({ ...newer, tokens, editorKey: newer.editorKey || (prev && prev.editorKey) || entry.editorKey || null });
      EditTokens.merge(entry.tokens || {});
      if (entry.editorKey && !EditorKeys.get(entry.id)) EditorKeys.set(entry.id, entry.editorKey);
      count++;
    }
    return count;
  },

  // Recreate a project on the server from its snapshot
  async restore(id) {
    const entry = await this.get(id);
    if (!entry) throw new Error('No backup for this project');
    const annotations = entry.annotations.map(a => ({ ...a, edit_token: (entry.tokens || {})[a.id] }));
    const result = await api('POST', '/api/projects/restore', {
      project: { ...entry.project, editor_token: entry.editorKey || undefined },
      annotations
    });
    EditorKeys.set(id, result.editor_token);
    await this.put({ ...entry, editorKey: result.editor_token });
    return result;
  }
};
