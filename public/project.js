const projectId = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop());

let player;
let project = null;
let annotations = [];
let tagsConfig = [];
let perms = { review: false, moderate: false, admin: false };
let storyboard = null;
let isYouTubeReady = false;
let videoDuration = 0;
let playerInitAttempts = 0;
let socket = null;

// Comment form state
let selectedTags = [];
let rangeIn = null;
let rangeOut = null;
let draftTimecode = null;        // time captured when the user started typing
let attachFrame = false;

// List state
let selectedId = null;
let editingId = null;
let editTags = [];
const openReplies = new Set();
const checked = new Set();
const filters = { search: '', status: 'all', tag: '', author: '', sort: 'time' };

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

// ── Helpers ───────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const roots = () => annotations.filter(a => !a.parent_id);
const repliesOf = (id) => annotations.filter(a => a.parent_id === id);
const findAnnotation = (id) => annotations.find(a => a.id === id);
const isOwn = (a) => !!EditTokens.get(a.id);
const authorName = () => $('authorName').value.trim();

const STATUS_BUTTON_LABELS = { 3: '◔ In work', 1: '✓ Accept', 2: '✗ Reject' };

function upsertAnnotation(annotation) {
  const idx = annotations.findIndex(a => a.id === annotation.id);
  if (idx >= 0) annotations[idx] = { ...annotations[idx], ...annotation };
  else annotations.push(annotation);
  annotations.sort((a, b) => a.timecode - b.timecode || String(a.created_at).localeCompare(String(b.created_at)));
}

let backupTimer = null;
function scheduleBackup(opened = false) {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    if (project) Backup.saveSnapshot({ ...project }, annotations, { opened });
  }, opened ? 0 : 800);
}

function currentTime() {
  try { return player && player.getCurrentTime ? player.getCurrentTime() : 0; } catch { return 0; }
}

function isPlaying() {
  try { return player.getPlayerState() === YT.PlayerState.PLAYING; } catch { return false; }
}

function frameStep() {
  const fps = parseFloat((lsGet('ofa_export', {}) || {}).fps) || 25;
  return 1 / fps;
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  EditorKeys.captureFromHash(projectId);

  const authorInput = $('authorName');
  authorInput.value = lsGet('author_name_v2', null) ?? (localStorage.getItem('author_name') || '');
  authorInput.addEventListener('input', () => lsSet('author_name_v2', authorInput.value));

  const autoPause = $('autoPause');
  autoPause.checked = lsGet('ofa_autopause', true);
  autoPause.addEventListener('change', () => lsSet('ofa_autopause', autoPause.checked));

  $('commentText').addEventListener('input', onCommentInput);
  $('addAnnotation').addEventListener('click', addAnnotation);
  $('frameToggle').addEventListener('click', toggleAttachFrame);
  $('rangeInfo').addEventListener('click', (e) => { if (e.target.closest('[data-clear-range]')) clearRange(); });

  $('tagSelector').addEventListener('click', (e) => {
    const chip = e.target.closest('.tag-chip');
    if (!chip) return;
    const tag = chip.dataset.tag;
    selectedTags = selectedTags.includes(tag) ? selectedTags.filter(t => t !== tag) : [...selectedTags, tag];
    chip.classList.toggle('active', selectedTags.includes(tag));
  });

  $('annotationsList').addEventListener('click', onListClick);
  $('annotationsList').addEventListener('change', (e) => {
    const box = e.target.closest('[data-check]');
    if (!box) return;
    if (box.checked) checked.add(box.dataset.check); else checked.delete(box.dataset.check);
    updateBulkBar();
  });

  setupFilters();
  setupTimeline();
  setupModals();
  setupKeyboard();
  renderRangeInfo();
  loadProject();
});

// ── Project load ──────────────────────────────────────────────────────────────

async function loadProject() {
  try {
    const data = await api('GET', `/api/projects/${encodeURIComponent(projectId)}`, undefined, { projectId });
    applyProjectData(data);
    document.title = `${project.title || 'Project'} — Open Frame Annotator`;
    $('reportLink').href = `/project/${encodeURIComponent(projectId)}/report`;
    $('loading').style.display = 'none';
    $('restorePanel').style.display = 'none';
    $('project-content').style.display = 'block';

    scheduleBackup(true);
    connectSocket();
    tryInitializePlayer();

    storyboard = await Storyboard.load(projectId);
    if (storyboard) { renderList(); renderTimeline(); }
  } catch (error) {
    if (error.status === 404) return showRestorePanel();
    console.error('Error loading project:', error);
    $('loading').textContent = 'Error: ' + error.message;
  }
}

function applyProjectData(data) {
  project = data.project;
  annotations = data.annotations || [];
  perms = data.permissions || perms;
  tagsConfig = parseTags(project.tags_config);
  // The editor link was revoked by the admin — forget the dead key
  if (EditorKeys.get(projectId) && !perms.review) {
    EditorKeys.set(projectId, null);
    showToast('Your editor link is no longer valid — you are a reviewer now', 'error');
  }
  renderHeader(data.retention);
  renderTagSelector();
  renderAll();
}

let retentionInfo = null;
function renderHeader(retention) {
  if (retention) retentionInfo = retention;
  $('projectMeta').style.display = 'block';
  $('projectTitle').textContent = project.title || 'Untitled project';
  $('projectDescription').textContent = project.description || '';

  const badge = $('roleBadge');
  if (perms.moderate) { badge.textContent = perms.admin ? 'Admin' : 'Editor'; badge.className = 'role-badge editor'; badge.style.display = ''; }
  else if (!perms.review) { badge.textContent = 'Reviewer'; badge.className = 'role-badge'; badge.style.display = ''; }
  else badge.style.display = 'none';
  $('settingsBtn').style.display = perms.moderate ? '' : 'none';
  $('bulkBar').style.display = perms.review ? '' : 'none';
  document.querySelector('[data-bulk="delete"]').style.display = perms.moderate ? '' : 'none';

  const banner = $('retentionBanner');
  const expires = project.expires_at ? new Date(project.expires_at) : null;
  const warnDays = retentionInfo ? retentionInfo.warn_days : 30;
  if (expires && expires.getTime() - Date.now() < warnDays * 86400000) {
    banner.textContent = `This project will be deleted automatically on ${formatDate(expires)} because it has been inactive. Any new comment or status change keeps it alive.`;
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }
}

async function showRestorePanel() {
  $('loading').style.display = 'none';
  const panel = $('restorePanel');
  const entry = await Backup.get(projectId);
  if (!entry) {
    panel.innerHTML = '<h3>Project not found</h3><p>It may have been deleted, or the link is wrong.</p><p><a href="/">← Back to start page</a></p>';
  } else {
    const count = (entry.annotations || []).length;
    panel.innerHTML = `
      <h3>This project no longer exists on the server</h3>
      <p>Your browser kept a backup of <strong>${escapeHtml(entry.project.title || 'Untitled project')}</strong>
         from ${escapeHtml(formatDate(entry.savedAt))} with ${count} comment${count === 1 ? '' : 's'}.</p>
      <p>Restoring recreates it at the same address, so existing links work again. You become its editor.</p>
      <button type="button" class="export-download-btn" id="restoreBtn">Restore project</button>`;
    $('restoreBtn').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const result = await Backup.restore(projectId);
        showToast(`Restored ${result.restored} comments`, 'success');
        panel.style.display = 'none';
        $('loading').style.display = 'block';
        if (socket) { socket.connect(); }
        loadProject();
      } catch (err) {
        showToast(err.message, 'error');
        e.target.disabled = false;
      }
    });
  }
  panel.style.display = 'block';
}

