const express = require('express');
const http = require('http');
const { Server: SocketServer } = require('socket.io');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

fs.mkdirSync('./data', { recursive: true });

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || true, credentials: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-key-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true }
}));

app.use(express.static(path.join(__dirname, 'public')));

// ── Socket.io ────────────────────────────────────────────────────────────────

const io = new SocketServer(server, {
  cors: { origin: process.env.ALLOWED_ORIGIN || '*' }
});

io.on('connection', (socket) => {
  socket.on('join-project', (projectId) => {
    if (typeof projectId === 'string' && projectId.length <= 36) {
      socket.join(projectId);
    }
  });
});

// ── Rate limiter ─────────────────────────────────────────────────────────────

const loginAttempts = new Map();

function adminRateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX_ATTEMPTS = 10;
  let record = loginAttempts.get(ip);
  if (!record || now > record.resetAt) {
    record = { count: 0, resetAt: now + WINDOW_MS };
    loginAttempts.set(ip, record);
  }
  if (record.count >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }
  req.loginRecord = record;
  next();
}

function safeCompare(a, b) {
  const aHash = crypto.createHash('sha256').update(Buffer.from(a)).digest();
  const bHash = crypto.createHash('sha256').update(Buffer.from(b)).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

// ── Utilities ────────────────────────────────────────────────────────────────

const YOUTUBE_URL_RE = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?.*v=|embed\/|v\/)|youtu\.be\/)\S+/;
const VALID_FPS = new Set([23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60]);

function secondsToTimecode(seconds, fps) {
  const isDropFrame = fps === 29.97 || fps === 59.94;
  const sep = isDropFrame ? ';' : ':';
  const nominalFps = Math.round(fps);
  const totalFrames = Math.round(seconds * fps);
  const f = totalFrames % nominalFps;
  const s = Math.floor(totalFrames / nominalFps) % 60;
  const m = Math.floor(totalFrames / (nominalFps * 60)) % 60;
  const h = Math.floor(totalFrames / (nominalFps * 3600));
  const pad = n => String(Math.floor(n)).padStart(2, '0');
  return `${pad(h)}${sep}${pad(m)}${sep}${pad(s)}${sep}${pad(f)}`;
}

function csvEscape(str) {
  return '"' + String(str).replace(/"/g, '""') + '"';
}

// ── Database ─────────────────────────────────────────────────────────────────

const db = new sqlite3.Database('./data/annotations.db', (err) => {
  if (err) { console.error('Error opening database:', err.message); process.exit(1); }
  console.log('Connected to SQLite database');
  initDatabase(() => {
    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Admin panel: http://localhost:${PORT}/admin`);
      if (!process.env.ADMIN_PASSWORD) {
        console.warn('WARNING: ADMIN_PASSWORD not set. Default password: CHANGE_ME');
      }
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

    // Migrations for existing databases
    runMigration(`ALTER TABLE projects ADD COLUMN title TEXT`, 'projects.title');
    runMigration(`ALTER TABLE projects ADD COLUMN description TEXT`, 'projects.description');
    runMigration(`ALTER TABLE projects ADD COLUMN tags_config TEXT`, 'projects.tags_config');
    runMigration(`ALTER TABLE projects ADD COLUMN password_hash TEXT`, 'projects.password_hash');
    runMigration(`ALTER TABLE annotations ADD COLUMN status INTEGER DEFAULT 0`, 'annotations.status');
    runMigration(`ALTER TABLE annotations ADD COLUMN parent_id TEXT`, 'annotations.parent_id');
    runMigration(`ALTER TABLE annotations ADD COLUMN tags TEXT`, 'annotations.tags');
    runMigration(`ALTER TABLE annotations ADD COLUMN edit_token TEXT`, 'annotations.edit_token');

    // Wait for last migration before signalling ready
    db.run(`SELECT 1`, () => {
      console.log('Database initialized');
      if (callback) callback();
    });
  });
}

function checkAdminAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Admin routes ─────────────────────────────────────────────────────────────

app.post('/api/admin/login', adminRateLimit, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  const adminPassword = process.env.ADMIN_PASSWORD || 'CHANGE_ME';
  if (safeCompare(password, adminPassword)) {
    req.loginRecord.count = 0;
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    req.loginRecord.count++;
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
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
        res.json({ success: true });
      });
    });
  });
});

