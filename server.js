const express = require('express');
const http = require('http');
const { Server: SocketServer } = require('socket.io');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const { promisify } = require('util');
require('dotenv').config();

const tc = require('./lib/timecode');
const { FORMATS } = require('./lib/exporters');
const { parseYouTubeId, fetchStoryboard } = require('./lib/youtube');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_TIMECODE = 48 * 3600;
const STATUSES = [0, 1, 2, 3]; // pending, accepted, rejected, in progress
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANNOTATION_FIELDS = 'id, project_id, parent_id, author, text, timecode, timecode_end, status, status_by, status_at, tags, has_screenshot, edited_at, created_at';

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ── Secrets ──────────────────────────────────────────────────────────────────

// Reads a secret from env; if absent, loads (or generates and persists) one in DATA_DIR
// so that it survives restarts without the user having to configure anything.
function loadOrCreateSecret(envValue, fileName, generate) {
  if (envValue) return { value: envValue, generated: false };
  const file = path.join(DATA_DIR, fileName);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return { value: existing, generated: true, file };
  } catch {}
  const value = generate();
  fs.writeFileSync(file, value + '\n', { mode: 0o600 });
  return { value, generated: true, file };
}

const sessionSecret = loadOrCreateSecret(
  process.env.SESSION_SECRET, '.session_secret',
  () => crypto.randomBytes(32).toString('hex')
).value;

const envAdminPassword = process.env.ADMIN_PASSWORD === 'CHANGE_ME' ? '' : process.env.ADMIN_PASSWORD;
const adminPassword = loadOrCreateSecret(
  envAdminPassword, 'admin_password.txt',
  () => crypto.randomBytes(12).toString('base64url')
);

// ── App setup ────────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

if (process.env.TRUST_PROXY) {
  const v = process.env.TRUST_PROXY;
  app.set('trust proxy', v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? parseInt(v, 10) : v);
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// The frontend is served from the same origin, so CORS is only needed for external clients.
if (ALLOWED_ORIGIN) {
  app.use(cors({ origin: ALLOWED_ORIGIN.split(',').map(s => s.trim()), credentials: true }));
}
app.use(express.json({ limit: '5mb' }));

// ── Database ─────────────────────────────────────────────────────────────────

const db = new sqlite3.Database(path.join(DATA_DIR, 'annotations.db'), (err) => {
  if (err) { console.error('Error opening database:', err.message); process.exit(1); }
  console.log(`Connected to SQLite database in ${DATA_DIR}`);
  initDatabase()
    .then(loadSettings)
    .then(startServer)
    .catch((e) => { console.error('Startup failed:', e); process.exit(1); });
});

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err) { err ? reject(err) : resolve(this); });
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

// Runs statements back-to-back inside one transaction (queued synchronously, so nothing interleaves)
function dbBatch(statements) {
  return new Promise((resolve, reject) => {
    let failed = null;
    db.serialize(() => {
      db.run('BEGIN');
      for (const [sql, params] of statements) {
        db.run(sql, params, (err) => { if (err && !failed) failed = err; });
      }
      db.run('COMMIT', (err) => (failed || err) ? reject(failed || err) : resolve());
    });
  });
}

async function addColumn(sql) {
  try { await dbRun(sql); } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
}

async function initDatabase() {
  await dbRun('PRAGMA journal_mode = WAL');
  await dbRun('PRAGMA busy_timeout = 5000');

  await dbRun(`CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    youtube_url TEXT NOT NULL,
    title       TEXT,
    description TEXT,
    tags_config TEXT,
    password_hash TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS annotations (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_id  TEXT,
    author     TEXT NOT NULL,
    text       TEXT NOT NULL,
    timecode   REAL NOT NULL,
    status     INTEGER DEFAULT 0,
    tags       TEXT,
    edit_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects (id),
    FOREIGN KEY (parent_id)  REFERENCES annotations (id)
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    sess    TEXT NOT NULL,
    expires INTEGER NOT NULL
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`);

  // Migrations for existing databases
  await addColumn('ALTER TABLE projects ADD COLUMN title TEXT');
  await addColumn('ALTER TABLE projects ADD COLUMN description TEXT');
  await addColumn('ALTER TABLE projects ADD COLUMN tags_config TEXT');
  await addColumn('ALTER TABLE projects ADD COLUMN password_hash TEXT');
  await addColumn('ALTER TABLE projects ADD COLUMN editor_token TEXT');
  await addColumn('ALTER TABLE projects ADD COLUMN pinned INTEGER DEFAULT 0');
  await addColumn('ALTER TABLE projects ADD COLUMN last_activity_at DATETIME');
  await addColumn('ALTER TABLE annotations ADD COLUMN status INTEGER DEFAULT 0');
  await addColumn('ALTER TABLE annotations ADD COLUMN parent_id TEXT');
  await addColumn('ALTER TABLE annotations ADD COLUMN tags TEXT');
  await addColumn('ALTER TABLE annotations ADD COLUMN edit_token TEXT');
  await addColumn('ALTER TABLE annotations ADD COLUMN timecode_end REAL');
  await addColumn('ALTER TABLE annotations ADD COLUMN status_by TEXT');
  await addColumn('ALTER TABLE annotations ADD COLUMN status_at DATETIME');
  await addColumn('ALTER TABLE annotations ADD COLUMN has_screenshot INTEGER DEFAULT 0');
  await addColumn('ALTER TABLE annotations ADD COLUMN edited_at DATETIME');

  await dbRun(`UPDATE projects SET last_activity_at = COALESCE(
      (SELECT MAX(created_at) FROM annotations WHERE annotations.project_id = projects.id), created_at)
    WHERE last_activity_at IS NULL`);

  await dbRun('CREATE INDEX IF NOT EXISTS idx_annotations_project ON annotations (project_id)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_annotations_parent ON annotations (parent_id)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_projects_activity ON projects (last_activity_at)');
  console.log('Database initialized');
}

