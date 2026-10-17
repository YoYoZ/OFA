# 🎬 Open Frame Annotator

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js-v20.17+-green)](https://nodejs.org/)
[![Docker image](https://github.com/YoYoZ/OFA/actions/workflows/docker.yml/badge.svg)](https://github.com/YoYoZ/OFA/actions/workflows/docker.yml)

**Open Frame Annotator** is an open-source tool for collaborative YouTube video review. Create a project from any YouTube video, share a link with your team, collect time-stamped comments and ranges, work through them as the editor, and take the result straight into DaVinci Resolve or Premiere Pro — or print a PDF report with frames.

Perfect for **video reviews**, **editorial feedback**, **client approvals**, and **team QA workflows**.

If it saves you time, [☕ buy me a coffee](https://base.monobank.ua/4QTZuQ2Q8UfjJF) — it keeps the project going.

---

## ✨ Features

| Feature | Details |
|---|---|
| 🎥 **YouTube Integration** | Any public or unlisted video — watch, youtu.be, shorts, live and mobile links |
| 🎞️ **Versions** | Every new cut is a version of the same project; open comments carry over, old cuts stay browsable |
| ⏱️ **Comments & Ranges** | Comment on a moment or on a range (`I` / `O`); the video pauses as soon as you start typing |
| 💬 **Threaded Replies** | Reply to any comment; edit or delete your own comments and replies |
| 🏷️ **Custom Tags** | Up to 8 colour-coded tags per project, editable later |
| 👥 **Reviewer & Editor Links** | Reviewers comment; the editor link also accepts/rejects, moderates and changes settings |
| ✅ **Review Workflow** | Pending → In progress → Accepted / Rejected, with who changed it and when |
| 🔎 **Filters & Bulk Actions** | Filter by status, tag, author or text; change status or delete many comments at once |
| 🖼️ **Frames** | Automatic preview frames from YouTube's storyboard, or attach the exact frame (tab capture) |
| 🎞️ **NLE Export** | DaVinci Resolve markers (EDL, coloured), Premiere Pro markers (FCP XML), on-screen subtitles (SRT), CSV |
| 📄 **PDF Report** | Printable report with frames, stats and replies; filter what goes in |
| ⚡ **Real-Time Collaboration** | Everyone sees new comments, edits and status changes instantly; reconnects catch up automatically |
| ⌨️ **Keyboard-First** | Enter to send, J/K/L shuttle, frame stepping, N/P to walk through comments, 1/2/3 to set status |
| 💾 **Browser Backup** | Every project you open is kept in your browser; export/import it, restore deleted projects |
| 🛠️ **Admin Panel** | Password change, project search, pinning, editor-link revocation, auto-cleanup, DB backup |
| 🧹 **Auto-Cleanup** | Optionally delete projects after N days without activity, with a warning banner before |
| 🗄️ **SQLite** | No external database — one folder holds everything |

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

### 1. Create a project

1. Open `http://localhost:3000`
2. Fill in the title, the YouTube URL and optionally a description and tags (comma-separated, max 8)
3. Click **Create Project**. You get two links:
   - **Reviewer link** — send it to everyone who should comment
   - **Editor link** — keep it for yourself: it can accept/reject comments, delete any comment and change project settings

The editor link carries a key after `#key=`. **The link alone decides the role**: the same browser opening the plain link is a reviewer, the `#key=` link is the editor — regardless of what was opened before or whether you are logged in as admin. Bookmark the editor link; both links are always available from **🔗 Share** (editor only) and the admin panel.

Projects created before roles existed stay open: anyone can change statuses, nobody can moderate. The admin can lock such a project by creating an editor link for it.

### 2. Comment

1. Enter your name once (it is remembered)
2. Start typing — the video pauses and the comment is pinned to that moment
3. Press **Enter** to send (**Shift+Enter** for a new line)

For a **range**, press `I` at the start and `O` at the end, then write the comment. Ranges show as bars on the timeline and become duration markers / subtitle lengths in exports.

**Frames.** Every comment automatically gets an approximate preview frame from YouTube's storyboard (the seek-bar thumbnails, 320×180, every ~2 s). For the exact frame, click **📷 Attach frame** (or press `S`) and choose **This tab** in the browser dialog: new comments then carry a screenshot of the player. Works best in Chrome/Edge (Region Capture crops exactly to the player); other browsers crop from the whole tab. Your own existing comments get a 📷 button to attach a frame later.

### 3. Review (editor)

- **◔ In work / ✓ Accept / ✗ Reject** on every comment; clicking the active status resets it to pending. The status line shows who changed it and when.
- Filter by status, tag, author or text; sort by timecode or newest.
- Tick comments and use the bulk bar to change the status of many at once or delete them.
- **⚙ Settings** changes the title, description and tags.

### 4. New cut → new version

When the edit changes, don't create a new project — add a version: **＋ New version** next to the *Cut* selector (editor only).

1. Paste the YouTube link of the new cut, optionally a name (*Colour pass*, *Client round 2*) and what changed — reviewers see it under the title.
2. Keep **Carry over open comments** ticked: pending and in-progress comments (with their replies) are copied into the new version, marked **↻ from v1**. Accepted and rejected ones stay in the old cut. The authors can still edit or delete their carried comments.
3. Everyone viewing the project gets the new cut live. Reviewer and editor links always open the latest version; older ones are a click away in the *Cut* selector (or `?v=1` in the address) with a banner pointing to the latest.

Timecodes of carried comments are the old ones — if the edit moved things, open the comment's **✏️ → ⏱ Move here**. Exports and the PDF report are per version (`…-v2.edl`). **✎** renames a version, edits its notes or deletes it together with its comments.

### 5. Export to your NLE

Click **⬇ Export** and choose:

| Format | Where | What you get |
|---|---|---|
| **EDL** | DaVinci Resolve — Media Pool → right-click the timeline → *Timelines → Import → Timeline Markers from EDL…* | Markers coloured by status (or first tag), ranges as duration markers |
| **FCP XML** | Premiere Pro — *File → Import* | A sequence carrying all comments as markers; drop the reviewed cut into it |
| **SRT** | Premiere Pro and Resolve | A subtitle/caption track: the comments appear right over the picture |
| **CSV** | Excel / Google Sheets | Timecodes, authors, comments, tags, status and replies |

Set the **frame rate** and **start timecode** of your timeline (Resolve timelines start at `01:00:00:00` by default, Premiere at `00:00:00:00`). 29.97 and 59.94 use SMPTE drop-frame timecode. You can restrict the export to certain statuses — e.g. only what is still to do.

### 6. PDF report

**📄 Report** opens a printable page with the video cover, stats and every comment with its frame, tags, status and replies. Choose which statuses to include, whether to show replies and the frame size, then **Print → Save as PDF**. Frames are marked as *exact* (attached screenshot) or *approx.* (storyboard).

### 7. Keyboard shortcuts

Press `?` on the project page for the full list.

| Key | Action |
|---|---|
| `Space` / `K` | Play / pause |
| `J` / `L` | Slower or back 5 s / play, faster (1× → 1.5× → 2×) |
| `←` / `→` | Seek ±5 s (`Shift` ±10 s) |
| `,` / `.` | Step one frame back / forward |
| `A` / `C` | Focus the comment field |
| `Enter` / `Shift+Enter` | Send / new line (comment, reply and edit fields) |
| `I` / `O` / `X` | Range in / out / clear |
| `S` | Toggle “Attach frame” |
| `N` / `P` | Next / previous comment (seeks the video) |
| `R` / `E` | Reply to / edit the selected comment |
| `1` `2` `3` `0` | Accept / reject / in progress / pending (editor) |
| `Del` | Delete the selected comment |
| `/` | Search comments |
| `Esc` | Close dialogs, cancel editing, clear selection |

Shortcuts use physical key positions, so they also work with Cyrillic and other keyboard layouts.

### 8. Your browser backup

Every project you open is stored in your browser (IndexedDB): the project, all its comments, your editor key and the tokens of your own comments. The start page lists them under **My projects**.

- **Export backup / Import backup** moves everything to another browser or computer as a JSON file.
- If a project was deleted on the server (e.g. by auto-cleanup), its page and the list offer **Restore** — the project is recreated at the same address with all comments, and you become its editor.

### 9. Admin panel

Open `/admin` and log in with the password from `.env` (or the generated one from the logs / `data/admin_password.txt`).

- **Projects** — search, sort, see open comments and last activity, pin projects, copy reviewer/editor links, revoke an editor link (♻️), delete one or many
- **Auto-cleanup** — delete projects after 30 days … 2 years (or a custom number) without activity; a preview shows what would be deleted and what is inside the warning window; viewers see a banner before expiry; pinned projects are never deleted. Runs every 6 hours.
- **Admin password** — change it in the panel (stored as a scrypt hash; other sessions are logged out). Forgot it? `npm run reset-admin-password` (Docker: `docker compose exec -u node ofa npm run reset-admin-password`) brings back `ADMIN_PASSWORD` / the generated password.
- **Backup** — download a consistent copy of the database

An admin login gives no extra rights inside projects — to moderate one, open its editor link (🔑 in the project list). Sessions last 24 hours and survive restarts.

**Single sign-on (optional).** If OFA runs behind a reverse proxy that already authenticates users (Authelia, oauth2-proxy, Authentik, a custom `auth_request` gate…), set `ADMIN_AUTH_HEADER` to the header the proxy fills with the user name (e.g. `X-Forwarded-User`). The admin panel then opens without the OFA password for those users; `ADMIN_AUTH_USERS` limits it to certain names, `ADMIN_LOGOUT_URL` points the Logout button at the proxy. The password login keeps working next to it. **Only enable this if clients cannot reach OFA except through that proxy and the proxy overwrites the header on every request** — otherwise anyone could send it. Example for nginx:

```nginx
location ~ ^/(admin|api/admin/) {
    auth_request /_auth;                                  # your auth endpoint
    auth_request_set $user $upstream_http_x_auth_user;
    proxy_set_header X-Forwarded-User $user;              # set by nginx, never by the client
    proxy_pass http://127.0.0.1:3000;
}
location / {
    proxy_set_header X-Forwarded-User "";                 # strip it everywhere else
    proxy_pass http://127.0.0.1:3000;
}
```

---

## 📁 Project Structure

```
OFA/
├── public/
│   ├── index.html       # Start page — create project, my projects, backup
│   ├── project.html     # Review interface
│   ├── project.js       # Review logic (player, comments, hotkeys, frames, export dialog)
│   ├── common.js        # Shared helpers: API, storyboard frames, browser backup
│   ├── report.html      # Printable PDF report
│   ├── admin.html       # Admin panel
│   └── style.css
├── lib/
│   ├── exporters.js     # CSV / SRT / EDL / FCP XML builders
│   ├── timecode.js      # SMPTE timecode maths (incl. drop-frame)
│   └── youtube.js       # Link parsing and storyboard lookup
├── scripts/
│   └── reset-admin-password.js
├── test/                # node:test suite (npm test)
├── server.js            # Express + Socket.io server and API routes
├── data/                # Runtime state (gitignored, auto-created)
│   ├── annotations.db   # SQLite: projects, comments, sessions, settings
│   ├── screenshots/     # Attached frames
│   ├── .session_secret  # generated if SESSION_SECRET is not set
│   └── admin_password.txt # generated if ADMIN_PASSWORD is not set
├── .env.example
├── Dockerfile, docker-entrypoint.sh, docker-compose.yml
└── FULL-RESET.sh        # Wipes data and rebuilds the container from scratch
```

---

## 🔌 API Reference

JSON everywhere unless noted. Editor-only calls need the header `X-Editor-Key: <editor token>`. Your own comments are identified by the `edit_token` returned on creation (body field `edit_token` or header `X-Edit-Token`).

### Projects

| Method & path | Who | Notes |
|---|---|---|
| `POST /api/projects` | anyone | `{ youtube_url, title?, description?, tags_config? }` → `201 { project_id, editor_token, share_url, editor_url }` |
| `GET /api/projects/:id` | anyone | `{ project, annotations, permissions: { review, moderate, admin }, retention }`; `project.editor_token` only for editors |
| `PATCH /api/projects/:id` | editor | `{ title?, description?, tags_config? }` |
| `GET /api/projects/:id/storyboard` | anyone | `{ duration, levels: [...] }` — YouTube storyboard sprite sheets for preview frames; `?version=` |
| `POST /api/projects/:id/versions` | editor | `{ youtube_url, label?, notes?, carry_over? (true), carry_statuses? ([0,3]), from_version_id? }` → `201 { version, annotations, carried }` |
| `PATCH /api/projects/:id/versions/:versionId` | editor | `{ label?, notes? }` |
| `DELETE /api/projects/:id/versions/:versionId` | editor | deletes the version and its comments; the last version cannot be deleted |
| `GET /api/projects/:id/export/:format` | anyone | `format`: `edl` · `xml` · `srt` · `csv`; query `fps`, `start` (`01:00:00:00`), `color` (`status`/`tag`), `statuses` (`0,3`) |
| `POST /api/projects/restore` | anyone | `{ project, versions?, annotations }` from a browser backup; `409` if the project exists |

`fps`: `23.976`, `24`, `25`, `29.97`, `30`, `48`, `50`, `59.94`, `60`. The old `GET /api/projects/:id/export/premiere` still returns CSV.

### Annotations

| Method & path | Who | Notes |
|---|---|---|
| `POST /api/projects/:id/annotations` | anyone | `{ author, text, timecode, timecode_end?, tags?, parent_id?, version_id? }` → `201` with `edit_token` (returned once — keep it). Without `version_id` the comment goes to the latest version |
| `PATCH /api/annotations/:id` | author | `{ text?, tags?, timecode?, timecode_end? }` |
| `DELETE /api/annotations/:id` | author or editor | deleting a root comment deletes its replies |
| `PATCH /api/annotations/:id/status` | editor | `{ status, by? }` — `0` pending, `3` in progress, `1` accepted, `2` rejected |
| `POST /api/projects/:id/annotations/bulk` | editor | `{ ids, action: "status", status, by? }` or `{ ids, action: "delete" }` |
| `POST /api/annotations/:id/screenshot` | author or editor | raw `image/jpeg` body, max 4 MB |
| `GET /api/annotations/:id/screenshot` | anyone | the attached frame |

Replies inherit the parent's timecode and version; only one level of threading. `GET /api/projects/:id` returns `versions` (oldest first) and every comment's `version_id`; carried comments have `carried_from` (the id they were copied from). Exports take `?version=` (default: latest).

### Admin (session cookie)

| Method & path | Notes |
|---|---|
| `POST /api/admin/login` / `POST /api/admin/logout` / `GET /api/admin/check` | login is rate-limited to 10 attempts / 15 min per IP |
| `POST /api/admin/password` | `{ current, next }` |
| `GET /api/admin/projects` | projects with counts, links, expiry; storage stats; settings |
| `PATCH /api/admin/projects/:id` | `{ pinned?, rotate_editor_token? }` |
| `DELETE /api/admin/projects/:id` · `POST /api/admin/projects/delete` | single / `{ ids }` |
| `GET` · `PUT /api/admin/settings` | `{ retention_days, retention_warn_days }` |
| `GET /api/admin/cleanup/preview` · `POST /api/admin/cleanup/run` | what would be deleted / delete now |
| `GET /api/admin/backup` | SQLite database file |

`GET /healthz` → `{ "status": "ok" }` for health checks.

---

## ⚡ Real-Time Collaboration

Socket.io (v4). Every client joins a room named after the project ID:

| Event | Payload | Trigger |
|---|---|---|
| `annotation:created` | annotation | new comment or reply |
| `annotation:updated` | annotation | edited, moved or frame attached |
| `annotation:status` | `{ id, status, status_by, status_at }` | status changed |
| `annotation:deleted` | `{ id }` | a reply was deleted |
| `thread:deleted` | `{ parentId }` | a root comment (and its replies) was deleted |
| `project:updated` | project | title, description or tags changed |
| `project:deleted` | `{ id }` | deleted by the admin or by auto-cleanup |
| `version:created` | `{ version, annotations }` | new cut added (with the carried comments) |
| `version:updated` / `version:deleted` | version / `{ id }` | version renamed or removed |

Clients re-join the room after a reconnect and re-fetch the project to catch up. Text being typed into reply/edit fields survives live updates.

---

## 🔒 Security

- **Roles without accounts:** reviewer link vs. editor link (random key per project, revocable by the admin). Editor keys and comment tokens are compared in constant time.
- **Admin:** no hard-coded default password (generated if unset); scrypt-hashed password once changed in the panel; `httpOnly`, `SameSite=Lax` session cookies stored in SQLite, `Secure` over HTTPS; login rate limiting.
- **Input validation:** YouTube URLs reduced to the video ID and stored canonically; types and ranges of all fields checked server-side; tags must belong to the project; replies must target a root comment of the same project; screenshots must be JPEG and ≤ 4 MB.
- **Output:** all user text HTML-escaped (including quotes) for markup and attributes; CORS disabled unless `ALLOWED_ORIGIN` is set.

### Production Checklist

- [ ] Set a strong `ADMIN_PASSWORD` in `.env` (or change the generated one in the admin panel)
- [ ] Run behind HTTPS (nginx / Caddy + Let's Encrypt) and set `TRUST_PROXY=1` and `PUBLIC_URL`
- [ ] Back up the `data/` folder regularly (database + attached frames)
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
| `OFA_PORT` | `3000` | Host port published by `docker compose` (e.g. `127.0.0.1:3000` behind a proxy) |
| `ADMIN_AUTH_HEADER` | off | Single sign-on for the admin panel: header with the user name set by your auth proxy (see *Admin panel*) |
| `ADMIN_AUTH_USERS` | anyone | Comma-separated user names allowed in via `ADMIN_AUTH_HEADER` |
| `ADMIN_LOGOUT_URL` | — | Where the admin Logout button sends single sign-on users |

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

Or download just the database from the admin panel without stopping anything. Attached frames live in `data/screenshots/`.

**Storyboard frames** are looked up from the server (`www.youtube.com`) and loaded by browsers from `i.ytimg.com`. If the server has no outbound internet access, comments simply show without preview frames.

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
npm test      # runs the test suite
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
