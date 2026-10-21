'use strict';

// Programmführer (EPG) aus dem Kabelsignal: Jede Frequenz wird kurz über RTSP getunt, aber nur mit
// den Info-PIDs (PAT, SDT, EIT) – ohne Bild und Ton. Daraus entsteht pro Sender die Sendungsliste.

const net = require('net');
const dgram = require('dgram');

const SI_PIDS = '0,17,18';

// ---------- RTSP-Minimalclient (SAT>IP, RTP über UDP) ----------

async function openStream(rtspUrl, onTsPacket) {
  const u = new URL(rtspUrl);
  const udp = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    udp.once('error', reject);
    udp.bind(0, resolve);
  });
  const port = udp.address().port;
  udp.on('message', (msg) => {
    if (msg.length < 12) return;
    let off = 12 + (msg[0] & 0x0f) * 4;
    if (msg[0] & 0x10) off += 4 + msg.readUInt16BE(off + 2) * 4;
    for (; off + 188 <= msg.length; off += 188) {
      if (msg[off] === 0x47) onTsPacket(msg, off);
    }
  });

  const sock = net.connect(Number(u.port) || 554, u.hostname);
  sock.setNoDelay(true);
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });

  let cseq = 0;
  let session = null;
  let buf = '';
  const waiting = [];
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    let i;
    while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
      const lines = buf.slice(0, i).split('\r\n');
      const headers = {};
      for (const l of lines.slice(1)) {
        const c = l.indexOf(':');
        if (c > 0) headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim();
      }
      const bodyLen = Number(headers['content-length']) || 0;
      if (buf.length < i + 4 + bodyLen) break;
      buf = buf.slice(i + 4 + bodyLen);
      const w = waiting.shift();
      if (w) w.resolve({ status: Number(lines[0].split(' ')[1]), headers });
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => { while (waiting.length) waiting.shift().reject(new Error('RTSP-Verbindung geschlossen')); });

  function request(method, url, extra = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RTSP ${method}: keine Antwort`)), 5000);
      waiting.push({
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      let msg = `${method} ${url} RTSP/1.0\r\nCSeq: ${++cseq}\r\n`;
      if (session) msg += `Session: ${session}\r\n`;
      for (const [k, v] of Object.entries(extra)) msg += `${k}: ${v}\r\n`;
      sock.write(msg + '\r\n');
    });
  }

  const cleanup = () => { sock.destroy(); try { udp.close(); } catch { /* schon zu */ } };

  try {
    const setup = await request('SETUP', rtspUrl, { Transport: `RTP/AVP;unicast;client_port=${port}-${port + 1}` });
    if (setup.status !== 200) throw new Error(`RTSP SETUP: Status ${setup.status} (Tuner belegt?)`);
    const [sess, ...params] = (setup.headers.session || '').split(';');
    session = sess;
    const timeout = Number((params.find((p) => p.trim().startsWith('timeout=')) || '').split('=')[1]) || 60;
    const streamId = setup.headers['com.ses.streamid'];
    const ctrlUrl = streamId ? `rtsp://${u.host}/stream=${streamId}` : rtspUrl;
    const play = await request('PLAY', ctrlUrl);
    if (play.status !== 200) throw new Error(`RTSP PLAY: Status ${play.status}`);

    const keepalive = setInterval(() => request('OPTIONS', ctrlUrl).catch(() => {}), (timeout * 1000) / 2);
    return {
      async close() {
        clearInterval(keepalive);
        await request('TEARDOWN', ctrlUrl).catch(() => {});
        cleanup();
      }
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

// ---------- MPEG-TS-Sektionen ----------

const CRC_TABLE = new Uint32Array(256).map((_, i) => {
  let c = i << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc;
}

class SectionReader {
  constructor(onSection) {
    this.onSection = onSection;
    this.acc = new Map(); // pid -> Buffer (laufende Sektion)
  }

  push(pkt, off) {
    const pid = ((pkt[off + 1] & 0x1f) << 8) | pkt[off + 2];
    const pusi = pkt[off + 1] & 0x40;
    const afc = (pkt[off + 3] >> 4) & 3;
    if (!(afc & 1)) return;
    let p = off + 4;
    if (afc === 3) p += 1 + pkt[p];
    const end = off + 188;
    if (p >= end) return;

    if (pusi) {
      const ptr = pkt[p];
      p += 1;
      if (this.acc.has(pid) && ptr) this.consume(pid, pkt.subarray(p, p + ptr));
      this.acc.set(pid, Buffer.alloc(0));
      this.consume(pid, pkt.subarray(p + ptr, end));
    } else if (this.acc.has(pid)) {
      this.consume(pid, pkt.subarray(p, end));
    }
  }

  consume(pid, data) {
    let acc = Buffer.concat([this.acc.get(pid), data]);
    while (acc.length >= 3) {
      if (acc[0] === 0xff) { acc = null; break; }
      const len = (((acc[1] & 0x0f) << 8) | acc[2]) + 3;
      if (acc.length < len) break;
      const section = acc.subarray(0, len);
      if (len > 7 && crc32(section) === 0) this.onSection(pid, section);
      acc = acc.subarray(len);
    }
    if (acc && acc.length) this.acc.set(pid, Buffer.from(acc));
    else this.acc.delete(pid);
  }
}

// ---------- DVB-Texte und Zeiten ----------

const DIACRITICS = {
  0xc1: '̀', 0xc2: '́', 0xc3: '̂', 0xc4: '̃', 0xc5: '̄', 0xc6: '̆',
  0xc7: '̇', 0xc8: '̈', 0xca: '̊', 0xcb: '̧', 0xcd: '̋', 0xce: '̨', 0xcf: '̌'
};

// ISO 6937 ist der DVB-Standardzeichensatz: Akzente stehen als eigenes Byte vor dem Buchstaben.
function decode6937(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (DIACRITICS[c] && i + 1 < b.length) {
      s += (String.fromCharCode(b[++i]) + DIACRITICS[c]).normalize('NFC');
    } else if (c === 0xfb) {
      s += 'ß';
    } else {
      s += String.fromCharCode(c);
    }
  }
  return s;
}

function dvbText(buf) {
  if (!buf || !buf.length) return '';
  let b = buf;
  let enc = 'iso6937';
  const c = b[0];
  if (c < 0x20) {
    if (c >= 0x01 && c <= 0x0b) { enc = `iso-8859-${c + 4}`; b = b.subarray(1); }
    else if (c === 0x10 && b.length >= 3) { enc = `iso-8859-${b[2]}`; b = b.subarray(3); }
    else if (c === 0x15) { enc = 'utf-8'; b = b.subarray(1); }
    else { enc = 'latin1'; b = b.subarray(1); }
  }
  // Bei Einbyte-Zeichensätzen sind 0x80–0x9F DVB-Steuerzeichen (0x8A = Zeilenumbruch), keine Buchstaben.
  if (enc !== 'utf-8') {
    b = Buffer.from([...b].filter((x) => x < 0x80 || x > 0x9f || x === 0x8a).map((x) => (x === 0x8a ? 0x0a : x)));
  }
  let s;
  if (enc === 'iso6937') s = decode6937(b);
  else {
    try { s = new TextDecoder(enc).decode(b); } catch { s = b.toString('latin1'); }
  }
  return s
    .replace(/[\u0080-\u0085\u0086\u0087\u0088-\u0089\u008b-\u009f]/g, '')
    .replace(/\u008a/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f]/g, '')
    .trim();
}

const bcd = (b) => (b >> 4) * 10 + (b & 0x0f);

function dvbTime(s, o) {
  const mjd = s.readUInt16BE(o);
  if (mjd === 0xffff) return null;
  return (mjd - 40587) * 86400000 + (bcd(s[o + 2]) * 3600 + bcd(s[o + 3]) * 60 + bcd(s[o + 4])) * 1000;
}

// ---------- SI-Tabellen ----------

function parsePat(s) {
  const programs = new Map(); // service_id -> PMT-PID
  for (let p = 8; p + 4 <= s.length - 4; p += 4) {
    const prog = s.readUInt16BE(p);
    if (prog) programs.set(prog, s.readUInt16BE(p + 2) & 0x1fff);
  }
  return { tsid: s.readUInt16BE(3), programs };
}

function parseSdt(s) {
  const services = new Map(); // service_id -> Name
  const end = s.length - 4;
  let p = 11;
  while (p + 5 <= end) {
    const sid = s.readUInt16BE(p);
    const dlen = s.readUInt16BE(p + 3) & 0x0fff;
    let d = p + 5;
    const dend = Math.min(d + dlen, end);
    while (d + 2 <= dend) {
      const tag = s[d];
      const len = s[d + 1];
      if (tag === 0x48) {
        const body = s.subarray(d + 2, d + 2 + len);
        const provLen = body[1];
        const nameLen = body[2 + provLen];
        services.set(sid, dvbText(body.subarray(3 + provLen, 3 + provLen + nameLen)));
      }
      d += 2 + len;
    }
    p = dend;
  }
  return { tsid: s.readUInt16BE(3), onid: s.readUInt16BE(8), services };
}

function parseEit(s) {
  const sid = s.readUInt16BE(3);
  const tsid = s.readUInt16BE(8);
  const onid = s.readUInt16BE(10);
  const events = [];
  const end = s.length - 4;
  let p = 14;
  while (p + 12 <= end) {
    const id = s.readUInt16BE(p);
    const start = dvbTime(s, p + 2);
    const dur = (bcd(s[p + 7]) * 3600 + bcd(s[p + 8]) * 60 + bcd(s[p + 9])) * 1000;
    const dlen = s.readUInt16BE(p + 10) & 0x0fff;
    let d = p + 12;
    const dend = Math.min(d + dlen, end);
    let title = '';
    let text = '';
    const ext = [];
    while (d + 2 <= dend) {
      const tag = s[d];
      const body = s.subarray(d + 2, d + 2 + s[d + 1]);
      if (tag === 0x4d && body.length >= 5) {
        const nl = body[3];
        title = dvbText(body.subarray(4, 4 + nl));
        const tl = body[4 + nl];
        text = dvbText(body.subarray(5 + nl, 5 + nl + tl));
      } else if (tag === 0x4e && body.length >= 6) {
        const q = 5 + body[4];
        ext.push([body[0] >> 4, dvbText(body.subarray(q + 1, q + 1 + body[q]))]);
      }
      d += 2 + s[d + 1];
    }
    if (ext.length) {
      const extText = ext.sort((a, b) => a[0] - b[0]).map((e) => e[1]).join('');
      if (extText.length > text.length) text = extText;
    }
    if (start !== null && title) events.push({ id, start, end: start + dur, title, text });
    p = dend;
  }
  return { key: `${onid}:${tsid}:${sid}`, tableId: s[0], events };
}

// ---------- Scan einer Frequenz ----------

function siUrl(channelUrl) {
  return channelUrl.replace(/pids=[^&]*/, `pids=${SI_PIDS}`);
}

async function scanMux(channelUrl, dwellMs, onEvents) {
  const result = { tsid: null, onid: null, programs: new Map(), services: new Map(), stats: {} };
  const reader = new SectionReader((pid, s) => {
    const t = s[0];
    result.stats[t] = (result.stats[t] || 0) + 1;
    if (pid === 0 && t === 0x00) {
      const pat = parsePat(s);
      result.tsid = pat.tsid;
      for (const [k, v] of pat.programs) result.programs.set(k, v);
    } else if (pid === 17 && t === 0x42) {
      const sdt = parseSdt(s);
      result.onid = sdt.onid;
      for (const [k, v] of sdt.services) result.services.set(k, v);
    } else if (pid === 18 && t >= 0x4e && t <= 0x6f) {
      const eit = parseEit(s);
      if (eit.events.length) onEvents(eit.key, eit.events);
    }
  });
  const stream = await openStream(siUrl(channelUrl), (pkt, off) => reader.push(pkt, off));
  await new Promise((r) => setTimeout(r, dwellMs));
  await stream.close();
  return result;
}

// ---------- EPG-Speicher und Zuordnung zu den Sendern ----------

function freqOf(url) {
  const m = url.match(/[?&]freq=([\d.]+)/);
  return m ? m[1] : null;
}

function pidsOf(url) {
  const m = url.match(/[?&]pids=([\d,]+)/);
  return m ? m[1].split(',').map(Number) : [];
}

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9äöüß]/g, '');

