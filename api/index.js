'use strict';

const fs   = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── WASM singleton ────────────────────────────────────────────────────────────
let bootPromise = null;

function bootWasm() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    globalThis.window   = globalThis;
    globalThis.self     = globalThis;
    globalThis.document = { createElement: () => ({}), body: { appendChild: () => {} } };

    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    globalThis.sodium = sodium;

    eval(fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8'));

    const go = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);

    await new Promise(r => setTimeout(r, 500));
    if (typeof globalThis.getAdv !== 'function') throw new Error('getAdv not found after WASM boot');
  })();
  return bootPromise;
}

// ── Parse headers embedded in the proxy URL ───────────────────────────────────
function parsePlaylistUrl(rawUrl) {
  let cleanUrl  = rawUrl;
  let referer   = '';
  let origin    = '';

  try {
    const u          = new URL(rawUrl);
    const headersRaw = u.searchParams.get('headers');

    if (headersRaw) {
      try {
        const parsed = JSON.parse(headersRaw);
        referer = parsed.referer || parsed.Referer || '';
        origin  = parsed.origin  || parsed.Origin  || '';
      } catch (_) {}
    }

    u.searchParams.delete('headers');
    u.searchParams.delete('host');
    cleanUrl = u.toString();
  } catch (_) {}

  if (!referer) referer = 'https://vidlink.pro/';
  if (!origin)  origin  = referer.replace(/\/$/, '');

  return { cleanUrl, referer, origin };
}

// ── Stream URL resolver ───────────────────────────────────────────────────────
async function getStream(id, season, episode) {
  await bootWasm();

  const REFERER = 'https://vidlink.pro/';
  const ORIGIN  = 'https://vidlink.pro';

  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('getAdv returned null');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA }
  });
  if (!res.ok) throw new Error(`vidlink API returned ${res.status}`);

  const data     = await res.json();
  const playlist = data?.stream?.playlist;
  if (!playlist) throw new Error('No playlist in response');

  return playlist;
}

// ── HLS Manifest proxy ───────────────────────────────────────────────────────
// Fetches the upstream manifest with the required headers, then rewrites all
// segment/sub-playlist URIs so they point back through /api/proxy.
// Roku fetches segments from /api/proxy — the server adds the headers.
// No client-side Referer/Origin needed on the Roku side.

async function proxyManifest(targetUrl, referer, origin, selfBase) {
  const res = await fetch(targetUrl, {
    headers: { Referer: referer, Origin: origin, 'User-Agent': UA }
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const text = await res.text();

  const base = new URL(targetUrl);

  // Rewrite every URI line in the HLS manifest
  const rewritten = text.split('\n').map(line => {
    const trimmed = line.trim();
    // Skip comment/tag lines
    if (!trimmed || trimmed.startsWith('#')) return line;

    // Resolve relative URI to absolute
    let absUri;
    try {
      absUri = new URL(trimmed, base).toString();
    } catch (_) {
      return line;
    }

    // Wrap through our proxy
    const encoded = encodeURIComponent(absUri);
    const encRef  = encodeURIComponent(referer);
    const encOri  = encodeURIComponent(origin);
    return `${selfBase}/api/proxy?url=${encoded}&ref=${encRef}&ori=${encOri}`;
  }).join('\n');

  return rewritten;
}

async function proxySegment(targetUrl, referer, origin, res) {
  const upstream = await fetch(targetUrl, {
    headers: { Referer: referer, Origin: origin, 'User-Agent': UA }
  });
  if (!upstream.ok) throw new Error(`upstream segment ${upstream.status}`);

  const ct = upstream.headers.get('content-type') || 'application/octet-stream';
  res.setHeader('Content-Type', ct);

  // Stream the body
  const buf = await upstream.arrayBuffer();
  res.end(Buffer.from(buf));
}

// ── Vercel handler ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { searchParams, pathname } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  // ── /api/proxy — transparent HLS proxy with injected headers ──────────────
  if (pathname === '/api/proxy') {
    if (!q.url) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'missing url' }));
    }

    const targetUrl = decodeURIComponent(q.url);
    const referer   = q.ref ? decodeURIComponent(q.ref) : 'https://vidlink.pro/';
    const origin    = q.ori ? decodeURIComponent(q.ori) : referer.replace(/\/$/, '');

    try {
      const isM3u8 = targetUrl.includes('.m3u8') || targetUrl.includes('playlist');
      if (isM3u8) {
        // Determine the base URL of this deployment for self-referencing proxy links
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
        const selfBase = `${proto}://${host}`;

        const manifest = await proxyManifest(targetUrl, referer, origin, selfBase);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end(manifest);
      } else {
        return await proxySegment(targetUrl, referer, origin, res);
      }
    } catch (err) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ── /api — resolve stream and return proxied m3u8 URL ────────────────────
  res.setHeader('Content-Type', 'application/json');

  if (!q.id) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'missing id' }));
  }

  try {
    const rawPlaylist                    = await getStream(q.id, q.s, q.e);
    const { cleanUrl, referer, origin }  = parsePlaylistUrl(rawPlaylist);

    // Build proxied URL — Roku hits this, server handles auth headers
    const proto    = req.headers['x-forwarded-proto'] || 'https';
    const host     = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const selfBase = `${proto}://${host}`;

    const proxiedM3u8 = `${selfBase}/api/proxy?url=${encodeURIComponent(cleanUrl)}&ref=${encodeURIComponent(referer)}&ori=${encodeURIComponent(origin)}`;

    return res.end(JSON.stringify({
      m3u8:    proxiedM3u8,
      referer: '',       // not needed — proxy handles it
      headers: {},       // not needed — proxy handles it
    }, null, 2));
  } catch (err) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: err.message }));
  }
};