// ── Settings ─────────────────────────────────────────────────────────────────

const settings = { retention_days: 0, retention_warn_days: 30 };

async function loadSettings() {
  const rows = await dbAll(`SELECT key, value FROM settings WHERE key IN ('retention_days', 'retention_warn_days')`);
  for (const { key, value } of rows) settings[key] = parseInt(value, 10) || 0;
}

async function saveSetting(key, value) {
  await dbRun('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
}

// ── Sessions (persisted in SQLite so admin logins survive restarts) ─────────

class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    setInterval(() => this.db.run('DELETE FROM sessions WHERE expires < ?', [Date.now()]), 60 * 60 * 1000).unref();
  }
  get(sid, cb) {
    this.db.get('SELECT sess, expires FROM sessions WHERE sid = ?', [sid], (err, row) => {
      if (err) return cb(err);
      if (!row || row.expires < Date.now()) return cb(null, null);
      try { cb(null, JSON.parse(row.sess)); } catch (e) { cb(e); }
    });
  }
  set(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + SESSION_TTL_MS;
    this.db.run('INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?, ?, ?)',
      [sid, JSON.stringify(sess), expires], (err) => cb && cb(err));
  }
  touch(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + SESSION_TTL_MS;
    this.db.run('UPDATE sessions SET expires = ? WHERE sid = ?', [expires, sid], (err) => cb && cb(err));
  }
  destroy(sid, cb) {
    this.db.run('DELETE FROM sessions WHERE sid = ?', [sid], (err) => cb && cb(err));
  }
}

app.use(session({
  name: 'ofa.sid',
  store: new SQLiteSessionStore(db),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: SESSION_TTL_MS, httpOnly: true, sameSite: 'lax', secure: 'auto' }
}));

app.use(express.static(path.join(__dirname, 'public')));

// ── Socket.io ────────────────────────────────────────────────────────────────

const io = new SocketServer(server, ALLOWED_ORIGIN
  ? { cors: { origin: ALLOWED_ORIGIN.split(',').map(s => s.trim()) } }
  : {});

