'use strict';

// Programmführer (EPG) aus dem Kabelsignal: Jede Frequenz wird kurz über RTSP getunt, aber nur mit
// den Info-PIDs (PAT, SDT, EIT) – ohne Bild und Ton. Daraus entsteht pro Sender die Sendungsliste.

const net = require('net');
const dgram = require('dgram');

const SI_PIDS = '0,17,18';

// ---------- RTSP-Minimalclient (SAT>IP, RTP über UDP) ----------

// onTsPacket(buf, offset) bekommt jedes TS-Paket einzeln; mit options.onPayload(buf) kommen stattdessen
// die TS-Daten eines RTP-Pakets am Stück (für das Durchreichen ganzer Streams).
async function openStream(rtspUrl, onTsPacket, options = {}) {
  const u = new URL(rtspUrl);
  const udp = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    udp.once('error', reject);
    udp.bind(0, resolve);
  });
  try { udp.setRecvBufferSize(8 * 1024 * 1024); } catch { /* System-Limit greift */ }
  const port = udp.address().port;
  udp.on('message', (msg) => {
    if (msg.length < 12) return;
    let off = 12 + (msg[0] & 0x0f) * 4;
    if (msg[0] & 0x10) off += 4 + msg.readUInt16BE(off + 2) * 4;
    if (options.onPayload) {
      if (off < msg.length) options.onPayload(msg.subarray(off));
      return;
    }
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

// Tunerbelegung der FRITZ!Box: DESCRIBE auf die Wurzel-URL listet alle laufenden Streams (auch fremder
// Geräte). Freie Tuner stehen als "a=inactive", belegte mit Tunernummer in der fmtp-Zeile. Mehrere Streams
// auf derselben Frequenz teilen sich einen Tuner.
function describeTuners(host, port = 554) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('RTSP DESCRIBE: keine Antwort')); }, 4000);
    const finish = (fn) => { clearTimeout(timer); sock.destroy(); fn(); };
    sock.on('connect', () => sock.write(`DESCRIBE rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n`));
    sock.on('error', (e) => finish(() => reject(e)));
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const len = Number((/content-length:\s*(\d+)/i.exec(buf.slice(0, i)) || [])[1]) || 0;
      if (buf.length < i + 4 + len) return;
      const status = Number(buf.split(' ')[1]);
      const sdp = buf.slice(i + 4, i + 4 + len);
      finish(() => {
        // ohne laufende Streams antworten manche SAT>IP-Server mit 404
        if (status !== 200 && status !== 404) return reject(new Error(`RTSP DESCRIBE: Status ${status}`));
        // s=SatIPServer:1 <DVB-S2>,<DVB-T>,<DVB-C>
        const caps = /^s=SatIPServer:1\s+([\d,]+)/m.exec(sdp);
        const total = caps ? caps[1].split(',').reduce((a, n) => a + (Number(n) || 0), 0) : 0;
        const used = new Set();
        let streams = 0;
        for (const media of sdp.split(/^m=/m).slice(1)) {
          if (!/^a=sendonly/m.test(media)) continue;
          streams++;
          const t = /tuner=(\d+)/.exec(media);
          used.add(t ? t[1] : `s${streams}`);
        }
        resolve({ total, used: used.size, free: Math.max(0, total - used.size), streams });
      });
    });
  });
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

// ISO 6937 ist der DVB-Standardzeichensatz: Akzente stehen als eigenes Byte vor dem Buchstaben.
// Die fertigen Buchstaben stehen als Tabelle hier, damit nichts von normalize()/ICU im Node des Fernsehers
// abhängt: Lose Kombi-Akzente zeigt der TV-Browser nicht sauber an.
const DIACRITICS = {
  0xc1: ['AEINOUaeinou', 'ÀÈÌǸÒÙàèìǹòù'],
  0xc2: ['ACEGILNORSUYZacegilnorsuyz', 'ÁĆÉǴÍĹŃÓŔŚÚÝŹáćéǵíĺńóŕśúýź'],
  0xc3: ['ACEGHIJOSUWYaceghijosuwy', 'ÂĈÊĜĤÎĴÔŜÛŴŶâĉêĝĥîĵôŝûŵŷ'],
  0xc4: ['AINOUainou', 'ÃĨÑÕŨãĩñõũ'],
  0xc5: ['AEIOUYaeiouy', 'ĀĒĪŌŪȲāēīōūȳ'],
  0xc6: ['AEGIOUaegiou', 'ĂĔĞĬŎŬăĕğĭŏŭ'],
  0xc7: ['ACEGIOZacegoz', 'ȦĊĖĠİȮŻȧċėġȯż'],
  0xc8: ['AEIOUYaeiouy', 'ÄËÏÖÜŸäëïöüÿ'],
  0xca: ['AUau', 'ÅŮåů'],
  0xcb: ['CEGKLNRSTcegklnrst', 'ÇȨĢĶĻŅŖŞŢçȩģķļņŗşţ'],
  0xcd: ['OUou', 'ŐŰőű'],
  0xce: ['AEIOUaeiou', 'ĄĘĮǪŲąęįǫų'],
  0xcf: ['ACDEGHIKLNORSTUZacdeghijklnorstuz', 'ǍČĎĚǦȞǏǨĽŇǑŘŠŤǓŽǎčďěǧȟǐǰǩľňǒřšťǔž']
};
DIACRITICS[0xc9] = DIACRITICS[0xc8]; // ältere Sender (T.61) setzen das Trema auf 0xC9