// ── YouTube player ────────────────────────────────────────────────────────────

function onYouTubeIframeAPIReady() {
  isYouTubeReady = true;
  if (project) initializePlayer();
}

function tryInitializePlayer() {
  playerInitAttempts++;
  if (typeof YT !== 'undefined' && typeof YT.Player === 'function') {
    isYouTubeReady = true;
    initializePlayer();
  } else if (playerInitAttempts < 30) {
    setTimeout(tryInitializePlayer, 200);
  } else {
    showToast('Failed to load YouTube player. Please refresh.', 'error');
  }
}

function initializePlayer() {
  if (player && typeof player.getPlayerState === 'function') return;
  if (!project || !isYouTubeReady) return;

  const videoId = extractVideoId(project.youtube_url);
  if (!videoId) { showToast('Invalid YouTube link', 'error'); return; }

  try {
    $('youtube-player').innerHTML = '';
    player = new YT.Player('youtube-player', {
      height: '100%', width: '100%', videoId,
      playerVars: { autoplay: 0, playsinline: 1, rel: 0, modestbranding: 1, origin: window.location.origin, enablejsapi: 1 },
      events: { onReady: onPlayerReady, onStateChange: onPlayerStateChange, onError: onPlayerError }
    });
  } catch (error) {
    showToast('Error creating player: ' + error.message, 'error');
  }
}

let tickTimer = null;
function onPlayerReady() {
  setTimeout(() => {
    try { videoDuration = player.getDuration(); if (videoDuration > 0) renderTimeline(); } catch {}
  }, 500);
  if (!tickTimer) tickTimer = setInterval(tick, 250);
}

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.BUFFERING) {
    try {
      const d = player.getDuration();
      if (d > 0 && d !== videoDuration) { videoDuration = d; renderTimeline(); }
    } catch {}
  }
}

function onPlayerError(event) {
  const messages = { 2: 'Invalid video ID.', 5: 'HTML5 player error.', 100: 'Video not found.', 101: 'Embedding disabled.', 150: 'Embedding disabled.' };
  showToast('Video error. ' + (messages[event.data] || ''), 'error');
}

function tick() {
  const t = currentTime();
  updateAddButton(t);
  const head = $('playhead');
  const max = timelineMax();
  if (head && max > 0) head.style.left = `${Math.min(100, (t / max) * 100)}%`;
}

function updateAddButton(t = currentTime()) {
  const label = $('currentTime');
  if (rangeIn !== null) {
    label.textContent = rangeOut !== null ? `${formatTime(rangeIn)}–${formatTime(rangeOut)}` : `${formatTime(rangeIn)}`;
  } else {
    label.textContent = formatTime(draftTimecode !== null ? draftTimecode : t);
  }
}

function seekToTime(seconds, play = false) {
  if (!player || !player.seekTo) return;
  try {
    player.seekTo(Math.max(0, seconds), true);
    if (play) player.playVideo();
  } catch {}
}

function togglePlayPause() {
  if (!player || !player.getPlayerState) return;
  try {
    if (isPlaying()) player.pauseVideo();
    else { player.setPlaybackRate(1); player.playVideo(); }
  } catch {}
}

const SPEEDS = [1, 1.5, 2];
function shuttle(direction) {
  if (!player || !player.getPlaybackRate) return;
  try {
    const rate = player.getPlaybackRate();
    if (direction > 0) {
      if (!isPlaying()) { player.setPlaybackRate(1); player.playVideo(); return; }
      const next = SPEEDS.find(s => s > rate);
      if (next) { player.setPlaybackRate(next); showToast(`${next}×`, 'info'); }
    } else if (rate > 1) {
      const prev = [...SPEEDS].reverse().find(s => s < rate) || 1;
      player.setPlaybackRate(prev);
      showToast(`${prev}×`, 'info');
    } else {
      seekRelative(-5);
    }
  } catch {}
}

function seekRelative(delta) {
  seekToTime(currentTime() + delta);
}

function stepFrame(direction) {
  if (!player) return;
  try { player.pauseVideo(); } catch {}
  seekToTime(currentTime() + direction * frameStep());
}

// ── Comment form ──────────────────────────────────────────────────────────────

function onCommentInput() {
  const text = $('commentText').value;
  if (text.trim() && draftTimecode === null) {
    draftTimecode = currentTime();
    if ($('autoPause').checked && isPlaying()) {
      try { player.pauseVideo(); player.seekTo(draftTimecode, true); } catch {}
    }
  } else if (!text.trim()) {
    draftTimecode = null;
  }
  updateAddButton();
}

function setRangePoint(which) {
  const t = currentTime();
  if (which === 'in') {
    rangeIn = t;
    if (rangeOut !== null && rangeOut <= rangeIn) rangeOut = null;
  } else {
    if (rangeIn === null || t <= rangeIn) { showToast('Set the in point (I) before the out point', 'error'); return; }
    rangeOut = t;
  }
  renderRangeInfo();
}

function clearRange() {
  rangeIn = rangeOut = null;
  renderRangeInfo();
}

function renderRangeInfo() {
  const el = $('rangeInfo');
  if (rangeIn === null) {
    el.innerHTML = '<span class="meta-muted">Range: <kbd>I</kbd> in, <kbd>O</kbd> out</span>';
  } else {
    el.innerHTML = `<span class="range-set">Range ${formatTime(rangeIn)} – ${rangeOut !== null ? formatTime(rangeOut) : '<em>press O</em>'}</span>
      <button type="button" data-clear-range title="Clear range (X)">✕</button>`;
  }
  updateAddButton();
  renderTimeline();
}

function renderTagSelector() {
  const container = $('tagSelector');
  selectedTags = selectedTags.filter(t => tagsConfig.includes(t));
  if (!tagsConfig.length) { container.style.display = 'none'; container.innerHTML = ''; return; }
  container.style.display = 'flex';
  container.innerHTML = tagsConfig.map(tag => `
    <button type="button" class="tag-chip ${selectedTags.includes(tag) ? 'active' : ''}" data-tag="${escapeHtml(tag)}"
            style="--tag-color:${tagColor(tag, tagsConfig)}">${escapeHtml(tag)}</button>
  `).join('');
}

