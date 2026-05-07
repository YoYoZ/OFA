const projectId = window.location.pathname.split('/').pop();

let player;
let projectData;
let annotations = [];
let tagsConfig = [];
let selectedTags = [];
let isYouTubeReady = false;
let isProjectLoaded = false;
let videoDuration = 0;
let playerInitAttempts = 0;
let timeUpdateInterval = null;
let socket = null;

const TAG_PALETTE = ['#64b5f6', '#52b788', '#ffd700', '#e74c3c', '#9b59b6', '#e67e22', '#1abc9c', '#e91e63'];

// ── Audio (single shared context) ────────────────────────────────────────────

let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playBellSound() {
  const ctx = getAudioContext();
  [800, 1000, 1200].forEach((freq, i) => {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq; osc.type = 'sine';
    const t = ctx.currentTime + i * 0.1;
    gain.gain.setValueAtTime(0.09, t);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.5);
    osc.start(t); osc.stop(t + 0.5);
  });
}

function playTrashSound() {
  const ctx = getAudioContext();
  const buf = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource(); noise.buffer = buf;
  const filter = ctx.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = 300; filter.Q.value = 5;
  const gain = ctx.createGain(); const now = ctx.currentTime;
  gain.gain.setValueAtTime(0.4, now); gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
  noise.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
  noise.start(now); noise.stop(now + 0.3);
}

function playRejectSound() {
  const ctx = getAudioContext();
  [300, 200].forEach((freq, i) => {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq; osc.type = 'sine';
    const t = ctx.currentTime + i * 0.15;
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.4);
    osc.start(t); osc.stop(t + 0.4);
  });
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-hide'), 2700);
  setTimeout(() => toast.remove(), 3000);
}

// ── Edit token storage ────────────────────────────────────────────────────────

function getAnnotationTokens() {
  try { return JSON.parse(localStorage.getItem('annotation_tokens') || '{}'); } catch { return {}; }
}
function saveAnnotationToken(id, token) {
  try { const t = getAnnotationTokens(); t[id] = token; localStorage.setItem('annotation_tokens', JSON.stringify(t)); } catch {}
}
function getAnnotationToken(id) { return getAnnotationTokens()[id] || null; }

// ── Tags ──────────────────────────────────────────────────────────────────────

function tagColor(tagName) {
  const idx = tagsConfig.indexOf(tagName);
  return TAG_PALETTE[(idx >= 0 ? idx : 0) % TAG_PALETTE.length];
}

function renderTagSelector() {
  const container = document.getElementById('tagSelector');
  if (!tagsConfig.length) { container.style.display = 'none'; return; }
  container.style.display = 'flex';
  container.innerHTML = tagsConfig.map(tag => `
    <button class="tag-chip" data-tag="${escapeHtml(tag)}"
            style="--tag-color:${tagColor(tag)}">
      ${escapeHtml(tag)}
    </button>
  `).join('');
  container.addEventListener('click', (e) => {
    const chip = e.target.closest('.tag-chip');
    if (!chip) return;
    const tag = chip.dataset.tag;
    const idx = selectedTags.indexOf(tag);
    if (idx >= 0) selectedTags.splice(idx, 1); else selectedTags.push(tag);
    chip.classList.toggle('active', selectedTags.includes(tag));
  });
}

