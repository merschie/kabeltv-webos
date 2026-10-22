// Übersetzungen: Deutsch bei deutscher Systemsprache, sonst Englisch.
// Zum Testen lässt sich die Sprache erzwingen: index.html?lang=en bzw. localStorage "kabeltv.lang" = "en".
(function () {
  'use strict';

  var TEXT = {
    de: {
      'hint.channels': '&#9650;&#9660; Auswahl &nbsp; &#9664;&#9654; Liste &nbsp; OK Abspielen &nbsp; <span class="key red"></span> Einstellungen',
      'settings.title': 'Einstellungen',
      'settings.fritz': 'FRITZ!Box-Adresse',
      'settings.lan': 'Statusseite im Heimnetz (Fehlersuche)',
      'settings.off': 'Aus',
      'settings.on': 'An',
      'btn.test': 'Verbindung testen',
      'btn.save': 'Speichern',
      'btn.cancel': 'Abbrechen',
      'btn.tutorial': 'Anleitung',
      'btn.demo': 'Demo ansehen',
      'btn.settings': 'Einstellungen',
      'btn.retry': 'Erneut versuchen',
      'nofritz.title': 'Keine FRITZ!Box gefunden',
      'nofritz.intro': 'KabelBox TV zeigt das Fernsehprogramm einer <b>FRITZ!Box Cable</b> im selben Heimnetz. In der FRITZ!Box muss unter <i>DVB-C</i> das Streaming eingeschaltet sein.',
      'nofritz.demo': 'Ohne FRITZ!Box lässt sich die App mit Testbildern ausprobieren.',
      'nofritz.hint': '&#9664;&#9654; Auswahl &nbsp; OK Bestätigen &nbsp; Zurück App beenden',
      'nofritz.searched': 'Gesucht unter „{host}“',
      'nofritz.noAnswer': 'keine Antwort',
      'tut.hint': '&#9664;&#9654; Blättern &nbsp; OK <span id="tut-ok"></span> &nbsp; Zurück Überspringen',
      'tut.step': 'Anleitung {n} / {total}',
      'tut.next': 'Weiter',
      'tut.done': 'Fertig',

      'svc.noWebos': 'kein webOS',
      'svc.noAnswer': 'Dienst antwortet nicht',
      'svc.badAnswer': 'ungültige Antwort',
      'svc.notRunning': 'Stream-Dienst läuft nicht',
      'svc.notStarted': 'nicht gestartet',
      'list.empty': 'Senderliste ist leer',
      'list.unavailable': 'Liste nicht verfügbar',
      'list.loading': 'Lade Senderliste …',
      'list.loadingShort': 'Lade …',
      'error.prefix': 'Fehler: {msg}',

      'demo.channel': 'Demo-Kanal {n}',
      'demo.channelSd': 'Demo-Kanal SD',
      'demo.radio': 'Demo-Radio',
      'demo.show': 'Demo-Sendung {n}',
      'demo.text': 'Beispieltext zur Demo-Sendung {n}. Mit einer FRITZ!Box Cable steht hier das echte Programm aus dem Kabelsignal.',

      'load.demo': 'Demo wird gestartet',
      'load.connecting': 'Verbindung zur FRITZ!Box wird aufgebaut',
      'load.service': 'Stream-Dienst im Fernseher wird gestartet',
      'load.request': 'Stream wird angefordert',
      'load.found': 'Sender gefunden, Daten kommen an',
      'load.firstFrame': 'Erstes Bild empfangen',
      'load.buffer': 'Puffer wird gefüllt',
      'load.starting': 'Wiedergabe startet',
      'load.rebuffer': 'Lade nach …',
      'load.stalled': 'Datenstrom stockt, Puffer wird aufgefüllt',
      'load.quiet': 'Seit {quiet} s keine Daten, Neustart nach {restart} s',

      'play.failed': 'Wiedergabe fehlgeschlagen',
      'play.demoFailed': 'Das Demo-Video ließ sich nicht abspielen.\nRote Taste: Einstellungen',
      'play.tvFailed': 'Der Fernseher konnte den Sender nicht abspielen{service}.\nMöglich: alle Tuner der FRITZ!Box belegt.\nRote Taste: Einstellungen',
      'play.serviceState': ' (Stream-Dienst: {state})',

      'tuners': 'Tuner {used}/{total} belegt · {free} frei',

      'epg.failed': 'Programm konnte nicht geladen werden.',
      'epg.empty': 'Noch keine Programminfos. Der Fernseher liest den EPG nach dem Start aus dem Kabelsignal ein, das dauert ein paar Minuten.',

      'test.running': 'Teste …',
      'test.fritzOk': 'FRITZ!Box: OK ({count} HD-Sender)',
      'test.fritzFail': 'FRITZ!Box: nicht erreichbar ({msg})',
      'test.service': 'Stream-Dienst im TV: {state}',
      'test.serviceRunning': 'läuft (Port {port})',

      tutorial: [
        { title: 'Willkommen bei KabelBox TV', rows: [
          ['', 'Live-Fernsehen und Radio direkt von der FRITZ!Box – alles mit der normalen Fernbedienung.'],
          ['', 'Die nächsten Seiten zeigen kurz, welche Taste was macht. Das Bild läuft im Hintergrund schon los.'],
          ['&#9664; &#9654;', 'blättern, OK geht weiter, Zurück überspringt die Anleitung']
        ] },
        { title: 'Sender wechseln', rows: [
          ['&#9650; &#9660; / CH+ CH−', 'nächster bzw. vorheriger Sender'],
          ['0 – 9', 'Sendernummer direkt eingeben, nach kurzer Pause wird umgeschaltet (OK schaltet sofort)'],
          ['<span class="key green"></span> Grün', 'zwischen den Listen HD, SD und Radio wechseln']
        ] },
        { title: 'Senderliste mit Programm', rows: [
          ['OK / &#9664; &#9654;', 'Senderliste öffnen, rechts steht das Programm des gewählten Senders'],
          ['&#9664; &#9654;', 'in der Liste: HD, SD oder Radio'],
          ['&#9650; &#9660; / CH+ CH−', 'Sender auswählen, mit CH+/CH− in Zehnerschritten'],
          ['OK', 'ausgewählten Sender abspielen, Zurück schließt die Liste']
        ] },
        { title: 'Infoleiste', rows: [
          ['<span class="key yellow"></span> Gelb / Info', 'zeigt Sender, was gerade läuft und was danach kommt'],
          ['Tuner', 'wie viele Tuner der FRITZ!Box belegt bzw. frei sind (zählt auch andere Geräte mit)']
        ] },
        { title: 'Einstellungen', rows: [
          ['<span class="key red"></span> Rot', 'Einstellungen öffnen: Adresse der FRITZ!Box'],
          ['Statusseite', 'Stream-Dienst für die Fehlersuche aus dem Heimnetz erreichbar machen'],
          ['Anleitung', 'diese Anleitung jederzeit erneut anzeigen'],
          ['Demo ansehen', 'Testbilder und Beispielprogramm ohne FRITZ!Box, Speichern beendet die Demo'],
          ['Zurück', 'im Fernsehbild beendet die App']
        ] }
      ]
    },

    en: {
      'hint.channels': '&#9650;&#9660; Select &nbsp; &#9664;&#9654; List &nbsp; OK Play &nbsp; <span class="key red"></span> Settings',
      'settings.title': 'Settings',
      'settings.fritz': 'FRITZ!Box address',
      'settings.lan': 'Status page on home network (troubleshooting)',
      'settings.off': 'Off',
      'settings.on': 'On',
      'btn.test': 'Test connection',
      'btn.save': 'Save',
      'btn.cancel': 'Cancel',
      'btn.tutorial': 'Guide',
      'btn.demo': 'Try demo',
      'btn.settings': 'Settings',
      'btn.retry': 'Try again',
      'nofritz.title': 'No FRITZ!Box found',
      'nofritz.intro': 'KabelBox TV shows the TV channels of a <b>FRITZ!Box Cable</b> on the same home network. Streaming must be enabled in the FRITZ!Box under <i>DVB-C</i>.',
      'nofritz.demo': 'Without a FRITZ!Box you can try the app with test pictures.',
      'nofritz.hint': '&#9664;&#9654; Select &nbsp; OK Confirm &nbsp; Back Exit app',
      'nofritz.searched': 'Looked for “{host}”',
      'nofritz.noAnswer': 'no answer',
      'tut.hint': '&#9664;&#9654; Browse &nbsp; OK <span id="tut-ok"></span> &nbsp; Back Skip',
      'tut.step': 'Guide {n} / {total}',
      'tut.next': 'Next',
      'tut.done': 'Done',

      'svc.noWebos': 'not webOS',
      'svc.noAnswer': 'service not responding',
      'svc.badAnswer': 'invalid response',
      'svc.notRunning': 'stream service not running',
      'svc.notStarted': 'not started',
      'list.empty': 'Channel list is empty',
      'list.unavailable': 'List not available',
      'list.loading': 'Loading channel list …',
      'list.loadingShort': 'Loading …',
      'error.prefix': 'Error: {msg}',

      'demo.channel': 'Demo channel {n}',
      'demo.channelSd': 'Demo channel SD',
      'demo.radio': 'Demo radio',
      'demo.show': 'Demo show {n}',
      'demo.text': 'Sample text for demo show {n}. With a FRITZ!Box Cable, the real programme guide from the cable signal appears here.',

      'load.demo': 'Starting demo',
      'load.connecting': 'Connecting to the FRITZ!Box',
      'load.service': 'Starting the stream service on the TV',
      'load.request': 'Requesting stream',
      'load.found': 'Channel found, data arriving',
      'load.firstFrame': 'First picture received',
      'load.buffer': 'Filling buffer',
      'load.starting': 'Starting playback',
      'load.rebuffer': 'Buffering …',
      'load.stalled': 'Stream stalled, refilling buffer',
      'load.quiet': 'No data for {quiet} s, restarting after {restart} s',

      'play.failed': 'Playback failed',
      'play.demoFailed': 'The demo video could not be played.\nRed button: Settings',
      'play.tvFailed': 'The TV could not play this channel{service}.\nPossibly all FRITZ!Box tuners are busy.\nRed button: Settings',
      'play.serviceState': ' (stream service: {state})',

      'tuners': 'Tuners {used}/{total} in use · {free} free',

      'epg.failed': 'Programme guide could not be loaded.',
      'epg.empty': 'No programme info yet. After starting, the TV reads the EPG from the cable signal; this takes a few minutes.',

      'test.running': 'Testing …',
      'test.fritzOk': 'FRITZ!Box: OK ({count} HD channels)',
      'test.fritzFail': 'FRITZ!Box: not reachable ({msg})',
      'test.service': 'Stream service on TV: {state}',
      'test.serviceRunning': 'running (port {port})',

      tutorial: [
        { title: 'Welcome to KabelBox TV', rows: [
          ['', 'Live TV and radio straight from your FRITZ!Box – all with the normal remote control.'],
          ['', 'The next pages briefly show what each button does. The picture is already starting in the background.'],
          ['&#9664; &#9654;', 'browse, OK continues, Back skips the guide']
        ] },
        { title: 'Changing channels', rows: [
          ['&#9650; &#9660; / CH+ CH−', 'next or previous channel'],
          ['0 – 9', 'enter a channel number, it switches after a short pause (OK switches immediately)'],
          ['<span class="key green"></span> Green', 'switch between the HD, SD and radio lists']
        ] },
        { title: 'Channel list with guide', rows: [
          ['OK / &#9664; &#9654;', 'open the channel list, the selected channel’s programme is shown on the right'],
          ['&#9664; &#9654;', 'in the list: HD, SD or radio'],
          ['&#9650; &#9660; / CH+ CH−', 'select a channel, CH+/CH− jump ten at a time'],
          ['OK', 'play the selected channel, Back closes the list']
        ] },
        { title: 'Info bar', rows: [
          ['<span class="key yellow"></span> Yellow / Info', 'shows the channel, what is on now and what comes next'],
          ['Tuners', 'how many FRITZ!Box tuners are in use or free (other devices included)']
        ] },
        { title: 'Settings', rows: [
          ['<span class="key red"></span> Red', 'open settings: FRITZ!Box address'],
          ['Status page', 'make the stream service reachable from the home network for troubleshooting'],
          ['Guide', 'show this guide again at any time'],
          ['Try demo', 'test pictures and a sample guide without a FRITZ!Box, Save ends the demo'],
          ['Back', 'on the TV picture exits the app']
        ] }
      ]
    }
  };

  // Meldungen des Stream-Dienstes (service/) kommen auf Deutsch und werden hier übersetzt
  var SERVICE_EN = [
    [/^Adresse der FRITZ!Box noch unbekannt$/, 'FRITZ!Box address not known yet'],
    [/^Adresse nicht erlaubt$/, 'Address not allowed'],
    [/^host fehlt$/, 'host missing'],
    [/^unbekannt$/, 'unknown'],
    [/^Zeitüberschreitung$/, 'timeout'],
    [/^Senderliste ist leer$/, 'Channel list is empty'],
    [/^RTSP-Verbindung geschlossen$/, 'RTSP connection closed'],
    [/^RTSP (\w+): keine Antwort$/, 'RTSP $1: no answer'],
    [/^RTSP SETUP: Status (\d+) \(Tuner belegt\?\)$/, 'RTSP SETUP: status $1 (tuner busy?)'],
    [/^RTSP (\w+): Status (\d+)$/, 'RTSP $1: status $2']
  ];

  function pick() {
    var forced = null;
    try {
      var m = /[?&]lang=(\w+)/.exec(location.search);
      forced = m ? m[1] : String(localStorage.getItem('kabeltv.lang') || '').replace(/"/g, '');
    } catch (e) { /* ignorieren */ }
    var sys = forced || (window.PalmSystem && window.PalmSystem.locale) || navigator.language ||
      (navigator.languages && navigator.languages[0]) || 'en';
    return /^de/i.test(String(sys)) ? 'de' : 'en';
  }

  var lang = pick();
  var table = TEXT[lang];

  function t(key, params) {
    var s = table.hasOwnProperty(key) ? table[key] : TEXT.en[key];
    if (s === undefined) return key;
    if (typeof s !== 'string' || !params) return s;
    return s.replace(/\{(\w+)\}/g, function (all, name) {
      return params.hasOwnProperty(name) ? params[name] : all;
    });
  }

  function serviceText(msg) {
    if (lang === 'de' || !msg) return msg;
    for (var i = 0; i < SERVICE_EN.length; i++) {
      if (SERVICE_EN[i][0].test(msg)) return msg.replace(SERVICE_EN[i][0], SERVICE_EN[i][1]);
    }
    return msg;
  }

  // Texte im HTML: data-i18n setzt den Text, data-i18n-html das HTML (für Tastensymbole)
  function apply(root) {
    document.documentElement.lang = lang;
    var els = (root || document).querySelectorAll('[data-i18n], [data-i18n-html]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.hasAttribute('data-i18n')) el.textContent = t(el.getAttribute('data-i18n'));
      else el.innerHTML = t(el.getAttribute('data-i18n-html'));
    }
  }

  window.KabelI18n = { lang: lang, t: t, serviceText: serviceText, apply: apply };
})();
