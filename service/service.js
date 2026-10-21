'use strict';

// Hintergrunddienst auf dem Fernseher: holt den RTSP-Stream der FRITZ!Box (RTP über UDP) und gibt das
// MPEG-TS unverändert per HTTP aus. Damit spielt der webOS-Videoplayer die Sender ohne externen Proxy.
// Die App startet den Dienst per Luna-Aufruf "start" und hält ihn mit einem Abo am Leben.
// Außerdem liest er den Programmführer (EPG) selbst, damit es ihn auch ohne Proxy gibt.

const http = require('http');
const os = require('os');
const path = require('path');
const Service = require('webos-service');
const { openStream, describeTuners, Epg, parseM3U } = require('./epg'); // beim Paketieren aus proxy/epg.js kopiert

const SERVICE_ID = 'de.local.kabeltv.service';
const PORT = 8096;
const MAX_BUFFERED = 8 * 1024 * 1024; // mehr Rückstau verwirft Daten statt den Speicher zu füllen

const IDLE_MS = 3000; // Player verbinden sich gern neu; so lange bleibt der Tuner reserviert
const LISTS = ['tvhd', 'tvsd', 'radio'];
const EPG_DWELL_MS = 12000;
const EPG_INTERVAL_MS = 6 * 3600000;
const EPG_RETRY_MS = 10 * 60000; // nach einem Abbruch wegen belegter Tuner

const service = new Service(SERVICE_ID);
const logLines = [];
let current = null; // { id, url, stream, clients: Set<res>, idleTimer }
let nextId = 1;
let fritzHost = null; // kommt mit der ersten EPG-Anfrage der App
let epgStarted = false;
let epgRetry = null;

function note(msg) {
  logLines.push(`${new Date().toISOString()} ${msg}`);
  if (logLines.length > 40) logLines.shift();
  console.log(msg);
}

// Nur RTSP-Adressen im Heimnetz, damit der Dienst kein offenes Relay ist
function isAllowed(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'rtsp:' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^fritz\.box$/.test(u.hostname);
}

function isAllowedHost(h) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)[\d.]+$|^fritz\.box$/.test(h || '');
}

function decodeB64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// ---------- Programmführer ----------

function fetchText(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', reject);
  });
}

const listCache = new Map(); // Liste -> { channels, fetched }

async function fetchList(list) {
  const c = listCache.get(list);
  if (c && Date.now() - c.fetched < 10 * 60000) return c.channels;
  const channels = parseM3U(await fetchText(`http://${fritzHost}/dvb/m3u/${list}.m3u`, 6000));
  listCache.set(list, { channels, fetched: Date.now() });
  return channels;
}

async function fetchAllChannels() {
  if (!fritzHost) throw new Error('Adresse der FRITZ!Box noch unbekannt');
  const all = [];
  for (const list of LISTS) all.push(...await fetchList(list));
  return all;
}

const epg = new Epg({
  fetchAllChannels,
  dwellMs: EPG_DWELL_MS,
  intervalMs: EPG_INTERVAL_MS,
  horizonMs: 30 * 3600000, // Speicher im Fernseher sparen: gut ein Tag reicht für Jetzt/Danach und die Vorschau
  canScan: () => !current || current.running, // keinen Tuner nehmen, während ein Sender startet
  cacheFile: path.join(os.tmpdir(), 'kabeltv-epg.json'),
  log: note
});

// Der Scan belegt einen Tuner. Er startet erst, wenn die App zum ersten Mal Programminfos braucht
// (also nicht, wenn der Proxy sie liefert), und lässt der Wiedergabe den Vortritt.
function ensureEpg() {
  if (epgStarted) return;
  epgStarted = true;
  epg.start(15000);
}

function retryEpgLater() {
  clearTimeout(epgRetry);
  epgRetry = setTimeout(() => epg.scanAll(), EPG_RETRY_MS);
}

const brief = (e) => e && { title: e.title, start: e.start, end: e.end };

// ---------- Streams ----------

async function stopCurrent(reason) {
  const c = current;
  current = null;
  if (!c) return;
  clearTimeout(c.idleTimer);
  c.sniff.finish();
  note(`Stream ${c.id} beendet (${reason})`);
  for (const res of c.clients) if (!res.writableEnded) res.end();
  const stream = await c.opening.catch(() => null);
  if (stream) await stream.close();
}

// Eine Tuner-Sitzung pro Sender; alle HTTP-Verbindungen für denselben Sender teilen sie sich.
// Nebenbei werden die SI-Daten im Stream für den Programmführer mitgelesen.
function startSession(url) {
  const entry = { id: nextId++, url, clients: new Set(), idleTimer: null, opening: null, running: false, sniff: epg.watch(url) };
  const open = () => openStream(url, null, {
    onPayload: (buf) => {
      entry.sniff.push(buf);
      const chunk = Buffer.from(buf);
      for (const res of entry.clients) {
        if (res.writableLength <= MAX_BUFFERED) res.write(chunk);
      }
    }
  });
  // Sind alle Tuner belegt, während der EPG-Scan läuft, gibt der Scan seinen Tuner ab
  entry.opening = open().catch(async (e) => {
    if (!epg.scanning) throw e;
    note(`Stream ${entry.id}: ${e.message} – EPG-Scan wird abgebrochen`);
    await epg.cancelScan();
    retryEpgLater();
    return open();
  });
  entry.opening.then(
    () => {
      entry.running = true;
      note(`Stream ${entry.id} läuft: ${url.replace(/pids=.*/, 'pids=…')}`);
    },
    (e) => {
      note(`Stream ${entry.id} fehlgeschlagen: ${e.message}`);
      if (current === entry) stopCurrent('Fehler');
    }
  );
  return entry;
}