async function addAnnotation() {
  const author = $('authorName').value.trim();
  const text = $('commentText').value.trim();
  if (!author) { showToast('Please enter your name', 'error'); $('authorName').focus(); return; }
  if (!text) { showToast('Please write a comment', 'error'); $('commentText').focus(); return; }
  if (!player || !player.getCurrentTime) { showToast('Player is not ready', 'error'); return; }

  const addBtn = $('addAnnotation');
  if (addBtn.disabled) return;
  addBtn.disabled = true;

  const timecode = rangeIn !== null ? rangeIn : draftTimecode !== null ? draftTimecode : currentTime();
  const timecodeEnd = rangeIn !== null && rangeOut !== null ? rangeOut : null;

  try {
    let shot = null;
    if (attachFrame && FrameCapture.active()) {
      if (Math.abs(currentTime() - timecode) > 0.2) {
        try { player.pauseVideo(); player.seekTo(timecode, true); } catch {}
        await new Promise(r => setTimeout(r, 900));
      }
      try { shot = await FrameCapture.grab(); } catch (e) { console.warn('Frame capture failed', e); }
    }

    const created = await api('POST', `/api/projects/${encodeURIComponent(projectId)}/annotations`, {
      author, text, timecode,
      timecode_end: timecodeEnd === null ? undefined : timecodeEnd,
      tags: selectedTags.length ? selectedTags : undefined
    }, { projectId });
    EditTokens.set(created.id, created.edit_token);
    const { edit_token: _token, ...annotation } = created;
    upsertAnnotation(annotation);

    selectedTags = [];
    $('commentText').value = '';
    draftTimecode = null;
    clearRange();
    renderTagSelector();
    renderAll();
    showToast('Comment added', 'success');

    if (shot) await uploadScreenshot(annotation.id, shot);
    scheduleBackup();
  } catch (error) {
    showToast(error.message || 'Error adding comment', 'error');
  } finally {
    addBtn.disabled = false;
  }
}

async function uploadScreenshot(annotationId, blob) {
  try {
    const updated = await api('POST', `/api/annotations/${encodeURIComponent(annotationId)}/screenshot`, blob, {
      projectId, headers: { 'Content-Type': 'image/jpeg', 'X-Edit-Token': EditTokens.get(annotationId) || '' }
    });
    upsertAnnotation({ ...updated, _shotVersion: Date.now() });
    renderList();
  } catch (e) {
    showToast('Frame upload failed: ' + e.message, 'error');
  }
}

// ── Frame capture (exact frames via tab capture) ──────────────────────────────

const FrameCapture = {
  stream: null,
  video: null,
  cropped: false,
  active() { return !!(this.stream && this.stream.active); },
  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error('Frame capture is not supported in this browser');
    }
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: 10 },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude'
    });
    const track = this.stream.getVideoTracks()[0];
    this.cropped = false;
    // Region Capture (Chrome) crops the stream to the player itself
    if (window.CropTarget && track.cropTo) {
      try { await track.cropTo(await CropTarget.fromElement($('playerBox'))); this.cropped = true; } catch {}
    }
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.srcObject = this.stream;
    await this.video.play();
    track.addEventListener('ended', () => { this.stop(); setAttachFrame(false); });
  },
  stop() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video = null;
  },
  async grab() {
    await new Promise(r => setTimeout(r, 150)); // let a fresh frame arrive
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (!this.cropped) {
      // Without Region Capture: cut the player out of the whole-tab frame
      const rect = $('playerBox').getBoundingClientRect();
      const scaleX = vw / window.innerWidth, scaleY = vh / window.innerHeight;
      sx = Math.max(0, rect.left * scaleX); sy = Math.max(0, rect.top * scaleY);
      sw = Math.min(vw - sx, rect.width * scaleX); sh = Math.min(vh - sy, rect.height * scaleY);
      if (sw <= 0 || sh <= 0) throw new Error('Player is not visible');
    }
    const outW = Math.min(1280, Math.round(sw));
    const outH = Math.round(sh * (outW / sw));
    const canvas = document.createElement('canvas');
    canvas.width = outW; canvas.height = outH;
    canvas.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, outW, outH);
    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Encoding failed')), 'image/jpeg', 0.85));
  }
};

function setAttachFrame(on) {
  attachFrame = on;
  $('frameToggle').classList.toggle('active', on);
  $('frameToggle').textContent = on ? '📷 Frame: on' : '📷 Attach frame';
  renderList();
}

async function toggleAttachFrame() {
  if (attachFrame) { FrameCapture.stop(); setAttachFrame(false); return; }
  try {
    if (!FrameCapture.active()) {
      showToast('Choose “This tab” in the browser dialog', 'info');
      await FrameCapture.start();
    }
    setAttachFrame(true);
  } catch (e) {
    if (e.name !== 'NotAllowedError') showToast(e.message, 'error');
  }
}

// Attach the frame at an own comment's timecode
async function captureFrameFor(id) {
  const a = findAnnotation(id);
  if (!a || !FrameCapture.active()) return;
  try { player.pauseVideo(); player.seekTo(a.timecode, true); } catch {}
  await new Promise(r => setTimeout(r, 900));
  try { await uploadScreenshot(id, await FrameCapture.grab()); showToast('Frame attached', 'success'); }
  catch (e) { showToast(e.message, 'error'); }
}

// ── Comment actions ───────────────────────────────────────────────────────────

async function deleteAnnotation(id) {
  const a = findAnnotation(id);
  if (!a || !confirm(a.parent_id ? 'Delete this reply?' : 'Delete this comment and its replies?')) return;
  try {
    await api('DELETE', `/api/annotations/${encodeURIComponent(id)}`, { edit_token: EditTokens.get(id) || undefined }, { projectId });
    annotations = annotations.filter(x => x.id !== id && x.parent_id !== id);
    if (selectedId === id) selectedId = null;
    checked.delete(id);
    renderAll();
    playTrashSound();
    showToast('Deleted', 'info');
    scheduleBackup();
  } catch (error) {
    showToast(error.message || 'Error deleting comment', 'error');
  }
}

async function setStatus(id, status) {
  const a = findAnnotation(id);
  if (!a || !perms.review) return;
  // Clicking the active status again resets to pending
  const next = (a.status || 0) === status ? 0 : status;
  try {
    const res = await api('PATCH', `/api/annotations/${encodeURIComponent(id)}/status`,
      { status: next, by: authorName() || undefined }, { projectId });
    Object.assign(a, res);
    renderAll();
    if (next === 1) playBellSound();
    else if (next === 2) playRejectSound();
    scheduleBackup();
  } catch (error) {
    showToast(error.message || 'Error updating status', 'error');
  }
}

async function submitReply(parentId) {
  const field = document.querySelector(`[data-draft="reply-${CSS.escape(parentId)}"]`);
  const text = field ? field.value.trim() : '';
  const author = authorName();
  if (!author) { showToast('Enter your name in the comment form first', 'error'); $('authorName').focus(); return; }
  if (!text) { showToast('Write a reply first', 'error'); return; }
  try {
    const created = await api('POST', `/api/projects/${encodeURIComponent(projectId)}/annotations`,
      { author, text, parent_id: parentId }, { projectId });
    EditTokens.set(created.id, created.edit_token);
    const { edit_token: _token, ...reply } = created;
    upsertAnnotation(reply);
    openReplies.delete(parentId);
    drafts.delete(`reply-${parentId}`);
    renderList();
    showToast('Reply added', 'success');
    scheduleBackup();
  } catch (error) {
    showToast(error.message || 'Error adding reply', 'error');
  }
}

