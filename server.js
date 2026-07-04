import express from 'express';
import * as cheerio from 'cheerio';
import { pathToFileURL } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = 'https://totalsportek24.is';

app.use(express.static('public'));

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

async function fetchWithHeaders(url, extraHeaders = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const headers = { ...BROWSER_HEADERS, ...extraHeaders };
    const res = await fetch(url, { signal: ctrl.signal, headers, redirect: 'follow' });
    return { text: () => res.text(), buffer: () => res.arrayBuffer(), status: res.status, headers: res.headers };
  } finally {
    clearTimeout(t);
  }
}

function gameUrlToDirect(url) {
  return url.replace('totalsportek24.is', 'totalsportekx.is');
}

function hexToString(hex) {
  return Buffer.from(hex, 'hex').toString('utf-8');
}

function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

function base64Decode(str) {
  try { return Buffer.from(str, 'base64').toString('utf-8'); } catch { return ''; }
}

async function tryDecodeHexWorker(text, pageUrl, results) {
  const hexRegex = /_hexDec\(["']([a-f0-9]{50,})["']\)/;
  const m = text.match(hexRegex);
  if (!m) return;
  try {
    const workerUrl = hexToString(m[1]);
    const resp = await fetchWithHeaders(workerUrl, {
      'Accept': 'application/json, text/plain, */*',
      'Origin': new URL(pageUrl).origin,
      'Referer': pageUrl,
    });
    if (resp.status !== 200) return;
    const json = JSON.parse(await resp.text());
    if (json.stream) {
      results.sources.push({
        type: json.stream.includes('.m3u8') ? 'hls' : 'video',
        url: json.stream,
        quality: 'HD',
        referer: workerUrl,
      });
    }
  } catch {}
}

async function tryCloudflareWorkerDirect(text, pageUrl, results) {
  const cfPatterns = [
    /(?:fetch|getStream|getUrl)\s*\(\s*["'](https?:\/\/[^'"]*workers\.dev[^'"]*)["']/,
    /["'](https?:\/\/[a-z]+-[a-z]+-\d+[a-z]+\.[a-z0-9]+\.workers\.dev[^"']*)["']/,
    /url\s*[:=]\s*["'](https?:\/\/[^'"]*workers\.dev[^'"]*)["']/,
  ];
  for (const pat of cfPatterns) {
    const m = text.match(pat);
    if (!m) continue;
    try {
      const resp = await fetchWithHeaders(m[1], {
        'Accept': 'application/json, text/plain, */*',
        'Origin': new URL(pageUrl).origin,
        'Referer': pageUrl,
      });
      if (resp.status !== 200) continue;
      const body = await resp.text();
      let json;
      try { json = JSON.parse(body); } catch { continue; }
      if (json.stream) {
        results.sources.push({
          type: json.stream.includes('.m3u8') ? 'hls' : 'video',
          url: json.stream,
          quality: 'HD',
          referer: m[1],
        });
      }
    } catch {}
  }
}

function tryBase64Encoded(text, results) {
  // Look for base64 blobs that decode to something with .m3u8
  const b64Pat = /["']([A-Za-z0-9+/]{50,}={0,2})["']/g;
  let match;
  while ((match = b64Pat.exec(text)) !== null) {
    try {
      const decoded = base64Decode(match[1]);
      if (decoded.includes('.m3u8')) {
        const urls = decoded.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/g);
        if (urls) {
          for (const url of urls) {
            if (!results.sources.find(s => s.url === url))
              results.sources.push({ type: 'hls', url, quality: 'HD' });
          }
        }
      }
    } catch {}
  }
}

function tryScriptVars(text, results) {
  // Look for var/let/const assignments containing m3u8 URLs
  const patterns = [
    /(?:src|source|stream|url|link|videoSrc|hls)\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /["']([^"']+\.m3u8[^"']*)["']/g,
  ];
  for (const pat of patterns) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(text)) !== null) {
      const url = m[1];
      if (url.includes('.m3u8') && !results.sources.find(s => s.url === url)) {
        results.sources.push({ type: 'hls', url, quality: 'HD' });
      }
    }
  }
}