io.on('connection', (socket) => {
  socket.on('join-project', (projectId) => {
    if (typeof projectId === 'string' && projectId.length <= 64) {
      socket.join(projectId);
    }
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Wraps async route handlers so rejections reach the error handler
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aHash = crypto.createHash('sha256').update(a).digest();
  const bHash = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPasswordHash(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

// The password set in the admin panel wins; ADMIN_PASSWORD / the generated one is the bootstrap
async function checkAdminPassword(password) {
  const row = await dbGet(`SELECT value FROM settings WHERE key = 'admin_password_hash'`);
  if (row && row.value) return verifyPasswordHash(password, row.value);
  return safeCompare(password, adminPassword.value);
}

function parseJsonArray(json) {
  if (!json) return [];
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

// SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC
function parseDbDate(value) {
  if (!value) return null;
  const s = String(value);
  const d = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  return isNaN(d) ? null : d;
}

function toDbDate(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function expiresAt(project) {
  if (!settings.retention_days || project.pinned) return null;
  const last = parseDbDate(project.last_activity_at || project.created_at);
  if (!last) return null;
  return new Date(last.getTime() + settings.retention_days * 86400000).toISOString();
}

function baseUrl(req) {
  return PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

function normalizeTagsConfig(input) {
  let list;
  if (Array.isArray(input)) list = input;
  else if (typeof input === 'string') {
    const parsed = input.trim().startsWith('[') ? parseJsonArray(input) : null;
    list = parsed || input.split(',');
  } else return null;
  const tags = [...new Set(list.filter(t => typeof t === 'string').map(t => t.trim().slice(0, 30)).filter(Boolean))].slice(0, 8);
  return tags.length ? JSON.stringify(tags) : null;
}

function optionalString(value, max, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, `Invalid ${field}`);
  const v = value.trim();
  if (v.length > max) throw new HttpError(400, `${field[0].toUpperCase() + field.slice(1)} too long (max ${max})`);
  return v || null;
}

function requiredString(value, max, field) {
  const v = optionalString(value, max, field);
  if (!v) throw new HttpError(400, `${field[0].toUpperCase() + field.slice(1)} is required`);
  return v;
}

function parseTimecode(value, field = 'timecode') {
  const n = Number(value);
  if (value === null || value === '' || typeof value === 'boolean' || !Number.isFinite(n) || n < 0 || n > MAX_TIMECODE) {
    throw new HttpError(400, `Invalid ${field}`);
  }
  return n;
}

function parseTimecodeEnd(value, start) {
  if (value === undefined || value === null || value === '') return null;
  const end = parseTimecode(value, 'timecode_end');
  if (end <= start) throw new HttpError(400, 'timecode_end must be after timecode');
  return end;
}

function cleanAnnotationTags(tags, project) {
  if (tags === undefined || tags === null) return null;
  if (!Array.isArray(tags)) throw new HttpError(400, 'Invalid tags');
  const allowed = parseJsonArray(project.tags_config);
  const clean = [...new Set(tags.filter(t => typeof t === 'string' && allowed.includes(t)))];
  return clean.length ? JSON.stringify(clean) : null;
}

// What the current request may do on a project
function permissionsFor(req, project) {
  if (req.session && req.session.isAdmin) return { review: true, moderate: true, admin: true };
  // Projects created before roles existed stay open for review, but nobody can moderate them
  if (!project.editor_token) return { review: true, moderate: false, admin: false };
  const editor = safeCompare(req.get('X-Editor-Key'), project.editor_token);
  return { review: editor, moderate: editor, admin: false };
}

function publicProject(project, perms) {
  const out = {
    id: project.id,
    youtube_url: project.youtube_url,
    title: project.title,
    description: project.description,
    tags_config: project.tags_config,
    created_at: project.created_at,
    last_activity_at: project.last_activity_at,
    pinned: !!project.pinned,
    expires_at: expiresAt(project)
  };
  if (perms && perms.moderate && project.editor_token) out.editor_token = project.editor_token;
  return out;
}

async function getProjectOr404(id) {
  const project = await dbGet('SELECT * FROM projects WHERE id = ?', [id]);
  if (!project) throw new HttpError(404, 'Project not found');
  return project;
}

async function getAnnotationOr404(id) {
  const annotation = await dbGet('SELECT * FROM annotations WHERE id = ?', [id]);
  if (!annotation) throw new HttpError(404, 'Annotation not found');
  return annotation;
}

async function publicAnnotation(id) {
  return dbGet(`SELECT ${ANNOTATION_FIELDS} FROM annotations WHERE id = ?`, [id]);
}

function touchProject(id) {
  return dbRun('UPDATE projects SET last_activity_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
}

// Author (edit token) or project moderator; tokenless legacy comments stay open
function canModifyAnnotation(req, annotation, perms) {
  if (perms.moderate) return true;
  if (!annotation.edit_token) return true;
  const token = (req.body && req.body.edit_token) || req.get('X-Edit-Token');
  return safeCompare(token, annotation.edit_token);
}

function screenshotPath(annotationId) {
  if (!SAFE_ID_RE.test(annotationId)) return null;
  return path.join(SCREENSHOT_DIR, `${annotationId}.jpg`);
}

function removeScreenshots(ids) {
  for (const id of ids) {
    const file = screenshotPath(id);
    if (file) fs.rm(file, { force: true }, () => {});
  }
}

async function deleteProjects(ids) {
  let deleted = 0;
  for (const id of ids) {
    const annotations = await dbAll('SELECT id FROM annotations WHERE project_id = ?', [id]);
    await dbRun('DELETE FROM annotations WHERE project_id = ?', [id]);
    const result = await dbRun('DELETE FROM projects WHERE id = ?', [id]);
    removeScreenshots(annotations.map(a => a.id));
    if (result.changes) {
      deleted++;
      io.to(id).emit('project:deleted', { id });
    }
  }
  return deleted;
}

function dirSize(dir) {
  try {
    return fs.readdirSync(dir).reduce((sum, f) => {
      try { return sum + fs.statSync(path.join(dir, f)).size; } catch { return sum; }
    }, 0);
  } catch { return 0; }
}

// ── Rate limiter ─────────────────────────────────────────────────────────────

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) if (now > record.resetAt) loginAttempts.delete(ip);
}, LOGIN_WINDOW_MS).unref();

function adminRateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  let record = loginAttempts.get(ip);
  if (!record || now > record.resetAt) {
    record = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    loginAttempts.set(ip, record);
  }
  if (record.count >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }
  req.loginRecord = record;
  next();
}

function checkAdminAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Health ───────────────────────────────────────────────────────────────────

app.get('/healthz', ah(async (req, res) => {
  await dbGet('SELECT 1 AS ok');
  res.json({ status: 'ok' });
}));

// ── Admin routes ─────────────────────────────────────────────────────────────

app.post('/api/admin/login', adminRateLimit, ah(async (req, res) => {
  const { password } = req.body;
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Password required' });
  if (!(await checkAdminPassword(password))) {
    req.loginRecord.count++;
    return res.status(401).json({ error: 'Invalid password' });
  }
  req.loginRecord.count = 0;
  req.session.regenerate((err) => {
    if (err) { console.error(err); return res.status(500).json({ error: 'Login failed' }); }
    req.session.isAdmin = true;
    res.json({ success: true });
  });
}));

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.clearCookie('ofa.sid');
    res.json({ success: true });
  });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.isAdmin) });
});

app.post('/api/admin/password', checkAdminAuth, ah(async (req, res) => {
  const { current, next } = req.body;
  if (typeof current !== 'string' || !(await checkAdminPassword(current))) {
    throw new HttpError(403, 'Current password is incorrect');
  }
  if (typeof next !== 'string' || next.length < 8 || next.length > 200) {
    throw new HttpError(400, 'New password must be 8–200 characters');
  }
  await saveSetting('admin_password_hash', await hashPassword(next));
  // Log out every other admin session
  await dbRun('DELETE FROM sessions WHERE sid != ?', [req.sessionID]);
  res.json({ success: true });
}));

