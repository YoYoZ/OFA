let player;
let projectData;
let annotations = [];
let isYouTubeReady = false;
let isProjectLoaded = false;
let videoDuration = 0;
let playerInitAttempts = 0;

document.addEventListener('DOMContentLoaded', function() {
    const projectId = window.location.pathname.split('/').pop();
    const authorInput = document.getElementById('authorName');
    try {
        const savedAuthor = localStorage.getItem('author_name');
        if (savedAuthor) authorInput.value = savedAuthor;
    } catch (e) {}
    authorInput.addEventListener('input', (e) => { try { localStorage.setItem('author_name', e.target.value); } catch {} });
    authorInput.addEventListener('blur', (e) => { try { localStorage.setItem('author_name', e.target.value); } catch {} });
    document.getElementById('addAnnotation').addEventListener('click', addAnnotation);
    loadProject(projectId);
});

function playBellSound() {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioContext.currentTime;
    [800, 1000, 1200].forEach((freq, i) => {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.connect(gain);
        gain.connect(audioContext.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.09, now + i * 0.1);
        gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.1 + 0.5);
        osc.start(now + i * 0.1);
        osc.stop(now + i * 0.1 + 0.5);
    });
}

function playTrashSound() {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioContext.currentTime;
    const bufferSize = audioContext.sampleRate * 0.3;
    const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = audioContext.createBufferSource();
    noise.buffer = buffer;
    const filter = audioContext.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 300;
    filter.Q.value = 5;
    const gainNode = audioContext.createGain();
    gainNode.gain.setValueAtTime(0.4, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    noise.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(audioContext.destination);
    noise.start(now);
    noise.stop(now + 0.3);
}

function onYouTubeIframeAPIReady() {
    isYouTubeReady = true;
    if (isProjectLoaded && projectData) initializePlayer();
}

async function loadProject(projectId) {
    try {
        const response = await fetch(`/api/projects/${projectId}`);
        if (!response.ok) throw new Error('Проект не найден');
        projectData = await response.json();
        annotations = projectData.annotations || [];
        isProjectLoaded = true;
        updateAnnotationsList();
        updateTimeline();
        document.getElementById('loading').style.display = 'none';
        document.getElementById('project-content').style.display = 'block';
        tryInitializePlayer();
    } catch (error) {
        document.getElementById('loading').textContent = 'Ошибка: ' + error.message;
    }
}

function tryInitializePlayer() {
    playerInitAttempts++;
    if (typeof YT !== 'undefined' && typeof YT.Player === 'function') {
        isYouTubeReady = true;
        initializePlayer();
    } else if (playerInitAttempts < 20) {
        setTimeout(tryInitializePlayer, 200);
    }
}

function initializePlayer() {
    if (player && typeof player.getPlayerState === 'function') return;
    if (!projectData?.project || !isYouTubeReady) return;
    const videoId = extractVideoId(projectData.project.youtube_url);
    if (!videoId) return;
    const playerDiv = document.getElementById('youtube-player');
    playerDiv.innerHTML = '';
    player = new YT.Player('youtube-player', {
        height: '450', width: '800', videoId: videoId,
        playerVars: { 'autoplay': 0, 'playsinline': 1, 'rel': 0, 'modestbranding': 1, 'origin': window.location.origin, 'enablejsapi': 1 },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}

function onPlayerReady() {
    setTimeout(() => {
        try {
            videoDuration = player.getDuration();
            if (videoDuration > 0) updateTimeline();
        } catch (e) {}
    }, 500);
    setInterval(updateCurrentTime, 1000);
}

function onPlayerStateChange(event) {
    if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.BUFFERING) {
        try {
            const newDuration = player.getDuration();
            if (newDuration > 0 && newDuration !== videoDuration) {
                videoDuration = newDuration;
                updateTimeline();
            }
        } catch (e) {}
    }
}

function updateCurrentTime() {
    if (player?.getCurrentTime) {
        try { document.getElementById('currentTime').textContent = formatTime(player.getCurrentTime()); } catch (e) {}
    }
}

async function addAnnotation() {
    const author = document.getElementById('authorName').value.trim();
    const text = document.getElementById('commentText').value.trim();
    if (!author || !text || !player?.getCurrentTime) return;
    let timecode;
    try { timecode = player.getCurrentTime(); } catch { return; }
    try { localStorage.setItem('author_name', author); } catch {}
    const projectId = window.location.pathname.split('/').pop();
    try {
        const response = await fetch(`/api/projects/${projectId}/annotations`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ author, text, timecode })
        });
        if (!response.ok) return;
        const newAnnotation = await response.json();
        annotations.push(newAnnotation);
        annotations.sort((a, b) => a.timecode - b.timecode);
        updateAnnotationsList();
        updateTimeline();
        document.getElementById('commentText').value = '';
    } catch {}
}