function tryJsonConfigs($, results) {
  $('script[type="application/json"], script[type="text/javascript"]').each((i, el) => {
    const raw = $(el).html() || '';
    // Try parsing as JSON
    try {
      const obj = JSON.parse(raw);
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        for (const v of Object.values(o)) {
          if (typeof v === 'string' && v.includes('.m3u8') && !results.sources.find(s => s.url === v))
            results.sources.push({ type: 'hls', url: v, quality: 'HD' });
          else if (typeof v === 'object') walk(v);
        }
      };
      walk(obj);
    } catch {}
  });
}

function tryDataAttrs($, results) {
  $('[data-src], [data-url], [data-stream], [data-hls], [data-video], [data-source]').each((i, el) => {
    for (const attr of ['data-src', 'data-url', 'data-stream', 'data-hls', 'data-video', 'data-source']) {
      const val = $(el).attr(attr);
      if (val && val.includes('.m3u8') && !results.sources.find(s => s.url === val))
        results.sources.push({ type: 'hls', url: val, quality: 'HD' });
    }
  });
}

function tryMetaRefresh(text, pageUrl, results) {
  const m = text.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["']\d*;?\s*url=([^"']+)["']/i);
  if (m) {
    const target = m[1].startsWith('http') ? m[1] : new URL(m[1], pageUrl).href;
    results.sources.push({ type: 'redirect', url: target, quality: 'HD' });
  }
}