app.get('/api/admin/projects', checkAdminAuth, ah(async (req, res) => {
  const projects = await dbAll(`
    SELECT p.*, COUNT(a.id) AS annotations_count,
           SUM(CASE WHEN a.parent_id IS NULL AND COALESCE(a.status, 0) IN (0, 3) THEN 1 ELSE 0 END) AS open_count
    FROM projects p
    LEFT JOIN annotations a ON p.id = a.project_id
    GROUP BY p.id ORDER BY p.last_activity_at DESC
  `);
  const total = await dbGet('SELECT COUNT(*) AS total FROM annotations');
  let dbSize = 0;
  for (const f of ['annotations.db', 'annotations.db-wal']) {
    try { dbSize += fs.statSync(path.join(DATA_DIR, f)).size; } catch {}
  }
  const base = baseUrl(req);
  res.json({
    projects: projects.map(p => ({
      ...publicProject(p, { moderate: true }),
      annotations_count: p.annotations_count,
      open_count: p.open_count || 0,
      share_url: `${base}/project/${p.id}`,
      editor_url: p.editor_token ? `${base}/project/${p.id}#key=${p.editor_token}` : null
    })),
    totalAnnotations: total.total,
    storage: { database: dbSize, screenshots: dirSize(SCREENSHOT_DIR) },
    settings
  });
}));

app.patch('/api/admin/projects/:id', checkAdminAuth, ah(async (req, res) => {
  const project = await getProjectOr404(req.params.id);
  const { pinned, rotate_editor_token } = req.body;
  if (pinned !== undefined) {
    await dbRun('UPDATE projects SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, project.id]);
  }
  if (rotate_editor_token) {
    await dbRun('UPDATE projects SET editor_token = ? WHERE id = ?', [crypto.randomUUID(), project.id]);
  }
  const updated = await getProjectOr404(project.id);
  const base = baseUrl(req);
  res.json({
    ...publicProject(updated, { moderate: true }),
    editor_url: updated.editor_token ? `${base}/project/${updated.id}#key=${updated.editor_token}` : null
  });
}));

app.delete('/api/admin/projects/:id', checkAdminAuth, ah(async (req, res) => {
  const deleted = await deleteProjects([req.params.id]);
  if (!deleted) throw new HttpError(404, 'Project not found');
  res.json({ success: true });
}));

app.post('/api/admin/projects/delete', checkAdminAuth, ah(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every(id => typeof id === 'string')) {
    throw new HttpError(400, 'ids must be a non-empty array');
  }
  res.json({ deleted: await deleteProjects(ids) });
}));

app.get('/api/admin/settings', checkAdminAuth, (req, res) => res.json(settings));

app.put('/api/admin/settings', checkAdminAuth, ah(async (req, res) => {
  const { retention_days, retention_warn_days } = req.body;
  if (retention_days !== undefined) {
    const v = Number(retention_days);
    if (!Number.isInteger(v) || v < 0 || v > 3650) throw new HttpError(400, 'retention_days must be 0–3650');
    settings.retention_days = v;
    await saveSetting('retention_days', v);
  }
  if (retention_warn_days !== undefined) {
    const v = Number(retention_warn_days);
    if (!Number.isInteger(v) || v < 0 || v > 365) throw new HttpError(400, 'retention_warn_days must be 0–365');
    settings.retention_warn_days = v;
    await saveSetting('retention_warn_days', v);
  }
  res.json(settings);
}));

// Projects that the next cleanup run would delete, plus those inside the warning window
async function cleanupCandidates() {
  if (!settings.retention_days) return { due: [], soon: [] };
  const rows = await dbAll(`
    SELECT p.id, p.title, p.youtube_url, p.last_activity_at, p.created_at, p.pinned, COUNT(a.id) AS annotations_count
    FROM projects p LEFT JOIN annotations a ON a.project_id = p.id
    WHERE COALESCE(p.pinned, 0) = 0
      AND p.last_activity_at < datetime('now', ?)
    GROUP BY p.id ORDER BY p.last_activity_at ASC`,
  [`-${Math.max(0, settings.retention_days - settings.retention_warn_days)} days`]);
  const now = Date.now();
  const due = [], soon = [];
  for (const p of rows) {
    const item = { ...p, expires_at: expiresAt(p) };
    (new Date(item.expires_at).getTime() <= now ? due : soon).push(item);
  }
  return { due, soon };
}

async function runCleanup() {
  if (!settings.retention_days) return 0;
  const { due } = await cleanupCandidates();
  const deleted = await deleteProjects(due.map(p => p.id));
  if (deleted) console.log(`Cleanup: deleted ${deleted} inactive project(s)`);
  return deleted;
}

app.get('/api/admin/cleanup/preview', checkAdminAuth, ah(async (req, res) => {
  res.json({ settings, ...(await cleanupCandidates()) });
}));

app.post('/api/admin/cleanup/run', checkAdminAuth, ah(async (req, res) => {
  res.json({ deleted: await runCleanup() });
}));

