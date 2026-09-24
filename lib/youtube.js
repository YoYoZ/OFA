// YouTube helpers: link parsing and storyboard (seek-preview sprite sheet) lookup.

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Accepts watch / youtu.be / embed / shorts / live / mobile links; returns the 11-char video ID or null.
function parseYouTubeId(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      const [, kind, value] = url.pathname.split('/');
      if (['embed', 'v', 'shorts', 'live'].includes(kind)) id = value;
    }
  }
  return id && YOUTUBE_ID_RE.test(id) ? id : null;
}

// Storyboard spec looks like:
//   https://i.ytimg.com/sb/ID/storyboard3_L$L/$N.jpg?sqp=...|48#27#100#10#10#0#default#rs$...|80#45#108#10#10#2000#M$M#rs$...
// Each level after the base URL: width#height#count#cols#rows#intervalMs#name#sigh
function parseStoryboardSpec(spec, durationSeconds) {
  const [base, ...levelSpecs] = String(spec).split('|');
  if (!base || !base.startsWith('https://i.ytimg.com/')) return [];
  return levelSpecs.map((raw, index) => {
    const [width, height, count, cols, rows, interval, name, sigh] = raw.split('#');
    const level = {
      width: +width, height: +height, count: +count, cols: +cols, rows: +rows,
      interval: +interval, name, sigh,
      url: base.replace('$L', String(index))
    };
    // Level 0 is spread evenly across the video instead of a fixed interval
    if (!level.interval && durationSeconds > 0 && level.count > 0) {
      level.interval = Math.round((durationSeconds * 1000) / level.count);
    }
    return level;
  }).filter(l => l.width > 0 && l.height > 0 && l.count > 0 && l.cols > 0 && l.rows > 0 && l.interval > 0 && l.name && l.sigh);
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

async function fetchStoryboard(videoId) {
  const cached = cache.get(videoId);
  if (cached && cached.expires > Date.now()) return cached.value;

  let value = { duration: 0, levels: [] };
  let ttl = FAILURE_TTL_MS;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        // Skip the EU cookie-consent interstitial
        Cookie: 'SOCS=CAI; CONSENT=YES+1'
      }
    });
    clearTimeout(timer);
    if (res.ok) {
      const html = await res.text();
      const specMatch = html.match(/"playerStoryboardSpecRenderer":\{"spec":"((?:[^"\\]|\\.)+)"/);
      const lengthMatch = html.match(/"lengthSeconds":"(\d+)"/);
      const duration = lengthMatch ? parseInt(lengthMatch[1], 10) : 0;
      if (specMatch) {
        const spec = JSON.parse(`"${specMatch[1]}"`);
        value = { duration, levels: parseStoryboardSpec(spec, duration) };
        if (value.levels.length) ttl = CACHE_TTL_MS;
      } else {
        value.duration = duration;
      }
    }
  } catch (err) {
    console.warn(`Storyboard fetch failed for ${videoId}: ${err.message}`);
  }

  cache.set(videoId, { value, expires: Date.now() + ttl });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

module.exports = { parseYouTubeId, parseStoryboardSpec, fetchStoryboard };
