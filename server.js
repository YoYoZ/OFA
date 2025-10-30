const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const session = require('express-session');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-key-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./data/annotations.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database');
    initDatabase();
  }
});

function initDatabase() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      youtube_url TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      timecode REAL NOT NULL,
      status INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects (id)
    )`);

    db.run(`ALTER TABLE annotations ADD COLUMN status INTEGER DEFAULT 0`, (err) => {
      if (err && !err.message.includes('duplicate column')) {
        console.error('Migration error:', err);
      }
    });

    console.log('Database tables initialized');
  });
}

function checkAdminAuth(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  if (password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true });
  });
});

app.get('/api/admin/check', (req, res) => {
  if (req.session && req.session.isAdmin) {
    res.json({ authenticated: true });
  } else {
    res.json({ authenticated: false });
  }
});

app.get('/api/admin/projects', checkAdminAuth, (req, res) => {
  db.all(`
    SELECT 
      p.id,
      p.youtube_url,
      p.created_at,
      COUNT(a.id) as annotations_count
    FROM projects p
    LEFT JOIN annotations a ON p.id = a.project_id
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `, [], (err, projects) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database error' });
    }

    db.get('SELECT COUNT(*) as total FROM annotations', [], (err, result) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
      }

      res.json({
        projects: projects,
        totalAnnotations: result.total
      });
    });
  });
});

app.delete('/api/admin/projects/:id', checkAdminAuth, (req, res) => {
  const { id } = req.params;

  db.serialize(() => {
    db.run('DELETE FROM annotations WHERE project_id = ?', [id], function(err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to delete annotations' });
      }

      db.run('DELETE FROM projects WHERE id = ?', [id], function(err) {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Failed to delete project' });
        }

        if (this.changes === 0) {
          return res.status(404).json({ error: 'Project not found' });
        }

        res.json({ 
          success: true,
          message: 'Project and all annotations deleted'
        });
      });
    });
  });
});

app.post('/api/projects', (req, res) => {
  const { youtube_url } = req.body;

  if (!youtube_url) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  const projectId = uuidv4();

  db.run('INSERT INTO projects (id, youtube_url) VALUES (?, ?)', [projectId, youtube_url], function(err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create project' });
    }

    res.json({ 
      project_id: projectId,
      share_url: `${req.protocol}://${req.get('host')}/project/${projectId}`
    });
  });
});

app.get('/api/projects/:id', (req, res) => {
  const { id } = req.params;

  console.log('📦 Loading project:', id);

  db.get('SELECT * FROM projects WHERE id = ?', [id], (err, project) => {
    if (err) {
      console.error('DB Error:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!project) {
      console.error('❌ Project not found:', id);
      return res.status(404).json({ error: 'Project not found' });
    }

    console.log('✅ Project found:', project.id);

    db.all('SELECT * FROM annotations WHERE project_id = ? ORDER BY timecode ASC', [id], (err, annotations) => {
      if (err) {
        console.error('DB Error loading annotations:', err);
        return res.status(500).json({ error: 'Failed to load annotations' });
      }

      console.log(`✅ Loaded ${annotations.length} annotations`);

      res.json({
        project: project,
        annotations: annotations
      });
    });
  });
});

app.post('/api/projects/:id/annotations', (req, res) => {
  const { id } = req.params;
  const { author, text, timecode } = req.body;

  if (!author || !text || timecode === undefined) {
    return res.status(400).json({ error: 'Author, text, and timecode are required' });
  }

  const annotationId = uuidv4();

  db.run('INSERT INTO annotations (id, project_id, author, text, timecode, status) VALUES (?, ?, ?, ?, ?, 0)', 
    [annotationId, id, author, text, timecode], function(err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to add annotation' });
    }

    res.json({ 
      id: annotationId,
      project_id: id,
      author,
      text,
      timecode,
      status: 0,
      created_at: new Date().toISOString()
    });
  });
});

app.delete('/api/annotations/:id', (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM annotations WHERE id = ?', [id], function(err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to delete annotation' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Annotation not found' });
    }

    res.json({ 
      success: true,
      id: id
    });
  });
});

// NEW: Update annotation status (0=pending, 1=accepted, 2=rejected)
app.patch('/api/annotations/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (status === undefined || ![0, 1, 2].includes(status)) {
    return res.status(400).json({ error: 'Invalid status (0=pending, 1=accepted, 2=rejected)' });
  }

  db.run('UPDATE annotations SET status = ? WHERE id = ?', [status, id], function(err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update annotation' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Annotation not found' });
    }

    res.json({ 
      id: id,
      status: status
    });
  });
});

// LEGACY: Keep resolve endpoint for backward compatibility
app.patch('/api/annotations/:id/resolve', (req, res) => {
  const { id } = req.params;
  const { resolved } = req.body;

  if (resolved === undefined) {
    return res.status(400).json({ error: 'Resolved status is required' });
  }

  db.run('UPDATE annotations SET status = ? WHERE id = ?', [resolved ? 1 : 0, id], function(err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update annotation' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Annotation not found' });
    }

    res.json({ 
      id: id,
      resolved: resolved ? 1 : 0
    });
  });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/project/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'project.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`🛠️ Admin panel: http://localhost:${PORT}/admin`);
  console.log(`📚 API ready at http://localhost:${PORT}/api`);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('⚠️ WARNING: ADMIN_PASSWORD not set in .env file!');
  }
});

process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('Database connection closed');
    process.exit(0);
  });
});