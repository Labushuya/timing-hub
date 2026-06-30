# Timing Hub — Betriebsanleitung

Version: 1.0 | Stand: Juni 2026

---

## Überblick

Timing Hub ist eine webbasierte Zeitnahme-Plattform für klassische Motorsport-Veranstaltungen. Das System verbindet mehrere Zeitnahme-Posten in Echtzeit, berechnet automatisch Abschnittszeiten und Strafpunkte und stellt Ranglisten live zur Verfügung.

**Für wen:** Veranstalter, Zeitnahme-Kommissare und Zeitnehmer bei Gleichmäßigkeitsprüfungen (GLP), Sonderprüfungen, Rundstreckenläufen und Orientierungsfahrten.

**Was es ersetzt:** Manuelle Tabellenkalkulation zur Auswertung, separate Übertragung von Postenprotokollen, händische Strafpunkteberechnung nach der Veranstaltung.

**Was es nicht ersetzt:** Das offizielle Protokoll (händisch + ALGE Timy-Ausdruck). Timing Hub ist ein Arbeitswerkzeug, kein Ersatz für die Dokumentationspflicht nach Sportreglement.

---

## Rollen im System

| Rolle | Zugang | Rechte |
|---|---|---|
| **Veranstalter** | Account + Login | Veranstaltung anlegen und konfigurieren, Teilnehmer verwalten, Klassen definieren, Sollzeiten hinterlegen, Posten-URLs generieren, Ergebnis exportieren, Veranstaltung abschließen |
| **Kommissar** | Account + Login | Zeiteinträge prüfen, Startnummern zuweisen, Zeiten annullieren (mit Begründung), Rangliste überwachen, Ergebnis freigeben |
| **Zeitnehmer** | Posten-URL (kein Account) | Zeiten am zugewiesenen Posten erfassen und Startnummer bestätigen, Laufnummer einstellen, Timy-Verbindung überwachen |
| **Teilnehmer / Zuschauer** | Ergebnis-URL (kein Account) | Öffentliche Rangliste und eigene Zeiten lesen (lesend, keine Eingabe) |

---

## Vor der Veranstaltung: Vorbereitung (Veranstalter)

### 1. Account und Veranstaltung anlegen

**Registrierung:** Timing Hub ist zugangsbeschränkt. Die Registrierung erfordert einen Einladungs-Token, der vom Plattformbetreiber vergeben wird. Den Token bei der Registrierung im entsprechenden Feld eingeben.

**Neue Veranstaltung erstellen:**

1. Nach dem Login auf "Neue Veranstaltung" klicken.
2. Pflichtfelder ausfüllen:
   - **Name der Veranstaltung** (z.B. "Herbstausfahrt 2026 — GLP")
   - **Veranstaltungsformat** (GLP, Sonderprüfung, Rundstrecke, Orientierungsfahrt/Rallye)
   - **Datum und Ort**
3. Veranstaltung speichern. Das System generiert einen eindeutigen **Event-Code** (z.B. `herbst26`), der für die öffentliche Ergebnis-URL verwendet wird.

---

### 2. Format und Wertungsmodus konfigurieren

#### GLP (Gleichmäßigkeitsprüfung)

Bei der GLP fährt der Teilnehmer eine Strecke mit einer vorgegebenen Sollzeit. Ziel ist es, die Sollzeit so genau wie möglich zu treffen — nicht schneller, nicht langsamer. Wer am wenigsten abweicht, gewinnt.

**Sollzeit:** Die Zielzeit, gegen die jede Fahrt gemessen wird. Sie kann definiert sein als:

- **Gesamtstrecke:** Eine einzige Sollzeit von Start bis Ziel (z.B. 90.0 Sekunden).
- **Pro Abschnitt:** Separate Sollzeiten für jeden Posten-Übergang (z.B. Start→ZZ1: 45.0s, ZZ1→Ziel: 45.0s). Strafpunkte werden pro Abschnitt einzeln berechnet und summiert.

**Strafpunkte-Berechnung:**

```
Abweichung = |Istzeit − Sollzeit| (in Sekunden)
Strafpunkte = Abweichung × Faktor
```