class Epg {
  constructor({ fetchAllChannels, dwellMs = 12000, intervalMs = 4 * 3600000, log = () => {} }) {
    this.fetchAllChannels = fetchAllChannels;
    this.dwellMs = dwellMs;
    this.intervalMs = intervalMs;
    this.log = log;
    this.events = new Map();   // Dienst-Schlüssel -> Map(event_id -> Sendung)
    this.channelKey = new Map(); // RTSP-URL -> Dienst-Schlüssel
    this.scanning = false;
    this.updated = null;
  }

  start(delayMs = 10000) {
    setTimeout(() => this.scanAll(), delayMs).unref();
    setInterval(() => this.scanAll(), this.intervalMs).unref();
  }

  addEvents(key, events) {
    let m = this.events.get(key);
    if (!m) this.events.set(key, (m = new Map()));
    for (const e of events) m.set(e.id, e);
  }

  prune() {
    const limit = Date.now() - 3600000;
    for (const m of this.events.values()) {
      for (const [id, e] of m) if (e.end < limit) m.delete(id);
    }
  }

  async scanAll() {
    if (this.scanning) return;
    this.scanning = true;
    const t0 = Date.now();
    try {
      const channels = await this.fetchAllChannels();
      const byFreq = new Map();
      for (const ch of channels) {
        const f = freqOf(ch.url);
        if (!f) continue;
        if (!byFreq.has(f)) byFreq.set(f, []);
        byFreq.get(f).push(ch);
      }
      for (const [freq, list] of byFreq) {
        try {
          const mux = await scanMux(list[0].url, this.dwellMs, (key, ev) => this.addEvents(key, ev));
          this.mapChannels(mux, list);
          this.log(`EPG: ${freq} MHz gelesen (${mux.services.size} Dienste)`);
        } catch (e) {
          this.log(`EPG: ${freq} MHz fehlgeschlagen: ${e.message}`);
        }
      }
      this.prune();
      this.updated = Date.now();
      this.log(`EPG: Scan fertig in ${Math.round((Date.now() - t0) / 1000)} s, ${this.channelKey.size} Sender zugeordnet`);
    } catch (e) {
      this.log(`EPG: Scan abgebrochen: ${e.message}`);
    } finally {
      this.scanning = false;
    }
  }

