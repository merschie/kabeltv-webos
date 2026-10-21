'use strict';

// Hintergrunddienst auf dem Fernseher: holt den RTSP-Stream der FRITZ!Box (RTP über UDP) und gibt das
// MPEG-TS unverändert per HTTP aus. Damit spielt der webOS-Videoplayer die Sender ohne externen Proxy.
// Die App startet den Dienst per Luna-Aufruf "start" und hält ihn mit einem Abo am Leben.

const http = require('http');
const Service = require('webos-service');
const { openStream } = require('./epg'); // beim Paketieren aus proxy/epg.js kopiert

const SERVICE_ID = 'de.local.kabeltv.service';
const PORT = 8096;
const MAX_BUFFERED = 8 * 1024 * 1024; // mehr Rückstau verwirft Daten statt den Speicher zu füllen

const IDLE_MS = 3000; // Player verbinden sich gern neu; so lange bleibt der Tuner reserviert

const service = new Service(SERVICE_ID);
const logLines = [];
let current = null; // { id, url, stream, clients: Set<res>, idleTimer }
let nextId = 1;

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

function decodeB64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

async function stopCurrent(reason) {
  const c = current;
  current = null;
  if (!c) return;
  clearTimeout(c.idleTimer);
  note(`Stream ${c.id} beendet (${reason})`);
  for (const res of c.clients) if (!res.writableEnded) res.end();
  const stream = await c.opening.catch(() => null);
  if (stream) await stream.close();
}

// Eine Tuner-Sitzung pro Sender; alle HTTP-Verbindungen für denselben Sender teilen sie sich.
function startSession(url) {
  const entry = { id: nextId++, url, clients: new Set(), idleTimer: null, opening: null };
  entry.opening = openStream(url, null, {
    onPayload: (buf) => {
      const chunk = Buffer.from(buf);
      for (const res of entry.clients) {
        if (res.writableLength <= MAX_BUFFERED) res.write(chunk);
      }
    }
  });
  entry.opening.then(
    () => note(`Stream ${entry.id} läuft: ${url.replace(/pids=.*/, 'pids=…')}`),
    (e) => {
      note(`Stream ${entry.id} fehlgeschlagen: ${e.message}`);
      if (current === entry) stopCurrent('Fehler');
    }
  );
  return entry;
}

function handleStream(req, res, url) {
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

const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, node: process.version, streaming: current ? current.id : null, log: logLines }));
    return;
  }
  const m = path.match(/^\/stream\/([\w-]+)$/);
  if (!m) { res.writeHead(404); res.end(); return; }
  const url = decodeB64url(m[1]);
  if (!isAllowed(url)) { res.writeHead(403); res.end(); return; }
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.end();
    return;
  }
  handleStream(req, res, url);
});

server.on('error', (e) => note(`HTTP-Server: ${e.message}`));
server.listen(PORT, '0.0.0.0', () => note(`Dienst bereit auf Port ${PORT} (Node ${process.version})`));

// Mit {subscribe: true} aufgerufen bleibt der Dienst aktiv, solange die App läuft.
service.register('start', (message) => {
  message.respond({ returnValue: true, port: PORT, subscribed: !!message.isSubscription });
});

service.register('status', (message) => {
  message.respond({ returnValue: true, port: PORT, streaming: current ? current.id : null, log: logLines });
});