Der Faktor ist konfigurierbar (Standard: 1.0, d.h. 1 Strafpunkt pro Sekunde Abweichung). Für Präzisionswettbewerbe kann der Faktor erhöht werden (z.B. 10 → 1 Strafpunkt pro 0,1 Sekunden).

**Zahlenbeispiel:**

| Wert | Beispiel |
|---|---|
| Sollzeit | 90.000 s |
| Istzeit (gemessen) | 90.456 s |
| Abweichung | \|90.456 − 90.000\| = 0.456 s |
| Faktor | 1.0 |
| **Strafpunkte** | **0.456** |

Ein weiteres Fahrzeug mit Istzeit 89.210 s: Abweichung = 0.790 s → 0.790 Strafpunkte.

**Lauf-Auswertung:** Bei mehreren Läufen stehen drei Modi zur Auswahl:

- **Summe:** Strafpunkte aller Läufe werden addiert.
- **Bester Lauf:** Nur der Lauf mit den wenigsten Strafpunkten zählt.
- **Best-of-N:** Die N besten Läufe werden summiert (z.B. beste 3 von 4 Läufen).

**Option — Sollzeiten verbergen:** Wenn aktiviert, sehen Zeitnehmer und Teilnehmer die Sollzeit nicht. Die Strafpunkte werden trotzdem berechnet und intern gespeichert, aber erst nach Freigabe durch den Kommissar veröffentlicht. Diese Option erhöht die Spannung, da Fahrer ihre Abweichung nicht sofort ableiten können.

---

#### Sonderprüfung

Schnellste Zeit gewinnt. Strafpunkte gibt es keine — die gemessene Zeit ist das Ergebnis.

Konfiguration:
- **Sektionen:** Optional Zwischenzeiten für Start/ZZ1/.../Ziel. Die Gesamtzeit ergibt sich aus Start bis Ziel.
- **DNF-Zeit:** Zeit für nicht gewertete Fahrten (Did Not Finish). Dieser Wert erscheint in der Rangliste statt einer gemessenen Zeit, wird aber ans Ende der Wertung gesetzt.
- **Lauf-Auswertung:** Summe, bester Lauf oder Best-of-N (identisch zu GLP, nur ohne Strafpunkte).

---

#### Rundstrecke

Rundenzeiten auf einem Kurs mit identischem Start/Ziel.

Konfiguration:
- **Rundenanzahl:** Feste Rundenanzahl oder Zeitlimit.
- **Wertung:** Bestzeit einer einzelnen Runde oder Gesamtzeit aller Runden.
- **Sektionen:** Zwischenzeiten auf der Runde möglich (z.B. nach Kurve 3, nach Zielkurve).

Besonderheit: Start und Ziel sind derselbe Posten. Das System erkennt wiederholte Überfahrten und nummeriert die Runden automatisch.

---

#### Orientierungsfahrt / Rallye

Mehrere Sektionen mit individuellen Sollzeiten. Früh- und Spätstrafpunkte können unterschiedlich gewichtet werden.

Konfiguration:
- **Sollzeit pro Sektion:** Jeder Abschnitt hat eine eigene Sollzeit.
- **Frühstrafe:** Strafpunkte pro Sekunde bei zu früher Ankunft (Faktor konfigurierbar).
- **Spätstrafe:** Strafpunkte pro Sekunde bei zu später Ankunft (häufig höher als Frühstrafe).
- **Lauf-Auswertung:** In der Regel Summe über alle Sektionen und Läufe.

---

### 3. Posten anlegen und Reihenfolge festlegen

Posten definieren die Messpunkte auf der Strecke. Die **Reihenfolge der Posten ist entscheidend**, da das System die Zeitdifferenz zwischen aufeinanderfolgenden Posten berechnet.

Pflichtposten:
- **Start** — immer erster Posten
- **Ziel** — immer letzter Posten

Optionale Posten:
- **Zwischenzeit 1, 2, ...** — in der Reihenfolge ihres Auftretens auf der Strecke

Jeden Posten anlegen mit:
- **Name** (z.B. "Start", "Zwischenzeit Forst", "Ziel")
- **Code** (kurz, z.B. `START`, `ZZ1`, `ZIEL`) — wird für CSV-Import und Posten-URLs verwendet
- **Position in der Reihenfolge** (per Drag & Drop sortierbar)

**Berechnungsbeispiel mit Zwischenzeit:**