// ── Project routes ───────────────────────────────────────────────────────────

app.post('/api/projects', (req, res) => {
  const { youtube_url, title, description, tags_config } = req.body;

  if (!youtube_url) return res.status(400).json({ error: 'YouTube URL is required' });
  if (youtube_url.length > 2048) return res.status(400).json({ error: 'URL too long' });
  if (!YOUTUBE_URL_RE.test(youtube_url)) return res.status(400).json({ error: 'Invalid YouTube URL' });
  if (title && title.length > 100) return res.status(400).json({ error: 'Title too long (max 100)' });
  if (description && description.length > 500) return res.status(400).json({ error: 'Description too long (max 500)' });

  // Validate and normalise tags_config as a JSON array of strings
  let tagsJson = null;
  if (tags_config) {
    const tags = tags_config.split(',').map(t => t.trim()).filter(Boolean).slice(0, 8);
    tagsJson = JSON.stringify(tags);
  }

  const projectId = uuidv4();

  db.run(
    'INSERT INTO projects (id, youtube_url, title, description, tags_config) VALUES (?, ?, ?, ?, ?)',
    [projectId, youtube_url, title || null, description || null, tagsJson],
    function(err) {
      if (err) { console.error(err); return res.status(500).json({ error: 'Failed to create project' }); }
      res.json({
        project_id: projectId,
        share_url: `${req.protocol}://${req.get('host')}/project/${projectId}`
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
  const { author, text, timecode, parent_id, tags } = req.body;

  if (!author || !text || timecode === undefined) {
    return res.status(400).json({ error: 'Author, text, and timecode are required' });
  }
  if (author.length > 100) return res.status(400).json({ error: 'Author name too long (max 100)' });
  if (text.length > 2000) return res.status(400).json({ error: 'Comment too long (max 2000)' });

  const tagsJson = Array.isArray(tags) && tags.length ? JSON.stringify(tags) : null;
  const annotationId = uuidv4();
  const editToken = uuidv4();

  db.run(
    'INSERT INTO annotations (id, project_id, parent_id, author, text, timecode, status, tags, edit_token) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
    [annotationId, id, parent_id || null, author, text, timecode, tagsJson, editToken],
    function(err) {
      if (err) { console.error(err); return res.status(500).json({ error: 'Failed to add annotation' }); }

      const annotation = {
        id: annotationId, project_id: id, parent_id: parent_id || null,
        author, text, timecode, status: 0, tags: tagsJson,
        created_at: new Date().toISOString()
      };

      io.to(id).emit('annotation:created', annotation);
      res.json({ ...annotation, edit_token: editToken });
    }
  );
});

app.delete('/api/annotations/:id', (req, res) => {
  const { id } = req.params;
  const { edit_token } = req.body;

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
      db.serialize(() => {
        db.run('DELETE FROM annotations WHERE parent_id = ?', [id]);
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

  if (status === undefined || ![0, 1, 2].includes(status)) {
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
  db.run('UPDATE annotations SET status = ? WHERE id = ?', [resolved ? 1 : 0, id], function(err) {
    if (err) { console.error(err); return res.status(500).json({ error: 'Failed to update' }); }
    if (this.changes === 0) return res.status(404).json({ error: 'Annotation not found' });
    res.json({ id, resolved: resolved ? 1 : 0 });
  });
});

// ── Export routes ────────────────────────────────────────────────────────────

app.get('/api/projects/:id/export/premiere', (req, res) => {
  const { id } = req.params;
  const fps = parseFloat(req.query.fps) || 24;

  if (!VALID_FPS.has(fps)) return res.status(400).json({ error: 'Unsupported FPS value' });

  db.get('SELECT id, title FROM projects WHERE id = ?', [id], (err, project) => {
    if (err || !project) return res.status(404).json({ error: 'Project not found' });

    db.all(
      'SELECT author, text, timecode, status FROM annotations WHERE project_id = ? AND parent_id IS NULL ORDER BY timecode ASC',
      [id],
      (err, annotations) => {
        if (err) return res.status(500).json({ error: 'Database error' });

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

process.on('SIGINT', () => {
  db.close((err) => {
    if (err) console.error(err.message);
    console.log('Database connection closed');
    process.exit(0);
  });
});
