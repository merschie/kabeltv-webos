# Kabel TV – FRITZ!Box-Cable-Streams auf dem LG-Fernseher

Diese webOS-App zeigt die DVB-C-Sender der FRITZ!Box (Listen HD, SD und Radio) auf dem LG C3.

```
FRITZ!Box (RTSP) ──▶ Stream-Dienst im TV (HTTP, MPEG-TS) ──▶ Videoplayer   Modus "Direkt"
FRITZ!Box (RTSP) ──▶ Unraid-Proxy (HLS) ─────────────────▶ LG C3         Modus "Proxy"
```

Der Videoplayer von webOS spielt kein RTSP. Deshalb bringt die App einen kleinen Hintergrunddienst mit (`service/`, Node.js auf dem Fernseher). Er holt den Sender per RTSP/RTP von der FRITZ!Box und reicht das MPEG-TS unverändert über `http://127.0.0.1:8096` an den Player weiter. Ein zusätzliches Gerät ist dafür nicht nötig.

- **Automatisch** (Standard): erst direkt über den Stream-Dienst, bei Problemen über den Proxy.
- **Nur direkt**: nur über den Stream-Dienst im Fernseher. Ist der Dienst nicht verfügbar, wird die RTSP-Adresse direkt versucht.
- **Nur Proxy**: Der Docker-Container wandelt die Streams in HLS um. Das Bild bleibt unverändert, nur der Ton wird nach AAC gewandelt.

Der Programmführer (EPG) kommt zurzeit noch vom Proxy.

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

## 1. Proxy auf Unraid (optional, für EPG und als Reserve)

Den Projektordner (mit `proxy/`, `webos-app/` und `docker-compose.yml`) zum Beispiel nach `/mnt/user/appdata/kabeltv` kopieren. Dann im Unraid-Terminal:

```bash
cd /mnt/user/appdata/kabeltv
docker build -f proxy/Dockerfile -t kabeltv-proxy .
docker run -d --name kabeltv-proxy --restart unless-stopped --network host \
  -e FRITZ_HOST=192.168.177.1 --tmpfs /tmp/kabeltv kabeltv-proxy
```

Ist das Compose-Manager-Plugin installiert, reicht stattdessen `docker compose up -d --build`.

Test: `http://192.168.177.80:8095/api/status` im Browser öffnen, dort muss `"ffmpeg": true` stehen. Unter `http://192.168.177.80:8095/` läuft die App zusätzlich im Browser, aber nur im Proxy-Modus.

Einstellungen über Umgebungsvariablen:

| Variable | Standard | Bedeutung |
|---|---|---|
| `FRITZ_HOST` | `192.168.177.1` | Adresse der FRITZ!Box |
| `PORT` | `8095` | Port des Proxys |
| `AUDIO` | `aac` | `copy` reicht den Originalton (MP2/AC3) unverändert durch |
| `VIDEO` | `copy` | `h264` kodiert neu, falls SD-Sender (MPEG-2) nicht laufen. Das kostet Rechenleistung |
| `RTSP_TRANSPORT` | (leer) | `tcp`, falls UDP-Pakete nicht ankommen |
| `MAX_STREAMS` | `2` | Gleichzeitige Streams. Die FRITZ!Box hat nur wenige Tuner |
| `IDLE_SECONDS` | `20` | Nach dieser Zeit ohne Abruf wird ein Stream beendet |
| `EPG` | (an) | `off` schaltet den Programmführer ab |
| `EPG_DWELL` | `15` | Sekunden pro Frequenz beim EPG-Scan |
| `EPG_INTERVAL_HOURS` | `6` | Abstand zwischen zwei EPG-Scans |

### Programmführer (EPG)

Der Proxy liest das Programm direkt aus dem Kabelsignal (DVB-EIT), etwa eine Woche im Voraus. Dafür tunt er beim Start und danach alle 6 Stunden jede Frequenz für 15 Sekunden an, aber nur die Info-Datenströme, ohne Bild. Ein Durchlauf dauert rund 5 Minuten und belegt so lange einen Tuner. Die App zeigt das Programm in der Senderliste und in der Infoleiste. Ohne Proxy gibt es keinen EPG.

`--network host` ist wichtig, weil die FRITZ!Box das Bild per RTP/UDP an den Container schickt.

## 2. App auf den Fernseher

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

App mit Stream-Dienst neu bauen (der Dienst nutzt den RTSP-Client aus `proxy/epg.js`):

```bash
cp proxy/epg.js service/epg.js && ares-package webos-app service -o dist
```

## Deploy in einem Schritt

`scripts/deploy.ps1` baut die `.ipk`, kopiert alles auf den Unraid-Server, baut dort den Container neu und installiert die App auf dem Fernseher. Mit `-NoTv` aktualisiert es nur den Server. Adressen und Pfade lassen sich als Parameter ändern (siehe Kopf des Skripts).

```powershell
.\scripts\deploy.ps1
```

## Hinweise

- Die FRITZ!Box liefert nur unverschlüsselte Sender, also keine privaten Sender in HD.
- Die Zahl der Tuner ist begrenzt. Sind alle belegt, etwa durch andere Geräte, startet kein weiterer Sender.
- Geht die App in den Hintergrund, gibt sie den Tuner sofort frei.
