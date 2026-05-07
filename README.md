# 🎬 Open Frame Annotator

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-v18+-green)](https://nodejs.org/)

**Open Frame Annotator** is an open-source tool for collaborative YouTube video annotation. Create a project from any YouTube video, invite your team to leave time-stamped comments, reply in threads, tag issues by category, and export everything to Premiere Pro markers or a printable PDF report.

Perfect for **video reviews**, **editorial feedback**, **client approvals**, and **team QA workflows**.

If it saves you time, [☕ buy me a coffee](https://base.monobank.ua/4QTZuQ2Q8UfjJF) — it keeps the project going.

---

## ✨ Features

| Feature | Details |
|---|---|
| 🎥 **YouTube Integration** | Paste any YouTube URL — public or unlisted — to embed the video |
| ⏱️ **Time-Stamped Comments** | Annotate at any timestamp; author name is free-text (no accounts needed) |
| 💬 **Threaded Replies** | Reply directly to any comment; threads collapse cleanly in the sidebar |
| 🏷️ **Custom Tags** | Define up to 8 colour-coded tags per project (e.g. *color*, *audio*, *pacing*) |
| ✅ **Review Status** | Mark each comment Accepted ✓, Rejected ✗, or leave it Pending ◯ |
| 📊 **Progress Indicator** | Live "X / Y reviewed" counter updates as you work through comments |
| 🎯 **Timeline Clustering** | Nearby markers merge into clusters; hover to expand individual items |
| ⚡ **Real-Time Collaboration** | All connected viewers see new comments and status changes instantly via WebSocket |
| ⌨️ **Keyboard Shortcuts** | Space, arrow keys, and `A` so you never have to leave the keyboard |
| 📄 **PDF Report** | One-click printable report with thumbnail, stats, and full comment table |
| 🎞️ **Premiere Pro CSV Export** | Download markers as CSV with frame-accurate timecodes; built-in import tutorial |
| 🔒 **Edit Tokens** | Delete-your-own-comment system without user accounts |
| 🛠️ **Admin Panel** | Password-protected panel for viewing stats and deleting projects |
| 🔊 **Audio Feedback** | Subtle sounds on accept and delete actions |
| 🌙 **Dark Theme** | Responsive dark UI, print-optimised report |
| 💾 **SQLite** | Zero external database — everything lives in a single file |

---

## 🚀 Quick Start

### Prerequisites

- **Docker + Docker Compose** (recommended)  
  or **Node.js 18+** for a bare-metal run

### Option 1: Docker (Recommended)

```bash
git clone https://github.com/YoYoZ/OFA.git
cd OFA

# Set your admin password (default is CHANGE_ME — change it)
echo "ADMIN_PASSWORD=your_secure_password" > .env

docker-compose up --build
```

`npm install` runs automatically inside the Docker build step — you do not need to run it manually.

Access at: **http://localhost:3000**

### Option 2: Node.js

```bash
git clone https://github.com/YoYoZ/OFA.git
cd OFA

npm install

echo "ADMIN_PASSWORD=your_secure_password" > .env

npm start
```

Access at: **http://localhost:3000**

---

## 📖 Usage

### 1. Create a Project

1. Open `http://localhost:3000`
2. Fill in:
   - **Project Title** *(required)* — shown in the header and PDF report
   - **YouTube URL** *(required)* — public or unlisted link
   - **Description** *(optional)* — a brief note for reviewers
   - **Custom Tags** *(optional)* — comma-separated list, max 8 (e.g. `color, audio, pacing, continuity`)
3. Click **Create Project**
4. Copy the unique share link and send it to your team

### 2. Annotate the Video

1. Open the project link
2. Play the video and pause at the moment you want to comment on
3. Enter your name and comment text
4. Optionally select one or more tags
5. Click **"Add at [timestamp]"**

Timeline marker colours:
- 🔴 **Red** — pending comment
- 🟢 **Green** — accepted comment
- 🟡 **Yellow** — cluster with mixed statuses

Click any marker to jump to that timestamp. Hover over a cluster to see individual entries.

### 3. Reply to Comments

Click **Reply** under any comment to open an inline reply form. Replies are threaded under the parent comment and carry the same timecode.

### 4. Review Comments

- **Accept** — click ✓ to mark a comment as accepted (plays a bell tone)
- **Reject** — click ✗ to mark as rejected
- **Delete** — click 🗑️ to delete (you can only delete comments you created in the current browser session; see [Edit Tokens](#-edit-tokens))

The progress bar shows **"X / Y reviewed"** (accepted + rejected out of total root comments).

### 5. Export

**PDF Report**  
Click **📄 Report** in the top bar. The report page shows the video thumbnail, project metadata, stats summary, and a full comment table including replies. Use your browser's **Print → Save as PDF** to export.

**Premiere Pro CSV**  
Click **⬇ Export Markers**, choose the frame rate matching your Premiere sequence, and click **Download CSV**. Follow the built-in step-by-step tutorial to import into Adobe Premiere Pro or DaVinci Resolve.

### 6. Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `←` / `→` | Seek ±5 seconds |
| `Shift+←` / `Shift+→` | Seek ±10 seconds |
| `A` | Focus the comment text field |
| `Esc` | Close export modal / close open reply forms |

Shortcuts are disabled when focus is inside any text input.

### 7. Admin Panel

1. Go to `http://localhost:3000/admin`
2. Enter the password from your `.env` file
3. View total project and comment counts, list all projects, and delete any project (cascades to all comments)

Session lasts **24 hours**.

---

## 📁 Project Structure

```
OFA/
├── public/
│   ├── index.html       # Homepage — create new project
│   ├── project.html     # Annotation interface
│   ├── report.html      # Printable PDF report page
│   ├── admin.html       # Admin panel
│   ├── project.js       # All client-side logic
│   └── style.css        # Styles
├── server.js            # Express + Socket.io server and API routes
├── data/
│   └── annotations.db   # SQLite database (auto-created on first run)
├── .env                 # Environment variables (gitignored)
├── .gitignore
├── package.json
├── docker-compose.yml
└── README.md
```

---

## 🔌 API Reference

All routes use JSON unless otherwise noted.

### Projects

**Create project**
```http
POST /api/projects
Content-Type: application/json

{
  "youtube_url": "https://youtu.be/dQw4w9WgXcQ",
  "title": "Brand Ad — Cut 3",
  "description": "Final round of reviews before delivery",
  "tags_config": "color, audio, pacing, continuity"
}

→ 201
{
  "project_id": "uuid",
  "share_url": "http://localhost:3000/project/uuid"
}
```

**Get project + annotations**
```http
GET /api/projects/:id

→ 200
{
  "project": {
    "id": "uuid",
    "youtube_url": "...",
    "title": "...",
    "description": "...",
    "tags_config": "[\"color\",\"audio\"]",
    "created_at": "2025-10-29T12:00:00Z"
  },
  "annotations": [
    {
      "id": "uuid",
      "project_id": "uuid",
      "parent_id": null,
      "author": "Alice",
      "text": "Colour grade feels warm here",
      "timecode": 42.5,
      "status": 0,
      "tags": "[\"color\"]",
      "created_at": "..."
    }
  ]
}
```

`status`: `0` = pending, `1` = accepted, `2` = rejected  
`parent_id`: `null` for root comments, parent annotation UUID for replies

### Annotations

**Add annotation (or reply)**
```http
POST /api/projects/:id/annotations
Content-Type: application/json

{
  "author": "Alice",
  "text": "Colour grade feels warm here",
  "timecode": 42.5,
  "tags": ["color"],
  "parent_id": null         // omit or null for root; UUID for reply
}

→ 201
{
  "id": "uuid",
  "edit_token": "uuid"      // store this — required to delete the annotation later
}
```

**Set review status**
```http
PATCH /api/annotations/:id/status
Content-Type: application/json

{ "status": 1 }   // 0 = pending, 1 = accepted, 2 = rejected
```

**Delete annotation**
```http
DELETE /api/annotations/:id
Content-Type: application/json

{ "edit_token": "uuid" }   // the token returned when the annotation was created
```

Deleting a root annotation automatically deletes all its replies. The server emits `thread:deleted` (root) or `annotation:deleted` (reply) via WebSocket to all connected clients.

**Export markers (Premiere Pro CSV)**
```http
GET /api/projects/:id/export/premiere?fps=24

→ 200 text/csv
Name,Description,In,Out,Duration,Comment
...
```

`fps` accepts: `23.976`, `24`, `25`, `29.97`, `30`, `48`, `50`, `59.94`, `60`

### Admin (session-protected)

```http
POST /api/admin/login        { "password": "..." }
GET  /api/admin/projects     → { projects: [...], totalAnnotations: N }
DELETE /api/admin/projects/:id
POST /api/admin/logout
```

Login is rate-limited to **10 attempts per 15 minutes** per IP.

---

## ⚡ Real-Time Collaboration

Socket.io (v4) handles live updates. Every client joins a room keyed to the project UUID on page load. The server broadcasts to the room on every write:

| Event | Payload | Trigger |
|---|---|---|
| `annotation:created` | full annotation object | new comment or reply added |
| `annotation:deleted` | `{ id }` | a reply was deleted |
| `thread:deleted` | `{ id }` | a root comment (and its replies) was deleted |
| `annotation:status` | `{ id, status }` | review status changed |

Clients deduplicate `annotation:created` events to avoid double-rendering their own submissions.

---

## 🔒 Security

### Edit Tokens

Comments can be deleted without user accounts using a one-time **edit token**. When an annotation is created, the server generates a UUID token and returns it **once** in the API response. The browser stores it in `localStorage` under `annotation_tokens`. The delete button only appears for comments whose token is present in the current browser's storage. The token is required in the DELETE request body.

Legacy annotations (created before tokens were introduced) have a `NULL` token and can be deleted freely — this preserves backwards compatibility.

### Admin Authentication

- Password compared with `crypto.timingSafeEqual` (prevents timing attacks)
- `express-session` with `httpOnly` cookies, 24-hour TTL
- Rate limiter: 10 login attempts per 15 minutes per IP, in-memory

### Input Validation

- YouTube URL validated against a strict regex before storing
- All user text HTML-escaped before rendering (no `innerHTML` with raw data)
- `tags_config` limited to 8 tags, comma-parsed and serialised as JSON

### Production Checklist

- [ ] Set a strong `ADMIN_PASSWORD` and `SESSION_SECRET` in `.env`
- [ ] Run behind HTTPS (nginx + Let's Encrypt)
- [ ] Enable `cookie.secure: true` in `server.js` when behind HTTPS
- [ ] Consider restricting `/admin` by IP in nginx

---

## ⚙️ Configuration

**`.env` file**

```env
# Required — admin panel password (default: CHANGE_ME)
ADMIN_PASSWORD=your_secure_password

# Optional — session signing secret (auto-generated if absent)
SESSION_SECRET=a_long_random_string

# Optional — port (default: 3000)
PORT=3000
```

---

## 🚢 Deployment

### Docker on a VPS

```bash
ssh user@your-server
git clone https://github.com/YoYoZ/OFA.git
cd OFA
echo "ADMIN_PASSWORD=your_password" > .env
docker-compose up -d --build
```

### Nginx Reverse Proxy

Socket.io requires WebSocket upgrade headers. Make sure your nginx config includes them:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Without `Upgrade` / `Connection` headers, real-time collaboration will fall back to HTTP long-polling and may not work at all depending on your proxy settings.

### PM2 (without Docker)

```bash
npm install
npm install -g pm2
pm2 start server.js --name ofa
pm2 save
pm2 startup
```

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m 'Add my feature'`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a Pull Request

**Development setup:**

```bash
git clone https://github.com/YoYoZ/OFA.git
cd OFA
npm install
npm run dev   # starts with nodemon
```

---

## 📝 License

MIT — see [LICENSE](LICENSE).

---

## 💬 Support

- **Issues**: [GitHub Issues](https://github.com/YoYoZ/OFA/issues)
- **Discussions**: [GitHub Discussions](https://github.com/YoYoZ/OFA/discussions)
- **Email**: yoyoza5@gmail.com

---

## 🙏 Acknowledgments

- [Express.js](https://expressjs.com/) — web framework
- [Socket.io](https://socket.io/) — real-time WebSocket layer
- [SQLite3](https://www.sqlite.org/) — embedded database
- [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference) — video player
- [express-session](https://github.com/expressjs/session) — admin session management

---

**Made with ❤️ by the Open Source Community**

⭐ If you like this project, please give it a star on GitHub!