app.get('/api/admin/backup', checkAdminAuth, ah(async (req, res) => {
  const file = path.join(DATA_DIR, `backup-tmp-${Date.now()}.db`);
  await dbRun('VACUUM INTO ?', [file]);
  const stamp = new Date().toISOString().slice(0, 10);
  res.download(file, `ofa-backup-${stamp}.db`, (err) => {
    fs.rm(file, { force: true }, () => {});
    if (err && !res.headersSent) res.status(500).json({ error: 'Backup failed' });
  });
}));

// ── Project routes ───────────────────────────────────────────────────────────

app.post('/api/projects', ah(async (req, res) => {
  const { youtube_url } = req.body;
  if (!youtube_url || typeof youtube_url !== 'string') throw new HttpError(400, 'YouTube URL is required');
  if (youtube_url.length > 2048) throw new HttpError(400, 'URL too long');
  const title = optionalString(req.body.title, 100, 'title');
  const description = optionalString(req.body.description, 500, 'description');
  if (req.body.tags_config != null && typeof req.body.tags_config !== 'string' && !Array.isArray(req.body.tags_config)) {
    throw new HttpError(400, 'Invalid tags');
  }

  const videoId = parseYouTubeId(youtube_url);
  if (!videoId) throw new HttpError(400, 'Invalid YouTube URL');

  const projectId = crypto.randomUUID();
  const editorToken = crypto.randomUUID();
  await dbRun(
    `INSERT INTO projects (id, youtube_url, title, description, tags_config, editor_token, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    // Canonical URL keeps rendering safe and makes every link format work in the player
    [projectId, `https://www.youtube.com/watch?v=${videoId}`, title, description, normalizeTagsConfig(req.body.tags_config), editorToken]
  );

  const base = baseUrl(req);
  res.status(201).json({
    project_id: projectId,
    editor_token: editorToken,
    share_url: `${base}/project/${projectId}`,
    editor_url: `${base}/project/${projectId}#key=${editorToken}`
  });
}));

app.get('/api/projects/:id', ah(async (req, res) => {
  const project = await getProjectOr404(req.params.id);
  const perms = permissionsFor(req, project);
  const annotations = await dbAll(
    `SELECT ${ANNOTATION_FIELDS} FROM annotations WHERE project_id = ? ORDER BY timecode ASC, created_at ASC`,
    [project.id]
  );
  res.json({
    project: publicProject(project, perms),
    annotations,
    permissions: perms,
    retention: { days: settings.retention_days, warn_days: settings.retention_warn_days }
  });
}));

