'use strict';

// Kabel-TV-Proxy: wandelt die RTSP-Streams der FRITZ!Box Cable mit ffmpeg in HLS um,
// damit der webOS-Fernseher sie zuverlässig abspielen kann. Ohne npm-Abhängigkeiten.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { Epg, describeTuners, parseM3U } = require('./epg');

const PORT = Number(process.env.PORT) || 8095;
const FRITZ_HOST = process.env.FRITZ_HOST || 'fritz.box';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const AUDIO = process.env.AUDIO || 'aac';          // aac | copy
const VIDEO = process.env.VIDEO || 'copy';         // copy | h264
const RTSP_TRANSPORT = process.env.RTSP_TRANSPORT || ''; // leer = ffmpeg-Standard, sonst udp | tcp
const MAX_STREAMS = Number(process.env.MAX_STREAMS) || 2;
const IDLE_SECONDS = Number(process.env.IDLE_SECONDS) || 20;
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..', 'webos-app');
const WORK_DIR = process.env.WORK_DIR || path.join(os.tmpdir(), 'kabeltv-proxy');
const LISTS = ['tvhd', 'tvsd', 'radio'];
const EPG_ENABLED = process.env.EPG !== 'off';
const EPG_DWELL = Number(process.env.EPG_DWELL) || 15;           // Sekunden pro Frequenz
const EPG_INTERVAL = Number(process.env.EPG_INTERVAL_HOURS) || 6;

const ffmpegAvailable = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0;

const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------- Playlists ----------

async function fetchChannels(list) {
  const res = await fetch(`http://${FRITZ_HOST}/dvb/m3u/${list}.m3u`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`FRITZ!Box antwortet mit HTTP ${res.status}`);
  return parseM3U(await res.text());
}

const epg = new Epg({
  fetchAllChannels: async () => (await Promise.all(LISTS.map(fetchChannels))).flat(),
  dwellMs: EPG_DWELL * 1000,
  intervalMs: EPG_INTERVAL * 3600000,
  log
});

const brief = (e) => e && { title: e.title, start: e.start, end: e.end };

// Nur RTSP-Adressen im Heimnetz zulassen, damit der Proxy kein offenes Relay ist.
function isAllowed(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'rtsp:') return false;
  const h = u.hostname;
  return h === FRITZ_HOST || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
}

// ---------- ffmpeg-Sitzungen ----------

const sessions = new Map(); // id -> { id, url, dir, proc, lastAccess, error, stderr }

function sessionId(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
}

function ffmpegArgs(url, dir) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];
  if (RTSP_TRANSPORT) args.push('-rtsp_transport', RTSP_TRANSPORT);
  args.push('-fflags', '+genpts+discardcorrupt', '-i', url);
  // erste Video- und erste Tonspur; bei Radio gibt es kein Video
  args.push('-map', '0:v:0?', '-map', '0:a:0?');
  if (VIDEO === 'h264') {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23', '-vf', 'yadif');
  } else {
    args.push('-c:v', 'copy');
  }
  if (AUDIO === 'copy') args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  args.push(
    '-sn', '-dn',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
    '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
    path.join(dir, 'index.m3u8')
  );
  return args;
}

function startSession(url) {
  const id = sessionId(url);
  const existing = sessions.get(id);
  if (existing) {
    existing.lastAccess = Date.now();
    return existing;
  }

  // Die FRITZ!Box hat nur wenige Tuner: älteste Sitzung beenden, wenn das Limit erreicht ist.
  while (sessions.size >= MAX_STREAMS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastAccess - b.lastAccess)[0];
    stopSession(oldest, 'Limit erreicht');
  }

  const dir = path.join(WORK_DIR, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const s = { id, url, dir, proc: null, lastAccess: Date.now(), error: null, stderr: '' };
  s.proc = spawn(FFMPEG, ffmpegArgs(url, dir), { stdio: ['ignore', 'ignore', 'pipe'] });
  s.proc.stderr.on('data', (d) => { s.stderr = (s.stderr + d).slice(-2000); });
  s.proc.on('error', (e) => { s.error = `ffmpeg konnte nicht gestartet werden: ${e.message}`; });
  s.proc.on('exit', (code) => {
    if (!s.error) s.error = `ffmpeg beendet (Code ${code}): ${s.stderr.trim().split('\n').pop() || ''}`;
    if (sessions.get(id) === s) {
      log('Sitzung beendet', id, s.error);
      sessions.delete(id);
      setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 1000);
    }
  });
  sessions.set(id, s);
  log('Sitzung gestartet', id, url);
  return s;
}

function stopSession(s, reason) {
  if (!s) return;
  log('Sitzung gestoppt', s.id, reason || '');
  sessions.delete(s.id);
  if (s.proc && s.proc.exitCode === null) s.proc.kill('SIGKILL');
  setTimeout(() => fs.rmSync(s.dir, { recursive: true, force: true }), 1000);
}

