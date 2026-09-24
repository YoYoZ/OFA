const express = require('express');
const http = require('http');
const { Server: SocketServer } = require('socket.io');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config();

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

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
app.use(express.json({ limit: '100kb' }));

// ── Database ─────────────────────────────────────────────────────────────────

const db = new sqlite3.Database(path.join(DATA_DIR, 'annotations.db'), (err) => {
  if (err) { console.error('Error opening database:', err.message); process.exit(1); }
  console.log(`Connected to SQLite database in ${DATA_DIR}`);
  initDatabase(() => {
    server.listen(PORT, () => {
      if (adminPassword.generated) {
        console.log('──────────────────────────────────────────────────────────────');
        console.log(' ADMIN_PASSWORD is not set. Using a generated admin password:');
        console.log(`   ${adminPassword.value}`);
        console.log(` (stored in ${adminPassword.file}; set ADMIN_PASSWORD to override)`);
        console.log('──────────────────────────────────────────────────────────────');
      }
      console.log(`Admin panel: ${PUBLIC_URL || `http://localhost:${PORT}`}/admin`);
      console.log(`Server running on port ${PORT}`);
    });
  });
});

function runMigration(sql, label) {
  db.run(sql, (err) => {
    if (err && !err.message.includes('already has a column named') && !err.message.includes('duplicate column')) {
      console.error(`Migration error (${label}):`, err.message);
    }
  });
}

function initDatabase(callback) {
  db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA busy_timeout = 5000');

    db.run(`CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      youtube_url TEXT NOT NULL,
      title       TEXT,
      description TEXT,
      tags_config TEXT,
      password_hash TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS annotations (
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

    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      sid     TEXT PRIMARY KEY,
      sess    TEXT NOT NULL,
      expires INTEGER NOT NULL
    )`);

    // Migrations for existing databases
    runMigration(`ALTER TABLE projects ADD COLUMN title TEXT`, 'projects.title');
    runMigration(`ALTER TABLE projects ADD COLUMN description TEXT`, 'projects.description');
    runMigration(`ALTER TABLE projects ADD COLUMN tags_config TEXT`, 'projects.tags_config');
    runMigration(`ALTER TABLE projects ADD COLUMN password_hash TEXT`, 'projects.password_hash');
    runMigration(`ALTER TABLE annotations ADD COLUMN status INTEGER DEFAULT 0`, 'annotations.status');
    runMigration(`ALTER TABLE annotations ADD COLUMN parent_id TEXT`, 'annotations.parent_id');
    runMigration(`ALTER TABLE annotations ADD COLUMN tags TEXT`, 'annotations.tags');
    runMigration(`ALTER TABLE annotations ADD COLUMN edit_token TEXT`, 'annotations.edit_token');

    db.run('CREATE INDEX IF NOT EXISTS idx_annotations_project ON annotations (project_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_annotations_parent ON annotations (parent_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires)');

    // Wait for last migration before signalling ready
    db.run(`SELECT 1`, () => {
      console.log('Database initialized');
      if (callback) callback();
    });
  });
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
    if (typeof projectId === 'string' && projectId.length <= 36) {
      socket.join(projectId);
    }
  });
});

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

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aHash = crypto.createHash('sha256').update(a).digest();
  const bHash = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

// ── Utilities ────────────────────────────────────────────────────────────────

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const VALID_FPS = new Set([23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60]);
const MAX_TIMECODE = 48 * 3600;

// Accepts watch / youtu.be / embed / shorts / live / mobile links; returns the 11-char video ID or null.
function parseYouTubeId(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      const [, kind, value] = url.pathname.split('/');
      if (['embed', 'v', 'shorts', 'live'].includes(kind)) id = value;
    }
  }
  return id && YOUTUBE_ID_RE.test(id) ? id : null;
}

