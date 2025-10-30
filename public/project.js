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
        if (savedAuthor) {
            authorInput.value = savedAuthor;
            console.log('✅ Loaded author');
        }
    } catch (e) {}

    authorInput.addEventListener('input', function(e) {
        try { localStorage.setItem('author_name', e.target.value); } catch (err) {}
    });

    authorInput.addEventListener('blur', function(e) {
        try { localStorage.setItem('author_name', e.target.value); } catch (err) {}
    });

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

function playRejectSound() {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioContext.currentTime;

    // Два низких звука для "отклонения"
    [300, 200].forEach((freq, i) => {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.connect(gain);
        gain.connect(audioContext.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.15, now + i * 0.15);
        gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.15 + 0.4);
        osc.start(now + i * 0.15);
        osc.stop(now + i * 0.15 + 0.4);
    });
}

function onYouTubeIframeAPIReady() {
    console.log('🎬 YouTube API ready');
    isYouTubeReady = true;

    if (isProjectLoaded && projectData) {
        initializePlayer();
    }
}

async function loadProject(projectId) {
    try {
        const response = await fetch(`/api/projects/${projectId}`);

        if (!response.ok) {
            throw new Error('Project not found');
        }

        projectData = await response.json();
        annotations = projectData.annotations || [];
        isProjectLoaded = true;

        console.log('📦 Project loaded', projectData);

        updateAnnotationsList();
        updateTimeline();

        document.getElementById('loading').style.display = 'none';
        document.getElementById('project-content').style.display = 'block';

        tryInitializePlayer();

    } catch (error) {
        console.error('❌ Error loading project:', error);
        document.getElementById('loading').textContent = 'Error: ' + error.message;
    }
}

function tryInitializePlayer() {
    playerInitAttempts++;
    console.log(`🎬 Attempt ${playerInitAttempts} to initialize player`);

    if (typeof YT !== 'undefined' && typeof YT.Player === 'function') {
        console.log('✅ YouTube API is ready');
        isYouTubeReady = true;
        initializePlayer();
    } else if (playerInitAttempts < 20) {
        console.log('⏳ YouTube API not ready, retrying in 200ms...');
        setTimeout(tryInitializePlayer, 200);
    } else {
        console.error('❌ YouTube API failed to load');
        alert('Failed to load YouTube player. Please refresh the page.');
    }
}

function initializePlayer() {
    if (player && typeof player.getPlayerState === 'function') {
        console.log('⚠️ Player already initialized');
        return;
    }

    console.log('🎬 Initializing player...');

    if (!projectData || !projectData.project) {
        console.error('❌ No project data');
        return;
    }

    if (!isYouTubeReady) {
        console.log('⏳ YouTube API not ready yet');
        return;
    }

    const videoId = extractVideoId(projectData.project.youtube_url);

    if (!videoId) {
        console.error('❌ Invalid YouTube URL');
        document.getElementById('loading').textContent = 'Invalid YouTube link';
        return;
    }

    console.log('🎬 Creating player for video:', videoId);

    try {
        const playerDiv = document.getElementById('youtube-player');
        playerDiv.innerHTML = '';

        player = new YT.Player('youtube-player', {
            height: '450',
            width: '800',
            videoId: videoId,
            playerVars: {
                'autoplay': 0,
                'playsinline': 1,
                'rel': 0,
                'modestbranding': 1,
                'origin': window.location.origin,
                'enablejsapi': 1
            },
            events: {
                'onReady': onPlayerReady,
                'onStateChange': onPlayerStateChange,
                'onError': onPlayerError
            }
        });

        console.log('✅ Player created successfully');
    } catch (error) {
        console.error('❌ Error creating player:', error);
        alert('Error creating player: ' + error.message);
    }
}

function onPlayerReady(event) {
    console.log('✅ Player ready');

    setTimeout(() => {
        try {
            videoDuration = player.getDuration();
            if (videoDuration && videoDuration > 0) {
                console.log('⏱️ Video duration:', videoDuration);
                updateTimeline();
            } else {
                console.log('⏳ Duration not available yet');
            }
        } catch (e) {
            console.error('Error getting duration:', e);
        }
    }, 500);

    setInterval(updateCurrentTime, 1000);
}

function onPlayerStateChange(event) {
    console.log('Player state changed:', event.data);

    if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.BUFFERING) {
        try {
            const newDuration = player.getDuration();
            if (newDuration && newDuration > 0 && newDuration !== videoDuration) {
                videoDuration = newDuration;
                console.log('⏱️ Updated duration:', videoDuration);
                updateTimeline();
            }
        } catch (e) {
            console.error('Error updating duration:', e);
        }
    }
}