  mapChannels(mux, channels) {
    if (mux.tsid === null || mux.onid === null) return;
    const byName = new Map();
    for (const [sid, name] of mux.services) byName.set(normalize(name), sid);
    for (const ch of channels) {
      let sid = byName.get(normalize(ch.name));
      if (sid === undefined) {
        // Ersatzweise über die PMT-PID, die in der PID-Liste der FRITZ!Box steht
        const pids = pidsOf(ch.url);
        for (const [s, pmt] of mux.programs) if (pids.includes(pmt)) { sid = s; break; }
      }
      if (sid !== undefined) this.channelKey.set(ch.url, `${mux.onid}:${mux.tsid}:${sid}`);
    }
  }

  // Sendungen eines Senders ab jetzt, zeitlich sortiert
  upcoming(url, limit) {
    const m = this.events.get(this.channelKey.get(url));
    if (!m) return [];
    const now = Date.now();
    return [...m.values()]
      .filter((e) => e.end > now)
      .sort((a, b) => a.start - b.start)
      .slice(0, limit);
  }
}

module.exports = { Epg, scanMux, parseEit, dvbText };

// Test von der Kommandozeile: node epg.js <rtsp-url> [sekunden]
if (require.main === module) {
  const [url, secs] = process.argv.slice(2);
  const store = new Map();
  scanMux(url, (Number(secs) || 12) * 1000, (key, ev) => {
    if (!store.has(key)) store.set(key, new Map());
    for (const e of ev) store.get(key).set(e.id, e);
  }).then((mux) => {
    console.log('TSID', mux.tsid, 'ONID', mux.onid, 'Tabellen', JSON.stringify(mux.stats));
    console.log('Dienste:', [...mux.services].map(([k, v]) => `${k}=${v}`).join(', '));
    console.log('EIT-Dienste:', store.size, 'Sendungen:', [...store.values()].reduce((a, m) => a + m.size, 0));
    const now = Date.now();
    for (const [key, m] of [...store].slice(0, 8)) {
      const evs = [...m.values()].filter((e) => e.end > now).sort((a, b) => a.start - b.start);
      const fmt = (e) => `${new Date(e.start).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} ${e.title}`;
      console.log(key, '|', evs.slice(0, 3).map(fmt).join(' | '), '| bis', evs.length ? new Date(evs[evs.length - 1].end).toLocaleString('de-DE') : '-');
    }
  }).catch((e) => { console.error('Fehler:', e.message); process.exit(1); });
}