function startEdit(id) {
  const a = findAnnotation(id);
  if (!a || !isOwn(a)) return;
  editingId = id;
  editTags = parseTags(a.tags);
  drafts.set(`edit-${id}`, a.text);
  renderList();
  const field = document.querySelector(`[data-draft="edit-${CSS.escape(id)}"]`);
  if (field) { field.focus(); field.setSelectionRange(field.value.length, field.value.length); }
}

async function saveEdit(id) {
  const a = findAnnotation(id);
  const field = document.querySelector(`[data-draft="edit-${CSS.escape(id)}"]`);
  if (!a || !field) return;
  const text = field.value.trim();
  if (!text) { showToast('Comment cannot be empty', 'error'); return; }
  const body = { text, edit_token: EditTokens.get(id) };
  if (!a.parent_id) body.tags = editTags;
  try {
    const updated = await api('PATCH', `/api/annotations/${encodeURIComponent(id)}`, body, { projectId });
    upsertAnnotation(updated);
    editingId = null;
    drafts.delete(`edit-${id}`);
    renderAll();
    scheduleBackup();
  } catch (error) {
    showToast(error.message || 'Error saving', 'error');
  }
}

// Move an own comment to the current I/O range, or to the playhead
async function retimeAnnotation(id) {
  const a = findAnnotation(id);
  if (!a || !isOwn(a) || a.parent_id) return;
  const body = { edit_token: EditTokens.get(id) };
  if (rangeIn !== null) { body.timecode = rangeIn; body.timecode_end = rangeOut; }
  else { body.timecode = currentTime(); body.timecode_end = null; }
  try {
    const updated = await api('PATCH', `/api/annotations/${encodeURIComponent(id)}`, body, { projectId });
    upsertAnnotation(updated);
    repliesOf(id).forEach(r => { r.timecode = updated.timecode; });
    renderAll();
    showToast(`Moved to ${formatRange(updated)}`, 'success');
    scheduleBackup();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function selectAnnotation(id, { seek = false, scroll = false } = {}) {
  selectedId = id;
  const a = findAnnotation(id);
  if (a && seek) seekToTime(a.timecode);
  document.querySelectorAll('.annotation-item.selected').forEach(el => el.classList.remove('selected'));
  const el = document.querySelector(`.annotation-item[data-id="${CSS.escape(id)}"]`);
  if (el) {
    el.classList.add('selected');
    if (scroll) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function onListClick(e) {
  const actionEl = e.target.closest('[data-action]');
  if (actionEl) {
    const { action, id } = actionEl.dataset;
    switch (action) {
      case 'delete': return deleteAnnotation(id);
      case 'status': return setStatus(id, Number(actionEl.dataset.status));
      case 'reply':
        if (openReplies.has(id)) openReplies.delete(id); else openReplies.add(id);
        renderList();
        if (openReplies.has(id)) document.querySelector(`[data-draft="reply-${CSS.escape(id)}"]`)?.focus();
        return;
      case 'send-reply': return submitReply(id);
      case 'cancel-reply': openReplies.delete(id); drafts.delete(`reply-${id}`); return renderList();
      case 'edit': return startEdit(id);
      case 'save-edit': return saveEdit(id);
      case 'cancel-edit': editingId = null; drafts.delete(`edit-${id}`); return renderList();
      case 'retime': return retimeAnnotation(id);
      case 'frame': return captureFrameFor(id);
      case 'edit-tag': {
        const tag = actionEl.dataset.tag;
        editTags = editTags.includes(tag) ? editTags.filter(t => t !== tag) : [...editTags, tag];
        actionEl.classList.toggle('active', editTags.includes(tag));
        return;
      }
    }
    return;
  }
  const seekEl = e.target.closest('[data-seek]');
  if (seekEl) {
    const card = seekEl.closest('.annotation-item');
    if (card) selectAnnotation(card.dataset.id);
    return seekToTime(Number(seekEl.dataset.seek));
  }
  if (e.target.closest('input, textarea, button, a, label')) return;
  const card = e.target.closest('.annotation-item');
  if (card) selectAnnotation(card.dataset.id);
}

// ── Filters & bulk actions ────────────────────────────────────────────────────

function setupFilters() {
  $('filterSearch').addEventListener('input', (e) => { filters.search = e.target.value.trim().toLowerCase(); renderList(); });
  $('filterTag').addEventListener('change', (e) => { filters.tag = e.target.value; renderList(); });
  $('filterAuthor').addEventListener('change', (e) => { filters.author = e.target.value; renderList(); });
  $('sortOrder').addEventListener('change', (e) => { filters.sort = e.target.value; renderList(); });
  $('statusFilters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter-status]');
    if (!chip) return;
    filters.status = chip.dataset.filterStatus;
    renderList();
  });
  $('bulkAll').addEventListener('change', (e) => {
    visibleRoots().forEach(a => e.target.checked ? checked.add(a.id) : checked.delete(a.id));
    renderList();
  });
  document.querySelector('.bulk-actions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bulk]');
    if (btn) runBulk(btn.dataset.bulk);
  });
}

function renderFilterOptions() {
  const tagSel = $('filterTag');
  if (!tagsConfig.includes(filters.tag)) filters.tag = '';
  tagSel.innerHTML = '<option value="">All tags</option>' + tagsConfig.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  tagSel.value = filters.tag;
  tagSel.style.display = tagsConfig.length ? '' : 'none';

  const authors = [...new Set(roots().map(a => a.author))].sort((a, b) => a.localeCompare(b));
  if (!authors.includes(filters.author)) filters.author = '';
  const authorSel = $('filterAuthor');
  authorSel.innerHTML = '<option value="">All authors</option>' + authors.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
  authorSel.value = filters.author;
}

function visibleRoots() {
  let list = roots().filter(a => {
    if (filters.status !== 'all' && (a.status || 0) !== Number(filters.status)) return false;
    if (filters.tag && !parseTags(a.tags).includes(filters.tag)) return false;
    if (filters.author && a.author !== filters.author) return false;
    if (filters.search) {
      const hay = [a.author, a.text, ...repliesOf(a.id).map(r => `${r.author} ${r.text}`)].join(' ').toLowerCase();
      if (!hay.includes(filters.search)) return false;
    }
    return true;
  });
  if (filters.sort === 'newest') {
    list = [...list].sort((a, b) => (parseDbDate(b.created_at) || 0) - (parseDbDate(a.created_at) || 0));
  }
  return list;
}