function onPlayerError(event) {
    console.error('❌ Player error:', event.data);
    let errorMsg = 'Video playback error.';
    switch(event.data) {
        case 2:
            errorMsg += ' Invalid video ID.';
            break;
        case 5:
            errorMsg += ' HTML5 player error.';
            break;
        case 100:
            errorMsg += ' Video not found or deleted.';
            break;
        case 101:
        case 150:
            errorMsg += ' Video owner disabled embedding.';
            break;
    }
    alert(errorMsg);
}

function updateCurrentTime() {
    if (player && player.getCurrentTime) {
        try {
            const currentTime = player.getCurrentTime();
            document.getElementById('currentTime').textContent = formatTime(currentTime);
        } catch (e) {}
    }
}

async function addAnnotation() {
    const author = document.getElementById('authorName').value.trim();
    const text = document.getElementById('commentText').value.trim();

    if (!author || !text) {
        alert('Please fill in all fields');
        return;
    }

    if (!player || !player.getCurrentTime) {
        alert('Player is not ready');
        return;
    }

    let timecode;
    try {
        timecode = player.getCurrentTime();
    } catch (e) {
        alert('Error getting current time');
        return;
    }

    try {
        localStorage.setItem('author_name', author);
    } catch (e) {}

    const projectId = window.location.pathname.split('/').pop();

    try {
        const response = await fetch(`/api/projects/${projectId}/annotations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ author, text, timecode })
        });

        if (!response.ok) {
            throw new Error('Error adding comment');
        }

        const newAnnotation = await response.json();
        annotations.push(newAnnotation);
        annotations.sort((a, b) => a.timecode - b.timecode);

        updateAnnotationsList();
        updateTimeline();

        document.getElementById('commentText').value = '';
        console.log('✅ Comment added');

    } catch (error) {
        console.error('❌ Error adding comment:', error);
        alert('Error adding comment');
    }
}

async function deleteAnnotation(annotationId) {
    if (!confirm('Delete this comment?')) {
        return;
    }

    try {
        const response = await fetch(`/api/annotations/${annotationId}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            throw new Error('Error deleting comment');
        }

        annotations = annotations.filter(a => a.id !== annotationId);

        updateAnnotationsList();
        updateTimeline();

        playTrashSound();

        console.log('✅ Comment deleted');

    } catch (error) {
        console.error('❌ Error deleting comment:', error);
        alert('Error deleting comment');
    }
}

