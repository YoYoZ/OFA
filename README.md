# 🎬 Open Frame Annotator

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-v18+-green)](https://nodejs.org/)

**Open Frame Annotator** is an open-source tool for collaborative YouTube video annotation. Create projects from YouTube videos, add time-stamped comments, mark them as resolved, and manage everything through a secure admin panel.

Perfect for **video reviews**, **tutorials**, **team feedback**, and **collaborative editing workflows**.

If it saves you time, [☕ buy me a coffee](https://base.monobank.ua/4QTZuQ2Q8UfjJF) — it keeps the project going.

---

## ✨ Features

- 🎥 **YouTube Integration**: Paste any YouTube URL to create a project with embedded player
- ⏱️ **Time-Stamped Annotations**: Add comments at specific video timestamps with author names
- ✅ **Resolved Status**: Mark comments as "Accepted" (green)
- 🎯 **Smart Timeline Clustering**: Multiple nearby annotations cluster together; hover to expand
- 🛠️ **Secure Admin Panel**: Password-protected admin interface to view/delete projects and statistics
- 🔊 **Audio Feedback**: Subtle bell sound for resolved comments, trash sound for deletions
- 🌙 **Dark Theme**: Responsive design, mobile-friendly interface
- 💾 **SQLite Database**: No external database required, everything stored locally

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ ([Download](https://nodejs.org/))
- **Docker** (optional, recommended for easy setup)
- **SQLite** (built-in, no installation needed)

### Installation

#### Option 1: Docker (Recommended)

```bash
# Clone the repository
git clone https://github.com/yoyoz/OFA.git
cd OFA

# Edit .env file with admin password
nano .env
Default password is CHANGE_ME

# Start with Docker
docker-compose up --build
```

Access at: **http://localhost:3000**

#### Option 2: Node.js

```bash
# Clone the repository
git clone https://github.com/yoyoz/OFA.git
cd OFA

# Install dependencies
npm install

# Create .env file
echo "ADMIN_PASSWORD=your_secure_password" > .env
Default password is CHANGE_ME

# Start the server
npm start
```

Access at: **http://localhost:3000**

---

## 📖 Usage

### 1. Create a Project

1. Go to the homepage: `http://localhost:3000`
2. Paste a YouTube URL (e.g., `https://youtu.be/dQw4w9WgXcQ`)
3. Click **"Create Project"**
4. Share the unique project link: `http://localhost:3000/project/{unique-id}`

### 2. Annotate the Video

1. Open the project link
2. Play the video and pause at the timestamp you want to comment on
3. Enter your name and comment text
4. Click **"Add at [timestamp]"** button
5. The timeline shows markers:
   - 🔴 **Red** = Unresolved comment
   - 🟢 **Green** = Accepted/Resolved comment
   - 🟡 **Yellow** = Mixed (cluster with both types)
6. Click markers to jump to that timestamp
7. Hover over clustered markers to expand them

### 3. Manage Comments

- **Delete**: Click 🗑️ button next to any comment
- **Accept/Resolve**: Click ✓ button to mark as accepted (plays bell sound 🔔)
- **Timeline Navigation**: Click any marker to seek to that timestamp

### 4. Admin Panel

1. Go to: `http://localhost:3000/admin`
2. Enter the password from your `.env` file
3. View:
   - **Total projects** and **total comments** statistics
   - **List of all projects** with YouTube URLs and comment counts
   - **Delete projects** (removes project + all comments)
4. Session lasts **24 hours**

---

## 📁 Project Structure

```
open-frame-annotator/
├── public/              # Static files served to browser
│   ├── index.html       # Homepage (create project)
│   ├── project.html     # Annotation interface
│   ├── admin.html       # Admin panel
│   ├── project.js       # Client-side logic
│   └── style.css        # Styles
├── server.js            # Express server + API routes
├── data/                # SQLite database folder
│   └── annotations.db   # Database file (auto-created)
├── .env                 # Environment variables (GITIGNORED!)
├── .gitignore           # Git ignore rules
├── package.json         # Node.js dependencies
├── docker-compose.yml   # Docker configuration
└── README.md            # This file
```

---

## 🔌 API Endpoints

All API routes are under `/api` and use JSON for requests/responses.

### Projects

**Create Project**
```http
POST /api/projects
Content-Type: application/json

{
  "youtube_url": "https://youtu.be/dQw4w9WgXcQ"
}

Response:
{
  "project_id": "uuid-here",
  "share_url": "http://localhost:3000/project/uuid-here"
}
```

**Get Project**
```http
GET /api/projects/:id

Response:
{
  "project": {
    "id": "uuid",
    "youtube_url": "...",
    "created_at": "2025-10-29T..."
  },
  "annotations": [...]
}
```

### Annotations

**Add Annotation**
```http
POST /api/projects/:id/annotations
Content-Type: application/json

{
  "author": "John Doe",
  "text": "Great transition here!",
  "timecode": 123.45
}
```

**Delete Annotation**
```http
DELETE /api/annotations/:id
```

**Toggle Resolved Status**
```http
PATCH /api/annotations/:id/resolve
Content-Type: application/json

{
  "resolved": 1  // 1 = resolved, 0 = unresolved
}
```

### Admin (Password-Protected)

**Login**
```http
POST /api/admin/login
Content-Type: application/json

{
  "password": "your_password"
}
```

**List Projects**
```http
GET /api/admin/projects

Response:
{
  "projects": [...],
  "totalAnnotations": 42
}
```

**Delete Project**
```http
DELETE /api/admin/projects/:id
```

**Logout**
```http
POST /api/admin/logout
```

---

## 🔒 Security

### Admin Authentication

- **Password Storage**: Admin password is stored in `.env` file (server-side only)
- **Session Management**: Uses `express-session` with httpOnly cookies
- **Session Duration**: 24 hours, configurable in `server.js`
- **Middleware Protection**: All admin routes are protected by `checkAdminAuth` middleware

### Best Practices

✅ **For Production:**
- Use HTTPS (nginx reverse proxy + Let's Encrypt)
- Set strong `SESSION_SECRET` in `.env`
- Enable `cookie.secure: true` for HTTPS-only cookies
- Add rate limiting for `/api/admin/login` route
- Restrict admin panel access by IP if possible

✅ **Data Validation:**
- Input sanitization in API routes
- HTML escaping in frontend
- SQLite foreign keys for data integrity

---

## ⚙️ Configuration

### Environment Variables (`.env`)

```env
# Required: Admin panel password (defaults to CHANGE_ME)
ADMIN_PASSWORD=your_secure_password_here

# Optional: Session secret (defaults to auto-generated)
SESSION_SECRET=your_session_secret_key

# Optional: Server port (defaults to 3000)
PORT=3000
```

### Customization

**Change Admin Password:**
```bash
# Edit .env file
ADMIN_PASSWORD=new_password

# Restart server
docker-compose restart
# or
npm start
```

**Adjust Session Duration:**
Edit `server.js`, line ~30:
```javascript
cookie: {
  maxAge: 24 * 60 * 60 * 1000, // 24 hours → change this
  httpOnly: true
}
```

**Modify Theme/Styles:**
Edit `public/style.css` to customize colors, fonts, layout.

**Adjust Sound Volumes:**
Edit `public/project.js`:
- Line ~33: `gainNode.gain.setValueAtTime(0.09, ...)` for bell volume
- Line ~50: `gainNode.gain.setValueAtTime(0.4, ...)` for trash sound volume

---

## 🚢 Deployment

### DigitalOcean / VPS

```bash
# SSH into server
ssh user@your-server

# Clone repo
git clone https://github.com/yoyoz/OFA.git
cd OFA

# Setup with Docker
echo "ADMIN_PASSWORD=your_password" > .env
docker-compose up -d

# Or with Node.js + PM2
npm install
npm install -g pm2
pm2 start server.js --name annotator
pm2 save
```

### Nginx Reverse Proxy (Production)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 🤝 Contributing

Contributions are welcome! Here's how:

1. **Fork** the repository
2. Create a **feature branch**: `git checkout -b feature/amazing-feature`
3. **Commit** your changes: `git commit -m 'Add amazing feature'`
4. **Push** to the branch: `git push origin feature/amazing-feature`
5. Open a **Pull Request**

### Development Setup

```bash
# Clone your fork
git clone https://github.com/YoYoZ/OFA

# Install dependencies
npm install

# Start in development mode (with nodemon)
npm run dev
```

---

## 📝 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

---

## 💬 Support

- **Issues**: [GitHub Issues](https://github.com/YoYoZ/OFA/issues)
- **Discussions**: [GitHub Discussions](https://github.com/YoYoZ/OFA/discussions)
- **Email**: yoyoza5@gmail.com

---

## 🙏 Acknowledgments

- Built with [Express.js](https://expressjs.com/)
- Powered by [SQLite](https://www.sqlite.org/)
- YouTube integration via [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference)
- Session management with [express-session](https://github.com/expressjs/session)

---

## 🗺️ Roadmap

- [ ] Add user authentication (multiple users, not just admin)
- [ ] Export annotations to CSV/JSON
- [ ] Annotation threading (replies to comments)
- [ ] Real-time collaboration (WebSockets)
- [ ] Video frame snapshots for annotations
- [ ] Dark/Light theme toggle
- [ ] i18n (multi-language support)
- [ ] Docker Compose with nginx
- [ ] Mobile app (React Native)

---

**Made with ❤️ by the Open Source Community**

⭐ If you like this project, please give it a star on GitHub!