function renderTagPills(tagsJson) {
  if (!tagsJson) return '';
  let tags;
  try { tags = JSON.parse(tagsJson); } catch { return ''; }
  if (!Array.isArray(tags) || !tags.length) return '';
  return `<div class="annotation-tags">${tags.map(t =>
    `<span class="tag-pill" style="background:${tagColor(t)}">${escapeHtml(t)}</span>`
  ).join('')}</div>`;
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const authorInput = document.getElementById('authorName');
  try { const saved = localStorage.getItem('author_name'); if (saved) authorInput.value = saved; } catch {}
  authorInput.addEventListener('input', (e) => { try { localStorage.setItem('author_name', e.target.value); } catch {} });
  authorInput.addEventListener('blur',  (e) => { try { localStorage.setItem('author_name', e.target.value); } catch {} });

  document.getElementById('addAnnotation').addEventListener('click', addAnnotation);

  // Delegated click handler for all annotation list actions
  document.getElementById('annotationsList').addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (actionEl) {
      const { action, id } = actionEl.dataset;
      if (action === 'delete')        deleteAnnotation(id);
      else if (action === 'accept')   updateAnnotationStatus(id, 1);
      else if (action === 'reject')   updateAnnotationStatus(id, 2);
      else if (action === 'reply')    toggleReplyForm(id);
      else if (action === 'send-reply')   submitReply(id);
      else if (action === 'cancel-reply') toggleReplyForm(id, false);
      return;
    }
    const tcEl = e.target.closest('[data-timecode]');
    if (tcEl) seekToTime(parseFloat(tcEl.dataset.timecode));
  });

  setupKeyboardShortcuts();
  loadProject();
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlayPause();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        seekRelative(e.shiftKey ? -10 : -5);
        break;
      case 'ArrowRight':
        e.preventDefault();
        seekRelative(e.shiftKey ? 10 : 5);
        break;
      case 'a':
      case 'A':
        document.getElementById('commentText').focus();
        break;
      case 'Escape':
        closeExportModal();
        document.querySelectorAll('.reply-form').forEach(f => f.style.display = 'none');
        break;
    }
  });
}

function togglePlayPause() {
  if (!player || !player.getPlayerState) return;
  try {
    player.getPlayerState() === YT.PlayerState.PLAYING
      ? player.pauseVideo()
      : player.playVideo();
  } catch {}
}

function seekRelative(delta) {
  if (!player || !player.getCurrentTime) return;
  try { player.seekTo(Math.max(0, player.getCurrentTime() + delta), true); } catch {}
}

// ── Project load ──────────────────────────────────────────────────────────────

async function loadProject() {
  try {
    const response = await fetch(`/api/projects/${projectId}`);
    if (!response.ok) throw new Error('Project not found');

    projectData = await response.json();
    annotations = projectData.annotations || [];
    tagsConfig = projectData.project.tags_config
      ? JSON.parse(projectData.project.tags_config) : [];
    isProjectLoaded = true;

    // Update page title and meta
    if (projectData.project.title) {
      document.title = `${projectData.project.title} — Open Frame Annotator`;
      document.getElementById('projectTitle').textContent = projectData.project.title;
      const metaEl = document.getElementById('projectMeta');
      metaEl.style.display = 'block';
      if (projectData.project.description) {
        document.getElementById('projectDescription').textContent = projectData.project.description;
      }
    }
    document.getElementById('reportLink').href = `/project/${projectId}/report`;

    renderTagSelector();
    updateAnnotationsList();
    updateTimeline();

    document.getElementById('loading').style.display = 'none';
    document.getElementById('project-content').style.display = 'block';

    connectSocket();
    tryInitializePlayer();
  } catch (error) {
    console.error('Error loading project:', error);
    document.getElementById('loading').textContent = 'Error: ' + error.message;
  }
}

// ── YouTube player ────────────────────────────────────────────────────────────

function onYouTubeIframeAPIReady() {
  isYouTubeReady = true;
  if (isProjectLoaded && projectData) initializePlayer();
}

function tryInitializePlayer() {
  playerInitAttempts++;
  if (typeof YT !== 'undefined' && typeof YT.Player === 'function') {
    isYouTubeReady = true;
    initializePlayer();
  } else if (playerInitAttempts < 20) {
    setTimeout(tryInitializePlayer, 200);
  } else {
    showToast('Failed to load YouTube player. Please refresh.', 'error');
  }
}

