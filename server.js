const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Database setup
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
    // Projects table
    db.run(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      youtube_url TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Annotations table with resolved field
    db.run(`CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      timecode REAL NOT NULL,
      resolved INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects (id)
    )`);

    // Add resolved column if it doesn't exist (for migration)
    db.run(`ALTER TABLE annotations ADD COLUMN resolved INTEGER DEFAULT 0`, (err) => {
      if (err && !err.message.includes('duplicate column')) {
        console.error('Migration error:', err);
      }
    });

    console.log('Database tables initialized');
  });
}

// API Routes

// Create new project
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

// Get project details
app.get('/api/projects/:id', (req, res) => {
  const { id } = req.params;

  db.get('SELECT * FROM projects WHERE id = ?', [id], (err, project) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Get annotations for this project
    db.all('SELECT * FROM annotations WHERE project_id = ? ORDER BY timecode ASC', [id], (err, annotations) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to load annotations' });
      }

      res.json({
        project: project,
        annotations: annotations
      });
    });
  });
});

// Add annotation
app.post('/api/projects/:id/annotations', (req, res) => {
  const { id } = req.params;
  const { author, text, timecode } = req.body;

  if (!author || !text || timecode === undefined) {
    return res.status(400).json({ error: 'Author, text, and timecode are required' });
  }

  const annotationId = uuidv4();

  db.run('INSERT INTO annotations (id, project_id, author, text, timecode, resolved) VALUES (?, ?, ?, ?, ?, 0)', 
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
      resolved: 0,
      created_at: new Date().toISOString()
    });
  });
});

// Delete annotation
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

// Toggle annotation resolved status
app.patch('/api/annotations/:id/resolve', (req, res) => {
  const { id } = req.params;
  const { resolved } = req.body;

  if (resolved === undefined) {
    return res.status(400).json({ error: 'Resolved status is required' });
  }

  db.run('UPDATE annotations SET resolved = ? WHERE id = ?', [resolved ? 1 : 0, id], function(err) {
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

// Serve project page (must be AFTER static middleware and API routes)
app.get('/project/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'project.html'));
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle 404
app.use((req, res) => {
  res.status(404).send('Page not found');
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('Database connection closed');
    process.exit(0);
  });
});