// Übrige Zeichen ab 0xA0, die sich von Latin-1 unterscheiden ('' = nicht belegt)
const ISO6937 = {
  0xa4: '$', 0xa6: '#', 0xa8: '¤', 0xa9: '‘', 0xaa: '“', 0xac: '←', 0xad: '↑', 0xae: '→', 0xaf: '↓',
  0xb4: '×', 0xb8: '÷', 0xb9: '’', 0xba: '”', 0xc0: '', 0xcc: '',
  0xd0: '―', 0xd1: '¹', 0xd2: '®', 0xd3: '©', 0xd4: '™', 0xd5: '♪', 0xd6: '¬', 0xd7: '¦',
  0xd8: '', 0xd9: '', 0xda: '', 0xdb: '', 0xdc: '⅛', 0xdd: '⅜', 0xde: '⅝', 0xdf: '⅞',
  0xe0: 'Ω', 0xe1: 'Æ', 0xe2: 'Đ', 0xe3: 'ª', 0xe4: 'Ħ', 0xe5: '', 0xe6: 'Ĳ', 0xe7: 'Ŀ',
  0xe8: 'Ł', 0xe9: 'Ø', 0xea: 'Œ', 0xeb: 'º', 0xec: 'Þ', 0xed: 'Ŧ', 0xee: 'Ŋ', 0xef: 'ŉ',
  0xf0: 'ĸ', 0xf1: 'æ', 0xf2: 'đ', 0xf3: 'ð', 0xf4: 'ħ', 0xf5: 'ı', 0xf6: 'ĳ', 0xf7: 'ŀ',
  0xf8: 'ł', 0xf9: 'ø', 0xfa: 'œ', 0xfb: 'ß', 0xfc: 'þ', 0xfd: 'ŧ', 0xfe: 'ŋ', 0xff: ''
};

// Abweichungen von Latin-1 in den Zeichensätzen, die deutsche Kabelsender benutzen. Ein Node mit
// small-icu kennt im TextDecoder nur UTF-8 und Latin-1, deshalb ohne ihn.
const LATIN_VARIANTS = {
  'iso-8859-9': { 0xd0: 'Ğ', 0xdd: 'İ', 0xde: 'Ş', 0xf0: 'ğ', 0xfd: 'ı', 0xfe: 'ş' },
  'iso-8859-15': { 0xa4: '€', 0xa6: 'Š', 0xa8: 'š', 0xb4: 'Ž', 0xb8: 'ž', 0xbc: 'Œ', 0xbd: 'œ', 0xbe: 'Ÿ' }
};

function decode6937(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    const d = DIACRITICS[c];
    if (d) {
      const k = i + 1 < b.length ? d[0].indexOf(String.fromCharCode(b[i + 1])) : -1;
      if (k >= 0) { s += d[1][k]; i++; }
    } else if (c >= 0xa0 && ISO6937[c] !== undefined) {
      s += ISO6937[c];
    } else {
      s += String.fromCharCode(c);
    }
  }
  return s;
}

function decodeLatin(b, enc) {
  const map = LATIN_VARIANTS[enc] || {};
  let s = '';
  for (const c of b) s += map[c] || String.fromCharCode(c);
  return s;
}

// Gültiges UTF-8 mit mindestens einem Mehrbyte-Zeichen?
function looksUtf8(b) {
  let multi = false;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c < 0x80) continue;
    const n = c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : -1;
    if (n < 0 || i + n >= b.length) return false;
    for (let j = 1; j <= n; j++) if ((b[i + j] & 0xc0) !== 0x80) return false;
    i += n;
    multi = true;
  }
  return multi;
}