function initializePlayer() {
  if (player && typeof player.getPlayerState === 'function') return;
  if (!projectData?.project || !isYouTubeReady) return;

  const videoId = extractVideoId(projectData.project.youtube_url);
  if (!videoId) { document.getElementById('loading').textContent = 'Invalid YouTube link'; return; }

  try {
    document.getElementById('youtube-player').innerHTML = '';
    player = new YT.Player('youtube-player', {
      height: '100%', width: '100%', videoId,
      playerVars: { autoplay: 0, playsinline: 1, rel: 0, modestbranding: 1, origin: window.location.origin, enablejsapi: 1 },
      events: { onReady: onPlayerReady, onStateChange: onPlayerStateChange, onError: onPlayerError }
    });
  } catch (error) {
    showToast('Error creating player: ' + error.message, 'error');
  }
}

function onPlayerReady() {
  if (timeUpdateInterval) clearInterval(timeUpdateInterval);
  setTimeout(() => {
    try { videoDuration = player.getDuration(); if (videoDuration > 0) updateTimeline(); } catch {}
  }, 500);
  timeUpdateInterval = setInterval(updateCurrentTime, 1000);
}

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.BUFFERING) {
    try {
      const d = player.getDuration();
      if (d > 0 && d !== videoDuration) { videoDuration = d; updateTimeline(); }
    } catch {}
  }
}

function onPlayerError(event) {
  const messages = { 2: 'Invalid video ID.', 5: 'HTML5 player error.', 100: 'Video not found.', 101: 'Embedding disabled.', 150: 'Embedding disabled.' };
  showToast('Video error. ' + (messages[event.data] || ''), 'error');
}

function updateCurrentTime() {
  if (player && player.getCurrentTime) {
    try { document.getElementById('currentTime').textContent = formatTime(player.getCurrentTime()); } catch {}
  }
}

// ── Annotations CRUD ──────────────────────────────────────────────────────────

async function addAnnotation() {
  const author = document.getElementById('authorName').value.trim();
  const text   = document.getElementById('commentText').value.trim();
  if (!author || !text) { showToast('Please fill in your name and comment', 'error'); return; }
  if (!player?.getCurrentTime) { showToast('Player is not ready', 'error'); return; }

  let timecode;
  try { timecode = player.getCurrentTime(); } catch { showToast('Error getting current time', 'error'); return; }

  try { localStorage.setItem('author_name', author); } catch {}

  try {
    const response = await fetch(`/api/projects/${projectId}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author, text, timecode, tags: selectedTags.length ? selectedTags : undefined })
    });
    if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e.error || 'Error adding comment'); }

    const newAnnotation = await response.json();
    if (newAnnotation.edit_token) saveAnnotationToken(newAnnotation.id, newAnnotation.edit_token);

    annotations.push(newAnnotation);
    annotations.sort((a, b) => a.timecode - b.timecode);
    selectedTags = [];
    document.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('active'));
    document.getElementById('commentText').value = '';
    updateAnnotationsList();
    updateTimeline();
    showToast('Comment added', 'success');
  } catch (error) {
    showToast(error.message || 'Error adding comment', 'error');
  }
}

async function deleteAnnotation(annotationId) {
  if (!confirm('Delete this comment?')) return;
  const token = getAnnotationToken(annotationId);
  try {
    const response = await fetch(`/api/annotations/${annotationId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edit_token: token })
    });
    if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e.error || 'Error deleting'); }

    // Remove annotation and all its replies
    annotations = annotations.filter(a => a.id !== annotationId && a.parent_id !== annotationId);
    updateAnnotationsList();
    updateTimeline();
    playTrashSound();
    showToast('Comment deleted', 'info');
  } catch (error) {
    showToast(error.message || 'Error deleting comment', 'error');
  }
}