async function runBulk(action) {
  const ids = [...checked].filter(id => findAnnotation(id));
  if (!ids.length) { showToast('Select comments first', 'info'); return; }
  if (action === 'delete' && !confirm(`Delete ${ids.length} comment(s) and their replies?`)) return;
  const body = action === 'delete'
    ? { ids, action: 'delete' }
    : { ids, action: 'status', status: Number(action), by: authorName() || undefined };
  try {
    await api('POST', `/api/projects/${encodeURIComponent(projectId)}/annotations/bulk`, body, { projectId });
    const fresh = await api('GET', `/api/projects/${encodeURIComponent(projectId)}`, undefined, { projectId });
    annotations = fresh.annotations;
    checked.clear();
    renderAll();
    showToast(`Updated ${ids.length} comment(s)`, 'success');
    scheduleBackup();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function updateBulkBar() {
  const visible = visibleRoots();
  const n = [...checked].filter(id => findAnnotation(id)).length;
  $('bulkCount').textContent = n ? `${n} selected` : 'Select all';
  const all = $('bulkAll');
  all.checked = visible.length > 0 && visible.every(a => checked.has(a.id));
  all.indeterminate = !all.checked && visible.some(a => checked.has(a.id));
  document.querySelectorAll('.bulk-actions button').forEach(b => { b.disabled = !n; });
}

// ── Render: comments list ─────────────────────────────────────────────────────

// Text typed into reply/edit fields survives re-renders caused by live updates
const drafts = new Map();

function captureDrafts() {
  const active = document.activeElement;
  let focus = null;
  document.querySelectorAll('[data-draft]').forEach(el => {
    drafts.set(el.dataset.draft, el.value);
    if (el === active) focus = { key: el.dataset.draft, start: el.selectionStart, end: el.selectionEnd };
  });
  return focus;
}

function restoreDrafts(focus) {
  document.querySelectorAll('[data-draft]').forEach(el => {
    if (drafts.has(el.dataset.draft)) el.value = drafts.get(el.dataset.draft);
  });
  if (focus) {
    const el = document.querySelector(`[data-draft="${CSS.escape(focus.key)}"]`);
    if (el) { el.focus(); try { el.setSelectionRange(focus.start, focus.end); } catch {} }
  }
}

function renderAll() {
  renderFilterOptions();
  renderList();
  renderTimeline();
}

function statusLine(a) {
  if (!a.status) return '';
  const s = STATUS[a.status];
  const by = a.status_by ? ` by ${escapeHtml(a.status_by)}` : '';
  const when = a.status_at ? ` · ${escapeHtml(timeAgo(a.status_at))}` : '';
  return `<div class="status-line status-${s.key}">${s.icon} ${s.label}${by}${when}</div>`;
}

function tagPillsHtml(tagsJson) {
  const tags = parseTags(tagsJson);
  if (!tags.length) return '';
  return `<div class="annotation-tags">${tags.map(t =>
    `<span class="tag-pill" style="background:${tagColor(t, tagsConfig)}">${escapeHtml(t)}</span>`).join('')}</div>`;
}

function replyHtml(r) {
  const id = escapeHtml(r.id);
  const own = isOwn(r);
  const editing = editingId === r.id;
  return `
    <div class="reply-item" data-reply="${id}">
      <div class="annotation-meta">
        <span class="annotation-author">${escapeHtml(r.author)}</span>
        <span class="meta-muted">${escapeHtml(timeAgo(r.created_at))}${r.edited_at ? ' · edited' : ''}</span>
      </div>
      ${editing ? editFormHtml(r) : `<div class="annotation-text">${escapeHtml(r.text)}</div>`}
      ${editing ? '' : `<div class="mini-actions">
        ${own ? `<button type="button" data-action="edit" data-id="${id}">Edit</button>` : ''}
        ${own || perms.moderate ? `<button type="button" data-action="delete" data-id="${id}">Delete</button>` : ''}
      </div>`}
    </div>`;
}

function editFormHtml(a) {
  const id = escapeHtml(a.id);
  const tagChips = !a.parent_id && tagsConfig.length
    ? `<div class="tag-selector">${tagsConfig.map(t => `<button type="button" class="tag-chip ${editTags.includes(t) ? 'active' : ''}"
         data-action="edit-tag" data-id="${id}" data-tag="${escapeHtml(t)}" style="--tag-color:${tagColor(t, tagsConfig)}">${escapeHtml(t)}</button>`).join('')}</div>`
    : '';
  return `
    <div class="edit-form">
      <textarea rows="3" maxlength="2000" data-draft="edit-${id}" data-submit="edit" data-id="${id}"></textarea>
      ${tagChips}
      <div class="reply-form-actions">
        <button type="button" class="reply-send-btn" data-action="save-edit" data-id="${id}">Save</button>
        <button type="button" class="reply-cancel-btn" data-action="cancel-edit" data-id="${id}">Cancel</button>
        ${!a.parent_id ? `<button type="button" class="reply-cancel-btn" data-action="retime" data-id="${id}"
            title="Move this comment to the playhead, or to the I/O range if one is set">⏱ Move here</button>` : ''}
      </div>
    </div>`;
}

function cardHtml(a) {
  const id = escapeHtml(a.id);
  const status = a.status || 0;
  const s = STATUS[status];
  const own = isOwn(a);
  const threadReplies = repliesOf(a.id);
  const editing = editingId === a.id;
  const thumb = thumbnailHtml(a, storyboard, 112);

  const statusButtons = perms.review ? [3, 1, 2].map(code => `
    <button type="button" class="status-btn status-${STATUS[code].key} ${status === code ? 'active' : ''}"
            data-action="status" data-status="${code}" data-id="${id}" title="${STATUS[code].label} (${code})">${STATUS_BUTTON_LABELS[code]}</button>`).join('') : '';

  return `
    <div class="annotation-item status-${s.key} ${selectedId === a.id ? 'selected' : ''}" data-id="${id}">
      <div class="card-top">
        ${perms.review ? `<input type="checkbox" class="bulk-check" data-check="${id}" ${checked.has(a.id) ? 'checked' : ''} title="Select">` : ''}
        ${thumb ? `<span class="card-thumb" data-seek="${Number(a.timecode)}" title="Jump to ${formatTime(a.timecode)}">${thumb}</span>` : ''}
        <div class="card-main">
          <div class="annotation-meta">
            <span class="annotation-author">${escapeHtml(a.author)}</span>
            <span class="annotation-timecode" data-seek="${Number(a.timecode)}">${escapeHtml(formatRange(a))}</span>
          </div>
          ${editing ? editFormHtml(a) : `<div class="annotation-text">${escapeHtml(a.text)}</div>${tagPillsHtml(a.tags)}`}
          ${statusLine(a)}
          <div class="meta-muted">${escapeHtml(timeAgo(a.created_at))}${a.edited_at ? ' · edited' : ''}</div>
        </div>
      </div>
      <div class="annotation-actions">
        ${statusButtons}
        <button type="button" class="reply-btn" data-action="reply" data-id="${id}">💬 Reply${threadReplies.length ? ` (${threadReplies.length})` : ''}</button>
        ${own && !editing ? `<button type="button" class="reply-btn icon-btn" data-action="edit" data-id="${id}" title="Edit (E)">✏️</button>` : ''}
        ${own && attachFrame ? `<button type="button" class="reply-btn icon-btn" data-action="frame" data-id="${id}" title="Attach the frame at this timecode">📷</button>` : ''}
        ${own || perms.moderate ? `<button type="button" class="delete-btn icon-btn" data-action="delete" data-id="${id}" title="Delete (Del)">🗑️</button>` : ''}
      </div>
      ${threadReplies.length ? `<div class="replies-thread">${threadReplies.map(replyHtml).join('')}</div>` : ''}
      ${openReplies.has(a.id) ? `
        <div class="reply-form">
          <textarea rows="2" maxlength="2000" placeholder="Reply as ${escapeHtml(authorName() || '…')} — Enter to send"
                    data-draft="reply-${id}" data-submit="reply" data-id="${id}"></textarea>
          <div class="reply-form-actions">
            <button type="button" class="reply-send-btn" data-action="send-reply" data-id="${id}">Send</button>
            <button type="button" class="reply-cancel-btn" data-action="cancel-reply" data-id="${id}">Cancel</button>
          </div>
        </div>` : ''}
    </div>`;
}

function renderStatusFilters() {
  const all = roots();
  const chip = (value, label, count, color) =>
    `<button type="button" class="filter-chip ${filters.status === String(value) ? 'active' : ''}" data-filter-status="${value}"
       ${color ? `style="--chip-color:${color}"` : ''}>${label} <span>${count}</span></button>`;
  $('statusFilters').innerHTML = chip('all', 'All', all.length) +
    STATUS_ORDER.map(code => chip(code, `${STATUS[code].icon} ${STATUS[code].label}`,
      all.filter(a => (a.status || 0) === code).length, STATUS[code].color)).join('');
}

function renderList() {
  const list = $('annotationsList');
  const focus = captureDrafts();
  const all = roots();

  $('annotationsCount').textContent = all.length;
  const reviewed = all.filter(a => a.status === 1 || a.status === 2).length;
  $('progressText').textContent = all.length ? `${reviewed} / ${all.length} reviewed` : '';
  renderStatusFilters();

  const visible = visibleRoots();
  if (!all.length) list.innerHTML = '<p class="empty-list">No comments yet</p>';
  else if (!visible.length) list.innerHTML = '<p class="empty-list">No comments match the filters</p>';
  else list.innerHTML = visible.map(cardHtml).join('');

  restoreDrafts(focus);
  if (perms.review) updateBulkBar();
}

// ── Timeline ──────────────────────────────────────────────────────────────────

function timelineMax() {
  if (videoDuration > 0) return videoDuration;
  if (storyboard && storyboard.duration) return storyboard.duration;
  const r = roots();
  return r.length ? Math.max(...r.map(a => a.timecode_end || a.timecode)) + 60 : 0;
}

function clusterAnnotations(list, maxTime) {
  const RADIUS = 2;
  const clusters = [];
  list.forEach(annotation => {
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

let timelineClusters = [];

function renderTimeline() {
  const timeline = $('timeline');
  const list = roots();
  const maxTime = timelineMax();
  let html = '<div class="timeline-line"></div>';

  if (maxTime > 0) {
    // Ranges as bars under the markers
    list.filter(a => a.timecode_end != null).forEach(a => {
      const left = (a.timecode / maxTime) * 100;
      const width = Math.max(0.4, ((a.timecode_end - a.timecode) / maxTime) * 100);
      html += `<div class="timeline-range" data-seek="${Number(a.timecode)}" style="left:${left}%;width:${width}%;background:${STATUS[a.status || 0].color}"
                    title="${escapeHtml(`${a.author}: ${a.text} (${formatRange(a)})`)}"></div>`;
    });
    if (rangeIn !== null) {
      const end = rangeOut !== null ? rangeOut : rangeIn;
      html += `<div class="timeline-draft-range" style="left:${(rangeIn / maxTime) * 100}%;width:${Math.max(0.3, ((end - rangeIn) / maxTime) * 100)}%"></div>`;
    }

    timelineClusters = clusterAnnotations(list, maxTime);
    timelineClusters.forEach((cluster, idx) => {
      if (cluster.annotations.length > 1) {
        const statuses = new Set(cluster.annotations.map(a => a.status || 0));
        const color = statuses.size === 1 ? STATUS[[...statuses][0]].color : '#ffd700';
        const titles = cluster.annotations.map(a => `${a.author}: ${a.text}`).join('\n');
        html += `<div class="timeline-cluster" data-cluster="${idx}" style="left:${cluster.position}%;background-color:${color};"
                      title="${escapeHtml(titles)}"><span class="cluster-count">${cluster.annotations.length}</span></div>`;
      } else {
        const a = cluster.annotations[0];
        html += `<div class="timeline-marker ${selectedId === a.id ? 'selected' : ''}" data-marker="${escapeHtml(a.id)}"
                      style="left:${cluster.position}%;background-color:${STATUS[a.status || 0].color};"
                      title="${escapeHtml(`${a.author}: ${a.text} (${formatRange(a)})`)}"></div>`;
      }
    });
  }
  html += '<div class="timeline-playhead" id="playhead"></div><div class="timeline-preview" id="timelinePreview"></div>';
  timeline.innerHTML = html;
  tick();
}

function setupTimeline() {
  const timeline = $('timeline');
  const jumpTo = (id) => {
    const a = findAnnotation(id);
    if (a) { selectAnnotation(a.id, { scroll: true }); seekToTime(a.timecode); renderTimeline(); }
  };
  timeline.addEventListener('click', (e) => {
    const marker = e.target.closest('[data-marker]');
    if (marker) return jumpTo(marker.dataset.marker);
    const mini = e.target.closest('[data-mini]');
    if (mini) return jumpTo(mini.dataset.mini);
    const range = e.target.closest('[data-seek]');
    if (range) return seekToTime(Number(range.dataset.seek));
    if (e.target.closest('.timeline-cluster, .cluster-wrapper')) return;
    const rect = timeline.getBoundingClientRect();
    const max = timelineMax();
    if (max > 0) seekToTime(((e.clientX - rect.left) / rect.width) * max);
  });

  timeline.addEventListener('mouseover', (e) => {
    const cluster = e.target.closest('.timeline-cluster');
    if (cluster) expandCluster(Number(cluster.dataset.cluster));
  });

  // Hover preview from the storyboard
  timeline.addEventListener('mousemove', (e) => {
    const preview = $('timelinePreview');
    const max = timelineMax();
    if (!preview) return;
    if (!storyboard || max <= 0 || e.target.closest('.cluster-wrapper, .timeline-marker, .timeline-cluster')) {
      preview.style.display = 'none';
      return;
    }
    const rect = timeline.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
    const t = (x / rect.width) * max;
    preview.innerHTML = `${Storyboard.html(storyboard, t, 160)}<span>${formatTime(t)}</span>`;
    preview.style.left = `${Math.min(rect.width - 84, Math.max(84, x))}px`;
    preview.style.display = 'block';
  });
  timeline.addEventListener('mouseleave', () => { const p = $('timelinePreview'); if (p) p.style.display = 'none'; });
}

function expandCluster(clusterIndex) {
  const timeline = $('timeline');
  timeline.querySelector('.cluster-wrapper')?.remove();
  const cluster = timelineClusters[clusterIndex];
  if (!cluster || cluster.annotations.length <= 1) return;
  const clusterEl = timeline.querySelector(`[data-cluster="${clusterIndex}"]`);
  if (!clusterEl) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'cluster-wrapper';
  wrapper.style.cssText = `position:absolute;left:calc(${cluster.position}% - 75px);top:-50px;width:150px;height:160px;z-index:10;`;
  wrapper.onmouseleave = () => {
    wrapper.remove();
    clusterEl.style.opacity = '1';
    clusterEl.style.pointerEvents = 'auto';
  };

  const R = 40, step = (Math.PI * 2) / cluster.annotations.length;
  cluster.annotations.forEach((a, i) => {
    const dot = document.createElement('div');
    dot.className = 'timeline-mini-marker';
    dot.dataset.mini = a.id;
    dot.style.cssText = `position:absolute;left:calc(50% + ${Math.cos(step * i) * R}px);top:calc(50% + ${Math.sin(step * i) * R}px);width:14px;height:14px;background:${STATUS[a.status || 0].color};border:2px solid #1a1a1a;border-radius:50%;cursor:pointer;transform:translate(-50%,-50%);z-index:11;`;
    dot.title = `${a.author}: ${a.text}`;
    wrapper.appendChild(dot);
  });

  timeline.appendChild(wrapper);
  clusterEl.style.opacity = '0';
  clusterEl.style.pointerEvents = 'none';
}

// ── Real-time collaboration ───────────────────────────────────────────────────

function connectSocket() {
  if (socket) return;
  socket = io();
  let connectedOnce = false;

  // Rooms are per-connection: re-join after every (re)connect and catch up on missed changes
  socket.on('connect', () => {
    socket.emit('join-project', projectId);
    if (connectedOnce) resync();
    connectedOnce = true;
  });

  socket.on('annotation:created', (annotation) => {
    if (findAnnotation(annotation.id)) return;
    upsertAnnotation(annotation);
    renderAll();
    showToast(annotation.parent_id ? `${annotation.author} replied to a comment` : `New comment from ${annotation.author}`, 'info');
    scheduleBackup();
  });

  socket.on('annotation:updated', (annotation) => {
    upsertAnnotation({ ...annotation, _shotVersion: annotation.has_screenshot ? Date.now() : undefined });
    if (!annotation.parent_id) repliesOf(annotation.id).forEach(r => { r.timecode = annotation.timecode; });
    renderAll();
    scheduleBackup();
  });

  socket.on('annotation:deleted', ({ id }) => {
    if (!findAnnotation(id)) return;
    annotations = annotations.filter(a => a.id !== id);
    renderAll();
    scheduleBackup();
  });

  socket.on('thread:deleted', ({ parentId }) => {
    annotations = annotations.filter(a => a.id !== parentId && a.parent_id !== parentId);
    if (selectedId === parentId) selectedId = null;
    checked.delete(parentId);
    renderAll();
    scheduleBackup();
  });

  socket.on('annotation:status', (update) => {
    const a = findAnnotation(update.id);
    if (!a) return;
    Object.assign(a, update);
    renderAll();
    scheduleBackup();
  });

  socket.on('project:updated', (updated) => {
    project = { ...project, ...updated };
    tagsConfig = parseTags(project.tags_config);
    renderHeader();
    renderTagSelector();
    renderAll();
    scheduleBackup();
  });

  socket.on('project:deleted', () => {
    showToast('This project has been deleted', 'error');
    $('project-content').style.display = 'none';
    showRestorePanel();
  });
}

async function resync() {
  try {
    const data = await api('GET', `/api/projects/${encodeURIComponent(projectId)}`, undefined, { projectId });
    annotations = data.annotations || [];
    project = data.project;
    renderAll();
    scheduleBackup();
  } catch {}
}

// ── Modals ────────────────────────────────────────────────────────────────────

function openModal(id) { $(id).style.display = 'flex'; }
function closeModals() { document.querySelectorAll('[data-modal]').forEach(m => { m.style.display = 'none'; }); }
function anyModalOpen() { return [...document.querySelectorAll('[data-modal]')].some(m => m.style.display === 'flex'); }

function setupModals() {
  document.querySelectorAll('[data-modal]').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('[data-close]')) modal.style.display = 'none';
    });
  });
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    if (await copyText($(btn.dataset.copy).value)) {
      const old = btn.textContent; btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = old; }, 1500);
    }
  });

  $('shareBtn').addEventListener('click', () => {
    const base = `${window.location.origin}/project/${encodeURIComponent(projectId)}`;
    $('reviewerLink').value = base;
    const showEditor = perms.moderate && project.editor_token;
    $('editorLinkBlock').style.display = showEditor ? '' : 'none';
    if (showEditor) $('editorLink').value = `${base}#key=${project.editor_token}`;
    openModal('share-modal');
  });

  $('settingsBtn').addEventListener('click', () => {
    $('setTitle').value = project.title || '';
    $('setDescription').value = project.description || '';
    $('setTags').value = tagsConfig.join(', ');
    openModal('settings-modal');
  });
  $('saveSettings').addEventListener('click', async () => {
    try {
      const updated = await api('PATCH', `/api/projects/${encodeURIComponent(projectId)}`, {
        title: $('setTitle').value, description: $('setDescription').value, tags_config: $('setTags').value
      }, { projectId });
      project = { ...project, ...updated };
      tagsConfig = parseTags(project.tags_config);
      renderHeader();
      renderTagSelector();
      renderAll();
      closeModals();
      showToast('Settings saved', 'success');
      scheduleBackup();
    } catch (e) { showToast(e.message, 'error'); }
  });

  $('helpBtn').addEventListener('click', () => openModal('help-modal'));
  setupExportModal();
}