// Passt der Text zu ISO 6937? Latin-1-Umlaute (ä ö ü ß Ä Ö Ü) sind dort Sonderzeichen, die in deutschen
// Texten nie vorkommen, und ein Akzentbyte muss vor einem passenden Buchstaben stehen.
function looks6937(b) {
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0xe4 || c === 0xf6 || c === 0xfc || c === 0xdf || c === 0xd6 || c === 0xdc) return false;
    const d = DIACRITICS[c];
    if (d && (i + 1 >= b.length || d[0].indexOf(String.fromCharCode(b[i + 1])) < 0)) return false;
  }
  return true;
}

// Länge des Zeichensatz-Kennbytes am Textanfang (0 = keins)
function selectorLength(b) {
  if (!b.length || b[0] >= 0x20) return 0;
  if (b[0] === 0x10) return 3;
  if (b[0] === 0x1f) return 2;
  return 1;
}

function dvbText(buf) {
  if (!buf || !buf.length) return '';
  let b = buf;
  let enc = null;
  const c = b[0];
  const sel = selectorLength(b);
  if (sel) {
    if (c >= 0x01 && c <= 0x0b) enc = `iso-8859-${c + 4}`;
    else if (c === 0x10 && b.length >= 3) enc = `iso-8859-${b[2]}`;
    else if (c === 0x15) enc = 'utf-8';
    else enc = 'latin1';
    b = b.subarray(sel);
  } else {
    // Ohne Kennbyte gilt eigentlich ISO 6937, manche Sender schicken aber UTF-8 oder Latin-1.
    enc = looksUtf8(b) ? 'utf-8' : looks6937(b) ? 'iso6937' : 'iso-8859-15';
  }
  // Bei Einbyte-Zeichensätzen sind 0x80–0x9F DVB-Steuerzeichen (0x8A = Zeilenumbruch), keine Buchstaben.
  if (enc !== 'utf-8') {
    b = Buffer.from([...b].filter((x) => x < 0x80 || x > 0x9f || x === 0x8a).map((x) => (x === 0x8a ? 0x0a : x)));
  }
  let s;
  if (enc === 'iso6937') s = decode6937(b);
  else if (enc === 'utf-8') s = b.toString('utf8');
  else if (enc === 'latin1' || LATIN_VARIANTS[enc]) s = decodeLatin(b, enc);
  else {
    try { s = new TextDecoder(enc).decode(b); } catch { s = decodeLatin(b, enc); }
  }
  return s
    .replace(/[\u0080-\u0089\u008b-\u009f]/g, '')
    .replace(/\u008a/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f]/g, '')
    .trim();
}

// Der lange Text einer Sendung ist auf mehrere Deskriptoren verteilt. Meist trägt nur der erste das
// Zeichensatz-Kennbyte, und Mehrbyte-Zeichen (UTF-8, ISO-6937-Akzente) reißen an der Grenze auseinander.
// Deshalb erst die Bytes zusammensetzen und dann einmal dekodieren.
function joinDvbText(parts) {
  if (!parts.length) return '';
  const first = parts[0].subarray(0, selectorLength(parts[0]));
  const rest = parts.map((p, i) => {
    if (i === 0) return p;
    const n = selectorLength(p);
    return n && first.length === n && first.equals(p.subarray(0, n)) ? p.subarray(n) : p;
  });
  return dvbText(Buffer.concat(rest));
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
        ext.push([body[0] >> 4, body.subarray(q + 1, q + 1 + body[q])]);
      }
      d += 2 + s[d + 1];
    }
    if (ext.length) {
      const extText = joinDvbText(ext.sort((a, b) => a[0] - b[0]).map((e) => e[1]));
      if (extText.length > text.length) text = extText;
    }
    if (start !== null && title) events.push({ id, start, end: start + dur, title, text });
    p = dend;
  }
  return { key: `${onid}:${tsid}:${sid}`, tableId: s[0], events };
}

// ---------- Scan einer Frequenz ----------

// Ohne avm=1: Damit behandelt die FRITZ!Box eine zweite Sitzung desselben Geräts als Senderwechsel und
// schickt dem laufenden Sender keine Daten mehr (Standbild). Ohne den Parameter laufen beide parallel.
function siUrl(channelUrl) {
  return channelUrl.replace(/pids=[^&]*/, `pids=${SI_PIDS}`).replace(/([?&])avm=1(&|$)/, (m, a, b) => (b ? a : ''));
}

