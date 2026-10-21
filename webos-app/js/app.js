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
  var PROXY_TIMEOUT = 25000;

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video');

  // ---------- Einstellungen ----------

  var DEFAULTS = { fritzHost: 'fritz.box', proxyUrl: 'http://192.168.177.80:8095', mode: 'auto' };

  function load(key, fallback) {
    try {
      var v = localStorage.getItem('kabeltv.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  }

  function save(key, value) {
    try { localStorage.setItem('kabeltv.' + key, JSON.stringify(value)); } catch (e) { /* ignorieren */ }
  }

  var settings = Object.assign({}, DEFAULTS, load('settings', {}));
  // Proxy ist von Port 8080 auf 8095 umgezogen
  if (settings.proxyUrl === 'http://192.168.177.80:8080') {
    settings.proxyUrl = DEFAULTS.proxyUrl;
    save('settings', settings);
  }

  function proxyBase() {
    var p = (settings.proxyUrl || '').trim().replace(/\/+$/, '');
    if (p && !/^https?:\/\//.test(p)) p = 'http://' + p;
    return p;
  }

  // ---------- Zustand ----------

  var state = {
    listId: load('listId', 'tvhd'),
    channels: {},          // listId -> [{name, url}]
    index: 0,
    via: null,             // 'direct' | 'proxy'
    proxyStream: null,     // aktuell genutzte Proxy-URL zum Freigeben
    directFailed: load('directFailed.v3', false), // im Auto-Modus: Direktwiedergabe hat schon einmal versagt
    playToken: 0,
    epg: {},               // listId -> { channels: {url: [jetzt, danach]}, fetched }
    epgDetail: {},         // url -> { events, fetched }
    view: 'tv',            // 'tv' | 'channels' | 'settings'
    overlayListId: null,
    overlayIndex: 0
  };

  // ---------- Hilfsfunktionen ----------

  function fetchText(url, timeout) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, timeout || 6000);
    return fetch(url, { signal: ctrl.signal, cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .finally(function () { clearTimeout(t); });
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

  function proxyStreamUrl(rtspUrl) {
    return proxyBase() + '/hls/' + b64url(rtspUrl) + '/index.m3u8';
  }

  // ---------- Stream-Dienst auf dem Fernseher ----------
  // Der mitgelieferte Hintergrunddienst holt RTSP von der FRITZ!Box und gibt es per HTTP aus.

  var SERVICE_URI = 'luna://de.local.kabeltv.service/start';
  var tvService = { port: null, bridge: null, error: null };

  function startTvService() {
    if (typeof window.PalmServiceBridge === 'undefined') {
      tvService.error = 'kein webOS';
      return;
    }
    try {
      var bridge = new window.PalmServiceBridge();
      bridge.onservicecallback = function (msg) {
        try {
          var r = JSON.parse(msg);
          if (r.returnValue && r.port) tvService.port = r.port;
          else tvService.error = r.errorText || 'Dienst antwortet nicht';
        } catch (e) { tvService.error = 'ungültige Antwort'; }
      };
      // Abo hält den Dienst am Leben, solange die App läuft
      bridge.call(SERVICE_URI, JSON.stringify({ subscribe: true }));
      tvService.bridge = bridge;
    } catch (e) {
      tvService.error = e.message;
    }
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

  // ---------- Programmführer (kommt vom Proxy) ----------

  var EPG_MAX_AGE = 120000;

  function loadEpg(listId) {
    var cached = state.epg[listId];
    if (!proxyBase() || (cached && Date.now() - cached.fetched < EPG_MAX_AGE)) return;
    fetchText(proxyBase() + '/api/epg/' + listId, 8000).then(function (t) {
      state.epg[listId] = { channels: JSON.parse(t).channels || {}, fetched: Date.now() };
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

    var host = (settings.fritzHost || DEFAULTS.fritzHost).trim();
    var direct = function () {
      return fetchText('http://' + host + '/dvb/m3u/' + listId + '.m3u').then(parseM3U);
    };
    var viaProxy = function () {
      if (!proxyBase()) return Promise.reject(new Error('Kein Proxy eingetragen'));
      return fetchText(proxyBase() + '/api/channels/' + listId)
        .then(function (t) { return JSON.parse(t); });
    };

    var p;
    if (settings.mode === 'proxy') p = viaProxy();
    else if (settings.mode === 'direct' || !proxyBase()) p = direct();
    else p = direct().catch(viaProxy);

    return p.then(function (list) {
      if (!list.length) throw new Error('Senderliste ist leer');
      state.channels[listId] = list;
      return list;
    });
  }

  // ---------- Wiedergabe ----------

  function releaseProxy() {
    if (state.proxyStream) {
      var url = state.proxyStream.replace(/\/index\.m3u8$/, '/release');
      state.proxyStream = null;
      fetch(url, { method: 'POST' }).catch(function () {});
    }
  }

  function stopPlayback() {
    state.playToken++;
    video.pause();
    video.removeAttribute('src');
    video.load();
    releaseProxy();
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

  function playbackOrder() {
    var hasProxy = !!proxyBase();
    if (settings.mode === 'direct') return ['direct'];
    if (settings.mode === 'proxy') return hasProxy ? ['proxy'] : [];
    if (!hasProxy) return ['direct'];
    return state.directFailed ? ['proxy'] : ['direct', 'proxy'];
  }

  function play(listId, index) {
    var list = state.channels[listId];
    if (!list || !list.length) return;
    index = (index + list.length) % list.length;

    stopPlayback();
    var token = state.playToken;
    state.listId = listId;
    state.index = index;
    save('listId', listId);
    save('last.' + listId, index);

    var ch = list[index];
    hideError();
    setRadio(listId === 'radio' ? ch.name : null);
    loadEpg(listId);
    showInfo();
    showStatus('Lade ' + ch.name + ' …');

    var order = playbackOrder();
    if (!order.length) {
      hideStatus();
      showError('Kein Proxy eingetragen', 'Der Modus "Nur Proxy" braucht eine Proxy-Adresse.\nRote Taste: Einstellungen');
      return;
    }

    var step = function (i) {
      if (token !== state.playToken) return;
      if (i >= order.length) {
        hideStatus();
        showError('Wiedergabe fehlgeschlagen', failureHint());
        return;
      }
      var via = order[i];
      state.via = via;
      showStatus('Lade ' + ch.name + (via === 'proxy' ? ' über Proxy' : '') + ' …');

      var ready = via === 'direct' ? waitForTvService(3000) : Promise.resolve();
      ready.then(function () {
        if (token !== state.playToken) return false;
        var url = via === 'direct' ? directStreamUrl(ch.url) : proxyStreamUrl(ch.url);
        if (via === 'proxy') state.proxyStream = url;
        return tryPlay(url, via === 'direct' ? DIRECT_TIMEOUT : PROXY_TIMEOUT, token);
      }).then(function (ok) {
        if (token !== state.playToken) return;
        if (ok) {
          hideStatus();
          showInfo();
          return;
        }
        // Nur merken, wenn es ohne Stream-Dienst war; mit Dienst sind Fehler eher vorübergehend (Tuner belegt)
        if (via === 'direct' && settings.mode === 'auto' && !tvService.port) {
          state.directFailed = true;
          save('directFailed.v3', true);
        }
        if (via === 'proxy') releaseProxy();
        step(i + 1);
      });
    };
    step(0);
  }

  function failureHint() {
    if (settings.mode === 'direct' || !proxyBase()) {
      return 'Der Fernseher konnte den Stream nicht direkt abspielen' +
        (tvService.port ? '' : ' (Stream-Dienst: ' + (tvService.error || 'nicht gestartet') + ')') + '.\n' +
        'Möglich: alle Tuner der FRITZ!Box belegt.\n' +
        'Ein Proxy (siehe Anleitung) löst das zuverlässig. Rote Taste: Einstellungen';
    }
    return 'Auch der Proxy konnte den Sender nicht liefern.\n' +
      'Läuft der Proxy? Sind alle Tuner der FRITZ!Box belegt?\nRote Taste: Einstellungen';
  }

  function zap(delta) {
    var list = state.channels[state.listId];
    if (list) play(state.listId, state.index + delta);
  }

  // ---------- Anzeige ----------

  var infoTimer = null;

  function showInfo() {
    var list = state.channels[state.listId] || [];
    var ch = list[state.index];
    if (!ch) return;
    $('info-num').textContent = state.index + 1;
    $('info-name').textContent = ch.name;
    $('info-list').textContent = listLabel(state.listId);
    var via = $('info-via');
    via.textContent = state.via === 'proxy' ? 'PROXY' : 'DIREKT';
    via.className = 'badge ' + (state.via || '');
    $('info-clock').textContent = fmtTime(Date.now());
    renderInfoEpg();
    show($('infobar'), true);
    clearTimeout(infoTimer);
    infoTimer = setTimeout(function () { show($('infobar'), false); }, 5000);
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

  function showStatus(text) { $('status-text').textContent = text; show($('status'), true); }
  function hideStatus() { show($('status'), false); }
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
      var t = document.createElement('div');
      t.className = 'tab' + (l.id === state.overlayListId ? ' active' : '');
      t.textContent = l.label;
      t.addEventListener('click', function () { switchOverlayList(l.id); });
      tabs.appendChild(t);
    });
  }

  function renderChannels() {
    renderTabs();
    var ul = $('channel-list');
    ul.innerHTML = '';
    var list = state.channels[state.overlayListId];
    if (!list) {
      ul.innerHTML = '<li>Lade …</li>';
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
    if (!proxyBase()) {
      renderDetail(null, 'Programminfos gibt es nur mit Proxy.');
      return;
    }
    if (cached && Date.now() - cached.fetched < EPG_MAX_AGE) return;
    detailTimer = setTimeout(function () {
      fetchText(proxyBase() + '/api/epg/channel/' + b64url(ch.url), 8000).then(function (t) {
        var events = JSON.parse(t).events || [];
        state.epgDetail[ch.url] = { events: events, fetched: Date.now() };
        var cur = (state.channels[state.overlayListId] || [])[state.overlayIndex];
        if (state.view === 'channels' && cur && cur.url === ch.url) renderDetail(events);
      }).catch(function () {
        renderDetail(null, 'Programm konnte nicht geladen werden.');
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
      empty.textContent = message || 'Keine Programminfos (der Proxy liest den EPG beim Start ein, das dauert ein paar Minuten).';
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
      li.textContent = 'Fehler: ' + e.message;
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
  var draftMode = 'auto';

  function openSettings(message, bad) {
    state.view = 'settings';
    $('set-fritz').value = settings.fritzHost;
    $('set-proxy').value = settings.proxyUrl;
    draftMode = settings.mode;
    renderMode();
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

  function renderMode() {
    var btns = document.querySelectorAll('#set-mode button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-mode') === draftMode);
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
      proxyUrl: $('set-proxy').value.trim(),
      mode: draftMode
    };
  }

  function testConnection() {
    var d = readDraft();
    setSettingsStatus('Teste …');
    var lines = [];
    var fritz = fetchText('http://' + d.fritzHost + '/dvb/m3u/tvhd.m3u', 5000)
      .then(function (t) { lines.push('FRITZ!Box: OK (' + parseM3U(t).length + ' HD-Sender)'); return true; })
      .catch(function (e) { lines.push('FRITZ!Box: nicht erreichbar (' + e.message + ')'); return false; });
    var proxy = Promise.resolve(null);
    if (d.proxyUrl) {
      var base = d.proxyUrl.replace(/\/+$/, '');
      if (!/^https?:\/\//.test(base)) base = 'http://' + base;
      proxy = fetchText(base + '/api/status', 5000)
        .then(function (t) {
          var s = JSON.parse(t);
          lines.push('Proxy: OK' + (s.ffmpeg ? '' : ' – aber ffmpeg fehlt!'));
          return s.ffmpeg !== false;
        })
        .catch(function (e) { lines.push('Proxy: nicht erreichbar (' + e.message + ')'); return false; });
    }
    lines.push('Stream-Dienst im TV: ' + (tvService.port ? 'läuft (Port ' + tvService.port + ')' : (tvService.error || 'nicht gestartet')));
    Promise.all([fritz, proxy]).then(function (r) {
      var bad = !r[0] || r[1] === false;
      setSettingsStatus(lines.join('\n'), bad);
    });
  }

  function saveSettings() {
    var d = readDraft();
    var changed = d.fritzHost !== settings.fritzHost || d.proxyUrl !== settings.proxyUrl || d.mode !== settings.mode;
    settings = d;
    save('settings', settings);
    closeSettings();
    if (changed) {
      state.channels = {};
      state.directFailed = false;
      save('directFailed.v3', false);
      start();
    }
  }

  function activateNav(el) {
    if (el.tagName === 'INPUT') {
      el.focus();
    } else if (el.hasAttribute('data-mode')) {
      draftMode = el.getAttribute('data-mode');
      renderMode();
    } else if (el.id === 'btn-test') testConnection();
    else if (el.id === 'btn-save') saveSettings();
    else if (el.id === 'btn-cancel') closeSettings();
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
    var inSeg = el && el.hasAttribute('data-mode');
    var inRow = el && el.parentNode.classList.contains('row');
    switch (code) {
      case KEY.UP: navIndex = prevGroupStart(); updateNav(); break;
      case KEY.DOWN: navIndex = nextGroupStart(); updateNav(); break;
      case KEY.LEFT: if ((inSeg || inRow) && navEls[navIndex - 1] && navEls[navIndex - 1].parentNode === el.parentNode) { navIndex--; updateNav(); } break;
      case KEY.RIGHT: if ((inSeg || inRow) && navEls[navIndex + 1] && navEls[navIndex + 1].parentNode === el.parentNode) { navIndex++; updateNav(); } break;
      case KEY.OK: activateNav(el); break;
      case KEY.BACK: case KEY.ESC: closeSettings(); break;
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
  });

  // ---------- Tasten ----------

  function exitApp() {
    stopPlayback();
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
          .catch(function (e) { showError('Liste nicht verfügbar', e.message); });
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
    if (state.view === 'settings') handled = settingsKey(e.keyCode);
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
    showStatus('Lade Senderliste …');
    loadList(listId).then(function () {
      play(listId, load('last.' + listId, 0));
    }).catch(function (e) {
      hideStatus();
      openSettings('Senderliste konnte nicht geladen werden:\n' + e.message +
        '\nBitte Adresse der FRITZ!Box prüfen oder einen Proxy eintragen.', true);
    });
  }

  startTvService();
  start();
})();