const EXPORT_HELP = {
  edl: `<h4>Import into DaVinci Resolve</h4>
    <ol class="tutorial-steps">
      <li>Pick the frame rate and start timecode of your timeline (Resolve timelines start at <strong>01:00:00:00</strong> by default) and click <strong>Download</strong>.</li>
      <li>In the <strong>Media Pool</strong>, right-click your timeline → <strong>Timelines → Import → Timeline Markers from EDL…</strong> and choose the file.</li>
      <li>Markers appear on the timeline colored by status (or tag). Ranges become duration markers; the comment is the marker name.</li>
    </ol>`,
  xml: `<h4>Import into Adobe Premiere Pro</h4>
    <ol class="tutorial-steps">
      <li>Pick your frame rate and click <strong>Download</strong>.</li>
      <li><strong>File → Import…</strong> and select the XML. Premiere creates a sequence <em>“… (review markers)”</em> that carries all comments as markers.</li>
      <li>Drop the reviewed cut (the same render that went to YouTube) at the start of that sequence — the markers line up with the picture. Browse them in <strong>Window → Markers</strong>.</li>
    </ol>
    <div class="tutorial-note">Marker colors are not transferred to Premiere. For comments shown right over the picture, use the SRT export.</div>`,
  srt: `<h4>Show comments on screen</h4>
    <ol class="tutorial-steps">
      <li>Click <strong>Download</strong>. Each comment becomes a subtitle (3 s, or the full range): <em>[Author] text</em>, replies below.</li>
      <li><strong>Premiere Pro:</strong> File → Import the .srt and drag it onto the timeline at the start of the cut — it becomes a caption track.</li>
      <li><strong>DaVinci Resolve:</strong> import the .srt into the Media Pool and drag it onto the timeline — it lands on a subtitle track.</li>
    </ol>
    <div class="tutorial-note">Subtitles are timed from the start of the video, so place them where the cut starts.</div>`,
  csv: `<h4>Spreadsheet</h4>
    <p class="export-hint">Timecodes, authors, comments, tags, status and replies — opens in Excel, Google Sheets or Numbers.</p>`
};