async function updateAnnotationStatus(annotationId, status) {
  const annotation = annotations.find(a => a.id === annotationId);
  if (!annotation) return;
  try {
    const response = await fetch(`/api/annotations/${annotationId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    if (!response.ok) throw new Error('Error updating status');
    annotation.status = status;
    updateAnnotationsList();
    updateTimeline();
    if (status === 1) playBellSound();
    else if (status === 2) playRejectSound();
  } catch (error) {
    showToast('Error updating comment status', 'error');
  }
}

// ── Threading ─────────────────────────────────────────────────────────────────

function toggleReplyForm(parentId, forceState) {
  const form = document.getElementById(`reply-form-${parentId}`);
  if (!form) return;
  const show = forceState !== undefined ? forceState : form.style.display === 'none';
  form.style.display = show ? 'block' : 'none';
  if (show) {
    try { form.querySelector('.reply-author').value = localStorage.getItem('author_name') || ''; } catch {}
    form.querySelector('.reply-text').focus();
  }
}

async function submitReply(parentId) {
  const form = document.getElementById(`reply-form-${parentId}`);
  if (!form) return;
  const author = form.querySelector('.reply-author').value.trim();
  const text   = form.querySelector('.reply-text').value.trim();
  if (!author || !text) { showToast('Please fill in your name and reply', 'error'); return; }

  const parent = annotations.find(a => a.id === parentId);
  if (!parent) return;

  try {
    try { localStorage.setItem('author_name', author); } catch {}
    const response = await fetch(`/api/projects/${projectId}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author, text, timecode: parent.timecode, parent_id: parentId })
    });
    if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e.error || 'Error adding reply'); }

    const newReply = await response.json();
    if (newReply.edit_token) saveAnnotationToken(newReply.id, newReply.edit_token);
    annotations.push(newReply);
    updateAnnotationsList();
    showToast('Reply added', 'success');
  } catch (error) {
    showToast(error.message || 'Error adding reply', 'error');
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function updateAnnotationsList() {
  const list  = document.getElementById('annotationsList');
  const roots = annotations.filter(a => !a.parent_id);
  const replies = (parentId) => annotations.filter(a => a.parent_id === parentId);

  // Progress indicator (counts root annotations only)
  document.getElementById('annotationsCount').textContent = roots.length;
  const reviewed = roots.filter(a => a.status === 1 || a.status === 2).length;
  const progressEl = document.getElementById('progressText');
  progressEl.textContent = roots.length > 0 ? `${reviewed} / ${roots.length} reviewed` : '';

  if (roots.length === 0) {
    list.innerHTML = '<p style="color:#9e9e9e;text-align:center;">No comments yet</p>';
    return;
  }

  list.innerHTML = roots.map(annotation => {
    const status     = annotation.status ?? 0;
    const statusClass = status === 1 ? 'accepted' : status === 2 ? 'rejected' : 'pending';
    const canDelete  = !!getAnnotationToken(annotation.id);
    const threadReplies = replies(annotation.id);

    const repliesHtml = threadReplies.map(reply => {
      const canDeleteReply = !!getAnnotationToken(reply.id);
      return `
        <div class="reply-item">
          <div class="annotation-meta">
            <span class="annotation-author">${escapeHtml(reply.author)}</span>
            <span class="reply-label">reply</span>
          </div>
          <div class="annotation-text">${escapeHtml(reply.text)}</div>
          <div class="annotation-actions">
            <button class="delete-btn" data-action="delete" data-id="${reply.id}"
              ${!canDeleteReply ? 'disabled title="You can only delete your own replies"' : ''}>
              🗑️ Delete
            </button>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="annotation-item ${statusClass}" data-id="${annotation.id}">
        <div class="annotation-meta">
          <span class="annotation-author">${escapeHtml(annotation.author)}</span>
          <span class="annotation-timecode" data-timecode="${annotation.timecode}">${formatTime(annotation.timecode)}</span>
        </div>
        <div class="annotation-text">${escapeHtml(annotation.text)}</div>
        ${renderTagPills(annotation.tags)}
        <div class="annotation-actions">
          <button class="delete-btn" data-action="delete" data-id="${annotation.id}"
            ${!canDelete ? 'disabled title="You can only delete your own comments"' : ''}>
            🗑️ Delete
          </button>
          <button class="reject-btn ${status === 2 ? 'active' : ''}" data-action="reject" data-id="${annotation.id}">✗ Reject</button>
          <button class="accept-btn ${status === 1 ? 'active' : ''}" data-action="accept" data-id="${annotation.id}">✓ Accept</button>
          <button class="reply-btn" data-action="reply" data-id="${annotation.id}">💬 Reply${threadReplies.length ? ` (${threadReplies.length})` : ''}</button>
        </div>
        ${repliesHtml ? `<div class="replies-thread">${repliesHtml}</div>` : ''}
        <div class="reply-form" id="reply-form-${annotation.id}" style="display:none;">
          <input type="text" class="reply-author" placeholder="Your name" maxlength="100" />
          <textarea class="reply-text" placeholder="Your reply..." rows="2" maxlength="2000"></textarea>
          <div class="reply-form-actions">
            <button class="reply-send-btn" data-action="send-reply" data-id="${annotation.id}">Send</button>
            <button class="reply-cancel-btn" data-action="cancel-reply" data-id="${annotation.id}">Cancel</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ── Timeline ──────────────────────────────────────────────────────────────────

function clusterAnnotations(annotations, maxTime) {
  if (!annotations.length) return [];
  const RADIUS = 2;
  const clusters = [];
  annotations.forEach(annotation => {
    const position = (annotation.timecode / maxTime) * 100;
    const found = clusters.find(c => Math.abs(c.center - position) < RADIUS);
    if (found) {
      found.annotations.push(annotation);
      found.position = found.annotations.reduce((s, a) => s + (a.timecode / maxTime) * 100, 0) / found.annotations.length;
    } else {
      clusters.push({ center: position, position, annotations: [annotation] });
    }
  });
  return clusters;
}

function updateTimeline() {
  const timeline = document.getElementById('timeline');
  // Only root annotations appear on the timeline; replies are contextual
  const roots = annotations.filter(a => !a.parent_id);

  if (!roots.length) { timeline.innerHTML = '<div class="timeline-line"></div>'; return; }

  const maxTime = videoDuration > 0 ? videoDuration : Math.max(...roots.map(a => a.timecode)) + 60;
  const clusters = clusterAnnotations(roots, maxTime);
  let html = '<div class="timeline-line"></div>';

  clusters.forEach((cluster, idx) => {
    if (cluster.annotations.length > 1) {
      const hasAccepted = cluster.annotations.some(a => a.status === 1);
      const hasRejected = cluster.annotations.some(a => a.status === 2);
      const hasPending  = cluster.annotations.some(a => !a.status);
      let color = '#ffd700';
      if (hasAccepted && !hasRejected && !hasPending) color = '#52b788';
      else if (hasRejected && !hasAccepted && !hasPending) color = '#e74c3c';
      const titles = cluster.annotations.map(a => `${escapeHtml(a.author)}: ${escapeHtml(a.text)}`).join('\n');
      html += `<div class="timeline-cluster" data-cluster="${idx}"
                    style="left:${cluster.position}%;background-color:${color};"
                    onmouseenter="expandCluster(${idx},${cluster.position})"
                    title="${titles}">
                 <span class="cluster-count">${cluster.annotations.length}</span>
               </div>`;
    } else {
      const a = cluster.annotations[0];
      const color = a.status === 1 ? '#52b788' : a.status === 2 ? '#e74c3c' : '#ffd700';
      html += `<div class="timeline-marker"
                    style="left:${cluster.position}%;background-color:${color};"
                    onclick="seekToTime(${a.timecode})"
                    title="${escapeHtml(a.author)}: ${escapeHtml(a.text)} (${formatTime(a.timecode)})">
               </div>`;
    }
  });

  timeline.innerHTML = html;
  timeline.dataset.clusters = JSON.stringify(clusters.map(c => ({
    position: c.position,
    annotations: c.annotations.map(a => ({ id: a.id, timecode: a.timecode, status: a.status ?? 0, author: a.author, text: a.text }))
  })));
}

function expandCluster(clusterIndex, centerPos) {
  const timeline = document.getElementById('timeline');
  timeline.querySelector('.cluster-wrapper')?.remove();
  const clustersData = JSON.parse(timeline.dataset.clusters || '[]');
  const cluster = clustersData[clusterIndex];
  if (!cluster || cluster.annotations.length <= 1) return;
  const clusterEl = timeline.querySelector(`[data-cluster="${clusterIndex}"]`);
  if (!clusterEl) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'cluster-wrapper';
  wrapper.style.cssText = `position:absolute;left:calc(${centerPos}% - 75px);top:-50px;width:150px;height:160px;z-index:10;`;
  wrapper.onmouseleave = () => {
    wrapper.remove();
    clusterEl.style.opacity = '1';
    clusterEl.style.pointerEvents = 'auto';
  };

  const R = 40, step = (Math.PI * 2) / cluster.annotations.length;
  cluster.annotations.forEach((a, i) => {
    const color = a.status === 1 ? '#52b788' : a.status === 2 ? '#e74c3c' : '#ffd700';
    const dot = document.createElement('div');
    dot.className = 'timeline-mini-marker';
    dot.style.cssText = `position:absolute;left:calc(50% + ${Math.cos(step*i)*R}px);top:calc(50% + ${Math.sin(step*i)*R}px);width:14px;height:14px;background:${color};border:2px solid #1a1a1a;border-radius:50%;cursor:pointer;transform:translate(-50%,-50%);z-index:11;`;
    dot.title = `${a.author}: ${a.text}`;
    dot.onclick = (e) => { e.stopPropagation(); seekToTime(a.timecode); };
    wrapper.appendChild(dot);
  });

  timeline.appendChild(wrapper);
  clusterEl.style.opacity = '0';
  clusterEl.style.pointerEvents = 'none';
}

// ── Real-time collaboration ───────────────────────────────────────────────────

function connectSocket() {
  socket = io();
  socket.emit('join-project', projectId);

  socket.on('annotation:created', (annotation) => {
    if (annotations.find(a => a.id === annotation.id)) return;
    annotations.push(annotation);
    annotations.sort((a, b) => a.timecode - b.timecode);
    updateAnnotationsList();
    updateTimeline();
    if (!annotation.parent_id) showToast(`New comment from ${annotation.author}`, 'info');
    else showToast(`${annotation.author} replied to a comment`, 'info');
  });

  socket.on('annotation:deleted', ({ id }) => {
    if (!annotations.find(a => a.id === id)) return;
    annotations = annotations.filter(a => a.id !== id);
    updateAnnotationsList();
    updateTimeline();
  });

  socket.on('thread:deleted', ({ parentId }) => {
    annotations = annotations.filter(a => a.id !== parentId && a.parent_id !== parentId);
    updateAnnotationsList();
    updateTimeline();
  });

  socket.on('annotation:status', ({ id, status }) => {
    const a = annotations.find(a => a.id === id);
    if (!a || a.status === status) return;
    a.status = status;
    updateAnnotationsList();
    updateTimeline();
  });
}

// ── Export modal ──────────────────────────────────────────────────────────────

function openExportModal()  { document.getElementById('export-modal').style.display = 'flex'; }
function closeExportModal(e) {
  if (!e || e.target === document.getElementById('export-modal')) {
    document.getElementById('export-modal').style.display = 'none';
  }
}
function triggerExport() {
  const fps = document.getElementById('exportFps').value;
  const a = document.createElement('a');
  a.href = `/api/projects/${projectId}/export/premiere?fps=${fps}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function seekToTime(seconds) {
  if (player?.seekTo) {
    try { player.seekTo(seconds, true); player.playVideo(); } catch {}
  }
}

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([^&]+)/,
    /(?:youtube\.com\/embed\/)([^?]+)/,
    /(?:youtu\.be\/)([^?]+)/,
    /(?:youtube\.com\/v\/)([^?]+)/
  ];
  for (const p of patterns) { const m = url.match(p); if (m?.[1]) return m[1]; }
  return null;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}