| Posten | Erfasste Uhrzeit |
|---|---|
| Start | 10:00:00.000 |
| ZZ1 | 10:01:23.456 |
| Ziel | 10:02:45.789 |

Daraus berechnet das System:
- Abschnitt A (Start → ZZ1): 10:01:23.456 − 10:00:00.000 = **83.456 s**
- Abschnitt B (ZZ1 → Ziel): 10:02:45.789 − 10:01:23.456 = **82.333 s**
- Gesamtzeit (Start → Ziel): 10:02:45.789 − 10:00:00.000 = **165.789 s**

Die Uhrzeiten vom ALGE Timy sind absolute Uhrzeiten im Format `HH:MM:SS.mmm`. Das System subtrahiert sie — eine interne Umrechnung auf Sekunden ist für den Benutzer nicht sichtbar.

---

### 4. Sollzeiten konfigurieren

Unter "Sollzeiten" können nach Anlegen der Posten die Zielwerte hinterlegt werden.

**Gesamtstrecke:** Eine Sollzeit von Start bis Ziel. Alle Teilnehmer (oder eine Klasse) fahren gegen diese eine Zeit.

**Pro Abschnitt:** Für jeden Posten-Übergang wird eine eigene Sollzeit angegeben. Beispiel:
- Start → ZZ1: 45.0 s
- ZZ1 → Ziel: 45.0 s

Das System wertet dann jeden Abschnitt separat und summiert die Strafpunkte.

**Pro Klasse:** Wenn für eine Klasse eine abweichende Sollzeit gilt, wird diese bei der Klassendefinition hinterlegt (siehe Abschnitt 5). Teilnehmer dieser Klasse werden automatisch gegen die Klassen-Sollzeit gewertet — nicht gegen die allgemeine Sollzeit.

---

### 5. Teilnehmer anlegen

**Manuell:** Über "Teilnehmer hinzufügen" für jeden Teilnehmer einzeln:

| Feld | Pflicht | Hinweis |
|---|---|---|
| Startnummer | Ja | Eindeutig innerhalb der Veranstaltung |
| Fahrer (Name) | Ja | |
| Beifahrer (Name) | Nein | |
| Fahrzeug (Marke/Modell) | Nein | |
| Baujahr | Nein | Relevant für Klasseneinteilung |
| Klasse | Ja | Aus den definierten Klassen wählen |

**CSV-Import:** Teilnehmer können als CSV-Datei importiert werden. Format: eine Zeile pro Teilnehmer, Spaltenköpfe in der ersten Zeile. Pflichtfelder: `startnummer`, `fahrer`, `klasse`.

**Klassen definieren:** Vor dem Anlegen der Teilnehmer die Klassen anlegen (unter "Klassen verwalten"). Klassen können nach Baujahr, Hubraum, Fahrzeugkategorie oder Kombinationen davon gebildet werden. Für jede Klasse kann optional eine eigene Sollzeit hinterlegt werden.

Beispiel Klasseneinteilung GLP:
- Klasse A: Baujahr bis 1960, Sollzeit 95.0 s
- Klasse B: Baujahr 1961–1980, Sollzeit 90.0 s
- Klasse C: Baujahr ab 1981, Sollzeit 85.0 s

Die Gesamtrangliste wird unabhängig von Klassen über alle Teilnehmer erstellt. Klassenranglisten werden zusätzlich erzeugt.

---

### 6. Posten-URLs verteilen

Nach der Konfiguration generiert das System für jeden Posten eine eindeutige URL mit einem Posten-Token. Diese URL ermöglicht den Zugang zum Zeitnehmer-Screen ohne Account oder Login.

Verteilung:
- **QR-Code:** Im System ausdrucken und dem Zeitnehmer mitgeben.
- **Link per Messenger:** URL direkt ans Gerät des Zeitnehmers senden.

**Wichtig:** Die Posten-URL ist postenspezifisch. Zeitnehmer am Start bekommen die Start-URL, Zeitnehmer am Ziel die Ziel-URL usw. Ein falscher URL am falschen Posten führt zu fehlerhaften Abschnittszuordnungen.

Die URL ist für die Dauer der Veranstaltung gültig. Nach dem Abschluss der Veranstaltung werden Posten-URLs deaktiviert.

---