function setupExportModal() {
  const saved = lsGet('ofa_export', {}) || {};
  if (saved.format) $('exportFormat').value = saved.format;
  if (saved.fps) $('exportFps').value = saved.fps;
  if (saved.start) $('exportStart').value = saved.start;
  if (saved.color) $('exportColor').value = saved.color;

  $('exportStatuses').innerHTML = STATUS_ORDER.map(code =>
    `<label class="option-check"><input type="checkbox" value="${code}" checked> ${STATUS[code].icon} ${STATUS[code].label}</label>`).join('');

  const update = () => {
    const format = $('exportFormat').value;
    const show = { fps: format !== 'srt', start: format !== 'srt', color: format === 'edl' };
    document.querySelectorAll('.export-grid [data-for]').forEach(el => { el.style.display = show[el.dataset.for] ? '' : 'none'; });
    $('exportHelp').innerHTML = EXPORT_HELP[format];
    lsSet('ofa_export', { format, fps: $('exportFps').value, start: $('exportStart').value, color: $('exportColor').value });
  };
  ['exportFormat', 'exportFps', 'exportStart', 'exportColor'].forEach(id => $(id).addEventListener('change', update));
  update();

  $('exportBtn').addEventListener('click', () => openModal('export-modal'));
  $('exportDownload').addEventListener('click', () => {
    const format = $('exportFormat').value;
    const statuses = [...document.querySelectorAll('#exportStatuses input:checked')].map(i => i.value);
    if (!statuses.length) { showToast('Select at least one status', 'error'); return; }
    const params = new URLSearchParams({ fps: $('exportFps').value, start: $('exportStart').value, color: $('exportColor').value });
    if (statuses.length < STATUS_ORDER.length) params.set('statuses', statuses.join(','));
    const a = document.createElement('a');
    a.href = `/api/projects/${encodeURIComponent(projectId)}/export/${format}?${params}`;
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  });
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

function setupKeyboard() {
  // Enter sends in every comment field; Shift+Enter adds a line
  document.addEventListener('keydown', (e) => {
    const field = e.target;
    if (field.id === 'commentText' || (field.dataset && field.dataset.submit)) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (field.id === 'commentText') addAnnotation();
        else if (field.dataset.submit === 'reply') submitReply(field.dataset.id);
        else if (field.dataset.submit === 'edit') saveEdit(field.dataset.id);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (field.dataset.submit === 'reply') { openReplies.delete(field.dataset.id); drafts.delete(`reply-${field.dataset.id}`); renderList(); }
        else if (field.dataset.submit === 'edit') { editingId = null; drafts.delete(`edit-${field.dataset.id}`); renderList(); }
        else field.blur();
        return;
      }
    }
    if (field.id === 'authorName' && e.key === 'Enter') { e.preventDefault(); $('commentText').focus(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const typing = e.target instanceof Element && e.target.matches('input, textarea, select, [contenteditable="true"]');
    if (e.key === 'Escape') {
      if (anyModalOpen()) return closeModals();
      if (typing) return e.target.blur();
      if (editingId) { editingId = null; return renderList(); }
      if (selectedId) { selectedId = null; renderList(); return renderTimeline(); }
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '?') { e.preventDefault(); return anyModalOpen() ? closeModals() : openModal('help-modal'); }
    if (anyModalOpen()) return;

    // e.code keeps shortcuts working on non-Latin keyboard layouts
    const sel = selectedId && findAnnotation(selectedId);
    switch (e.code) {
      case 'Space': e.preventDefault(); togglePlayPause(); break;
      case 'KeyK': togglePlayPause(); break;
      case 'KeyJ': shuttle(-1); break;
      case 'KeyL': shuttle(1); break;
      case 'ArrowLeft': e.preventDefault(); seekRelative(e.shiftKey ? -10 : -5); break;
      case 'ArrowRight': e.preventDefault(); seekRelative(e.shiftKey ? 10 : 5); break;
      case 'Comma': stepFrame(-1); break;
      case 'Period': stepFrame(1); break;
      case 'KeyA': case 'KeyC': e.preventDefault(); $('commentText').focus(); break;
      case 'KeyI': setRangePoint('in'); break;
      case 'KeyO': setRangePoint('out'); break;
      case 'KeyX': clearRange(); break;
      case 'KeyS': toggleAttachFrame(); break;
      case 'KeyN': navigateComments(1); break;
      case 'KeyP': navigateComments(-1); break;
      case 'Slash': e.preventDefault(); $('filterSearch').focus(); break;
      case 'KeyR':
        if (sel) {
          e.preventDefault();
          const rootId = sel.parent_id || sel.id;
          openReplies.add(rootId);
          renderList();
          document.querySelector(`[data-draft="reply-${CSS.escape(rootId)}"]`)?.focus();
        }
        break;
      case 'KeyE': if (sel && isOwn(sel)) { e.preventDefault(); startEdit(sel.id); } break;
      case 'Digit1': if (sel) setStatus(sel.id, 1); break;
      case 'Digit2': if (sel) setStatus(sel.id, 2); break;
      case 'Digit3': if (sel) setStatus(sel.id, 3); break;
      case 'Digit0': if (sel && sel.status) setStatus(sel.id, sel.status); break;
      case 'Delete': case 'Backspace':
        if (sel && (isOwn(sel) || perms.moderate)) { e.preventDefault(); deleteAnnotation(sel.id); }
        break;
    }
  });
}

// Next/previous visible comment relative to the selection, or to the playhead
function navigateComments(direction) {
  const list = visibleRoots();
  if (!list.length) return;
  let idx = list.findIndex(a => a.id === selectedId);
  if (idx === -1) {
    const t = currentTime();
    idx = direction > 0
      ? list.findIndex(a => a.timecode > t + 0.05)
      : list.map(a => a.timecode < t - 0.05).lastIndexOf(true);
    if (idx === -1) idx = direction > 0 ? 0 : list.length - 1;
  } else {
    idx = (idx + direction + list.length) % list.length;
  }
  selectAnnotation(list[idx].id, { seek: true, scroll: true });
  renderTimeline();
}