function handleStream(req, res, url) {
  if (!fritzHost) fritzHost = new URL(url).hostname; // reicht, um mitgelesene EPG-Daten zuzuordnen
  if (!current || current.url !== url) {
    // Tuner sparen: ein anderer Sender beendet den alten
    if (current) stopCurrent('neuer Sender');
    current = startSession(url);
  }
  const entry = current;
  clearTimeout(entry.idleTimer);
  entry.clients.add(res);
  note(`Verbindung zu Stream ${entry.id} (${entry.clients.size} offen, Range: ${req.headers.range || '-'}, ${req.headers['user-agent'] || '?'})`);

  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });

  res.on('close', () => {
    entry.clients.delete(res);
    if (current === entry && entry.clients.size === 0) {
      entry.idleTimer = setTimeout(() => {
        if (current === entry && entry.clients.size === 0) stopCurrent('Player hat getrennt');
      }, IDLE_MS);
    }
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function epgStatus() {
  return { started: epgStarted, scanning: epg.scanning, updated: epg.updated, channels: epg.channelKey.size };
}

// Gleiche Antworten wie /api/epg/... beim Proxy, damit die App beide gleich behandeln kann
async function handleEpg(req, res, pathname, query) {
  const host = query.get('host');
  if (host) {
    if (!isAllowedHost(host)) return sendJson(res, 403, { error: 'Adresse nicht erlaubt' });
    if (host !== fritzHost) listCache.clear();
    fritzHost = host;
  }
  if (!fritzHost) return sendJson(res, 400, { error: 'host fehlt' });
  ensureEpg();
  let m;
  if ((m = pathname.match(/^\/api\/epg\/channel\/([\w-]+)$/))) {
    const url = decodeB64url(m[1]);
    return sendJson(res, 200, { events: epg.upcoming(url, 40).map((e) => Object.assign(brief(e), { text: e.text })) });
  }
  if ((m = pathname.match(/^\/api\/epg\/(\w+)$/)) && LISTS.includes(m[1])) {
    let channels;
    try { channels = await fetchList(m[1]); } catch (e) { return sendJson(res, 502, { error: e.message }); }
    const out = {};
    for (const ch of channels) {
      const [now, next] = epg.upcoming(ch.url, 2);
      if (now) out[ch.url] = [brief(now), brief(next)];
    }
    return sendJson(res, 200, Object.assign(epgStatus(), { channels: out }));
  }
  return sendJson(res, 404, { error: 'unbekannt' });
}

function handleRequest(req, res) {
  const [pathname, qs] = req.url.split('?');
  if (pathname === '/status') {
    sendJson(res, 200, { ok: true, node: process.version, streaming: current ? current.id : null, epg: epgStatus(), log: logLines });
    return;
  }
  if (pathname === '/tuners') {
    // Belegung aller FRITZ!Box-Tuner, auch durch andere Geräte
    const host = new URL(req.url, 'http://x').searchParams.get('host') || 'fritz.box';
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(body));
    };
    if (!isAllowed(`rtsp://${host}/`)) return json(403, { error: 'Adresse nicht erlaubt' });
    describeTuners(host).then((t) => json(200, t), (e) => json(502, { error: e.message }));
    return;
  }
  if (pathname.startsWith('/api/epg/')) {
    handleEpg(req, res, pathname, new URLSearchParams(qs || '')).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
    });
    return;
  }
  const m = pathname.match(/^\/stream\/([\w-]+)$/);
  if (!m) { res.writeHead(404); res.end(); return; }
  const url = decodeB64url(m[1]);
  if (!isAllowed(url)) { res.writeHead(403); res.end(); return; }
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.end();
    return;
  }
  handleStream(req, res, url);
}

// Standard ist nur 127.0.0.1. Mit "lan" ist der Dienst (z. B. /status) auch aus dem Heimnetz erreichbar.
let server = null;
let lanAccess = null;

function listen(lan) {
  if (lan === lanAccess) return;
  lanAccess = lan;
  const old = server;
  const host = lan ? '0.0.0.0' : '127.0.0.1';
  server = http.createServer(handleRequest);
  let retries = 5;
  server.on('error', (e) => {
    // Der alte Server gibt den Port erst kurz nach close() frei
    if (e.code === 'EADDRINUSE' && retries-- > 0) { setTimeout(() => server.listen(PORT, host), 200); return; }
    note(`HTTP-Server: ${e.message}`);
  });
  if (old) old.close(); // laufende Streams bleiben verbunden
  server.listen(PORT, host, () => note(`Dienst bereit auf ${host}:${PORT} (Node ${process.version})`));
}

listen(false);

// Mit {subscribe: true} aufgerufen bleibt der Dienst aktiv, solange die App läuft.
service.register('start', (message) => {
  if (typeof message.payload.lan === 'boolean') listen(message.payload.lan);
  message.respond({ returnValue: true, port: PORT, lan: lanAccess, subscribed: !!message.isSubscription });
});

service.register('status', (message) => {
  message.respond({ returnValue: true, port: PORT, streaming: current ? current.id : null, epg: epgStatus(), log: logLines });
});

// webOS beendet den Dienst, wenn die App länger zu ist: EPG vorher sichern, Tuner freigeben
function shutdown() {
  epg.saveCacheSync();
  stopCurrent('Dienst beendet').then(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