function tryAtobCalls(text, results) {
  // Look for atob("...") calls that might decode to a URL
  const atobPat = /(?:atob|btoa)\s*\(\s*["']([A-Za-z0-9+/]{20,}={0,2})["']\s*\)/g;
  let m;
  while ((m = atobPat.exec(text)) !== null) {
    try {
      const decoded = Buffer.from(m[1], 'base64').toString('utf-8');
      if (decoded.includes('.m3u8')) {
        const urls = decoded.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/g);
        if (urls) {
          for (const url of urls) {
            if (!results.sources.find(s => s.url === url))
              results.sources.push({ type: 'hls', url, quality: 'HD' });
          }
        }
      }
    } catch {}
  }
}

function tryConcatUrls(text, results) {
  // Look for URLs built by concatenation: "https://" + "domain.com/" + "path/file.m3u8"
  const concatPat = /["']([^"']+)["']\s*\+\s*["']([^"']+)["'](?:\s*\+\s*["']([^"']+)["'])?(?:\s*\+\s*["']([^"']+)["'])?/g;
  let m;
  while ((m = concatPat.exec(text)) !== null) {
    try {
      const parts = m.slice(1).filter(Boolean);
      const combined = parts.join('');
      if (combined.includes('.m3u8') && combined.startsWith('http') && !results.sources.find(s => s.url === combined)) {
        results.sources.push({ type: 'hls', url: combined, quality: 'HD' });
      }
    } catch {}
  }
}

async function scrapeVideoSource(pageUrl, depth = 0) {
  const results = { sources: [], error: null };
  if (depth > 4) return results;

  try {
    const fetchResult = await fetchWithHeaders(pageUrl);
    const htmlText = await fetchResult.text();
    const text = htmlText;
    const $ = cheerio.load(htmlText);

    // --- Collect followable links ---
    const iframeUrls = [];
    $('iframe').each((i, el) => {
      const src = $(el).attr('src');
      if (!src || src.startsWith('javascript')) return;
      iframeUrls.push(src.startsWith('http') ? src : new URL(src, pageUrl).href);
    });

    // --- Phase 1: find HLS from current page ---
    await tryDecodeHexWorker(text, pageUrl, results);
    await tryCloudflareWorkerDirect(text, pageUrl, results);
    tryBase64Encoded(text, results);
    tryAtobCalls(text, results);
    tryConcatUrls(text, results);
    tryScriptVars(text, results);
    tryJsonConfigs($, results);
    tryDataAttrs($, results);
    tryMetaRefresh(text, pageUrl, results);

    // Direct m3u8 in raw text
    const directM3u8 = text.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/g);
    if (directM3u8) {
      for (const url of directM3u8) {
        if (!results.sources.find(s => s.url === url))
          results.sources.push({ type: 'hls', url, quality: 'HD' });
      }
    }

    // --- Phase 2: follow iframes (always, even if we found something) ---
    for (const iframeUrl of iframeUrls) {
      if (iframeUrl.includes('youtube.com') || iframeUrl.includes('youtu.be')) continue;
      try {
        const sub = await scrapeVideoSource(iframeUrl, depth + 1);
        for (const s of sub.sources) {
          if (!results.sources.find(x => x.url === s.url))
            results.sources.push(s);
        }
      } catch {}
    }

    // --- Phase 3: follow meta refresh redirects ---
    if (results.sources.some(s => s.type === 'redirect') && !results.sources.some(s => s.type === 'hls')) {
      const redirectUrl = results.sources.find(s => s.type === 'redirect')?.url;
      if (redirectUrl) {
        results.sources = results.sources.filter(s => s.type !== 'redirect');
        const sub = await scrapeVideoSource(redirectUrl, depth + 1);
        for (const s of sub.sources) {
          if (!results.sources.find(x => x.url === s.url))
            results.sources.push(s);
        }
      }
    }

  } catch (err) {
    results.error = err.message;
  }

  // Remove YouTube
  results.sources = results.sources.filter(s => s.type !== 'youtube');

  // Dedup
  const seen = new Set();
  results.sources = results.sources.filter(s => {
    const key = s.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort: HLS first
  results.sources.sort((a, b) => {
    const priority = { hls: 0, mp4: 1, video: 1, twitch: 2, redirect: 3, iframe: 4 };
    return (priority[a.type] ?? 5) - (priority[b.type] ?? 5);
  });

  return results;
}

// --- HLS Proxy ---

app.get('/api/hls/playlist', async (req, res) => {
  try {
    const hlsUrl = req.query.url;
    const referer = req.query.ref || '';
    if (!hlsUrl) return res.status(400).send('Missing url');

    const origin = new URL(hlsUrl).origin;
    const { text: body, status } = await fetchWithHeaders(hlsUrl, {
      'Accept': '*/*',
      'Origin': origin,
      'Referer': referer || origin + '/',
    });

    if (status !== 200) return res.status(status).send('Failed to fetch playlist');

    let playlist = await body();

    // Rewrite URLs in playlist
    const baseUrl = hlsUrl.substring(0, hlsUrl.lastIndexOf('/') + 1);

    // Rewrite EXTINF lines (segment URLs)
    playlist = playlist.replace(/^([^#].+)$/gm, (match) => {
      const trimmed = match.trim();
      if (!trimmed) return match;
      const absUrl = resolveUrl(baseUrl, trimmed);
      const proxyUrl = `/api/hls/segment?url=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer || hlsUrl)}`;
      return proxyUrl;
    });

    // Also rewrite URIs in EXT-X-KEY and other tags
    playlist = playlist.replace(/URI="([^"]+)"/g, (match, uri) => {
      const absUrl = resolveUrl(baseUrl, uri);
      const proxyUrl = `/api/hls/segment?url=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer || hlsUrl)}`;
      return `URI="${proxyUrl}"`;
    });

    // Rewrite master playlist variant URLs (lines starting with http or relative paths that aren't #)
    playlist = playlist.replace(/^(https?:\/\/.+)$/gm, (match) => {
      return `/api/hls/playlist?url=${encodeURIComponent(match)}&ref=${encodeURIComponent(referer || hlsUrl)}`;
    });

    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    res.send(playlist);
  } catch (err) {
    res.status(500).send('Proxy error: ' + err.message);
  }
});