// Sammelt PAT, SDT und EIT aus den TS-Paketen einer Frequenz. Andere PIDs (Bild, Ton) werden übergangen,
// damit das auch im laufenden Stream mitlesen kann.
function muxCollector(onEvents) {
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
  result.push = (pkt, off) => {
    const pid = ((pkt[off + 1] & 0x1f) << 8) | pkt[off + 2];
    if (pid === 0 || pid === 17 || pid === 18) reader.push(pkt, off);
  };
  return result;
}

// signal.wait(ms) darf die Wartezeit vorzeitig beenden (Scan abbrechen)
async function scanMux(channelUrl, dwellMs, onEvents, signal) {
  const result = muxCollector(onEvents);
  const stream = await openStream(siUrl(channelUrl), result.push);
  try {
    await (signal ? signal.wait(dwellMs) : new Promise((r) => setTimeout(r, dwellMs)));
  } finally {
    await stream.close();
  }
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

function parseM3U(text) {
  const out = [];
  let name = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) name = line.slice(line.indexOf(',') + 1).trim();
    else if (!line.startsWith('#')) {
      out.push({ name: name || line, url: line });
      name = null;
    }
  }
  return out;
}

const CACHE_VERSION = 2;

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9äöüß]/g, '');

class Epg {
  // horizonMs begrenzt, wie weit im Voraus Sendungen behalten werden (Speicher im Fernseher),
  // canScan() kann den Scan einer Frequenz aufschieben, cacheFile hält das Ergebnis über Neustarts.
  constructor({ fetchAllChannels, dwellMs = 12000, intervalMs = 4 * 3600000, horizonMs = 0, canScan = () => true, cacheFile = null, log = () => {} }) {
    this.fetchAllChannels = fetchAllChannels;
    this.dwellMs = dwellMs;
    this.intervalMs = intervalMs;
    this.horizonMs = horizonMs;
    this.canScan = canScan;
    this.cacheFile = cacheFile;
    this.log = log;
    this.events = new Map();   // Dienst-Schlüssel -> Map(event_id -> Sendung)
    this.channelKey = new Map(); // RTSP-URL -> Dienst-Schlüssel
    this.scannedAt = new Map();  // Frequenz -> Zeit des letzten vollständigen Lesens
    this.channels = null;        // zuletzt geholte Senderliste (alle Listen)
    this.scanning = false;
    this.scanDone = null;
    this.cancelled = false;
    this.wakeDwell = null;
    this.updated = null;
    this.savedAt = 0;
    this.saveTimer = null;
    this.loadCache();
  }

  start(delayMs = 10000) {
    setTimeout(() => this.scanAll(), delayMs).unref();
    setInterval(() => this.scanAll(), this.intervalMs).unref();
  }

  addEvents(key, events) {
    const limit = this.horizonMs ? Date.now() + this.horizonMs : Infinity;
    let m = this.events.get(key);
    for (const e of events) {
      if (e.start > limit) continue;
      if (!m) this.events.set(key, (m = new Map()));
      m.set(e.id, e);
    }
  }

  prune() {
    const limit = Date.now() - 3600000;
    for (const [key, m] of this.events) {
      for (const [id, e] of m) if (e.end < limit) m.delete(id);
      if (!m.size) this.events.delete(key);
    }
  }

  async loadChannels(refresh) {
    if (!this.channels || refresh) this.channels = await this.fetchAllChannels();
    return this.channels;
  }

  // Bricht einen laufenden Scan ab und wartet, bis dessen Tuner wieder frei ist
  cancelScan() {
    if (!this.scanning) return Promise.resolve();
    this.cancelled = true;
    if (this.wakeDwell) this.wakeDwell();
    return this.scanDone;
  }

  scanAll() {
    if (this.scanning) return this.scanDone;
    this.scanning = true;
    this.cancelled = false;
    this.scanDone = this.runScan().finally(() => { this.scanning = false; });
    return this.scanDone;
  }

