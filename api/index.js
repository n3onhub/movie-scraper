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
// The playlist URL looks like:
//   https://storm.vodvidl.site/proxy/.../playlist.m3u8
//     ?headers={"referer":"https://megacloud.live/","origin":"https://megacloud.live"}
//     &host=https://vod2.ironwallnet.com:6069
//
// We strip those query params so Roku gets a clean .m3u8 URL,
// and return the embedded headers separately so Roku can send them.
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

    // Remove proxy-only params that break Roku's HLS parser
    u.searchParams.delete('headers');
    u.searchParams.delete('host');
    cleanUrl = u.toString();
  } catch (_) {}

  // Fallback: if no embedded headers found, use vidlink as referer
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

// ── Vercel handler ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  if (!q.id) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'missing id' }));
  }

  try {
    const rawPlaylist            = await getStream(q.id, q.s, q.e);
    const { cleanUrl, referer, origin } = parsePlaylistUrl(rawPlaylist);

    return res.end(JSON.stringify({
      m3u8:    cleanUrl,
      referer: referer,
      headers: {
        'Referer':    referer,
        'Origin':     origin,
        'User-Agent': UA,
      },
    }, null, 2));
  } catch (err) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: err.message }));
  }
};