## Am Veranstaltungstag: Zeitnahme (Zeitnehmer)

### Schritt 1: Posten-URL öffnen

Browser auf Mobilgerät oder Tablet öffnen, die zugewiesene URL eingeben oder QR-Code scannen. Der Zeitnehmer-Screen erscheint sofort — keine Anmeldung, kein Account erforderlich.

Der Screen zeigt:
- Name des Postens (zur Kontrolle: ist es der richtige Posten?)
- Aktuelle Laufnummer
- Eingabefeld für Startnummer
- Letzte erfasste Einträge (als Kontrolle)
- Verbindungsstatus (grün = online, orange = offline/gepuffert)

Vor dem ersten Einsatz kurz prüfen: Ist der angezeigte Postenname korrekt?

---

### Schritt 2: Zeitnahmegerät anschließen (falls vorhanden)

---

### Unterstützte Zeitnahmegeräte

#### ALGE Timy 3 (USB)

Der ALGE Timy 3 oder Timy pce erfasst absolute Uhrzeiten im Format `HH:MM:SS.mmm` beim Auslösen durch Lichtschranke oder Druckschalter.

Verbindung herstellen:
1. **Timy Bridge-Executable** auf dem Laptop starten (wird vom Veranstalter bereitgestellt).
2. Timy per USB an den Laptop anschließen.
3. Grüner Verbindungsindikator auf dem Zeitnehmer-Screen bestätigt die aktive Verbindung.

Sobald verbunden, fließen Timy-Auslösungen automatisch in das System. Der Zeitnehmer muss nur noch die **Startnummer bestätigen**.

**Timy-Ausdruck:** Der Timy druckt jede Auslösung automatisch auf dem angeschlossenen Drucker. Diesen Ausdruck aufbewahren — er ist Teil des offiziellen Protokolls.

Config: `type = "alge_timy"` — Verbindung über USB, automatische Erkennung

#### TAG Heuer CP-Serie (RS-232 / USB-Serial)

Modelle: CP 450, CP 500, CP 520, CP 525, CP 540

Verbindung: RS-232 Seriell oder USB-Serial-Adapter

Typische Einstellungen: 9600 Baud, 8N1

Config:
```toml
type = "tag_heuer_cp"
serial_port = "COM3"  # Windows-Beispiel
baud_rate = 9600
```

#### Trentmann RallyStar (RS-232 / USB-Serial)

Verbindung: RS-232 Seriell oder USB-Serial-Adapter

Typische Einstellungen: 9600 Baud, 8N1

Config:
```toml
type = "trentmann_rallystar"
serial_port = "COM4"  # Windows-Beispiel
baud_rate = 9600
```

#### Hinweis: COM-Port ermitteln (Windows)

Geräte-Manager → Anschlüsse (COM und LPT) → USB-Serial-Adapter suchen

Der zugewiesene COM-Port (z.B. COM3, COM4) wird in der `bridge.toml` unter `serial_port` eingetragen.

#### Hinweis: Manuelle Eingabe (immer verfügbar)

Auch ohne Hardware-Gerät kann der Zeitnehmer Zeiten manuell im Browser eingeben — entweder per Knopfdruck (Systemzeit) oder durch direkte Eingabe einer Uhrzeit im Format `HH:MM:SS.mmm`.

---

### Schritt 3: Laufnummer einstellen

Vor dem ersten Fahrzeug des jeweiligen Laufs die Laufnummer am Zeitnehmer-Screen einstellen. Die Laufnummer bleibt gesetzt bis sie manuell geändert wird.

**Gemischte Startreihenfolge:** Wenn nicht alle Fahrzeuge erst Lauf 1 absolvieren und dann alle Lauf 2, sondern die Startreihenfolge gemischt ist (z.B. Fahrzeug 42 macht Lauf 2, dann Fahrzeug 17 macht Lauf 1), muss der Zeitnehmer die Laufnummer vor jeder Einfahrt manuell anpassen.

Empfehlung: Der Startposten teilt dem Zielposten per Funk die Laufnummer des jeweils einfahrenden Fahrzeugs mit.

---

### Schritt 4: Zeiten erfassen

#### Mit Timy:

1. Fahrzeug passiert die Lichtschranke.
2. Timy löst aus → absolute Uhrzeit wird automatisch an den Zeitnehmer-Screen übertragen.
3. Zeit erscheint im Screen als "nicht bestätigt" (orange hinterlegt).
4. Zeitnehmer trägt die **Startnummer** des Fahrzeugs ein.
5. Bestätigen → Eintrag wird gespeichert und an den Server übertragen.

Falls mehrere Fahrzeuge kurz nacheinander passieren: Die Zeiten werden in Reihe angezeigt. Startnummern werden der Reihe nach zugewiesen und einzeln bestätigt.

#### Ohne Timy (manuell):

**Option A — Zeitstempel per Knopfdruck:**
1. Beim Passieren des Fahrzeugs "Zeit erfassen" drücken.
2. Das System stempelt die aktuelle Uhrzeit des Geräts.
3. Startnummer eintragen und bestätigen.

**Option B — Zeit direkt eingeben:**
1. Zeit vom Stoppuhr-Display oder Timy-Ausdruck ablesen.
2. Im Feld "Uhrzeit manuell eingeben" eintragen (Format: `HH:MM:SS.mmm`).
3. Startnummer eintragen und bestätigen.

**Hinweis:** Bei manuellen Zeitstempeln per Knopfdruck ist die Reaktionszeit des Zeitnehmers (typ. 0.1–0.3 s) in der Zeit enthalten. Für offizielle Wertungen ist ein Timy oder gleichwertiges Messgerät erforderlich.

---

### Schritt 5: Offline-Betrieb

Bei Verbindungsausfall (kein Mobilnetz, WLAN unterbrochen) funktioniert der Zeitnehmer-Screen weiter:

- Zeiten werden **lokal im Browser** gespeichert.
- Ein **oranger Banner** erscheint mit der Anzahl der gepufferten Einträge (z.B. "3 Einträge ausstehend").
- Sobald die Verbindung wiederhergestellt ist, werden alle gepufferten Einträge automatisch synchronisiert.
- Nach der Synchronisation verschwindet der Banner.

**Empfehlung:** Gerät nicht schließen oder Browser-Tab nicht wechseln während offline, um den lokalen Puffer nicht zu verlieren. Ein Geräteneustart während des Offline-Betriebs kann gepufferte Daten löschen — in diesem Fall ist das Timy-Protokoll maßgeblich.

---

### Protokollpflicht (immer!)

Unabhängig vom System gilt:

1. **Händisches Protokoll:** Jeder Zeitnehmer führt ein Papierprotokoll mit Startnummer, Uhrzeit und Laufnummer für jede Passage.
2. **Timy-Ausdruck:** Jede Timy-Auslösung wird automatisch gedruckt. Die Ausdrucke aufbewahren.

Timing Hub ist ein Hilfswerkzeug. Das offizielle Ergebnis basiert auf dem schriftlichen Protokoll und dem Timy-Ausdruck. Bei Diskrepanzen zwischen System und Protokoll entscheidet der Kommissar.

---

## Während der Veranstaltung: Auswertung (Kommissar)

### Live-Dashboard

Der Kommissar sieht auf dem Dashboard alle Zeiteinträge aller Posten in Echtzeit:

- **Grün:** Bestätigt — Startnummer zugewiesen, Eintrag vollständig.
- **Orange:** Nicht bestätigt — Timy hat ausgelöst, aber Startnummer fehlt noch.
- **Rot:** Annulliert — Eintrag wurde ungültig gesetzt (Begründung hinterlegt).

Die Ansicht kann nach Posten, Lauf und Teilnehmer gefiltert werden.

---

### Zeiten bestätigen und korrigieren

**Startnummer nachträglich zuweisen:** Bei nicht bestätigten (orangen) Einträgen kann der Kommissar die Startnummer direkt im Dashboard eintragen und bestätigen. Sinnvoll wenn der Zeitnehmer am Posten überlastet war.

**Zeit annullieren:** Jede Zeit kann mit Pflichtbegründung annulliert werden (z.B. "Fahrzeug überquerte Linie außerhalb des Messbereichs", "Doppelauslösung durch Windböe"). Annullierte Zeiten verbleiben im System sichtbar, gehen aber nicht in die Wertung ein. Das Audit-Log dokumentiert wer wann was geändert hat.