  async runScan() {
    const t0 = Date.now();
    const signal = {
      wait: (ms) => new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        this.wakeDwell = () => { clearTimeout(timer); resolve(); };
      })
    };
    let read = 0;
    try {
      const channels = await this.loadChannels(true);
      const byFreq = new Map();
      for (const ch of channels) {
        const f = freqOf(ch.url);
        if (!f) continue;
        if (!byFreq.has(f)) byFreq.set(f, []);
        byFreq.get(f).push(ch);
      }
      for (const [freq, list] of byFreq) {
        // Frequenzen, die gerade erst gelesen wurden (auch beim Zuschauen), auslassen
        if (Date.now() - (this.scannedAt.get(freq) || 0) < this.intervalMs / 2) continue;
        while (!this.cancelled && !this.canScan()) await signal.wait(2000);
        if (this.cancelled) break;
        try {
          const mux = await scanMux(list[0].url, this.dwellMs, (key, ev) => this.addEvents(key, ev), signal);
          if (this.cancelled) break;
          this.mapChannels(mux, list);
          this.scannedAt.set(freq, Date.now());
          read++;
          this.log(`EPG: ${freq} MHz gelesen (${mux.services.size} Dienste)`);
        } catch (e) {
          this.log(`EPG: ${freq} MHz fehlgeschlagen: ${e.message}`);
        }
        this.saveCache(false);
      }
      this.prune();
      this.updated = Date.now();
      this.log(`EPG: Scan ${this.cancelled ? 'abgebrochen' : 'fertig'} nach ${Math.round((Date.now() - t0) / 1000)} s, ${read} Frequenzen gelesen, ${this.channelKey.size} Sender zugeordnet`);
    } catch (e) {
      this.log(`EPG: Scan abgebrochen: ${e.message}`);
    } finally {
      this.wakeDwell = null;
      this.saveCache(true);
    }
  }

  // Liest SI-Daten aus einem laufenden Stream mit (die FRITZ!Box schickt PAT/SDT/EIT meist mit).
  // push(buf) bekommt die TS-Daten eines RTP-Pakets, finish() wird beim Ende des Streams aufgerufen.
  watch(url) {
    const freq = freqOf(url);
    const t0 = Date.now();
    const mux = muxCollector((key, ev) => this.addEvents(key, ev));
    let mapped = false;
    const map = (complete) => {
      if (mux.tsid === null || mux.onid === null) return;
      mapped = true;
      this.loadChannels().then((channels) => {
        this.mapChannels(mux, channels.filter((ch) => freqOf(ch.url) === freq));
        if (complete) this.scannedAt.set(freq, Date.now());
        this.updated = Date.now();
        this.saveCache(false);
      }).catch(() => {});
    };
    return {
      push: (buf) => {
        for (let off = 0; off + 188 <= buf.length; off += 188) if (buf[off] === 0x47) mux.push(buf, off);
        if (!mapped && Date.now() - t0 > 5000) map(false);
      },
      finish: () => map(Date.now() - t0 >= this.dwellMs)
    };
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

  loadCache() {
    if (!this.cacheFile) return;
    try {
      const c = JSON.parse(require('fs').readFileSync(this.cacheFile, 'utf8'));
      if (c.version !== CACHE_VERSION) return; // ältere Stände mit falsch dekodierten Umlauten verwerfen
      for (const [key, list] of c.events) this.addEvents(key, list);
      this.channelKey = new Map(c.channelKey);
      this.scannedAt = new Map(c.scannedAt);
      this.updated = c.updated;
      this.prune();
      this.log(`EPG: Zwischenspeicher geladen (${this.channelKey.size} Sender)`);
    } catch { /* noch keiner da */ }
  }

  cacheData() {
    return JSON.stringify({
      version: CACHE_VERSION,
      updated: this.updated,
      channelKey: [...this.channelKey],
      scannedAt: [...this.scannedAt],
      events: [...this.events].map(([key, m]) => [key, [...m.values()]])
    });
  }

  // Höchstens einmal pro Minute schreiben (sonst später nachholen), außer am Ende eines Scans
  saveCache(force) {
    if (!this.cacheFile) return;
    const wait = 60000 - (Date.now() - this.savedAt);
    if (!force && wait > 0) {
      if (!this.saveTimer) this.saveTimer = setTimeout(() => this.saveCache(true), wait);
      return;
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.savedAt = Date.now();
    require('fs').writeFile(this.cacheFile, this.cacheData(), (e) => {
      if (e) this.log(`EPG: Zwischenspeicher nicht geschrieben: ${e.message}`);
    });
  }

  // Beim Beenden des Prozesses, damit nichts verloren geht
  saveCacheSync() {
    if (!this.cacheFile) return;
    try { require('fs').writeFileSync(this.cacheFile, this.cacheData()); } catch { /* egal */ }
  }
}

module.exports = { Epg, scanMux, parseEit, dvbText, joinDvbText, openStream, describeTuners, parseM3U };

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