app.patch('/api/projects/:id', ah(async (req, res) => {
  const project = await getProjectOr404(req.params.id);
  if (!permissionsFor(req, project).moderate) throw new HttpError(403, 'Only the editor can change project settings');

  const updates = {};
  if (req.body.title !== undefined) updates.title = optionalString(req.body.title, 100, 'title');
  if (req.body.description !== undefined) updates.description = optionalString(req.body.description, 500, 'description');
  if (req.body.tags_config !== undefined) {
    if (req.body.tags_config !== null && typeof req.body.tags_config !== 'string' && !Array.isArray(req.body.tags_config)) {
      throw new HttpError(400, 'Invalid tags');
    }
    updates.tags_config = normalizeTagsConfig(req.body.tags_config);
  }
  const keys = Object.keys(updates);
  if (keys.length) {
    await dbRun(`UPDATE projects SET ${keys.map(k => `${k} = ?`).join(', ')}, last_activity_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...keys.map(k => updates[k]), project.id]);
  }
  const updated = await getProjectOr404(project.id);
  io.to(project.id).emit('project:updated', publicProject(updated));
  res.json(publicProject(updated, { moderate: true }));
}));

app.get('/api/projects/:id/storyboard', ah(async (req, res) => {
  const project = await getProjectOr404(req.params.id);
  const videoId = parseYouTubeId(project.youtube_url);
  if (!videoId) return res.json({ duration: 0, levels: [] });
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.json(await fetchStoryboard(videoId));
}));

// Recreate a deleted project from a browser backup
app.post('/api/projects/restore', ah(async (req, res) => {
  const { project: src, annotations: srcAnnotations } = req.body || {};
  if (!src || typeof src !== 'object') throw new HttpError(400, 'Project is required');
  if (typeof src.id !== 'string' || !SAFE_ID_RE.test(src.id) || src.id.length > 36) throw new HttpError(400, 'Invalid project id');
  if (await dbGet('SELECT id FROM projects WHERE id = ?', [src.id])) {
    return res.status(409).json({ error: 'Project already exists', exists: true });
  }
  const videoId = parseYouTubeId(src.youtube_url);
  if (!videoId) throw new HttpError(400, 'Invalid YouTube URL');
  const title = optionalString(src.title, 100, 'title');
  const description = optionalString(src.description, 500, 'description');
  const tagsConfig = src.tags_config == null ? null : normalizeTagsConfig(src.tags_config);
  const editorToken = typeof src.editor_token === 'string' && UUID_RE.test(src.editor_token) ? src.editor_token : crypto.randomUUID();

  const list = Array.isArray(srcAnnotations) ? srcAnnotations : [];
  if (list.length > 5000) throw new HttpError(400, 'Too many annotations (max 5000)');

  const projectForTags = { tags_config: tagsConfig };
  const valid = new Map();
  // Roots first so replies can reference them
  const ordered = [...list.filter(a => a && !a.parent_id), ...list.filter(a => a && a.parent_id)];
  for (const a of ordered) {
    try {
      if (typeof a.id !== 'string' || !SAFE_ID_RE.test(a.id) || valid.has(a.id)) continue;
      if (a.parent_id && (!valid.has(a.parent_id) || valid.get(a.parent_id).parent_id)) continue;
      if (await dbGet('SELECT id FROM annotations WHERE id = ?', [a.id])) continue;
      const timecode = a.parent_id ? valid.get(a.parent_id).timecode : parseTimecode(a.timecode);
      const created = parseDbDate(a.created_at) || new Date();
      valid.set(a.id, {
        id: a.id,
        parent_id: a.parent_id || null,
        author: requiredString(a.author, 100, 'author'),
        text: requiredString(a.text, 2000, 'text'),
        timecode,
        timecode_end: a.parent_id ? null : parseTimecodeEnd(a.timecode_end, timecode),
        status: STATUSES.includes(a.status) ? a.status : 0,
        status_by: optionalString(a.status_by, 100, 'status_by'),
        tags: cleanAnnotationTags(typeof a.tags === 'string' ? parseJsonArray(a.tags) : a.tags, projectForTags),
        // Comments restored without their token can only be removed by the editor
        edit_token: typeof a.edit_token === 'string' && a.edit_token.length <= 64 ? a.edit_token : crypto.randomUUID(),
        created_at: toDbDate(created)
      });
    } catch { /* skip invalid entries */ }
  }

  const statements = [[
    `INSERT INTO projects (id, youtube_url, title, description, tags_config, editor_token, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [src.id, `https://www.youtube.com/watch?v=${videoId}`, title, description, tagsConfig, editorToken]
  ]];
  for (const a of valid.values()) {
    statements.push([
      `INSERT INTO annotations (id, project_id, parent_id, author, text, timecode, timecode_end, status, status_by, tags, edit_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [a.id, src.id, a.parent_id, a.author, a.text, a.timecode, a.timecode_end, a.status, a.status_by, a.tags, a.edit_token, a.created_at]
    ]);
  }
  await dbBatch(statements);

  const base = baseUrl(req);
  res.status(201).json({
    project_id: src.id,
    editor_token: editorToken,
    restored: valid.size,
    share_url: `${base}/project/${src.id}`,
    editor_url: `${base}/project/${src.id}#key=${editorToken}`
  });
}));

// ── Annotation routes ────────────────────────────────────────────────────────

app.post('/api/projects/:id/annotations', ah(async (req, res) => {
  const author = requiredString(req.body.author, 100, 'author');
  const text = requiredString(req.body.text, 2000, 'text');
  const { parent_id } = req.body;
  if (parent_id != null && typeof parent_id !== 'string') throw new HttpError(400, 'Invalid parent_id');

  const project = await getProjectOr404(req.params.id);

  let parent = null;
  if (parent_id) {
    parent = await dbGet('SELECT id, parent_id, timecode FROM annotations WHERE id = ? AND project_id = ?', [parent_id, project.id]);
    if (!parent) throw new HttpError(404, 'Parent comment not found');
    if (parent.parent_id) throw new HttpError(400, 'Cannot reply to a reply');
  }

  // Replies inherit the parent's timecode; root comments must supply a valid one
  if (!parent && req.body.timecode === undefined) throw new HttpError(400, 'Timecode is required');
  const timecode = parent ? parent.timecode : parseTimecode(req.body.timecode);
  const timecodeEnd = parent ? null : parseTimecodeEnd(req.body.timecode_end, timecode);
  const tags = parent ? null : cleanAnnotationTags(req.body.tags, project);

  const annotationId = crypto.randomUUID();
  const editToken = crypto.randomUUID();
  await dbRun(
    `INSERT INTO annotations (id, project_id, parent_id, author, text, timecode, timecode_end, status, tags, edit_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [annotationId, project.id, parent ? parent.id : null, author, text, timecode, timecodeEnd, tags, editToken]
  );
  await touchProject(project.id);

  const annotation = await publicAnnotation(annotationId);
  io.to(project.id).emit('annotation:created', annotation);
  res.status(201).json({ ...annotation, edit_token: editToken });
}));

app.patch('/api/annotations/:id', ah(async (req, res) => {
  const annotation = await getAnnotationOr404(req.params.id);
  const project = await getProjectOr404(annotation.project_id);
  // Only the author edits content — moderators can delete, but not put words in someone's mouth
  const token = req.body.edit_token || req.get('X-Edit-Token');
  if (!annotation.edit_token || !safeCompare(token, annotation.edit_token)) {
    throw new HttpError(403, 'You can only edit your own comments');
  }

  const updates = {};
  if (req.body.text !== undefined) updates.text = requiredString(req.body.text, 2000, 'text');
  if (!annotation.parent_id) {
    if (req.body.tags !== undefined) updates.tags = cleanAnnotationTags(req.body.tags, project);
    const start = req.body.timecode !== undefined ? parseTimecode(req.body.timecode) : annotation.timecode;
    if (req.body.timecode !== undefined) updates.timecode = start;
    if (req.body.timecode_end !== undefined) updates.timecode_end = parseTimecodeEnd(req.body.timecode_end, start);
    else if (annotation.timecode_end != null && annotation.timecode_end <= start) updates.timecode_end = null;
  }
  const keys = Object.keys(updates);
  if (!keys.length) throw new HttpError(400, 'Nothing to update');

  await dbRun(`UPDATE annotations SET ${keys.map(k => `${k} = ?`).join(', ')}, edited_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [...keys.map(k => updates[k]), annotation.id]);
  if (updates.timecode !== undefined) {
    await dbRun('UPDATE annotations SET timecode = ? WHERE parent_id = ?', [updates.timecode, annotation.id]);
  }
  await touchProject(project.id);

  const updated = await publicAnnotation(annotation.id);
  io.to(project.id).emit('annotation:updated', updated);
  res.json(updated);
}));

app.delete('/api/annotations/:id', ah(async (req, res) => {
  const annotation = await getAnnotationOr404(req.params.id);
  const project = await getProjectOr404(annotation.project_id);
  if (!canModifyAnnotation(req, annotation, permissionsFor(req, project))) {
    const token = (req.body && req.body.edit_token) || req.get('X-Edit-Token');
    throw new HttpError(403, token ? 'Invalid edit token' : 'Edit token required');
  }

  if (annotation.parent_id) {
    await dbRun('DELETE FROM annotations WHERE id = ?', [annotation.id]);
    removeScreenshots([annotation.id]);
    io.to(project.id).emit('annotation:deleted', { id: annotation.id });
  } else {
    // Root annotation — cascade delete replies, then the root
    const replies = await dbAll('SELECT id FROM annotations WHERE parent_id = ?', [annotation.id]);
    await dbRun('DELETE FROM annotations WHERE parent_id = ?', [annotation.id]);
    await dbRun('DELETE FROM annotations WHERE id = ?', [annotation.id]);
    removeScreenshots([annotation.id, ...replies.map(r => r.id)]);
    io.to(project.id).emit('thread:deleted', { parentId: annotation.id });
  }
  await touchProject(project.id);
  res.json({ success: true, id: annotation.id });
}));

async function setStatus(annotation, status, by) {
  await dbRun('UPDATE annotations SET status = ?, status_by = ?, status_at = ? WHERE id = ?',
    [status, status ? by : null, status ? toDbDate(new Date()) : null, annotation.id]);
  const row = await publicAnnotation(annotation.id);
  io.to(annotation.project_id).emit('annotation:status', {
    id: row.id, status: row.status, status_by: row.status_by, status_at: row.status_at
  });
  return row;
}

app.patch('/api/annotations/:id/status', ah(async (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) {
    throw new HttpError(400, 'Invalid status (0=pending, 1=accepted, 2=rejected, 3=in progress)');
  }
  const by = optionalString(req.body.by, 100, 'name');
  const annotation = await getAnnotationOr404(req.params.id);
  const project = await getProjectOr404(annotation.project_id);
  if (!permissionsFor(req, project).review) throw new HttpError(403, 'Only the editor can change comment status');

  const row = await setStatus(annotation, status, by);
  await touchProject(project.id);
  res.json({ id: row.id, status: row.status, status_by: row.status_by, status_at: row.status_at });
}));

// Legacy endpoint
app.patch('/api/annotations/:id/resolve', ah(async (req, res) => {
  const { resolved } = req.body;
  if (resolved === undefined) throw new HttpError(400, 'Resolved status is required');
  const annotation = await getAnnotationOr404(req.params.id);
  const project = await getProjectOr404(annotation.project_id);
  if (!permissionsFor(req, project).review) throw new HttpError(403, 'Only the editor can change comment status');
  const row = await setStatus(annotation, resolved ? 1 : 0, null);
  await touchProject(project.id);
  res.json({ id: row.id, resolved: row.status });
}));

app.post('/api/projects/:id/annotations/bulk', ah(async (req, res) => {
  const project = await getProjectOr404(req.params.id);
  const perms = permissionsFor(req, project);
  const { ids, action, status } = req.body;
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every(id => typeof id === 'string')) {
    throw new HttpError(400, 'ids must be a non-empty array (max 500)');
  }
  const placeholders = ids.map(() => '?').join(',');
  const rows = await dbAll(`SELECT * FROM annotations WHERE project_id = ? AND id IN (${placeholders})`, [project.id, ...ids]);

  if (action === 'status') {
    if (!perms.review) throw new HttpError(403, 'Only the editor can change comment status');
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Invalid status');
    const by = optionalString(req.body.by, 100, 'name');
    for (const row of rows) await setStatus(row, status, by);
  } else if (action === 'delete') {
    if (!perms.moderate) throw new HttpError(403, 'Only the editor can delete comments in bulk');
    for (const row of rows.filter(r => !r.parent_id)) {
      const replies = await dbAll('SELECT id FROM annotations WHERE parent_id = ?', [row.id]);
      await dbRun('DELETE FROM annotations WHERE parent_id = ?', [row.id]);
      await dbRun('DELETE FROM annotations WHERE id = ?', [row.id]);
      removeScreenshots([row.id, ...replies.map(r => r.id)]);
      io.to(project.id).emit('thread:deleted', { parentId: row.id });
    }
    for (const row of rows.filter(r => r.parent_id)) {
      const result = await dbRun('DELETE FROM annotations WHERE id = ?', [row.id]);
      if (result.changes) {
        removeScreenshots([row.id]);
        io.to(project.id).emit('annotation:deleted', { id: row.id });
      }
    }
  } else {
    throw new HttpError(400, 'Unknown action');
  }
  await touchProject(project.id);
  res.json({ success: true, affected: rows.length });
}));