**Zeit neu zuweisen:** Eine annullierte Zeit kann einem anderen Teilnehmer zugewiesen werden (z.B. wenn die falsche Startnummer eingegeben wurde). Vorgehen: Erst annullieren, dann neue Zeit für die korrekte Startnummer erfassen (manuell oder aus dem Timy-Protokoll).

---

### Live-Rangliste

Die Rangliste wird nach jeder bestätigten Zeit automatisch neu berechnet. Die öffentliche Ergebnis-URL (`timinghub.de/results/[event-code]`) zeigt immer den aktuellen Stand.

Wenn Sollzeiten verborgen sind: Die Rangliste ist intern für den Kommissar sichtbar, aber auf der öffentlichen URL nicht abrufbar bis der Kommissar die Veröffentlichung freigibt.

---

## Nach der Veranstaltung: Ergebnis (Kommissar / Veranstalter)

### Endergebnis prüfen

Vor dem Abschluss der Veranstaltung:

1. Alle nicht bestätigten (orangen) Einträge prüfen und zuweisen oder begründet annullieren.
2. Gesamtzahl der Einträge pro Posten gegen das händische Protokoll abgleichen.
3. System-Rangliste gegen die handschriftlich geführte Kontrollrangliste prüfen.
4. Bei Abweichungen: Audit-Log konsultieren, Timy-Ausdruck heranziehen.

---

### Export

**CSV:** Alle Zeitdaten als tabellarische CSV-Datei exportieren. Enthält alle Einträge inkl. annullierter Zeiten (als separate Spalte markiert). Geeignet für eigene Auswertung in Excel oder zur Archivierung.

**PDF / Druck:** Aufbereitete Ergebnis-PDFs:
- Gesamtrangliste (alle Teilnehmer, sortiert nach Strafpunkten/Zeit)
- Klassenranglisten (eine pro Klasse)
- Detailergebnis pro Teilnehmer (alle Abschnitte, alle Läufe)

---

### Veranstaltung abschließen

Status auf "Beendet" setzen. Danach:
- Posten-URLs werden deaktiviert (kein weiterer Eingang möglich).
- Ergebnisse bleiben auf der öffentlichen URL dauerhaft abrufbar.
- Exportfunktionen bleiben für Veranstalter und Kommissar weiterhin verfügbar.

---

## Teilnehmer: Eigene Zeiten einsehen

URL: `timinghub.de/results/[event-code]`

Keine Anmeldung erforderlich. Die Seite zeigt:

- **Gesamtrangliste:** Alle Teilnehmer sortiert nach Ergebnis (Strafpunkte aufsteigend / Zeit aufsteigend).
- **Klassenranglisten:** Separate Ansicht pro Klasse, umschaltbar.
- **Einzelergebnis:** Klick auf Startnummer oder Name zeigt alle Läufe mit Abschnittszeiten, Sollzeiten (falls nicht verborgen) und Abweichungen.

Die Seite aktualisiert sich während der Veranstaltung automatisch alle 10 Sekunden.

---

## CSV-Import von Zeitdaten (Fallback ohne Timy)

Wenn Zeiten während der Veranstaltung nicht über Timing Hub erfasst wurden (Timy-Ausfall, fehlende Verbindung, manuelle Zeitnahme vor Ort), können sie nachträglich per CSV importiert werden.

**Format:** Normalisierte Liste, eine Zeile pro Zeitmessung.

Spalten (Trennzeichen: Pipe `|` oder Semikolon `;`):

```
Startnummer | Posten-Code | Zeitstempel | Lauf-Nummer
```

**Beispiel:**

```
42 | START | 10:00:00.000 | 1
42 | ZZ1   | 10:01:23.456 | 1
42 | ZIEL  | 10:02:45.789 | 1
43 | START | 10:03:10.000 | 1
43 | ZZ1   | 10:04:28.100 | 1
43 | ZIEL  | 10:05:55.321 | 1
42 | START | 10:10:00.000 | 2
42 | ZZ1   | 10:11:22.900 | 2
42 | ZIEL  | 10:12:48.200 | 2
```

