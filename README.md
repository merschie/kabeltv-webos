# Kabel TV – FRITZ!Box-Cable-Streams auf dem LG-Fernseher

Diese webOS-App zeigt die DVB-C-Sender der FRITZ!Box (Listen HD, SD und Radio) auf dem LG C3.

```
FRITZ!Box (RTSP) ──▶ Stream-Dienst im TV (HTTP, MPEG-TS) ──▶ Videoplayer
```

Der Videoplayer von webOS spielt kein RTSP. Deshalb bringt die App einen kleinen Hintergrunddienst mit (`service/`, Node.js auf dem Fernseher). Er holt den Sender per RTSP/RTP von der FRITZ!Box und reicht das MPEG-TS unverändert über `http://127.0.0.1:8096` an den Player weiter. Ein zusätzliches Gerät ist dafür nicht nötig. Den Programmführer (EPG) liest derselbe Dienst aus dem Kabelsignal (siehe [Programmführer](#programmführer-epg)).

## Bedienung

| Taste | im TV-Bild | in der Senderliste |
|---|---|---|
| ▲ ▼ / P+ P− | Sender wechseln | Auswahl bewegen (P± springt 10 Sender) |
| OK, ◀ ▶ | Senderliste öffnen | OK spielt ab, ◀ ▶ wechselt HD/SD/Radio |
| 0–9 | Sendernummer eingeben | – |
| Rot | Einstellungen | Einstellungen |
| Grün | Liste wechseln (HD → SD → Radio) | – |
| Gelb / Info | Infoleiste mit Jetzt/Danach | – |
| Zurück | App beenden | Liste schließen |

Mit dem Magic-Remote-Zeiger lässt sich ebenfalls alles anklicken.

## Programmführer (EPG)

Der Stream-Dienst im Fernseher liest das Programm direkt aus dem Kabelsignal (DVB-EIT):

- **Beim Zuschauen**: Die FRITZ!Box schickt die Info-Datenströme (PID 0, 17, 18) im Stream mit. Der Dienst liest sie nebenbei mit, das kostet keinen Tuner. So gibt es für alle Sender auf der Frequenz des laufenden Senders sofort Jetzt/Danach.
- **Scan im Hintergrund**: Fragt die App das erste Mal nach Programminfos, tunt der Dienst nach 15 Sekunden nacheinander jede Frequenz für 12 Sekunden an (nur Info-Daten, ohne Bild), danach alle 6 Stunden. Frequenzen, die er gerade beim Zuschauen gelesen hat, lässt er aus. Ein Durchlauf belegt einige Minuten lang einen zweiten Tuner.
- **Wiedergabe geht vor**: Während ein Sender startet, wartet der Scan. Sind alle Tuner belegt, bricht der Scan ab und gibt seinen Tuner frei, der Sender startet trotzdem. Nach 10 Minuten versucht er es erneut.
- Der Dienst behält Sendungen für die nächsten 30 Stunden und sichert sie in `/tmp/kabeltv-epg.json`. Nach einem Neustart der App ist das Programm deshalb sofort wieder da, solange der Fernseher nicht neu gestartet wurde.

Der Dienst ist standardmäßig nur im Fernseher selbst erreichbar (`127.0.0.1`). Für die Fehlersuche lässt sich in den Einstellungen „Statusseite im Heimnetz“ einschalten, dann zeigt `http://<TV-IP>:8096/status` den Zustand (Abschnitt `epg` und Protokoll).

## App auf den Fernseher

1. Auf dem C3 aus dem LG Content Store die App **Developer Mode** installieren und mit einem kostenlosen Konto von [webostv.developer.lge.com](https://webostv.developer.lge.com) anmelden.
2. *Dev Mode Status* einschalten. Der Fernseher startet neu. Die Session läuft 50 Stunden und lässt sich in der App verlängern.
3. Auf dem PC:

```bash
npm install -g @webos-tools/cli
```

```bash
ares-setup-device
```

Gerät hinzufügen: IP des Fernsehers, Port `9922`, Benutzer `prisoner`.

```bash
ares-novacom --device tv --getkey
```

Die Passphrase dafür zeigt die Developer-Mode-App an.

```bash
ares-install --device tv dist/de.local.kabeltv_1.0.0_all.ipk
```

Alternativ geht die Installation per Klick mit dem *webOS Dev Manager* (GitHub: webosbrew/dev-manager-desktop). Dort lässt sich die Dev-Mode-Session auch automatisch verlängern.

App mit Stream-Dienst neu bauen:

```bash
ares-package webos-app service -o dist
```

## Deploy in einem Schritt

`scripts/deploy.ps1` baut die `.ipk` und installiert die App auf den Fernsehern (`-TvDevice tv, tv2`). Mit `-NoTv` baut es nur.

```powershell
.\scripts\deploy.ps1
```

## Hinweise

- Die FRITZ!Box liefert nur unverschlüsselte Sender, also keine privaten Sender in HD.
- Die Zahl der Tuner ist begrenzt. Sind alle belegt, etwa durch andere Geräte, startet kein weiterer Sender.
- Geht die App in den Hintergrund, gibt sie den Tuner sofort frei.
- Beim Senderwechsel zeigt die Ladeanzeige das Senderlogo im Hintergrund. Die Logos stammen aus [tv-logo/tv-logos](https://github.com/tv-logo/tv-logos) (Markenzeichen der jeweiligen Sender) und liegen in `webos-app/logos/`. Gibt es kein passendes Logo, steht dort der Sendername. Aktualisieren mit `scripts/update-logos.sh`.