// ── Screenshots ──────────────────────────────────────────────────────────────

app.post('/api/annotations/:id/screenshot',
  express.raw({ type: ['image/jpeg'], limit: '4mb' }),
  ah(async (req, res) => {
    const annotation = await getAnnotationOr404(req.params.id);
    const project = await getProjectOr404(annotation.project_id);
    if (!canModifyAnnotation(req, annotation, permissionsFor(req, project))) {
      throw new HttpError(403, 'You can only attach frames to your own comments');
    }
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 100 || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) {
      throw new HttpError(400, 'Expected a JPEG image');
    }
    const file = screenshotPath(annotation.id);
    if (!file) throw new HttpError(400, 'Unsupported annotation id');
    await fs.promises.writeFile(file, buf);
    await dbRun('UPDATE annotations SET has_screenshot = 1 WHERE id = ?', [annotation.id]);
    const updated = await publicAnnotation(annotation.id);
    io.to(project.id).emit('annotation:updated', updated);
    res.json(updated);
  })
);

app.get('/api/annotations/:id/screenshot', ah(async (req, res) => {
  const file = screenshotPath(req.params.id);
  if (!file || !fs.existsSync(file)) throw new HttpError(404, 'No screenshot');
  res.setHeader('Content-Type', 'image/jpeg');
  res.sendFile(file, { headers: { 'Cache-Control': 'private, no-cache' } });
}));