app.get('/api/hls/segment', async (req, res) => {
  try {
    const segUrl = req.query.url;
    const referer = req.query.ref || '';
    if (!segUrl) return res.status(400).send('Missing url');

    const origin = new URL(segUrl).origin;
    const resp = await fetch(segUrl, {
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        'Accept': '*/*',
        'Origin': origin,
        'Referer': referer || origin + '/',
      },
    });

    if (!resp.ok) return res.status(resp.status).send('Failed to fetch segment');

    const contentType = resp.headers.get('content-type') || 'video/mp2t';
    const buffer = Buffer.from(await resp.arrayBuffer());

    res.set({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Segment proxy error: ' + err.message);
  }
});

// --- API endpoints ---

app.get('/api/matches', async (req, res) => {
  try {
    const { text: html } = await fetchWithHeaders(BASE_URL);
    const $ = cheerio.load(await html());
    const matches = [];
    let currentCategory = 'General';

    const container = $('.col-md-12.border.rounded').first();
    container.children().each((i, el) => {
      const $el = $(el);
      const tag = el.tagName.toLowerCase();

      if (tag === 'div' && $el.hasClass('col') && $el.hasClass('fs-7') && $el.hasClass('fw-bold')) {
        const catName = $el.find('span').text().trim();
        if (catName) currentCategory = catName;
        return;
      }

      if (tag === 'a') {
        const href = $el.attr('href');
        if (!href || href === '#') return;

        const statusEl = $el.find('.xj, .Bj, .Aj').first();
        const status = statusEl.find('span').text().trim() || statusEl.text().trim();
        const teamDivs = $el.find('[class*="fs-7"][class*="px-2"] .row .col-12, [class*="fs-7"][class*="px-2"] .row .col-12.my-auto');
        const teams = [];
        teamDivs.each((j, teamEl) => {
          const text = $(teamEl).text().trim();
          if (text && !text.toLowerCase().includes('live')) teams.push(text);
        });

        const isExternal = href.includes('hofoot.com') || href.includes('highlights');
        const matchType = isExternal ? 'highlights' : (status.toLowerCase().includes('end') ? 'highlights' : 'stream');

        if (teams.length > 0) {
          matches.push({
            category: currentCategory, status, teams: teams.join(' vs '),
            team1: teams[0] || '', team2: teams[1] || '',
            url: href, type: matchType,
          });
        }
      }
    });

    const categories = [...new Set(matches.map(m => m.category))];
    const grouped = categories.map(cat => ({
      category: cat, matches: matches.filter(m => m.category === cat),
    }));
    res.json({ categories: grouped, total: matches.length });
  } catch (err) {
    console.error('Matches error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/streams', async (req, res) => {
  try {
    const gameUrl = req.query.url;
    if (!gameUrl) return res.status(400).json({ error: 'Missing url param' });
    const directUrl = gameUrlToDirect(gameUrl);
    const { text: html } = await fetchWithHeaders(directUrl);
    const $ = cheerio.load(await html());
    const title = $('title').text().trim();
    const streams = [];

    $('a.nocolor').each((i, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (!href) return;
      const cols = $el.children('div').children('div');
      const providerDiv = cols.eq(0);
      const provider = providerDiv.clone().children('span, i').remove().end().text().trim();
      const channel = cols.eq(1).text().trim();
      const mobile = cols.eq(2).text().trim();
      const quality = cols.eq(3).text().trim();
      const ads = cols.eq(4).text().trim();
      const language = cols.eq(5).text().trim();
      streams.push({ provider, channel, mobile: mobile === 'yes', quality, ads: parseInt(ads) || 0, language, url: href });
    });

    res.json({ title, streams, total: streams.length });
  } catch (err) {
    console.error('Streams error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/resolve', async (req, res) => {
  try {
    const streamUrl = req.query.url;
    if (!streamUrl) return res.status(400).json({ error: 'Missing url param' });
    const result = await scrapeVideoSource(streamUrl);
    res.json(result);
  } catch (err) {
    console.error('Resolve error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