**Regeln:**
- **Posten-Code** muss exakt mit den konfigurierten Posten übereinstimmen (Groß-/Kleinschreibung egal). Falls abweichende Codes verwendet wurden, kann im Import-Dialog ein Mapping angegeben werden (z.B. `S1` → `START`).
- **Zeitstempel-Format:** `HH:MM:SS.mmm` (Punkt als Dezimaltrennzeichen) oder `HH:MM:SS,mmm` (Komma wird automatisch akzeptiert).
- **Lauf-Nummer:** Ganzzahl ab 1.
- Leerzeilen und Zeilen mit `#` am Anfang werden ignoriert.

**Import-Ablauf:**
1. CSV-Datei unter "Zeitdaten importieren" hochladen.
2. Vorschau prüfen: Das System zeigt an, wie viele Einträge gefunden wurden und ob Posten-Codes gemappt werden müssen.
3. Bei Konflikten (Eintrag für diese Startnummer/Posten/Lauf bereits vorhanden): Auswahl ob überschreiben oder überspringen.
4. Import bestätigen.

---

## Häufige Fragen

**Q: Was tun wenn der Timy nicht reagiert?**

A: Auf manuelle Eingabe umschalten. Zeiten vom Stoppuhr-Display oder handgeschriebenen Protokoll direkt in den Zeitnehmer-Screen eingeben. Nach der Veranstaltung können die Timy-Daten aus dem Ausdruck per CSV nachimportiert werden, falls der Timy später wieder funktioniert oder die Daten aus dem Timy-Speicher ausgelesen werden können.

---

**Q: Kann man Zeiten nachträglich korrigieren?**

A: Ja. Der Kommissar kann jede Zeit annullieren (mit Pflichtbegründung) und manuell neu erfassen. Das Audit-Log dokumentiert alle Änderungen mit Zeitstempel und Benutzerkonto. Einmal annullierte Einträge können nicht reaktiviert werden — bei Bedarf neuen Eintrag anlegen.

---

**Q: Was passiert bei Verbindungsausfall am Posten?**

A: Zeiten werden lokal im Browser des Zeitnehmers gepuffert. Nach Wiederherstellung der Verbindung synchronisiert das System automatisch. Der orange Banner zeigt die Anzahl ausstehender Einträge. Der Zeitnehmer muss nichts manuell tun, nur den Browser-Tab offen lassen.

---

**Q: Können mehrere Zeitnehmer denselben Posten bedienen?**

A: Ja. Die Posten-URL kann auf mehreren Geräten gleichzeitig geöffnet werden. Alle Einträge landen im selben Posten. Nützlich bei hohem Fahrzeugaufkommen oder als Redundanz. Beide Zeitnehmer müssen koordinieren, wer welche Startnummer einträgt, um Doppeleinträge zu vermeiden.

---

**Q: Wie werden Klassen mit eigenen Sollzeiten behandelt?**

A: Beim Anlegen der Klasse kann eine abweichende Sollzeit definiert werden. Alle Teilnehmer dieser Klasse werden automatisch gegen die Klassen-Sollzeit gewertet, nicht gegen die allgemeine Sollzeit. In der Rangliste ist erkennbar, gegen welche Sollzeit ein Teilnehmer gewertet wurde. Die Gesamtrangliste vergleicht die Strafpunkte direkt — nicht die absoluten Abweichungen — sodass Klassen mit unterschiedlichen Sollzeiten fair zusammen gewertet werden können, sofern dies vom Sportreglement vorgesehen ist.

---

**Q: Wie wird bei Best-of-N ausgewertet wenn ein Teilnehmer weniger als N Läufe absolviert hat?**

A: Es werden alle vorhandenen Läufe gewertet. Wenn ein Teilnehmer 2 Läufe hat und Best-of-3 eingestellt ist, werden beide Läufe summiert. Teilnehmer mit weniger Läufen können dadurch benachteiligt sein — das Sportreglement sollte eine Mindestlaufanzahl für die Wertung vorschreiben.

---

**Q: Kann die öffentliche Rangliste temporär ausgeblendet werden?**

A: Ja. Unter den Veranstaltungseinstellungen kann die öffentliche Ergebnis-URL deaktiviert werden. Sinnvoll wenn die Sollzeiten verborgen sind und die Rangliste keine Rückschlüsse auf die Sollzeit zulassen soll. Die Aktivierung ist jederzeit möglich, z.B. nach Abschluss der letzten Einfahrt.

---

*Timing Hub — Betriebsanleitung | Stand: Juni 2026*