// ── Export routes ────────────────────────────────────────────────────────────

async function exportProject(req, res, format) {
  const exporter = FORMATS[format];
  if (!exporter) throw new HttpError(400, 'Unsupported format');
  const fps = parseFloat(req.query.fps) || 24;
  if (!tc.VALID_FPS.includes(fps)) throw new HttpError(400, 'Unsupported FPS value');
  const startFrames = req.query.start ? tc.timecodeToFrames(req.query.start, fps) : 0;
  if (startFrames === null) throw new HttpError(400, 'Invalid start timecode');
  const statusFilter = req.query.statuses
    ? String(req.query.statuses).split(',').map(Number).filter(s => STATUSES.includes(s))
    : null;

  const project = await getProjectOr404(req.params.id);
  const all = await dbAll(`SELECT ${ANNOTATION_FIELDS} FROM annotations WHERE project_id = ? ORDER BY timecode ASC, created_at ASC`, [project.id]);
  const threads = all
    .filter(a => !a.parent_id)
    .filter(a => !statusFilter || statusFilter.includes(a.status || 0))
    .map(a => ({ ...a, status: a.status || 0, replies: all.filter(r => r.parent_id === a.id) }));

  const body = exporter.build({
    project: { title: project.title, tags: parseJsonArray(project.tags_config) },
    threads, fps, startFrames,
    colorBy: req.query.color === 'tag' ? 'tag' : 'status'
  });
  const slug = (project.title || 'markers').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'markers';
  res.setHeader('Content-Type', exporter.type);
  res.setHeader('Content-Disposition',
    `attachment; filename="markers-${project.id.substring(0, 8)}.${exporter.ext}"; filename*=UTF-8''${encodeURIComponent(slug)}.${exporter.ext}`);
  res.send(body);
}

// Old CSV endpoint kept for API compatibility
app.get('/api/projects/:id/export/premiere', ah((req, res) => exportProject(req, res, 'csv')));
app.get('/api/projects/:id/export/:format', ah((req, res) => exportProject(req, res, req.params.format)));

// ── Static + page routes ─────────────────────────────────────────────────────

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/project/:id/report', (req, res) => res.sendFile(path.join(__dirname, 'public', 'report.html')));
app.get('/project/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'project.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Startup / shutdown ───────────────────────────────────────────────────────

async function startServer() {
  const customPassword = await dbGet(`SELECT value FROM settings WHERE key = 'admin_password_hash'`);
  server.listen(PORT, () => {
    if (adminPassword.generated && !customPassword) {
      console.log('──────────────────────────────────────────────────────────────');
      console.log(' ADMIN_PASSWORD is not set. Using a generated admin password:');
      console.log(`   ${adminPassword.value}`);
      console.log(` (stored in ${adminPassword.file}; set ADMIN_PASSWORD to override)`);
      console.log('──────────────────────────────────────────────────────────────');
    }
    if (settings.retention_days) console.log(`Auto-cleanup: projects inactive for ${settings.retention_days} days are deleted`);
    console.log(`Admin panel: ${PUBLIC_URL || `http://localhost:${PORT}`}/admin`);
    console.log(`Server running on port ${PORT}`);
  });

  const cleanup = () => runCleanup().catch(err => console.error('Cleanup failed:', err));
  setTimeout(cleanup, 60 * 1000).unref();
  setInterval(cleanup, 6 * 60 * 60 * 1000).unref();
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  setTimeout(() => process.exit(1), 10000).unref();
  // io.close() also closes the underlying HTTP server
  io.close(() => {
    db.close((err) => {
      if (err) console.error(err.message);
      console.log('Database connection closed');
      process.exit(0);
    });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
