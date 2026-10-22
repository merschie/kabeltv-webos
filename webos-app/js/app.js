(function () {
  'use strict';

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13,
    BACK: 461, ESC: 27, BACKSPACE: 8,
    CH_UP: 33, CH_DOWN: 34,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, INFO: 457
  };

  var LISTS = [
    { id: 'tvhd', label: 'HD' },
    { id: 'tvsd', label: 'SD' },
    { id: 'radio', label: 'Radio' }
  ];

  var DIRECT_TIMEOUT = 10000;

  var i18n = window.KabelI18n;
  var t = i18n.t;
  i18n.apply();

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video');

  // ---------- Einstellungen ----------

  var DEFAULTS = { fritzHost: 'fritz.box', lanStatus: false };

  function load(key, fallback) {
    try {
      var v = localStorage.getItem('kabeltv.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  }

  function save(key, value) {
    try { localStorage.setItem('kabeltv.' + key, JSON.stringify(value)); } catch (e) { /* ignorieren */ }
  }

  var stored = load('settings', {});
  var settings = { fritzHost: stored.fritzHost || DEFAULTS.fritzHost, lanStatus: !!stored.lanStatus };

  // ---------- Zustand ----------

  var state = {
    listId: load('listId', 'tvhd'),
    channels: {},          // listId -> [{name, url}]
    index: 0,
    playToken: 0,
    epg: {},               // listId -> { channels: {url: [jetzt, danach]}, fetched }
    epgDetail: {},         // url -> { events, fetched }
    demo: false,           // Demo-Modus ohne FRITZ!Box (Testbilder aus demo/)
    view: 'tv',            // 'tv' | 'channels' | 'settings'
    overlayListId: null,
    overlayIndex: 0
  };

  // ---------- Hilfsfunktionen ----------

  function fetchText(url, timeout) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeout || 6000);
    return fetch(url, { signal: ctrl.signal, cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .finally(function () { clearTimeout(timer); });
  }

  function parseM3U(text) {
    var out = [];
    var name = null;
    text.split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      if (line.indexOf('#EXTINF') === 0) {
        name = line.slice(line.indexOf(',') + 1).trim();
      } else if (line.charAt(0) !== '#') {
        out.push({ name: name || line, url: line });
        name = null;
      }
    });
    return out;
  }

  function b64url(s) {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ---------- Stream-Dienst auf dem Fernseher ----------
  // Der mitgelieferte Hintergrunddienst holt RTSP von der FRITZ!Box und gibt es per HTTP aus.

  var SERVICE_URI = 'luna://de.merschie.kabelboxtv.service/start';
  var tvService = { port: null, bridge: null, error: null };

  function startTvService() {
    if (typeof window.PalmServiceBridge === 'undefined') {
      tvService.error = t('svc.noWebos');
      return;
    }
    try {
      var bridge = new window.PalmServiceBridge();
      bridge.onservicecallback = function (msg) {
        try {
          var r = JSON.parse(msg);
          if (r.returnValue && r.port) tvService.port = r.port;
          else tvService.error = i18n.serviceText(r.errorText) || t('svc.noAnswer');
        } catch (e) { tvService.error = t('svc.badAnswer'); }
      };
      // Abo hält den Dienst am Leben, solange die App läuft
      bridge.call(SERVICE_URI, JSON.stringify({ subscribe: true, lan: !!settings.lanStatus }));
      tvService.bridge = bridge;
    } catch (e) {
      tvService.error = e.message;
    }
  }

  // Heimnetz-Zugriff auf den Dienst nachträglich umschalten (eigener Aufruf, das Abo bleibt bestehen)
  function setTvServiceLan(lan) {
    if (typeof window.PalmServiceBridge === 'undefined') return;
    try {
      var bridge = new window.PalmServiceBridge();
      bridge.onservicecallback = function () {};
      bridge.call(SERVICE_URI, JSON.stringify({ lan: lan }));
    } catch (e) { /* ignorieren */ }
  }

  // Wartet kurz auf den Dienst, damit der erste Senderstart nicht an der Startreihenfolge scheitert
  function waitForTvService(ms) {
    return new Promise(function (resolve) {
      var end = Date.now() + ms;
      (function check() {
        if (tvService.port || tvService.error || Date.now() > end) resolve(tvService.port);
        else setTimeout(check, 100);
      })();
    });
  }

  function directStreamUrl(rtspUrl) {
    return tvService.port ? 'http://127.0.0.1:' + tvService.port + '/stream/' + b64url(rtspUrl) : rtspUrl;
  }

  function listLabel(id) {
    for (var i = 0; i < LISTS.length; i++) if (LISTS[i].id === id) return LISTS[i].label;
    return id;
  }

  function show(el, on) { el.classList.toggle('hidden', !on); }

  function fmtTime(ms) {
    var d = new Date(ms);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function progressOf(ev) {
    var p = (Date.now() - ev.start) / (ev.end - ev.start);
    return Math.max(0, Math.min(1, p)) * 100;
  }

  // ---------- Demo-Modus ----------
  // Für Geräte ohne FRITZ!Box (z. B. die Prüfer im LG Content Store): selbst erzeugte Testbilder
  // und ein ausgedachter Programmführer, damit sich die ganze Bedienung ausprobieren lässt.

  var DEMO_LISTS = {
    tvhd: [
      { name: t('demo.channel', { n: 1 }), url: 'demo/demo1.mp4' },
      { name: t('demo.channel', { n: 2 }), url: 'demo/demo2.mp4' },
      { name: t('demo.channel', { n: 3 }), url: 'demo/demo3.mp4' }
    ],
    tvsd: [{ name: t('demo.channelSd'), url: 'demo/demo2.mp4' }],
    radio: [{ name: t('demo.radio'), url: 'demo/radio1.m4a' }]
  };
  var DEMO_SLOT = 30 * 60000;

  function demoEvents(url, count) {
    var n = 0;
    for (var i = 0; i < url.length; i++) n += url.charCodeAt(i);
    var first = Math.floor(Date.now() / DEMO_SLOT) * DEMO_SLOT;
    var out = [];
    for (var k = 0; k < count; k++) {
      var no = (Math.floor(first / DEMO_SLOT) + k + n) % 9 + 1;
      out.push({
        start: first + k * DEMO_SLOT,
        end: first + (k + 1) * DEMO_SLOT,
        title: t('demo.show', { n: no }),
        text: t('demo.text', { n: no })
      });
    }
    return out;
  }

  function demoEpg(path) {
    var m = path.match(/^\/api\/epg\/channel\/(.+)$/);
    if (m) return { events: demoEvents(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')), 8) };
    var list = DEMO_LISTS[path.replace('/api/epg/', '')] || [];
    var channels = {};
    list.forEach(function (ch) { channels[ch.url] = demoEvents(ch.url, 2); });
    return { channels: channels };
  }

  function startDemo() {
    state.demo = true;
    state.channels = {};
    state.epg = {};
    state.epgDetail = {};
    state.listId = 'tvhd';
    closeSettings();
    start();
  }

  // ---------- Programmführer ----------
  // Kommt vom Stream-Dienst im Fernseher, der ihn selbst aus dem Kabelsignal liest.

  var EPG_MAX_AGE = 120000;

  function serviceBase() {
    return tvService.port ? 'http://127.0.0.1:' + tvService.port : '';
  }

  function fetchEpg(path) {
    if (state.demo) return Promise.resolve(demoEpg(path));
    return waitForTvService(3000).then(function () {
      if (!serviceBase()) throw new Error(t('svc.notRunning'));
      var host = (settings.fritzHost || DEFAULTS.fritzHost).trim();
      return fetchText(serviceBase() + path + '?host=' + encodeURIComponent(host), 8000);
    }).then(JSON.parse);
  }

  function loadEpg(listId) {
    var cached = state.epg[listId];
    if (cached && Date.now() - cached.fetched < EPG_MAX_AGE) return;
    fetchEpg('/api/epg/' + listId).then(function (r) {
      var channels = r.channels || {};
      // Solange der Fernseher noch einliest, bald wieder nachfragen
      var fetched = Object.keys(channels).length || !r.scanning ? Date.now() : Date.now() - EPG_MAX_AGE + 20000;
      state.epg[listId] = { channels: channels, fetched: fetched, scanning: !!r.scanning };
      if (state.view === 'channels' && state.overlayListId === listId) refreshNowLines();
      if (listId === state.listId && !$('infobar').classList.contains('hidden')) renderInfoEpg();
    }).catch(function () { /* ohne EPG weiter */ });
  }

  // Jetzt/Danach eines Senders; ist "jetzt" schon vorbei, rückt "danach" nach
  function nowNext(listId, url) {
    var e = state.epg[listId] && state.epg[listId].channels[url];
    if (!e) return null;
    var now = e[0];
    var next = e[1];
    if (now && now.end <= Date.now() && next) { now = next; next = null; }
    return now ? { now: now, next: next } : null;
  }

  // ---------- Playlists ----------

  function loadList(listId) {
    if (state.channels[listId]) return Promise.resolve(state.channels[listId]);
    if (state.demo) return Promise.resolve(state.channels[listId] = DEMO_LISTS[listId]);

    var host = (settings.fritzHost || DEFAULTS.fritzHost).trim();
    return fetchText('http://' + host + '/dvb/m3u/' + listId + '.m3u').then(parseM3U).then(function (list) {
      if (!list.length) throw new Error(t('list.empty'));
      state.channels[listId] = list;
      return list;
    });
  }

  // ---------- Wiedergabe ----------

  function stopPlayback() {
    state.playToken++;
    video.pause();
    video.removeAttribute('src');
    video.load();
    hideStatus();
  }

  // Spielt eine URL ab und meldet true, sobald Bild/Ton läuft, sonst false.
  function tryPlay(url, timeout, token) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (ok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeEventListener('playing', onPlaying);
        video.removeEventListener('error', onError);
        resolve(ok);
      };
      var onPlaying = function () { finish(true); };
      var onError = function () { finish(false); };
      var timer = setTimeout(function () { finish(false); }, timeout);

      video.addEventListener('playing', onPlaying);
      video.addEventListener('error', onError);
      video.src = url;
      var pr = video.play();
      if (pr && pr.catch) pr.catch(function () { /* Fehler kommt über 'error' bzw. Timeout */ });

      // abgelöst durch neueren Senderwechsel
      var check = setInterval(function () {
        if (token !== state.playToken) { clearInterval(check); finish(false); }
        if (done) clearInterval(check);
      }, 200);
    });
  }

  function play(listId, index) {
    var list = state.channels[listId];
    if (!list || !list.length) return;
    index = (index + list.length) % list.length;

    stopPlayback();
    var token = state.playToken;
    state.listId = listId;
    state.index = index;
    if (!state.demo) {
      save('listId', listId);
      save('last.' + listId, index);
    }

    var ch = list[index];
    hideError();
    setRadio(listId === 'radio' ? ch.name : null);
    loadEpg(listId);
    showInfo();
    video.loop = state.demo;
    if (state.demo) {
      startLoader(ch.name, t('load.demo'), ch.name);
    } else {
      startLoader(ch.name, tvService.port ? t('load.connecting') : t('load.service'), ch.name);
    }
    (state.demo ? Promise.resolve() : waitForTvService(3000)).then(function () {
      if (token !== state.playToken) return false;
      if (state.demo) return tryPlay(ch.url, DIRECT_TIMEOUT, token);
      setLoaderBar(10, t('load.connecting'));
      return tryPlay(directStreamUrl(ch.url), DIRECT_TIMEOUT, token);
    }).then(function (ok) {
      if (token !== state.playToken) return;
      if (ok) {
        // Ladeanzeige verschwindet von selbst, sobald das Bild wirklich läuft
        showInfo();
        return;
      }
      hideStatus();
      showError(t('play.failed'), failureHint());
    });
  }

  function failureHint() {
    if (state.demo) return t('play.demoFailed');
    return t('play.tvFailed', {
      service: tvService.port ? '' : t('play.serviceState', { state: tvService.error || t('svc.notStarted') })
    });
  }

  function zap(delta) {
    var list = state.channels[state.listId];
    if (list) play(state.listId, state.index + delta);
  }

  // ---------- Anzeige ----------

  var infoTimer = null;
  var tunerTimer = null;

  // Belegte/freie Tuner der FRITZ!Box (zählt auch andere Geräte mit), über den Dienst im TV
  function fetchTuners() {
    if (state.demo) return Promise.reject(new Error('Demo'));
    if (!tvService.port) return Promise.reject(new Error(t('svc.notRunning')));
    var host = (settings.fritzHost || DEFAULTS.fritzHost).trim();
    return fetchText('http://127.0.0.1:' + tvService.port + '/tuners?host=' + encodeURIComponent(host), 5000).then(JSON.parse);
  }

  function updateTuners() {
    var el = $('info-tuners');
    fetchTuners().then(function (tu) {
      if (!tu.total) throw new Error('keine Angabe');
      el.textContent = t('tuners', { used: tu.used, total: tu.total, free: tu.free });
      el.className = 'badge ' + (tu.free === 0 ? 'full' : tu.free === 1 ? 'low' : 'ok');
      show(el, true);
    }).catch(function () { show(el, false); });
  }

  function showInfo() {
    var list = state.channels[state.listId] || [];
    var ch = list[state.index];
    if (!ch) return;
    $('info-num').textContent = state.index + 1;
    $('info-name').textContent = ch.name;
    $('info-list').textContent = listLabel(state.listId);
    show($('info-demo'), state.demo);
    $('info-clock').textContent = fmtTime(Date.now());
    renderInfoEpg();
    show($('infobar'), true);
    // nach dem Senderwechsel belegt der neue Stream seinen Tuner erst nach ein paar Sekunden
    updateTuners();
    clearInterval(tunerTimer);
    tunerTimer = setInterval(updateTuners, 2000);
    clearTimeout(infoTimer);
    infoTimer = setTimeout(function () {
      show($('infobar'), false);
      clearInterval(tunerTimer);
    }, 5000);
  }

  function renderInfoEpg() {
    var ch = (state.channels[state.listId] || [])[state.index];
    var nn = ch && nowNext(state.listId, ch.url);
    show($('info-epg'), !!nn);
    if (!nn) return;
    $('info-now-time').textContent = fmtTime(nn.now.start) + ' – ' + fmtTime(nn.now.end);
    $('info-now-title').textContent = nn.now.title;
    $('info-now-progress').style.width = progressOf(nn.now) + '%';
    $('info-next-time').textContent = nn.next ? fmtTime(nn.next.start) : '';
    $('info-next-title').textContent = nn.next ? nn.next.title : '';
  }

  function setRadio(name) {
    show($('radio'), !!name);
    $('radio-name').textContent = name || '';
  }

  function showStatus(text) { startLoader(text, ''); }
  function hideStatus() {
    loader.phase = 'idle';
    show($('status'), false);
  }

  // ---------- Ladeanzeige ----------
  // Deckt beim Senderwechsel Schwarzbild und Standbild ab, bis die Zeit im Video wirklich läuft.
  // Danach erscheint sie wieder, wenn die Wiedergabe hängt (Nachladen).

  var START_HOLD = 0.6;      // Sekunden echter Wiedergabe, bevor die Abdeckung verschwindet
  var START_MAX = 8000;      // spätestens dann weg, auch wenn die Zeit nicht weiterläuft
  var STALL_MS = 1000;       // so lange ohne Fortschritt gilt als Hänger
  var RECONNECT_MS = 20000;  // so lange hängend, dann Sender neu starten

  var loader = {
    phase: 'idle',           // 'idle' | 'starting' | 'running' | 'buffering'
    pct: 0,
    playingAt: 0,
    startTime: 0,
    lastTime: 0,
    lastMove: 0,
    waitingAt: 0
  };

  function setLoaderBar(pct, step) {
    if (pct < loader.pct) return;
    loader.pct = pct;
    $('status-bar').style.width = pct + '%';
    if (step !== undefined) setLoaderStep(step);
  }

  function setLoaderStep(step) {
    $('status-step').textContent = step;
    show($('status-step'), !!step);
  }

  // ---------- Senderlogos ----------
  // Logos liegen in logos/<schlüssel>.png, die Liste steht in js/logos.js.
  // Der Sendername wird vereinfacht ("ZDFneo HD" -> "zdfneo") und mit den Schlüsseln ohne Bindestriche verglichen.
  // Passt nichts, werden hinten Wörter weggelassen ("WDR HD Köln" -> "wdr", "hr-fernsehen" -> "hr").

  var LOGO_ALIAS = {
    erste: 'das-erste', ardhd: 'das-erste',
    pro7: 'pro-sieben', pro7maxx: 'pro-sieben-maxx',
    rtl2: 'rtl-zwei', rtlnitro: 'nitro', superrtl: 'rtl-super', rtlsuper: 'rtl-super',
    kabel1: 'kabel-eins', kabel1doku: 'kabel-eins-doku', kabel1classics: 'kabel-eins-classics',
    servustv: 'servus-tv-deutchland', servustvdeutschland: 'servus-tv-deutchland',
    euronews: 'euronews-deutsch', eurosport: 'eurosport-1', hse24: 'hse', qvc2: 'qvc-zwei',
    ndrfshh: 'ndr-hamburg', ndrfsmv: 'ndr-mecklenburg-vorpommern', ndrfssh: 'ndr-schleswig-holstein',
    mdrsachsenanhalt: 'mdr-sachsen-anhalt', mdrthuringen: 'mdr-thuringen',
    welttv: 'welt', ntvhd: 'ntv', dmf: 'deutsches-musik-fernsehen'
  };

  var logoIndex = null;

  function logoKeyFor(name) {
    if (!logoIndex) {
      logoIndex = {};
      (window.KABELTV_LOGOS || []).forEach(function (k) { logoIndex[k.replace(/-/g, '')] = k; });
    }
    var words = String(name || '').toLowerCase()
      .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
      .replace(/\+/g, ' plus ')
      .split(/[^a-z0-9]+/)
      .filter(function (w) { return w && !/^(hd|sd|uhd|4k)$/.test(w); });
    for (var n = words.length; n > 0; n--) {
      var c = words.slice(0, n).join('');
      if (LOGO_ALIAS[c]) return LOGO_ALIAS[c];
      if (logoIndex[c]) return logoIndex[c];
    }
    return null;
  }

  // Hintergrund der Ladeanzeige: Senderlogo, ohne Logo der Sendername in groß
  function setLoaderLogo(channelName) {
    var img = $('status-logo');
    var label = $('status-logo-name');
    var key = channelName ? logoKeyFor(channelName) : null;
    var fallback = function () {
      show(img, false);
      label.textContent = channelName || '';
      show(label, !!channelName);
    };
    img.onload = null;
    img.onerror = null;
    if (!key) {
      img.removeAttribute('src');
      fallback();
      return;
    }
    show(label, false);
    img.onerror = fallback;
    img.src = 'logos/' + key + '.png';
    show(img, true);
  }

  function startLoader(text, step, channelName) {
    loader.phase = 'starting';
    loader.pct = 0;
    loader.playingAt = 0;
    loader.waitingAt = 0;
    loader.lastTime = 0;
    loader.lastMove = Date.now();
    $('status-text').textContent = text;
    setLoaderLogo(channelName);
    $('status').classList.add('cover');
    $('status').classList.remove('buffering');
    $('status-bar').style.width = '0';
    setLoaderBar(5, step);
    show($('status'), true);
  }

  function showBuffering() {
    loader.phase = 'buffering';
    $('status-text').textContent = t('load.rebuffer');
    setLoaderStep(t('load.stalled'));
    $('status').classList.remove('cover');
    $('status').classList.add('buffering');
    show($('status'), true);
  }

  function loaderRunning() {
    loader.phase = 'running';
    loader.waitingAt = 0;
    show($('status'), false);
  }

  // Zwischenschritte für den Balken; beim Start ist das echte Ende erst die laufende Zeit
  video.addEventListener('loadstart', function () { if (loader.phase === 'starting') setLoaderBar(15, t('load.request')); });
  video.addEventListener('loadedmetadata', function () { if (loader.phase === 'starting') setLoaderBar(40, t('load.found')); });
  video.addEventListener('loadeddata', function () { if (loader.phase === 'starting') setLoaderBar(55, t('load.firstFrame')); });
  video.addEventListener('canplay', function () { if (loader.phase === 'starting') setLoaderBar(65, t('load.buffer')); });
  video.addEventListener('playing', function () {
    if (loader.phase !== 'starting' || loader.playingAt) return;
    loader.playingAt = Date.now();
    loader.startTime = video.currentTime;
    setLoaderBar(75, t('load.starting'));
  });
  video.addEventListener('waiting', function () {
    if (loader.phase === 'running') loader.waitingAt = Date.now();
  });

  setInterval(function () {
    if (loader.phase === 'idle') return;
    var now = Date.now();
    var pos = video.currentTime;
    var moved = pos > loader.lastTime + 0.01;
    loader.lastTime = pos;
    if (moved) loader.lastMove = now;

    if (loader.phase === 'starting') {
      if (!loader.playingAt) return;
      var played = pos - loader.startTime;
      setLoaderBar(75 + Math.min(1, Math.max(0, played / START_HOLD)) * 25);
      if (played >= START_HOLD || now - loader.playingAt > START_MAX) loaderRunning();
    } else if (loader.phase === 'running') {
      var stalled = now - loader.lastMove > STALL_MS ||
        (loader.waitingAt && now - loader.waitingAt > 400 && now - loader.lastMove > 400);
      if (stalled && state.view !== 'settings') showBuffering();
    } else if (loader.phase === 'buffering') {
      var quiet = Math.round((now - loader.lastMove) / 1000);
      if (moved) loaderRunning();
      else if (now - loader.lastMove > RECONNECT_MS && state.channels[state.listId]) play(state.listId, state.index);
      else if (quiet >= 5) setLoaderStep(t('load.quiet', { quiet: quiet, restart: RECONNECT_MS / 1000 }));
    }
  }, 250);
  function showError(title, text) {
    $('error-title').textContent = title;
    $('error-text').textContent = text;
    show($('error'), true);
  }
  function hideError() { show($('error'), false); }

  // ---------- Nummerneingabe ----------

  var numBuf = '';
  var numTimer = null;

  function digit(d) {
    numBuf = (numBuf + d).slice(-3);
    $('numinput').textContent = numBuf;
    show($('numinput'), true);
    clearTimeout(numTimer);
    numTimer = setTimeout(commitNumber, 1500);
  }

  function commitNumber() {
    clearTimeout(numTimer);
    var n = parseInt(numBuf, 10);
    numBuf = '';
    show($('numinput'), false);
    var list = state.channels[state.listId] || [];
    if (n >= 1 && n <= list.length) play(state.listId, n - 1);
  }

  // ---------- Senderliste ----------

  function openChannels() {
    state.view = 'channels';
    state.overlayListId = state.listId;
    state.overlayIndex = state.index;
    show($('channels'), true);
    renderChannels();
    loadEpg(state.overlayListId);
  }

  function closeChannels() {
    state.view = 'tv';
    show($('channels'), false);
  }

  function renderTabs() {
    var tabs = $('tabs');
    tabs.innerHTML = '';
    LISTS.forEach(function (l) {
      var tab = document.createElement('div');
      tab.className = 'tab' + (l.id === state.overlayListId ? ' active' : '');
      tab.textContent = l.label;
      tab.addEventListener('click', function () { switchOverlayList(l.id); });
      tabs.appendChild(tab);
    });
  }

  function renderChannels() {
    renderTabs();
    var ul = $('channel-list');
    ul.innerHTML = '';
    var list = state.channels[state.overlayListId];
    if (!list) {
      ul.innerHTML = '<li>' + t('list.loadingShort') + '</li>';
      return;
    }
    list.forEach(function (ch, i) {
      var li = document.createElement('li');
      if (state.overlayListId === state.listId && i === state.index) li.classList.add('playing');
      var num = document.createElement('span');
      num.className = 'num';
      num.textContent = i + 1;
      var col = document.createElement('div');
      col.className = 'ch';
      var name = document.createElement('div');
      name.className = 'ch-name';
      name.textContent = ch.name;
      var nowLine = document.createElement('div');
      nowLine.className = 'ch-now';
      col.appendChild(name);
      col.appendChild(nowLine);
      li.appendChild(num);
      li.appendChild(col);
      li.addEventListener('click', function () {
        state.overlayIndex = i;
        closeChannels();
        play(state.overlayListId, i);
      });
      li.addEventListener('mouseenter', function () { state.overlayIndex = i; updateSelection(); });
      ul.appendChild(li);
    });
    refreshNowLines();
    updateSelection();
  }

  function refreshNowLines() {
    var list = state.channels[state.overlayListId] || [];
    var items = $('channel-list').querySelectorAll('.ch-now');
    for (var i = 0; i < items.length && i < list.length; i++) {
      var nn = nowNext(state.overlayListId, list[i].url);
      items[i].textContent = nn ? fmtTime(nn.now.start) + '  ' + nn.now.title : '';
    }
  }

  function updateSelection() {
    var items = $('channel-list').children;
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('selected', i === state.overlayIndex);
    }
    var sel = items[state.overlayIndex];
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    scheduleDetail();
  }

  // ---------- Programm des ausgewählten Senders ----------

  var detailTimer = null;

  function scheduleDetail() {
    clearTimeout(detailTimer);
    var ch = (state.channels[state.overlayListId] || [])[state.overlayIndex];
    $('epg-channel').textContent = ch ? ch.name : '';
    if (!ch) { $('epg-events').innerHTML = ''; return; }
    var cached = state.epgDetail[ch.url];
    if (cached) renderDetail(cached.events);
    else $('epg-events').innerHTML = '';
    if (cached && Date.now() - cached.fetched < EPG_MAX_AGE) return;
    detailTimer = setTimeout(function () {
      fetchEpg('/api/epg/channel/' + b64url(ch.url)).then(function (r) {
        var events = r.events || [];
        // leere Antwort nicht lange merken, der EPG kann gerade erst eingelesen werden
        state.epgDetail[ch.url] = { events: events, fetched: events.length ? Date.now() : Date.now() - EPG_MAX_AGE + 20000 };
        var cur = (state.channels[state.overlayListId] || [])[state.overlayIndex];
        if (state.view === 'channels' && cur && cur.url === ch.url) renderDetail(events);
      }).catch(function () {
        renderDetail(null, t('epg.failed'));
      });
    }, 250);
  }

  function renderDetail(events, message) {
    var box = $('epg-events');
    box.innerHTML = '';
    var now = Date.now();
    events = (events || []).filter(function (e) { return e.end > now; });
    if (!events.length) {
      var empty = document.createElement('div');
      empty.className = 'epg-empty';
      empty.textContent = message || t('epg.empty');
      box.appendChild(empty);
      return;
    }
    events.slice(0, 12).forEach(function (e, i) {
      var ev = document.createElement('div');
      ev.className = 'ev' + (e.start <= now ? ' now' : '');
      var head = document.createElement('div');
      head.className = 'ev-head';
      var time = document.createElement('span');
      time.className = 'ev-time';
      time.textContent = fmtTime(e.start);
      var title = document.createElement('span');
      title.className = 'ev-title';
      title.textContent = e.title;
      head.appendChild(time);
      head.appendChild(title);
      ev.appendChild(head);
      if (e.start <= now) {
        var bar = document.createElement('div');
        bar.className = 'progress';
        bar.innerHTML = '<div style="width:' + progressOf(e) + '%"></div>';
        ev.appendChild(bar);
      }
      if (i === 0 && e.text) {
        var text = document.createElement('div');
        text.className = 'ev-text';
        text.textContent = e.text;
        ev.appendChild(text);
      }
      box.appendChild(ev);
    });
  }

  function switchOverlayList(listId) {
    state.overlayListId = listId;
    state.overlayIndex = listId === state.listId ? state.index : 0;
    renderChannels();
    loadEpg(listId);
    loadList(listId).then(function () {
      if (state.overlayListId === listId) renderChannels();
    }).catch(function (e) {
      $('channel-list').innerHTML = '';
      var li = document.createElement('li');
      li.textContent = t('error.prefix', { msg: i18n.serviceText(e.message) });
      $('channel-list').appendChild(li);
    });
  }

  function channelsKey(code) {
    var list = state.channels[state.overlayListId] || [];
    var idx = LISTS.map(function (l) { return l.id; }).indexOf(state.overlayListId);
    switch (code) {
      case KEY.UP: state.overlayIndex = Math.max(0, state.overlayIndex - 1); updateSelection(); break;
      case KEY.DOWN: state.overlayIndex = Math.min(list.length - 1, state.overlayIndex + 1); updateSelection(); break;
      case KEY.CH_UP: state.overlayIndex = Math.max(0, state.overlayIndex - 10); updateSelection(); break;
      case KEY.CH_DOWN: state.overlayIndex = Math.min(list.length - 1, state.overlayIndex + 10); updateSelection(); break;
      case KEY.LEFT: switchOverlayList(LISTS[(idx + LISTS.length - 1) % LISTS.length].id); break;
      case KEY.RIGHT: switchOverlayList(LISTS[(idx + 1) % LISTS.length].id); break;
      case KEY.OK:
        if (list.length) {
          closeChannels();
          play(state.overlayListId, state.overlayIndex);
        }
        break;
      case KEY.RED: closeChannels(); openSettings(); break;
      case KEY.BACK: case KEY.ESC: case KEY.BACKSPACE: closeChannels(); break;
      default: return false;
    }
    return true;
  }

  // ---------- Einstellungen ----------

  var navEls = [];
  var navIndex = 0;
  var draftLan = false;

  function openSettings(message, bad) {
    state.view = 'settings';
    $('set-fritz').value = settings.fritzHost;
    draftLan = !!settings.lanStatus;
    renderLan();
    setSettingsStatus(message || '', bad);
    navEls = Array.prototype.slice.call(document.querySelectorAll('#settings .nav'));
    navIndex = 0;
    show($('settings'), true);
    updateNav();
  }

  function closeSettings() {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    state.view = 'tv';
    show($('settings'), false);
  }

  // Ohne Senderliste gibt es kein Fernsehbild, dahinter: dann zurück zum Hinweis
  function cancelSettings() {
    closeSettings();
    if (!state.channels[state.listId]) openNoFritz();
  }

  function renderLan() {
    var lan = document.querySelectorAll('#set-lan button');
    for (var j = 0; j < lan.length; j++) {
      lan[j].classList.toggle('active', (lan[j].getAttribute('data-lan') === 'on') === draftLan);
    }
  }

  function updateNav() {
    navEls.forEach(function (el, i) { el.classList.toggle('focused', i === navIndex); });
  }

  function setSettingsStatus(text, bad) {
    var s = $('settings-status');
    s.textContent = text;
    s.className = text ? (bad ? 'bad' : 'ok') : '';
  }

  function readDraft() {
    return {
      fritzHost: $('set-fritz').value.trim() || DEFAULTS.fritzHost,
      lanStatus: draftLan
    };
  }

  function testConnection() {
    var d = readDraft();
    setSettingsStatus(t('test.running'));
    var lines = [];
    var fritz = fetchText('http://' + d.fritzHost + '/dvb/m3u/tvhd.m3u', 5000)
      .then(function (text) { lines.push(t('test.fritzOk', { count: parseM3U(text).length })); return true; })
      .catch(function (e) { lines.push(t('test.fritzFail', { msg: e.message })); return false; });
    lines.push(t('test.service', {
      state: tvService.port ? t('test.serviceRunning', { port: tvService.port }) : (tvService.error || t('svc.notStarted'))
    }));
    fritz.then(function (ok) { setSettingsStatus(lines.join('\n'), !ok); });
  }

  function saveSettings() {
    var d = readDraft();
    var changed = d.fritzHost !== settings.fritzHost || state.demo;
    state.demo = false;
    if (d.lanStatus !== !!settings.lanStatus) setTvServiceLan(d.lanStatus);
    settings = d;
    save('settings', settings);
    closeSettings();
    if (changed) {
      state.channels = {};
      state.epg = {};
      state.epgDetail = {};
      start();
    }
  }

  function activateNav(el) {
    if (el.tagName === 'INPUT') {
      el.focus();
    } else if (el.hasAttribute('data-lan')) {
      draftLan = el.getAttribute('data-lan') === 'on';
      renderLan();
    } else if (el.id === 'btn-test') testConnection();
    else if (el.id === 'btn-save') saveSettings();
    else if (el.id === 'btn-cancel') cancelSettings();
    else if (el.id === 'btn-tutorial') openTutorial();
    else if (el.id === 'btn-demo') startDemo();
  }

  function settingsKey(code) {
    var editing = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (editing) {
      if (code === KEY.OK || code === KEY.UP || code === KEY.DOWN) {
        document.activeElement.blur();
        if (code === KEY.OK) return true;
      } else {
        return false; // Tasten an das Eingabefeld durchreichen
      }
    }
    var el = navEls[navIndex];
    var inSeg = el && el.parentNode.classList.contains('segmented');
    var inRow = el && el.parentNode.classList.contains('row');
    switch (code) {
      case KEY.UP: navIndex = prevGroupStart(); updateNav(); break;
      case KEY.DOWN: navIndex = nextGroupStart(); updateNav(); break;
      case KEY.LEFT: if ((inSeg || inRow) && navEls[navIndex - 1] && navEls[navIndex - 1].parentNode === el.parentNode) { navIndex--; updateNav(); } break;
      case KEY.RIGHT: if ((inSeg || inRow) && navEls[navIndex + 1] && navEls[navIndex + 1].parentNode === el.parentNode) { navIndex++; updateNav(); } break;
      case KEY.OK: activateNav(el); break;
      case KEY.BACK: case KEY.ESC: cancelSettings(); break;
      default: return false;
    }
    return true;
  }

  // Hoch/Runter springen zwischen Zeilen (Eingabefeld, Moduswahl, Knopfleiste)
  function groupOf(i) { var el = navEls[i]; return el.tagName === 'INPUT' ? el : el.parentNode; }
  function nextGroupStart() {
    var g = groupOf(navIndex);
    for (var i = navIndex + 1; i < navEls.length; i++) if (groupOf(i) !== g) return i;
    return navIndex;
  }
  function prevGroupStart() {
    var g = groupOf(navIndex);
    for (var i = navIndex - 1; i >= 0; i--) {
      if (groupOf(i) !== g) {
        var pg = groupOf(i);
        while (i > 0 && groupOf(i - 1) === pg) i--;
        return i;
      }
    }
    return navIndex;
  }

  navEls = Array.prototype.slice.call(document.querySelectorAll('#settings .nav'));
  navEls.forEach(function (el, i) {
    el.addEventListener('click', function () { navIndex = i; updateNav(); activateNav(el); });
    el.addEventListener('mouseenter', function () { navIndex = i; updateNav(); });
  });

  // ---------- Anleitung ----------

  var TUTORIAL = t('tutorial');

  var tutorial = { open: false, page: 0 };

  function openTutorial() {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    tutorial.open = true;
    tutorial.page = 0;
    renderTutorial();
    show($('tutorial'), true);
  }

  function closeTutorial() {
    tutorial.open = false;
    show($('tutorial'), false);
    save('tutorialSeen', true);
  }

  function renderTutorial() {
    var p = TUTORIAL[tutorial.page];
    $('tut-step').textContent = t('tut.step', { n: tutorial.page + 1, total: TUTORIAL.length });
    $('tut-title').textContent = p.title;
    $('tut-body').innerHTML = p.rows.map(function (r) {
      return '<div class="tut-row">' + (r[0] ? '<div class="tut-key">' + r[0] + '</div>' : '') +
        '<div class="tut-text">' + r[1] + '</div></div>';
    }).join('');
    $('tut-ok').textContent = t(tutorial.page < TUTORIAL.length - 1 ? 'tut.next' : 'tut.done');
    $('tut-dots').innerHTML = TUTORIAL.map(function (x, i) {
      return '<span' + (i === tutorial.page ? ' class="active"' : '') + '></span>';
    }).join('');
  }

  function tutorialKey(code) {
    switch (code) {
      case KEY.RIGHT: case KEY.OK:
        if (tutorial.page < TUTORIAL.length - 1) { tutorial.page++; renderTutorial(); } else closeTutorial();
        break;
      case KEY.LEFT:
        if (tutorial.page > 0) { tutorial.page--; renderTutorial(); }
        break;
      case KEY.BACK: case KEY.ESC: case KEY.BACKSPACE: closeTutorial(); break;
      default: break; // übrige Tasten nicht ans Fernsehbild durchreichen
    }
    return true;
  }

  $('tutorial').addEventListener('click', function () { tutorialKey(KEY.OK); });

  // ---------- Hinweis ohne FRITZ!Box ----------

  var nofritzIndex = 0;

  function openNoFritz(detail) {
    state.view = 'nofritz';
    if (detail && /fetch|network/i.test(detail)) detail = t('nofritz.noAnswer');
    $('nofritz-detail').textContent = t('nofritz.searched', { host: settings.fritzHost || DEFAULTS.fritzHost }) + (detail ? ': ' + detail : '');
    nofritzIndex = 0;
    renderNoFritz();
    show($('nofritz'), true);
  }

  function closeNoFritz() {
    state.view = 'tv';
    show($('nofritz'), false);
  }

  function renderNoFritz() {
    var btns = document.querySelectorAll('#nofritz .nf-btn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('focused', i === nofritzIndex);
  }

  function noFritzAction(act) {
    closeNoFritz();
    if (act === 'demo') startDemo();
    else if (act === 'settings') openSettings();
    else start();
  }

  function noFritzKey(code) {
    var btns = document.querySelectorAll('#nofritz .nf-btn');
    switch (code) {
      case KEY.LEFT: if (nofritzIndex > 0) nofritzIndex--; renderNoFritz(); break;
      case KEY.RIGHT: if (nofritzIndex < btns.length - 1) nofritzIndex++; renderNoFritz(); break;
      case KEY.OK: noFritzAction(btns[nofritzIndex].getAttribute('data-act')); break;
      case KEY.RED: closeNoFritz(); openSettings(); break;
      case KEY.BACK: case KEY.ESC: exitApp(); break;
      default: return false;
    }
    return true;
  }

  Array.prototype.forEach.call(document.querySelectorAll('#nofritz .nf-btn'), function (el, i) {
    el.addEventListener('mouseenter', function () { nofritzIndex = i; renderNoFritz(); });
  });

  $('nofritz').addEventListener('click', function (e) {
    var act = e.target.getAttribute && e.target.getAttribute('data-act');
    if (act) noFritzAction(act);
  });

  // Magic Remote: ein Klick ins Fernsehbild öffnet die Senderliste (sonst gäbe es mit dem Zeiger keinen Weg dorthin)
  video.addEventListener('click', function () {
    if (state.view === 'tv' && !tutorial.open && state.channels[state.listId]) openChannels();
  });

  // ---------- Tasten ----------

  // platformBack fragt erst „App verlassen?“. Bricht man ab, soll der Sender weiterlaufen,
  // deshalb hier nicht stoppen: Den Tuner gibt visibilitychange frei, sobald die App wirklich weg ist.
  function exitApp() {
    if (window.PalmSystem && window.PalmSystem.platformBack) window.PalmSystem.platformBack();
    else window.close();
  }

  function tvKey(code) {
    if (code >= 48 && code <= 57) { digit(String(code - 48)); return true; }
    if (code >= 96 && code <= 105) { digit(String(code - 96)); return true; }
    switch (code) {
      case KEY.UP: case KEY.CH_UP: zap(1); break;
      case KEY.DOWN: case KEY.CH_DOWN: zap(-1); break;
      case KEY.OK:
        if (numBuf) commitNumber(); else openChannels();
        break;
      case KEY.LEFT: case KEY.RIGHT: openChannels(); break;
      case KEY.RED: openSettings(); break;
      case KEY.GREEN: {
        var idx = LISTS.map(function (l) { return l.id; }).indexOf(state.listId);
        var next = LISTS[(idx + 1) % LISTS.length].id;
        loadList(next).then(function () { play(next, load('last.' + next, 0)); })
          .catch(function (e) { showError(t('list.unavailable'), e.message); });
        break;
      }
      case KEY.YELLOW: case KEY.INFO: showInfo(); break;
      case KEY.BACK: case KEY.ESC:
        if (!$('error').classList.contains('hidden')) hideError();
        else exitApp();
        break;
      default: return false;
    }
    return true;
  }

  document.addEventListener('keydown', function (e) {
    var handled;
    if (tutorial.open) handled = tutorialKey(e.keyCode);
    else if (state.view === 'settings') handled = settingsKey(e.keyCode);
    else if (state.view === 'nofritz') handled = noFritzKey(e.keyCode);
    else if (state.view === 'channels') handled = channelsKey(e.keyCode);
    else handled = tvKey(e.keyCode);
    if (handled) e.preventDefault();
  });

  // Tuner der FRITZ!Box freigeben, wenn die App in den Hintergrund geht
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopPlayback();
    } else if (state.channels[state.listId]) {
      play(state.listId, state.index);
    }
  });

  // ---------- Start ----------

  function start() {
    var listId = state.listId;
    showStatus(t('list.loading'));
    return loadList(listId).then(function () {
      play(listId, load('last.' + listId, 0));
    }).catch(function (e) {
      hideStatus();
      openNoFritz(e.message);
    });
  }

  // Startparameter für Tests und Screenshots, z. B.
  // ares-launch --device tv de.merschie.kabelboxtv --params '{"demo":true,"view":"channels"}'
  // oder im Browser index.html?demo=1
  function launchParams() {
    try {
      var p = window.PalmSystem && window.PalmSystem.launchParams;
      if (!p && window.location.search) {
        // im Browser: index.html?demo=1&view=channels
        var q = {};
        window.location.search.slice(1).split('&').forEach(function (kv) {
          var parts = kv.split('=');
          q[decodeURIComponent(parts[0])] = parts[1] === undefined || parts[1] === '1' ? true : decodeURIComponent(parts[1]);
        });
        return q;
      }
      return (typeof p === 'string' ? JSON.parse(p || '{}') : p) || {};
    } catch (e) { return {}; }
  }

  var params = launchParams();
  if (params.demo) {
    state.demo = true;
    state.listId = params.list || 'tvhd';
  }
  startTvService();
  var started = start();
  if (params.view) {
    started.then(function () {
      setTimeout(function () {
        if (params.view === 'channels') openChannels();
        else if (params.view === 'settings') openSettings();
        else if (params.view === 'tutorial') openTutorial();
      }, 3000);
    });
  } else if (!load('tutorialSeen', false)) {
    openTutorial();
  }
})();