async function deleteAnnotation(annotationId) {
    if (!confirm('Удалить?')) return;
    try {
        await fetch(`/api/annotations/${annotationId}`, { method: 'DELETE' });
        annotations = annotations.filter(a => a.id !== annotationId);
        updateAnnotationsList();
        updateTimeline();
        playTrashSound();
    } catch {}
}

async function toggleResolve(annotationId) {
    const annotation = annotations.find(a => a.id === annotationId);
    if (!annotation) return;
    const newResolvedState = annotation.resolved ? 0 : 1;
    try {
        await fetch(`/api/annotations/${annotationId}/resolve`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolved: newResolvedState })
        });
        annotation.resolved = newResolvedState;
        updateAnnotationsList();
        updateTimeline();
        if (newResolvedState === 1) playBellSound();
    } catch {}
}

function updateAnnotationsList() {
    const list = document.getElementById('annotationsList');
    const count = document.getElementById('annotationsCount');
    count.textContent = annotations.length;
    if (annotations.length === 0) {
        list.innerHTML = '<p style="color: #9e9e9e; text-align: center;">Нет комментариев</p>';
        return;
    }
    list.innerHTML = annotations.map(a => `
        <div class="annotation-item ${a.resolved ? 'resolved' : ''}">
            <div class="annotation-meta">
                <span class="annotation-author">${escapeHtml(a.author)}</span>
                <span class="annotation-timecode" onclick="seekToTime(${a.timecode})">${formatTime(a.timecode)}</span>
            </div>
            <div class="annotation-text">${escapeHtml(a.text)}</div>
            <div class="annotation-actions">
                <button class="delete-btn" onclick="deleteAnnotation('${a.id}')">🗑️ Удалить</button>
                <button class="resolve-btn ${a.resolved ? 'resolved' : ''}" onclick="toggleResolve('${a.id}')">
                    ${a.resolved ? '✓ Принято' : '✓ Принять'}
                </button>
            </div>
        </div>
    `).join('');
}

function clusterAnnotations(annotations, maxTime) {
    if (annotations.length === 0) return [];
    const clusterRadius = 2;
    const clusters = [];
    annotations.forEach(annotation => {
        const position = (annotation.timecode / maxTime) * 100;
        let found = clusters.find(c => Math.abs(c.position - position) < clusterRadius);
        if (found) {
            found.annotations.push(annotation);
            found.position = found.annotations.reduce((sum, a) => sum + (a.timecode / maxTime) * 100, 0) / found.annotations.length;
        } else {
            clusters.push({ position, annotations: [annotation] });
        }
    });
    return clusters;
}

