# 🎬 Open Frame Annotator

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js-v20.17+-green)](https://nodejs.org/)
[![Docker image](https://github.com/YoYoZ/OFA/actions/workflows/docker.yml/badge.svg)](https://github.com/YoYoZ/OFA/actions/workflows/docker.yml)

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

- **Docker with the Compose plugin** (recommended)  
  or **Node.js 20.17+** for a bare-metal run

### Option 1: Docker Compose (Recommended)

```bash
git clone https://github.com/YoYoZ/OFA.git
cd OFA

cp .env.example .env        # optional — every setting has a sensible default
docker compose up -d --build
docker compose logs         # shows the admin password if you did not set one
```

Access at: **http://localhost:3000**

All state (SQLite database + generated secrets) lives in `./data` on the host — back up that folder and you have backed up everything.

If `ADMIN_PASSWORD` is empty, a random password is generated on first start, printed in the logs and saved to `data/admin_password.txt`.

### Option 2: Prebuilt image (no build on the server)

Every push to `master` publishes a multi-arch image (amd64 + arm64) to GitHub Container Registry:

```bash
docker run -d --name ofa --restart unless-stopped \
  -p 3000:3000 \
  -v "$PWD/data:/app/data" \
  -e ADMIN_PASSWORD=your_secure_password \
  ghcr.io/yoyoz/ofa:latest
```

### Option 3: Node.js

```bash
git clone https://github.com/YoYoZ/OFA.git
cd OFA

npm ci
cp .env.example .env   # then edit ADMIN_PASSWORD

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
2. Enter the password from your `.env` file (or the generated one from the logs / `data/admin_password.txt`)
3. View total project and comment counts, list all projects, and delete any project (cascades to all comments; open viewers are notified)

Session lasts **24 hours** and survives server restarts.

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
├── data/                # Runtime state (gitignored, auto-created)
│   ├── annotations.db   # SQLite database: projects, comments, admin sessions
│   ├── .session_secret  # generated if SESSION_SECRET is not set
│   └── admin_password.txt # generated if ADMIN_PASSWORD is not set
├── .env.example         # Configuration template (copy to .env)
├── Dockerfile
├── docker-entrypoint.sh
├── docker-compose.yml
├── FULL-RESET.sh        # Wipes data and rebuilds the container from scratch
├── package.json
├── package-lock.json
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

Accepted URL formats: `youtube.com/watch?v=`, `youtu.be/`, `m.youtube.com`, `/embed/`, `/shorts/`, `/live/`. The URL is stored in canonical `https://www.youtube.com/watch?v=ID` form.

### Annotations

**Add annotation (or reply)**
```http
POST /api/projects/:id/annotations
Content-Type: application/json

{
  "author": "Alice",
  "text": "Colour grade feels warm here",
  "timecode": 42.5,
  "tags": ["color"],         // only tags configured on the project are kept
  "parent_id": null         // omit or null for root; UUID of a root comment for a reply
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
Marker Name,Description,In,Out,Duration,Marker Type
...
```

`fps` accepts: `23.976`, `24`, `25`, `29.97`, `30`, `48`, `50`, `59.94`, `60`. For `29.97` and `59.94` timecodes use SMPTE drop-frame (`HH:MM:SS;FF`).

Replies don't need a `timecode` — they inherit the parent's. Only one level of threading is allowed.

**Health check**
```http
GET /healthz   → 200 { "status": "ok" }
```

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
| `thread:deleted` | `{ parentId }` | a root comment (and its replies) was deleted |
| `annotation:status` | `{ id, status }` | review status changed |
| `project:deleted` | `{ id }` | an admin deleted the project |

Clients deduplicate `annotation:created` events to avoid double-rendering their own submissions, re-join the room after a reconnect and re-fetch the project to catch up on anything missed while offline.

---

## 🔒 Security

### Edit Tokens

Comments can be deleted without user accounts using a one-time **edit token**. When an annotation is created, the server generates a UUID token and returns it **once** in the API response. The browser stores it in `localStorage` under `annotation_tokens`. The delete button only appears for comments whose token is present in the current browser's storage. The token is required in the DELETE request body.

Legacy annotations (created before tokens were introduced) have a `NULL` token and can be deleted freely — this preserves backwards compatibility.

### Admin Authentication

- Password compared with `crypto.timingSafeEqual` (prevents timing attacks)
- No hard-coded default password: if `ADMIN_PASSWORD` is unset (or left as `CHANGE_ME`), a random one is generated
- `express-session` with `httpOnly`, `SameSite=Lax` cookies, 24-hour TTL, stored in SQLite
- Cookies are marked `Secure` automatically when the request arrives over HTTPS (set `TRUST_PROXY` behind a reverse proxy)
- Rate limiter: 10 login attempts per 15 minutes per IP, in-memory

### Input Validation

- YouTube URL parsed and reduced to its video ID; a canonical URL is stored
- All user text HTML-escaped (including quotes) before rendering into markup or attributes
- Types and ranges of every field are checked server-side (timecode must be a finite number, tags must belong to the project, replies must target a root comment of the same project)
- `tags_config` limited to 8 unique tags, comma-parsed and serialised as JSON
- CORS is disabled unless `ALLOWED_ORIGIN` is set

### Production Checklist

- [ ] Set a strong `ADMIN_PASSWORD` in `.env` (or keep the generated one safe)
- [ ] Run behind HTTPS (nginx / Caddy + Let's Encrypt) and set `TRUST_PROXY=1` and `PUBLIC_URL`
- [ ] Back up the `data/` folder regularly
- [ ] Consider restricting `/admin` by IP in your reverse proxy

---

## ⚙️ Configuration

All settings are environment variables; put them in `.env` (see [`.env.example`](.env.example)). Everything is optional.

| Variable | Default | Description |
|---|---|---|
| `ADMIN_PASSWORD` | generated | Admin panel password. If empty, generated on first start, logged and saved to `data/admin_password.txt` |
| `SESSION_SECRET` | generated | Cookie signing secret. If empty, generated and saved to `data/.session_secret` |
| `PUBLIC_URL` | from request | Base URL for share links, e.g. `https://review.example.com` |
| `TRUST_PROXY` | off | Set behind a reverse proxy: `true`, a hop count (`1`) or IP/subnet list |
| `ALLOWED_ORIGIN` | off | Comma-separated origins allowed to call the API cross-origin |
| `PORT` | `3000` | Port the server listens on inside the container / process |
| `DATA_DIR` | `./data` | Where the database and generated secrets are stored |
| `OFA_PORT` | `3000` | Host port published by `docker compose` |

---

## 🚢 Deployment

### Docker on a VPS

```bash
ssh user@your-server
git clone https://github.com/YoYoZ/OFA.git
cd OFA
cp .env.example .env    # set ADMIN_PASSWORD, PUBLIC_URL, TRUST_PROXY=1
docker compose up -d --build
```

The container runs as an unprivileged user, has a built-in health check (`docker ps` shows `healthy`), shuts down gracefully on `docker compose down` and restarts automatically after a reboot.

**Update to the latest version**

```bash
git pull
docker compose up -d --build
```

Data in `./data` is kept; the database schema is migrated automatically on start.

**Backup**

```bash
docker compose stop && tar czf ofa-backup-$(date +%F).tgz data && docker compose start
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
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Without `Upgrade` / `Connection` headers, real-time collaboration will fall back to HTTP long-polling and may not work at all depending on your proxy settings. Set `TRUST_PROXY=1` in `.env` so the login rate limiter sees real client IPs and cookies get the `Secure` flag over HTTPS.

**Caddy** (automatic HTTPS, WebSockets work out of the box):

```
review.example.com {
    reverse_proxy localhost:3000
}
```

### PM2 (without Docker)

```bash
npm ci --omit=dev
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
npm ci
npm run dev   # starts with nodemon
```

---

## 📝 License

GNU Affero General Public License v3.0 — see [LICENSE](LICENSE).

If you modify this software and run it as a network service, you must make your source code available under the same license.

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