function secondsToTimecode(seconds, fps) {
  const isDropFrame = fps === 29.97 || fps === 59.94;
  const nominalFps = Math.round(fps);
  let frames = Math.round(seconds * fps);

  if (isDropFrame) {
    // SMPTE drop-frame: skip frame numbers 0..N at the start of every minute except each 10th minute
    const dropFrames = Math.round(fps * 0.066666);           // 2 @ 29.97, 4 @ 59.94
    const framesPer10Min = Math.round(fps * 600);            // 17982 / 35964
    const framesPerMin = nominalFps * 60 - dropFrames;       // 1798 / 3596
    const tens = Math.floor(frames / framesPer10Min);
    const rem = frames % framesPer10Min;
    frames += dropFrames * 9 * tens;
    if (rem > dropFrames) frames += dropFrames * Math.floor((rem - dropFrames) / framesPerMin);
  }

  const f = frames % nominalFps;
  const s = Math.floor(frames / nominalFps) % 60;
  const m = Math.floor(frames / (nominalFps * 60)) % 60;
  const h = Math.floor(frames / (nominalFps * 3600));
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${isDropFrame ? ';' : ':'}${pad(f)}`;
}

function csvEscape(str) {
  return '"' + String(str).replace(/"/g, '""') + '"';
}

function parseJsonArray(json) {
  if (!json) return [];
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

function checkAdminAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Health ───────────────────────────────────────────────────────────────────

app.get('/healthz', (req, res) => {
  db.get('SELECT 1 AS ok', [], (err) => {
    if (err) return res.status(503).json({ status: 'error' });
    res.json({ status: 'ok' });
  });
});

// ── Admin routes ─────────────────────────────────────────────────────────────

app.post('/api/admin/login', adminRateLimit, (req, res) => {
  const { password } = req.body;
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Password required' });
  if (safeCompare(password, adminPassword.value)) {
    req.loginRecord.count = 0;
    req.session.regenerate((err) => {
      if (err) { console.error(err); return res.status(500).json({ error: 'Login failed' }); }
      req.session.isAdmin = true;
      res.json({ success: true });
    });
  } else {
    req.loginRecord.count++;
    res.status(401).json({ error: 'Invalid password' });
  }
});

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

app.get('/api/admin/projects', checkAdminAuth, (req, res) => {
  db.all(`
    SELECT p.id, p.youtube_url, p.title, p.created_at,
           COUNT(a.id) as annotations_count
    FROM projects p
    LEFT JOIN annotations a ON p.id = a.project_id
    GROUP BY p.id ORDER BY p.created_at DESC
  `, [], (err, projects) => {
    if (err) { console.error(err); return res.status(500).json({ error: 'Database error' }); }
    db.get('SELECT COUNT(*) as total FROM annotations', [], (err, result) => {
      if (err) { console.error(err); return res.status(500).json({ error: 'Database error' }); }
      res.json({ projects, totalAnnotations: result.total });
    });
  });
});

app.delete('/api/admin/projects/:id', checkAdminAuth, (req, res) => {
  const { id } = req.params;
  db.serialize(() => {
    db.run('DELETE FROM annotations WHERE project_id = ?', [id], function(err) {
      if (err) { console.error(err); return res.status(500).json({ error: 'Failed to delete annotations' }); }
      db.run('DELETE FROM projects WHERE id = ?', [id], function(err) {
        if (err) { console.error(err); return res.status(500).json({ error: 'Failed to delete project' }); }
        if (this.changes === 0) return res.status(404).json({ error: 'Project not found' });
        io.to(id).emit('project:deleted', { id });
        res.json({ success: true });
      });
    });
  });
});

// ── Project routes ───────────────────────────────────────────────────────────

app.post('/api/projects', (req, res) => {
  const { youtube_url, title, description, tags_config } = req.body;

  if (!youtube_url || typeof youtube_url !== 'string') return res.status(400).json({ error: 'YouTube URL is required' });
  if (youtube_url.length > 2048) return res.status(400).json({ error: 'URL too long' });
  if (title !== undefined && title !== null && typeof title !== 'string') return res.status(400).json({ error: 'Invalid title' });
  if (description !== undefined && description !== null && typeof description !== 'string') return res.status(400).json({ error: 'Invalid description' });
  if (tags_config !== undefined && tags_config !== null && typeof tags_config !== 'string') return res.status(400).json({ error: 'Invalid tags' });
  if (title && title.length > 100) return res.status(400).json({ error: 'Title too long (max 100)' });
  if (description && description.length > 500) return res.status(400).json({ error: 'Description too long (max 500)' });

  const videoId = parseYouTubeId(youtube_url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });
  // Store a canonical URL — keeps rendering safe and makes every link format work in the player
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Validate and normalise tags_config as a JSON array of unique strings
  let tagsJson = null;
  if (tags_config) {
    const tags = [...new Set(tags_config.split(',').map(t => t.trim().slice(0, 30)).filter(Boolean))].slice(0, 8);
    if (tags.length) tagsJson = JSON.stringify(tags);
  }

  const projectId = crypto.randomUUID();

  db.run(
    'INSERT INTO projects (id, youtube_url, title, description, tags_config) VALUES (?, ?, ?, ?, ?)',
    [projectId, canonicalUrl, title ? title.trim() : null, description ? description.trim() : null, tagsJson],
    function(err) {
      if (err) { console.error(err); return res.status(500).json({ error: 'Failed to create project' }); }
      const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
      res.status(201).json({
        project_id: projectId,
        share_url: `${base}/project/${projectId}`
      });
    }
  );
});

app.get('/api/projects/:id', (req, res) => {
  const { id } = req.params;
  db.get('SELECT id, youtube_url, title, description, tags_config, created_at FROM projects WHERE id = ?', [id], (err, project) => {
    if (err) { console.error(err); return res.status(500).json({ error: 'Database error' }); }
    if (!project) return res.status(404).json({ error: 'Project not found' });

    db.all(
      'SELECT id, project_id, parent_id, author, text, timecode, status, tags, created_at FROM annotations WHERE project_id = ? ORDER BY timecode ASC, created_at ASC',
      [id],
      (err, annotations) => {
        if (err) { console.error(err); return res.status(500).json({ error: 'Failed to load annotations' }); }
        res.json({ project, annotations });
      }
    );
  });
});

// ── Annotation routes ────────────────────────────────────────────────────────

app.post('/api/projects/:id/annotations', (req, res) => {
  const { id } = req.params;
  const { parent_id, tags } = req.body;
  const author = typeof req.body.author === 'string' ? req.body.author.trim() : '';
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';

  if (!author || !text) return res.status(400).json({ error: 'Author and text are required' });
  if (author.length > 100) return res.status(400).json({ error: 'Author name too long (max 100)' });
  if (text.length > 2000) return res.status(400).json({ error: 'Comment too long (max 2000)' });
  if (parent_id !== undefined && parent_id !== null && typeof parent_id !== 'string') {
    return res.status(400).json({ error: 'Invalid parent_id' });
  }
  if (tags !== undefined && tags !== null && !Array.isArray(tags)) return res.status(400).json({ error: 'Invalid tags' });

  db.get('SELECT id, tags_config FROM projects WHERE id = ?', [id], (err, project) => {
    if (err) { console.error(err); return res.status(500).json({ error: 'Database error' }); }
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const withParent = (cb) => {
      if (!parent_id) return cb(null);
      db.get('SELECT id, parent_id, timecode FROM annotations WHERE id = ? AND project_id = ?', [parent_id, id], (err, parent) => {
        if (err) { console.error(err); return res.status(500).json({ error: 'Database error' }); }
        if (!parent) return res.status(404).json({ error: 'Parent comment not found' });
        if (parent.parent_id) return res.status(400).json({ error: 'Cannot reply to a reply' });
        cb(parent);
      });
    };

    withParent((parent) => {
      // Replies inherit the parent's timecode; root comments must supply a valid one
      const timecode = parent ? parent.timecode : Number(req.body.timecode);
      if (req.body.timecode === undefined && !parent) return res.status(400).json({ error: 'Timecode is required' });
      if (!Number.isFinite(timecode) || timecode < 0 || timecode > MAX_TIMECODE) {
        return res.status(400).json({ error: 'Invalid timecode' });
      }

      // Only tags configured on the project are accepted
      const allowedTags = parseJsonArray(project.tags_config);
      const cleanTags = Array.isArray(tags)
        ? [...new Set(tags.filter(t => typeof t === 'string' && allowedTags.includes(t)))]
        : [];
      const tagsJson = cleanTags.length ? JSON.stringify(cleanTags) : null;

      const annotationId = crypto.randomUUID();
      const editToken = crypto.randomUUID();

      db.run(
        'INSERT INTO annotations (id, project_id, parent_id, author, text, timecode, status, tags, edit_token) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
        [annotationId, id, parent ? parent.id : null, author, text, timecode, tagsJson, editToken],
        function(err) {
          if (err) { console.error(err); return res.status(500).json({ error: 'Failed to add annotation' }); }

          const annotation = {
            id: annotationId, project_id: id, parent_id: parent ? parent.id : null,
            author, text, timecode, status: 0, tags: tagsJson,
            created_at: new Date().toISOString()
          };

          io.to(id).emit('annotation:created', annotation);
          res.status(201).json({ ...annotation, edit_token: editToken });
        }
      );
    });
  });
});

app.delete('/api/annotations/:id', (req, res) => {
  const { id } = req.params;
  const { edit_token } = req.body || {};

  db.get('SELECT project_id, parent_id, edit_token FROM annotations WHERE id = ?', [id], (err, row) => {
    if (err) { console.error(err); return res.status(500).json({ error: 'Database error' }); }
    if (!row) return res.status(404).json({ error: 'Annotation not found' });

    if (row.edit_token) {
      if (!edit_token) return res.status(403).json({ error: 'Edit token required' });
      if (!safeCompare(edit_token, row.edit_token)) return res.status(403).json({ error: 'Invalid edit token' });
    }

    if (row.parent_id) {
      // Reply — delete only this one
      db.run('DELETE FROM annotations WHERE id = ?', [id], function(err) {
        if (err) { console.error(err); return res.status(500).json({ error: 'Failed to delete' }); }
        io.to(row.project_id).emit('annotation:deleted', { id });
        res.json({ success: true, id });
      });
    } else {
      // Root annotation — cascade delete replies, then the root
      db.run('DELETE FROM annotations WHERE parent_id = ?', [id], (err) => {
        if (err) { console.error(err); return res.status(500).json({ error: 'Failed to delete' }); }
        db.run('DELETE FROM annotations WHERE id = ?', [id], function(err) {
          if (err) { console.error(err); return res.status(500).json({ error: 'Failed to delete' }); }
          io.to(row.project_id).emit('thread:deleted', { parentId: id });
          res.json({ success: true, id });
        });
      });
    }
  });
});

app.patch('/api/annotations/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (![0, 1, 2].includes(status)) {
    return res.status(400).json({ error: 'Invalid status (0=pending, 1=accepted, 2=rejected)' });
  }

  db.get('SELECT project_id FROM annotations WHERE id = ?', [id], (err, row) => {
    if (err) { console.error(err); return res.status(500).json({ error: 'Database error' }); }
    if (!row) return res.status(404).json({ error: 'Annotation not found' });

    db.run('UPDATE annotations SET status = ? WHERE id = ?', [status, id], function(err) {
      if (err) { console.error(err); return res.status(500).json({ error: 'Failed to update' }); }
      io.to(row.project_id).emit('annotation:status', { id, status });
      res.json({ id, status });
    });
  });
});

// Legacy endpoint
app.patch('/api/annotations/:id/resolve', (req, res) => {
  const { id } = req.params;
  const { resolved } = req.body;
  if (resolved === undefined) return res.status(400).json({ error: 'Resolved status is required' });
  const status = resolved ? 1 : 0;
  db.get('SELECT project_id FROM annotations WHERE id = ?', [id], (err, row) => {
    if (err) { console.error(err); return res.status(500).json({ error: 'Database error' }); }
    if (!row) return res.status(404).json({ error: 'Annotation not found' });
    db.run('UPDATE annotations SET status = ? WHERE id = ?', [status, id], function(err) {
      if (err) { console.error(err); return res.status(500).json({ error: 'Failed to update' }); }
      io.to(row.project_id).emit('annotation:status', { id, status });
      res.json({ id, resolved: status });
    });
  });
});

// ── Export routes ────────────────────────────────────────────────────────────

app.get('/api/projects/:id/export/premiere', (req, res) => {
  const { id } = req.params;
  const fps = parseFloat(req.query.fps) || 24;

  if (!VALID_FPS.has(fps)) return res.status(400).json({ error: 'Unsupported FPS value' });

  db.get('SELECT id, title FROM projects WHERE id = ?', [id], (err, project) => {
    if (err) { console.error(err); return res.status(500).json({ error: 'Database error' }); }
    if (!project) return res.status(404).json({ error: 'Project not found' });

    db.all(
      'SELECT author, text, timecode, status FROM annotations WHERE project_id = ? AND parent_id IS NULL ORDER BY timecode ASC',
      [id],
      (err, annotations) => {
        if (err) { console.error(err); return res.status(500).json({ error: 'Database error' }); }

        const zero = secondsToTimecode(0, fps);
        const header = 'Marker Name,Description,In,Out,Duration,Marker Type';
        const rows = annotations.map(a => [
          csvEscape(a.author),
          csvEscape(a.text),
          csvEscape(secondsToTimecode(a.timecode, fps)),
          csvEscape(secondsToTimecode(a.timecode, fps)),
          csvEscape(zero),
          csvEscape('Comment')
        ].join(','));

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="markers-${id.substring(0, 8)}.csv"`);
        res.send([header, ...rows].join('\n'));
      }
    );
  });
});

// ── Static + page routes ─────────────────────────────────────────────────────

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/project/:id/report', (req, res) => res.sendFile(path.join(__dirname, 'public', 'report.html')));
app.get('/project/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'project.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

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