setInterval(() => {
  const limit = Date.now() - IDLE_SECONDS * 1000;
  for (const s of sessions.values()) if (s.lastAccess < limit) stopSession(s, 'inaktiv');
}, 5000).unref();

async function waitForFile(file, s, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(file)) return true;
    if (!sessions.has(s.id)) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ---------- HTTP ----------

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache'
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'nicht gefunden' });
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

function decodeStreamUrl(b64) {
  try { return Buffer.from(b64, 'base64url').toString('utf8'); } catch { return ''; }
}

async function handle(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return send(res, 204, '');

  const { pathname } = new URL(req.url, 'http://localhost');
  let m;

  if (pathname === '/api/status') {
    return send(res, 200, {
      ok: true,
      app: 'kabeltv-proxy',
      fritzHost: FRITZ_HOST,
      ffmpeg: ffmpegAvailable,
      video: VIDEO,
      audio: AUDIO,
      epg: { enabled: EPG_ENABLED, scanning: epg.scanning, updated: epg.updated, channels: epg.channelKey.size },
      sessions: [...sessions.values()].map((s) => ({ id: s.id, url: s.url, idle: Math.round((Date.now() - s.lastAccess) / 1000) }))
    });
  }

  if (pathname === '/api/tuners') {
    try {
      return send(res, 200, await describeTuners(FRITZ_HOST));
    } catch (e) {
      return send(res, 502, { error: e.message });
    }
  }

  if ((m = pathname.match(/^\/api\/channels\/(\w+)$/))) {
    if (!LISTS.includes(m[1])) return send(res, 404, { error: 'unbekannte Liste' });
    try {
      return send(res, 200, await fetchChannels(m[1]));
    } catch (e) {
      return send(res, 502, { error: e.message });
    }
  }

  // Jetzt/Danach für alle Sender einer Liste
  if ((m = pathname.match(/^\/api\/epg\/(\w+)$/))) {
    if (!LISTS.includes(m[1])) return send(res, 404, { error: 'unbekannte Liste' });
    let channels;
    try { channels = await fetchChannels(m[1]); } catch (e) { return send(res, 502, { error: e.message }); }
    const out = {};
    for (const ch of channels) {
      const [now, next] = epg.upcoming(ch.url, 2);
      if (now) out[ch.url] = [brief(now), brief(next)];
    }
    return send(res, 200, { updated: epg.updated, scanning: epg.scanning, channels: out });
  }

  // Programm eines Senders mit Beschreibungen
  if ((m = pathname.match(/^\/api\/epg\/channel\/([\w-]+)$/))) {
    const url = decodeStreamUrl(m[1]);
    return send(res, 200, { events: epg.upcoming(url, 40).map((e) => ({ ...brief(e), text: e.text })) });
  }

  if ((m = pathname.match(/^\/hls\/([\w-]+)\/(index\.m3u8|seg_\d+\.ts|release)$/))) {
    const url = decodeStreamUrl(m[1]);
    if (!isAllowed(url)) return send(res, 403, { error: 'Adresse nicht erlaubt' });
    const file = m[2];

    if (file === 'release') {
      stopSession(sessions.get(sessionId(url)), 'freigegeben');
      return send(res, 200, { ok: true });
    }

    if (file === 'index.m3u8') {
      if (!ffmpegAvailable) return send(res, 500, { error: 'ffmpeg nicht installiert' });
      const s = startSession(url);
      const target = path.join(s.dir, file);
      if (await waitForFile(target, s, 20000)) return sendFile(res, target);
      return send(res, 502, { error: s.error || 'Stream startet nicht (Tuner belegt?)' });
    }

    const s = sessions.get(sessionId(url));
    if (!s) return send(res, 404, { error: 'keine aktive Sitzung' });
    s.lastAccess = Date.now();
    return sendFile(res, path.join(s.dir, file));
  }

  // webOS-App zum Testen im Browser ausliefern
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(STATIC_DIR, rel);
  if (!file.startsWith(path.resolve(STATIC_DIR))) return send(res, 403, { error: 'verboten' });
  return sendFile(res, file);
}

fs.mkdirSync(WORK_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('Fehler', e);
    if (!res.headersSent) send(res, 500, { error: e.message });
  });
});

server.listen(PORT, () => {
  log(`Kabel-TV-Proxy läuft auf Port ${PORT}, FRITZ!Box: ${FRITZ_HOST}, ffmpeg: ${ffmpegAvailable ? 'ja' : 'NICHT GEFUNDEN'}`);
  if (EPG_ENABLED) epg.start();
});

function shutdown() {
  for (const s of sessions.values()) stopSession(s, 'Beenden');
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