function updateTimeline() {
    const timeline = document.getElementById('timeline');
    if (annotations.length === 0) {
        timeline.innerHTML = '<div class="timeline-line"></div>';
        return;
    }
    const maxTime = videoDuration > 0 ? videoDuration : Math.max(...annotations.map(a => a.timecode)) + 60;
    let html = '<div class="timeline-line"></div>';
    const clusters = clusterAnnotations(annotations, maxTime);

    clusters.forEach((cluster, idx) => {
        if (cluster.annotations.length > 1) {
            const hasUnresolved = cluster.annotations.some(a => !a.resolved);
            const hasResolved = cluster.annotations.some(a => a.resolved);
            let color = '#ffd700';
            if (hasUnresolved && !hasResolved) color = '#ff6b6b';
            else if (hasResolved && !hasUnresolved) color = '#52b788';
            html += `<div class="timeline-cluster" data-cluster="${idx}" style="left: ${cluster.position}%; background-color: ${color};" onmouseenter="expandCluster(${idx}, ${cluster.position})">
                <span class="cluster-count">${cluster.annotations.length}</span>
            </div>`;
        } else {
            const a = cluster.annotations[0];
            const color = a.resolved ? '#52b788' : '#ff6b6b';
            html += `<div class="timeline-marker" style="left: ${cluster.position}%; background-color: ${color};" onclick="seekToTime(${a.timecode})"></div>`;
        }
    });
    timeline.innerHTML = html;
    timeline.dataset.clusters = JSON.stringify(clusters.map(c => ({
        position: c.position,
        annotations: c.annotations.map(a => ({ id: a.id, timecode: a.timecode, resolved: a.resolved, author: a.author, text: a.text }))
    })));
}

// КЛЮЧЕВОЕ: ОДНА обёртка на ВСЁ облачко!
function expandCluster(clusterIndex, centerPos) {
    const timeline = document.getElementById('timeline');

    // Удаляем старое облачко если есть
    const oldWrapper = timeline.querySelector('.cluster-wrapper');
    if (oldWrapper) oldWrapper.remove();

    const clustersData = JSON.parse(timeline.dataset.clusters || '[]');
    const cluster = clustersData[clusterIndex];
    if (!cluster || cluster.annotations.length <= 1) return;

    const clusterEl = timeline.querySelector(`[data-cluster="${clusterIndex}"]`);
    if (!clusterEl) return;

    // ОБЁРТКА на всё облачко - ОДИН onmouseleave!
    const wrapper = document.createElement('div');
    wrapper.className = 'cluster-wrapper';
    wrapper.style.position = 'absolute';
    wrapper.style.left = `calc(${centerPos}% - 60px)`;
    wrapper.style.top = '-60px';
    wrapper.style.width = '120px';
    wrapper.style.height = '180px';
    wrapper.style.zIndex = '10';
    // Для отладки раскомментируй:
    // wrapper.style.background = 'rgba(0,255,0,0.1)';

    // ОДИН обработчик на ВСЕЙ обёртке!
    wrapper.onmouseleave = () => {
        wrapper.remove();
        clusterEl.style.opacity = '1';
        clusterEl.style.pointerEvents = 'auto';
    };

    const cloudRadius = 40;
    const angleStep = (Math.PI * 2) / cluster.annotations.length;

    cluster.annotations.forEach((annotation, i) => {
        const angle = angleStep * i;
        const offsetX = Math.cos(angle) * cloudRadius;
        const offsetY = Math.sin(angle) * cloudRadius;
        const color = annotation.resolved ? '#52b788' : '#ff6b6b';

        const dot = document.createElement('div');
        dot.className = 'timeline-mini-marker';
        dot.style.position = 'absolute';
        dot.style.left = `calc(50% + ${offsetX}px)`;
        dot.style.top = `calc(50% + ${offsetY}px)`;
        dot.style.width = '14px';
        dot.style.height = '14px';
        dot.style.backgroundColor = color;
        dot.style.border = '2px solid #1a1a1a';
        dot.style.borderRadius = '50%';
        dot.style.cursor = 'pointer';
        dot.style.transform = 'translate(-50%, -50%)';
        dot.style.zIndex = '11';
        dot.title = `${annotation.author}: ${annotation.text}`;
        dot.onclick = (e) => {
            e.stopPropagation();
            seekToTime(annotation.timecode);
        };

        wrapper.appendChild(dot);
    });

    timeline.appendChild(wrapper);
    clusterEl.style.opacity = '0';
    clusterEl.style.pointerEvents = 'none';
}

function seekToTime(seconds) {
    if (player?.seekTo) {
        try {
            player.seekTo(seconds, true);
            player.playVideo();
        } catch (e) {}
    }
}

function extractVideoId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=)([^&]+)/,
        /(?:youtu\.be\/)([^?]+)/
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m?.[1]) return m[1];
    }
    return null;
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}