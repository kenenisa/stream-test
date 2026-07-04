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

async function scrapeVideoSource(pageUrl, depth = 0) {
  const results = { sources: [], error: null };
  if (depth > 3) return results;

  try {
    const fetchResult = await fetchWithHeaders(pageUrl);
    const htmlText = await fetchResult.text();
    const $ = cheerio.load(htmlText);

    // Collect iframe URLs first (for later following)
    const iframeUrls = [];

    // Pattern: iframe embeds
    $('iframe').each((i, el) => {
      const src = $(el).attr('src');
      if (!src || src.startsWith('javascript')) return;
      const absSrc = src.startsWith('http') ? src : new URL(src, pageUrl).href;
      iframeUrls.push(absSrc);
      const ytMatch = src.match(/(?:youtube\.com|youtu\.be)[\/\w]*(?:\?v=|\/)([\w-]{11})/);
      if (ytMatch) {
        results.sources.push({ type: 'youtube', url: `https://www.youtube.com/embed/${ytMatch[1]}?autoplay=1`, quality: 'HD' });
      } else if (src.includes('twitch.tv')) {
        results.sources.push({ type: 'twitch', url: src, quality: 'HD' });
      }
    });

    const text = htmlText;

    // Pattern: hex-encoded worker URL (maslaz.com style)
    const hexRegex = /_hexDec\(["']([a-f0-9]{50,})["']\)/;
    const hexMatch = text.match(hexRegex);
    if (hexMatch) {
      try {
        const workerUrl = hexToString(hexMatch[1]);
        const origin = new URL(pageUrl).origin;
        const resp = await fetchWithHeaders(workerUrl, {
          'Accept': 'application/json, text/plain, */*',
          'Origin': origin,
          'Referer': pageUrl,
        });
        if (resp.status === 200) {
          const json = JSON.parse(await resp.text());
          if (json.stream) {
            results.sources.push({
              type: json.stream.includes('.m3u8') ? 'hls' : 'video',
              url: json.stream,
              quality: 'HD',
              referer: workerUrl,
            });
          }
        }
      } catch {}
    }

    // Pattern: script vars with m3u8
    $('script').each((i, el) => {
      const script = $(el).html() || '';
      const m = script.match(/['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/);
      if (m) results.sources.push({ type: 'hls', url: m[1], quality: 'HD' });
    });

    // Pattern: direct m3u8 in page text
    const directM3u8 = text.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/g);
    if (directM3u8) {
      for (const url of directM3u8) {
        if (!results.sources.find(s => s.url === url)) {
          results.sources.push({ type: 'hls', url, quality: 'HD' });
        }
      }
    }

    // Follow iframes to find deeper sources (only if no HLS found yet)
    if (!results.sources.some(s => s.type === 'hls')) {
      for (const iframeUrl of iframeUrls) {
        try {
          const sub = await scrapeVideoSource(iframeUrl, depth + 1);
          for (const s of sub.sources) {
            if (!results.sources.find(x => x.url === s.url)) {
              results.sources.push(s);
            }
          }
        } catch {}
      }
    }

  } catch (err) {
    results.error = err.message;
  }

  const seen = new Set();
  results.sources = results.sources.filter(s => {
    const key = s.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort: HLS first, then YouTube/Twitch, then other
  results.sources.sort((a, b) => {
    const priority = { hls: 0, mp4: 1, video: 1, youtube: 2, twitch: 2, iframe: 3 };
    return (priority[a.type] ?? 4) - (priority[b.type] ?? 4);
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
