# LG Seller Lounge: Felder bei „CREATE APP“

Stand: 22.10.2026, abgelesen aus dem Formular (nichts gespeichert oder eingereicht). `*` = Pflichtfeld.

## 1. File Upload
- **Set App ID \*** – Reverse-DNS, nur `a-z 0-9 - .`, min. 2 Zeichen. Nicht `com.palm/com.webos/com.lge/com.palmdts`. Mit JS-Service keine `-` und kein `.`+Ziffer. Wird mit „Confirm“ fest reserviert, nach Veröffentlichung nicht änderbar. → `de.merschie.kabelboxtv`
- **Service Platforms \*** – webOS / NetCast → webOS
- **webOS File Upload \*** – IPK; File Type Web/Native/Native Game; Chipset (bei Web: „All“); dann „Add File“.
  - Tabelle je Datei: File Name \*, Service Platform/SDK Ver. \* (2014 … 2027 „and later“), Resolution \* (u. a. 1280×720 = FHD-Geräte, 1920×1080 = UHD-Geräte), File Ver. \* (darf nicht kleiner als frühere sein), Deep Link (optional).
  - LG empfiehlt zwei Pakete: 1920×1080 und 1280×720. Nur 1920×1080 → App erscheint nicht auf FHD-Modellen (Warnung beim Submit).

## 2. Images
- **App Icon \*** – quadratisch, einfarbiger deckender Hintergrund (kein Verlauf), Logo mittig. Empfohlen ≥ 400×400, JPG/PNG, max. 5 MB.
- **App Tile Color \*** – Hex, muss exakt der Icon-Hintergrundfarbe entsprechen (häufiger Ablehnungsgrund).
- **Screenshots \*** – mind. 3, max. 6 (1 primär + 5), Reihenfolge per Drag & Drop. Empfohlen 1920×1080 oder 1280×720, JPG/PNG, max. 5 MB.
- Splash Screen Background (optional) – 1920×1080, JPG/PNG, max. 10 MB.
- Launcher Background (optional, nur webOS 2014–2015) – 1920×1080, max. 10 MB.

## 3. Service Country Info.
- **Service Countries \*** – nach Regionen; Deutschland unter Europe („All platform“). Zusätzlich „Others“ (z. B. EU_Others = im Ausland gekaufte Geräte).
- **Service Languages \*** – Mehrfachauswahl (German, English …). Global angebotene Apps müssen Englisch haben.

## 4. Display Info.
- **English (Default) App Title \*** – max. 95 Byte.
- **English (Default) App Description \*** – 50–4.000 Byte, keine Emojis. Zu kurz/ungenau = Ablehnungsgrund.
- Weitere Sprachen: je Sprache Titel (95 Byte) und Beschreibung (4.000 Byte).

## 5. Service Info.
- **App Category \*** – Game / Entertainment / Life / Education / News Info (+ Unterkategorie).
- **App Version \*** – drei Felder `x.y.z`.
- **App Rating \*** – General Audiences / 4+ / 12+ / 16+ / 18+; dazu „Enter Rating for Selected Country“ (sonst bleibt Submit gesperrt). Zertifikat nur für Korea, Brasilien hat eigene Selbstprüfung.
- **Content Rating \*** – Erwachsenen-Inhalte nein/ja.
- **Tag Keywords \*** – durch Leerzeichen getrennt, keine Sonderzeichen/Emojis, max. 4.000 Byte (oder „Not Applicable“).
- **Contact Seller \*** – URL oder E-Mail (wird im Store angezeigt).
- Datenerhebung (Pflicht bei UK): Privacy Policy nein/ja (+ Text, auf dem TV nur als Klartext), gesammelte Daten (Kategorien × Zweck), geteilte Daten, Speicherort der Daten (Land oder „Refer to Privacy Policy“).

## 6. Feature Info.
- **Device Requirements \*** – None / 3D / Camera / Gesture / Gamepad.
- **Remote Controller \*** – Both Magic and general remote / Only Magic remote / Magic remote and voice recognition.
- DIAL (optional).

## 7. Test Info.
- Reference E-Mail für QA-Ergebnisse (optional, max. 5).
- **UX Scenario File \*** (max. 3; JPG/PNG/PDF/DOC/PPT/XLS/XLSX/ZIP, max. 10 MB) – LG stellt eine Vorlage bereit („Download Template“). Muss die echten Funktionen beschreiben.
- **Note for Tester \*** – Kategorien Service Feature Update / Bug revision / Images-Service Info Change / Other Information / Not Applicable, je max. 2.000 Byte. Anhänge max. 5, bis 100 MB.
- **Test Account/Password \*** – oder „Not applicable“.
- **Voucher Code \*** – oder „Not applicable“.
- Test-IPK (als ZIP, max. 10 MB) oder Test-URL (optional).
- **Geo IP Block \*** – No/Yes (bei Yes: LG-QA-IPs freischalten).
- **Billing \*** – Not Applicable / webOS Pay / 3rd Party / beides.
- **In-App Ad \*** – Not Applicable / Banner / AVOD.
- **Player Specification \*** – Not Applicable oder DRM, Streaming-Protokoll (u. a. HTTP progressive, HLS, DASH), Video-Codec (H.264, H.265, MPEG-2 …), Audio-Codec (MP3, AAC, AC3, EAC3 …), HDR.

## Weitere Reiter
Self-check list, webOS Cloud Test Lab Reservation, Defect Info, Defect History – danach **SUBMIT**.