async function updateAnnotationStatus(annotationId, status) {
    // status: 0 = pending (yellow), 1 = accepted (green), 2 = rejected (red)
    const annotation = annotations.find(a => a.id === annotationId);
    if (!annotation) return;

    try {
        const response = await fetch(`/api/annotations/${annotationId}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ status: status })
        });

        if (!response.ok) {
            throw new Error('Error updating status');
        }

        annotation.status = status;

        updateAnnotationsList();
        updateTimeline();

        if (status === 1) {
            playBellSound();
        } else if (status === 2) {
            playRejectSound();
        }

    } catch (error) {
        console.error('❌ Error updating status:', error);
        alert('Error updating comment status');
    }
}

function updateAnnotationsList() {
    const list = document.getElementById('annotationsList');
    const count = document.getElementById('annotationsCount');

    count.textContent = annotations.length;

    if (annotations.length === 0) {
        list.innerHTML = '<p style="color: #9e9e9e; text-align: center;">No comments yet</p>';
        return;
    }

    list.innerHTML = annotations.map(annotation => {
        // Если есть поле resolved (старая система), преобразуем в status
        let status = annotation.status !== undefined ? annotation.status : (annotation.resolved ? 1 : 0);

        let statusClass = 'pending';
        let statusText = 'Pending';
        let statusEmoji = '◯';

        if (status === 1) {
            statusClass = 'accepted';
            statusText = '✓ Accept';
            statusEmoji = '✓';
        } else if (status === 2) {
            statusClass = 'rejected';
            statusText = '✗ Reject';
            statusEmoji = '✗';
        }

        return `
        <div class="annotation-item ${statusClass}" data-id="${annotation.id}">
            <div class="annotation-meta">
                <span class="annotation-author">${escapeHtml(annotation.author)}</span>
                <span class="annotation-timecode" onclick="seekToTime(${annotation.timecode})">${formatTime(annotation.timecode)}</span>
            </div>
            <div class="annotation-text">${escapeHtml(annotation.text)}</div>
            <div class="annotation-actions">
                <button class="delete-btn" onclick="deleteAnnotation('${annotation.id}')">
                    🗑️ Delete
                </button>
                <button class="reject-btn ${status === 2 ? 'active' : ''}" onclick="updateAnnotationStatus('${annotation.id}', 2)">
                    ✗ Reject
                </button>
                <button class="accept-btn ${status === 1 ? 'active' : ''}" onclick="updateAnnotationStatus('${annotation.id}', 1)">
                    ✓ Accept
                </button>
            </div>
        </div>
        `;
    }).join('');
}

function clusterAnnotations(annotations, maxTime) {
    if (annotations.length === 0) return [];

    const clusterRadius = 2;
    const clusters = [];

    annotations.forEach(annotation => {
        const position = (annotation.timecode / maxTime) * 100;

        let foundCluster = clusters.find(cluster => 
            Math.abs(cluster.position - position) < clusterRadius
        );

        if (foundCluster) {
            foundCluster.annotations.push(annotation);
            foundCluster.position = foundCluster.annotations.reduce((sum, a) => 
                sum + (a.timecode / maxTime) * 100, 0) / foundCluster.annotations.length;
        } else {
            clusters.push({
                position: position,
                annotations: [annotation]
            });
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

    let markersHtml = '<div class="timeline-line"></div>';

    const clusters = clusterAnnotations(annotations, maxTime);

    clusters.forEach((cluster, clusterIndex) => {
        const isCluster = cluster.annotations.length > 1;

        if (isCluster) {
            const hasAccepted = cluster.annotations.some(a => (a.status !== undefined ? a.status === 1 : a.resolved));
            const hasRejected = cluster.annotations.some(a => a.status === 2);
            const hasPending = cluster.annotations.some(a => (a.status !== undefined ? a.status === 0 : !a.resolved && !a.status));

            let color = '#ffd700'; // yellow по умолчанию
            if (hasAccepted && !hasRejected && !hasPending) {
                color = '#52b788'; // green - все приняты
            } else if (hasRejected && !hasAccepted && !hasPending) {
                color = '#e74c3c'; // red - все отклонены
            } else if (hasAccepted || hasRejected) {
                color = '#ffd700'; // yellow - смесь статусов
            }

            const titles = cluster.annotations.map(a => 
                `${escapeHtml(a.author)}: ${escapeHtml(a.text)}`
            ).join('\n');

            markersHtml += `
                <div class="timeline-cluster" 
                     data-cluster="${clusterIndex}"
                     style="left: ${cluster.position}%; background-color: ${color};"
                     onmouseenter="expandCluster(${clusterIndex}, ${cluster.position})"
                     title="${titles}">
                    <span class="cluster-count">${cluster.annotations.length}</span>
                </div>
            `;
        } else {
            const annotation = cluster.annotations[0];
            let status = annotation.status !== undefined ? annotation.status : (annotation.resolved ? 1 : 0);

            let color = '#ffd700'; // yellow - pending
            if (status === 1) color = '#52b788'; // green - accepted
            if (status === 2) color = '#e74c3c'; // red - rejected

            markersHtml += `
                <div class="timeline-marker" 
                     style="left: ${cluster.position}%; background-color: ${color};" 
                     onclick="seekToTime(${annotation.timecode})"
                     title="${escapeHtml(annotation.author)}: ${escapeHtml(annotation.text)} (${formatTime(annotation.timecode)})">
                </div>
            `;
        }
    });

    timeline.innerHTML = markersHtml;

    timeline.dataset.clusters = JSON.stringify(clusters.map(c => ({
        position: c.position,
        annotations: c.annotations.map(a => ({
            id: a.id,
            timecode: a.timecode,
            status: a.status !== undefined ? a.status : (a.resolved ? 1 : 0),
            author: a.author,
            text: a.text
        }))
    })));
}

function expandCluster(clusterIndex, centerPos) {
    const timeline = document.getElementById('timeline');

    const oldWrapper = timeline.querySelector('.cluster-wrapper');
    if (oldWrapper) oldWrapper.remove();

    const clustersData = JSON.parse(timeline.dataset.clusters || '[]');
    const cluster = clustersData[clusterIndex];
    if (!cluster || cluster.annotations.length <= 1) return;

    const clusterEl = timeline.querySelector(`[data-cluster="${clusterIndex}"]`);
    if (!clusterEl) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'cluster-wrapper';
    wrapper.style.position = 'absolute';
    wrapper.style.left = `calc(${centerPos}% - 75px)`;
    wrapper.style.top = '-50px';
    wrapper.style.width = '150px';
    wrapper.style.height = '160px';
    wrapper.style.zIndex = '10';

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

        let color = '#ffd700'; // yellow - pending
        if (annotation.status === 1) color = '#52b788'; // green - accepted
        if (annotation.status === 2) color = '#e74c3c'; // red - rejected

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
    if (player && player.seekTo) {
        try {
            player.seekTo(seconds, true);
            player.playVideo();
        } catch (e) {
            console.error('Error seeking:', e);
        }
    }
}

function extractVideoId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=)([^&]+)/,
        /(?:youtube\.com\/embed\/)([^?]+)/,
        /(?:youtu\.be\/)([^?]+)/,
        /(?:youtube\.com\/v\/)([^?]+)/
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }

    return null;
}

function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}