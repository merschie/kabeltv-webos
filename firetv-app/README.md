# Kabel TV für den Fire TV Stick

Android-TV-App (Kotlin, Media3/ExoPlayer) für die Sender der FRITZ!Box 6660 Cable, mit denselben Funktionen wie die webOS-App: Listen HD, SD und Radio, Senderliste mit Programm, Ladeanzeige mit Senderlogo, Infoleiste mit Jetzt/Danach und Tuner-Anzeige, Einstellungen und Anleitung beim ersten Start.

## Bedienung

Die Fire-TV-Fernbedienung hat keine Farb- und Zifferntasten. Deshalb liegen deren Funktionen auf anderen Tasten:

| Taste | im TV-Bild | in der Senderliste |
|---|---|---|
| ▲ ▼ | Sender wechseln | Auswahl bewegen |
| OK, ◀ ▶ | Senderliste öffnen | OK spielt ab, ◀ ▶ wechselt HD/SD/Radio |
| ⏪ ⏩ | Liste wechseln (HD → SD → Radio) | 10 Sender springen |
| ⏯ | Infoleiste mit Jetzt/Danach | – |
| ☰ Menü | Einstellungen | Einstellungen |
| Zurück | App beenden | Liste schließen |

Fernbedienungen mit Zifferntasten, Farbtasten oder P+/P− funktionieren wie unter webOS.

## Wiedergabe und Programmführer

Die FRITZ!Box schickt MPEG-TS per RTP (Payload-Typ 33). Das kann der RTSP-Player von Media3 nicht. Im Modus *Direkt* holt deshalb `RtspSession` den Stream selbst (wie der webOS-Stream-Dienst), entfernt die RTP-Header und gibt das MPEG-TS über `RtspTsDataSource` an ExoPlayer weiter.

- **Automatisch** (Standard): erst direkt, bei Problemen über den Proxy.
- **Nur direkt**: nur direkt von der FRITZ!Box.
- **Nur Proxy**: HLS vom Unraid-Proxy.

Den EPG holt die App im Modus *Automatisch* zuerst vom Proxy. Antwortet der nicht (oder im Modus *Nur direkt*), liest sie ihn selbst aus dem Kabelsignal (`LocalEpg`, Kotlin-Fassung von `proxy/epg.js`): Sie tunt dafür jede Frequenz kurz an, belegt dabei einen Tuner und gibt ihn sofort ab, wenn ein Sender startet und alle Tuner belegt sind. Die Senderlogos kommen beim Bauen aus `webos-app/logos`.

## Entwicklungsumgebung unter Windows 11

1. **Android Studio** installieren (aktuelle stabile Version von developer.android.com/studio). Der Einrichtungsassistent lädt das Android SDK und bringt ein passendes JDK mit.
2. Im SDK Manager (*Settings → Languages & Frameworks → Android SDK*) prüfen:
   - *SDK Platforms*: Android 16 (API 36)
   - *SDK Tools*: Android SDK Build-Tools, Android SDK Platform-Tools
3. In Android Studio *File → Open* und den Ordner `firetv-app` öffnen (nicht den ganzen Repo-Ordner). Gradle synchronisiert danach von selbst.
4. Damit `adb` auch im Terminal funktioniert, den Ordner `%LOCALAPPDATA%\Android\Sdk\platform-tools` zur Umgebungsvariable `Path` hinzufügen.

Ohne Android Studio geht der Build auch in der Konsole, dann muss `ANDROID_HOME` auf das SDK zeigen:

```powershell
cd firetv-app
.\gradlew.bat assembleDebug
```

Unit-Tests und Lint laufen mit `.\gradlew.bat testDebugUnitTest lintDebug`. Die APK liegt danach unter `app\build\outputs\apk\debug\app-debug.apk`.

## Fire TV Stick vorbereiten

1. *Einstellungen → Mein Fire TV → Info*: siebenmal auf den Gerätenamen klicken, bis die *Entwickleroptionen* erscheinen.
2. *Einstellungen → Mein Fire TV → Entwickleroptionen*: **ADB-Debugging** einschalten. Für Sideloading ohne ADB zusätzlich *Apps unbekannter Herkunft* erlauben.
3. Die IP-Adresse des Sticks steht unter *Mein Fire TV → Info → Netzwerk*. Am besten in der FRITZ!Box eine feste Adresse vergeben.

Verbinden (beim ersten Mal auf dem Fernseher *Zulassen* bestätigen, am besten mit *Immer von diesem Computer zulassen*):

```powershell
adb connect <IP-des-Sticks>:5555
adb devices
```

Danach erscheint der Stick in Android Studio in der Geräteliste, und der grüne Startknopf installiert und startet die App direkt. In der Konsole:

```powershell
.\gradlew.bat installDebug
adb shell am start -n de.local.kabeltv/.MainActivity
adb logcat --pid=$(adb shell pidof de.local.kabeltv)
```

## Automatischer Build

Bei jedem Push mit Änderungen in `firetv-app/` baut GitHub Actions eine Debug-APK. Sie liegt im Lauf unter *Artifacts* (`kabeltv-firetv-debug`) und lässt sich mit `adb install -r app-debug.apk` installieren.
