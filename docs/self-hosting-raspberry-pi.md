# Self-Hosting Timing Hub auf dem Raspberry Pi 5

> Diese Anleitung gilt für Raspberry Pi 5 mit Raspberry Pi OS Bookworm (64-bit) und Docker Compose v2.

---

## Inhaltsverzeichnis

1. [Voraussetzungen](#1-voraussetzungen)
2. [Architekturübersicht](#2-architekturübersicht)
3. [Schritt 1: DuckDNS einrichten](#3-schritt-1-duckdns-einrichten)
4. [Schritt 2: Port-Weiterleitung im Router](#4-schritt-2-port-weiterleitung-im-router)
5. [Schritt 3: DNS bei Strato konfigurieren](#5-schritt-3-dns-bei-strato-konfigurieren)
6. [Schritt 4: Pi-hole von Port 80 befreien](#6-schritt-4-pi-hole-von-port-80-befreien)
7. [Schritt 5: Projekt herunterladen](#7-schritt-5-projekt-herunterladen)
8. [Schritt 6: Konfiguration](#8-schritt-6-konfiguration)
9. [Schritt 7: Erster Start (Bootstrap)](#9-schritt-7-erster-start-bootstrap)
10. [Schritt 8: SSL-Zertifikat holen](#10-schritt-8-ssl-zertifikat-holen)
11. [Schritt 9: Nginx auf HTTPS umstellen](#11-schritt-9-nginx-auf-https-umstellen)
12. [Schritt 10: Alle Services starten](#12-schritt-10-alle-services-starten)
13. [Schritt 11: Datenbank initialisieren](#13-schritt-11-datenbank-initialisieren)
14. [Schritt 12: Autostart einrichten](#14-schritt-12-autostart-einrichten)
15. [Schritt 13: SSL-Erneuerung automatisieren](#15-schritt-13-ssl-erneuerung-automatisieren)
16. [Schritt 14: Testen](#16-schritt-14-testen)
17. [Updates einspielen](#17-updates-einspielen)
18. [Ressourcenverbrauch Pi 5](#18-ressourcenverbrauch-pi-5)
19. [Troubleshooting](#19-troubleshooting)

---

## 1. Voraussetzungen

Bevor du beginnst, stelle sicher, dass folgendes vorhanden und eingerichtet ist:

| Komponente | Anforderung |
|---|---|
| Hardware | Raspberry Pi 5 (4 GB oder 8 GB RAM empfohlen) |
| Betriebssystem | Raspberry Pi OS Bookworm (64-bit), aktuell gepatcht |
| Docker | Docker Engine + Docker Compose v2 installiert |
| Pi-hole | Bereits installiert und in Betrieb (wird auf Port 8081 verschoben) |
| Domain | Strato-Domain, z.B. `timinghub.de` |
| Router | Fritz!Box (oder beliebiger Router mit Port-Forwarding) |
| Internetzugang | Dynamische IP (wird über DuckDNS abgefangen) |

**Docker installieren (falls noch nicht vorhanden):**

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker pi
newgrp docker
```

**Docker-Version prüfen:**

```bash
docker --version
docker compose version
```

---

## 2. Architekturübersicht

```
Internet
   |
   | HTTPS (443) / HTTP (80)
   |
[Fritz!Box Router]
   | Port-Forwarding 80/443 -> Pi lokale IP
   |
[Raspberry Pi 5]
   |
   +--[Nginx :80/:443]  <-- SSL-Termination, Reverse Proxy
   |      |
   |      +-- /          -> Frontend (React, statisch)
   |      +-- /api/      -> API Service (:3000)
   |      +-- /.well-known/acme-challenge/  -> Certbot Webroot
   |
   +--[API Service :3000]  <-- Node.js Backend
   |      |
   |      +-- [PostgreSQL :5432]
   |      +-- [Redis :6379]
   |
   +--[Pi-hole :8081]  <-- DNS-Adblocker (verschoben von :80)
   |
   +--[Certbot]  <-- Let's Encrypt SSL-Zertifikate

DNS-Auflösung:
  timinghub.de       -> CNAME -> timinghub.duckdns.org -> dynamische IP
  www.timinghub.de   -> CNAME -> timinghub.duckdns.org -> dynamische IP
  api.timinghub.de   -> CNAME -> timinghub.duckdns.org -> dynamische IP

DuckDNS (alle 5 Min. aktualisiert):
  timinghub.duckdns.org -> aktuelle öffentliche IP des Routers
```

---

## 3. Schritt 1: DuckDNS einrichten

DuckDNS ist ein kostenloser Dynamic-DNS-Dienst. Er hält den DNS-Eintrag immer auf die aktuelle IP-Adresse deines Heimanschlusses aktuell.

### 3.1 Account und Subdomain anlegen

1. Öffne [https://www.duckdns.org](https://www.duckdns.org) im Browser.
2. Melde dich mit GitHub, Google oder Reddit an.
3. Trage im Feld "sub domain" den Namen `timinghub` ein und klicke auf **add domain**.
4. Die Subdomain `timinghub.duckdns.org` ist jetzt registriert.
5. Notiere dir deinen **Token** (sichtbar oben auf der Seite nach dem Login) — du brauchst ihn im nächsten Schritt.

### 3.2 Update-Script konfigurieren

Das Script liegt bereits im Repository. Öffne es zur Bearbeitung:

```bash
nano /home/pi/timing-hub/infra/scripts/duckdns-update.sh
```

Stelle sicher, dass folgende Variablen korrekt gesetzt sind (ersetze die Platzhalter):

```bash
DUCKDNS_TOKEN="dein-token-von-duckdns.org"
DUCKDNS_DOMAIN="timinghub"
```

Script ausführbar machen:

```bash
chmod +x /home/pi/timing-hub/infra/scripts/duckdns-update.sh
```

Manuell testen:

```bash
/home/pi/timing-hub/infra/scripts/duckdns-update.sh
```

Erwartete Ausgabe: `OK`

### 3.3 Cron Job einrichten

Den Cron Job hinzufügen, damit die IP alle 5 Minuten aktualisiert wird:

```bash
crontab -e
```

Folgende Zeile am Ende einfügen:

```
*/5 * * * * /home/pi/timing-hub/infra/scripts/duckdns-update.sh
```

Speichern und beenden (in nano: `Ctrl+O`, `Enter`, `Ctrl+X`).

---

## 4. Schritt 2: Port-Weiterleitung im Router

Der Router muss eingehende Verbindungen auf Port 80 und 443 an den Raspberry Pi weiterleiten.

### 4.1 Lokale IP des Pi ermitteln

```bash
hostname -I
```

Beispiel-Ausgabe: `192.168.178.42 fd00::...`

Die erste IPv4-Adresse (hier `192.168.178.42`) ist die lokale IP des Pi. **Notiere dir diese Adresse.**

Empfehlung: Vergib dem Pi im Router eine statische DHCP-Reservierung, damit sich die IP nicht ändert.

### 4.2 Fritz!Box konfigurieren

1. Öffne die Fritz!Box-Oberfläche im Browser: [http://fritz.box](http://fritz.box)
2. Navigiere zu **Internet** -> **Freigaben** -> **Portfreigaben**
3. Klicke auf **Gerät für Freigaben hinzufügen**
4. Wähle den Raspberry Pi aus der Liste (oder gib seine IP manuell ein)
5. Klicke auf **Neue Freigabe**

**Freigabe 1 — HTTP:**

| Feld | Wert |
|---|---|
| Anwendung | Andere Anwendung |
| Name | Timing Hub HTTP |
| Protokoll | TCP |
| von Port | 80 |
| bis Port | 80 |
| an Computer | (Raspberry Pi, lokale IP) |
| an Port | 80 |

**Freigabe 2 — HTTPS:**

| Feld | Wert |
|---|---|
| Anwendung | Andere Anwendung |
| Name | Timing Hub HTTPS |
| Protokoll | TCP |
| von Port | 443 |
| bis Port | 443 |
| an Computer | (Raspberry Pi, lokale IP) |
| an Port | 443 |

6. Beide Freigaben speichern und aktivieren.

> **Hinweis:** Bei manchen Internet-Anbietern ist Port 80 und 443 für Privatkunden gesperrt. In diesem Fall muss ein anderer externer Port verwendet und im Nginx entsprechend konfiguriert werden. Prüfe dies bei Bedarf in den Fritz!Box-Logs oder beim Anbieter.

---

## 5. Schritt 3: DNS bei Strato konfigurieren

Die Strato-Domain `timinghub.de` wird per CNAME auf `timinghub.duckdns.org` zeigen. So wird die dynamische IP automatisch aufgelöst.

### 5.1 DNS-Verwaltung öffnen

1. Melde dich an: [https://www.strato.de/apps/CustomerService](https://www.strato.de/apps/CustomerService)
2. Navigiere zu **Domains** -> **Domain-Verwaltung**
3. Klicke auf `timinghub.de`
4. Wähle **DNS-Verwaltung** (oder "Zonenverwaltung")

### 5.2 Standard-A-Record entfernen

- Lösche den vorhandenen `A`-Record für `@` (Apex-Domain), der auf eine Strato-IP zeigt.
- Lösche auch alle anderen vorhandenen `A`- oder `AAAA`-Records für `@`, `www` und `api`, sofern vorhanden.

### 5.3 CNAME-Records anlegen

Lege folgende drei CNAME-Records an:

| Typ | Name | Ziel | TTL |
|---|---|---|---|
| CNAME | `@` | `timinghub.duckdns.org.` | 300 |
| CNAME | `www` | `timinghub.duckdns.org.` | 300 |
| CNAME | `api` | `timinghub.duckdns.org.` | 300 |

> **Wichtig:** Der Punkt am Ende von `timinghub.duckdns.org.` ist ein vollqualifizierter Domainname (FQDN) und muss so eingegeben werden, wie die Strato-Oberfläche es verlangt. Manche Interfaces fügen den Punkt automatisch hinzu, andere erfordern ihn explizit.

### 5.4 Änderungen speichern und prüfen

Speichere alle Änderungen. DNS-Propagation dauert typisch **15–30 Minuten**.

Testen mit:

```bash
nslookup timinghub.de
```

Erwartete Ausgabe (nach Propagation):

```
Server:  ...
Address: ...

Non-authoritative answer:
timinghub.de    canonical name = timinghub.duckdns.org
timinghub.duckdns.org   Address: <deine öffentliche IP>
```

Alternativ mit `dig`:

```bash
dig timinghub.de +short
dig www.timinghub.de +short
dig api.timinghub.de +short
```

Alle drei sollten die öffentliche IP deines Routers zurückgeben.

---

## 6. Schritt 4: Pi-hole von Port 80 befreien

Pi-hole verwendet standardmäßig Port 80 für sein Admin-Interface (lighttpd). Nginx braucht Port 80 für HTTP und die ACME-Challenge von Let's Encrypt. Pi-hole wird deshalb auf Port 8081 verschoben.

### 6.1 lighttpd-Konfiguration anpassen

```bash
sudo nano /etc/lighttpd/lighttpd.conf
```

Suche die Zeile:

```
server.port = 80
```

Ändere sie zu:

```
server.port = 8081
```

Speichern und beenden (`Ctrl+O`, `Enter`, `Ctrl+X`).

### 6.2 lighttpd neu starten

```bash
sudo systemctl restart lighttpd
```

Status prüfen:

```bash
sudo systemctl status lighttpd
```

Erwartete Ausgabe: `active (running)`

### 6.3 Pi-hole Admin erreichbar

Das Pi-hole Admin-Interface ist ab jetzt unter folgender Adresse erreichbar:

```
http://pi.local:8081/admin
```

oder mit der lokalen IP:

```
http://192.168.178.42:8081/admin
```

---

## 7. Schritt 5: Projekt herunterladen

```bash
cd /home/pi && git clone https://github.com/Labushuya/timing-hub.git
```

Ins Projektverzeichnis wechseln:

```bash
cd /home/pi/timing-hub
```

Verzeichnisstruktur prüfen:

```bash
ls -la
```

---

## 8. Schritt 6: Konfiguration

### 8.1 Konfigurationsdatei erstellen

```bash
cp /home/pi/timing-hub/infra/.env.prod.example /home/pi/timing-hub/infra/.env.prod
```

### 8.2 Konfigurationsdatei bearbeiten

```bash
nano /home/pi/timing-hub/infra/.env.prod
```

### 8.3 Secrets generieren

Für `JWT_SECRET` (einmal ausführen, Ausgabe kopieren):

```bash
openssl rand -hex 32
```

Für `MASTER_ADMIN_TOKEN` (nochmals ausführen, andere Ausgabe kopieren):

```bash
openssl rand -hex 32
```

### 8.4 Konfigurationsdatei ausfüllen

Ersetze in der `.env.prod` alle Platzhalter:

| Variable | Beschreibung |
|---|---|
| `JWT_SECRET` | Erster generierter Hex-String (64 Zeichen) |
| `MASTER_ADMIN_TOKEN` | Zweiter generierter Hex-String (64 Zeichen) |
| `POSTGRES_PASSWORD` | Ersetze `CHANGE_ME_STRONG_PASSWORD` durch ein sicheres Passwort |
| `DOMAIN` | `timinghub.de` |
| `API_DOMAIN` | `api.timinghub.de` |

> **Sicherheitshinweis:** Die `.env.prod` enthält Secrets und darf niemals in Git committed werden. Die Datei ist in `.gitignore` eingetragen.

---

## 9. Schritt 7: Erster Start (Bootstrap)

Der erste Start erfolgt in zwei Phasen: Zuerst wird Nginx mit einer minimalen HTTP-Konfiguration gestartet (kein SSL), damit Certbot die ACME-Challenge durchführen kann.

### 9.1 Bootstrap-Nginx-Konfiguration aktivieren

Die Bootstrap-Konfiguration (`timing-hub-bootstrap.conf`) liegt bereits im Repository und ist auf HTTP-only ausgelegt — sie lässt die ACME-Challenge durch, ohne SSL vorauszusetzen.

Stelle sicher, dass **nur** die Bootstrap-Konfiguration im `conf.d`-Verzeichnis aktiv ist:

```bash
cd /home/pi/timing-hub/infra
ls nginx/conf.d/
# Erwartete Ausgabe:
#   timing-hub-bootstrap.conf
#   timing-hub.conf
```

> Die Nginx-Konfiguration wird über das Docker-Volume `./nginx/conf.d:/etc/nginx/conf.d:ro` eingebunden.
> Nginx lädt **alle** `.conf`-Dateien in diesem Verzeichnis. Da `timing-hub.conf` SSL-Zertifikate referenziert, die noch nicht existieren, würde Nginx beim Start abstürzen.
>
> Lösung: Benenne `timing-hub.conf` vorübergehend um, damit sie nicht geladen wird:

```bash
mv /home/pi/timing-hub/infra/nginx/conf.d/timing-hub.conf \
   /home/pi/timing-hub/infra/nginx/conf.d/timing-hub.conf.disabled
```

### 9.2 Infrastruktur-Services starten

```bash
docker compose -f docker-compose.prod.yml up -d postgres redis nginx
```

### 9.3 Warten bis PostgreSQL bereit ist

```bash
sleep 30
```

Status prüfen:

```bash
docker compose -f docker-compose.prod.yml ps
```

Alle drei Services (`postgres`, `redis`, `nginx`) sollten den Status `running` oder `healthy` haben.

Nginx direkt testen:

```bash
curl -v http://timinghub.de/.well-known/acme-challenge/test
```

Erwartete Antwort: HTTP 404 (kein Zertifikat vorhanden, aber Nginx antwortet — das ist korrekt).

---

## 10. Schritt 8: SSL-Zertifikat holen

Certbot fordert ein Let's Encrypt-Zertifikat für alle drei Domains gleichzeitig an.

```bash
docker compose -f docker-compose.prod.yml run --rm certbot certonly \
  --webroot \
  -w /var/www/certbot \
  -d timinghub.de \
  -d www.timinghub.de \
  -d api.timinghub.de \
  --email YOUR@EMAIL.DE \
  --agree-tos \
  --non-interactive
```

> **Wichtig:** Ersetze `YOUR@EMAIL.DE` durch deine echte E-Mail-Adresse. Let's Encrypt sendet Ablauf-Benachrichtigungen an diese Adresse.

Erwartete Ausgabe am Ende:

```
Successfully received certificate.
Certificate is saved at: /etc/letsencrypt/live/timinghub.de/fullchain.pem
Key is saved at: /etc/letsencrypt/live/timinghub.de/privkey.pem
This certificate expires on YYYY-MM-DD.
```

> **Voraussetzung:** DNS muss bereits propagiert sein und Port 80 muss vom Internet aus erreichbar sein. Falls Certbot fehlschlägt, zuerst Schritt 3 und 4 prüfen.

---

## 11. Schritt 9: Nginx auf HTTPS umstellen

Jetzt wird die Bootstrap-Konfiguration deaktiviert und die vollständige HTTPS-Konfiguration aktiviert.

```bash
cd /home/pi/timing-hub/infra

# Bootstrap-Config deaktivieren
mv nginx/conf.d/timing-hub-bootstrap.conf \
   nginx/conf.d/timing-hub-bootstrap.conf.disabled

# Vollständige HTTPS-Config aktivieren (falls noch disabled)
mv nginx/conf.d/timing-hub.conf.disabled \
   nginx/conf.d/timing-hub.conf 2>/dev/null || true
```

Nginx neu starten:

```bash
docker compose -f docker-compose.prod.yml restart nginx
```

HTTPS testen:

```bash
curl -v https://timinghub.de
```

Erwartete Antwort: HTTP 200 oder 301/302 (Redirect zur App).

---

## 12. Schritt 10: Alle Services starten

```bash
cd /home/pi/timing-hub/infra
docker compose -f docker-compose.prod.yml up -d
```

Alle Services prüfen:

```bash
docker compose -f docker-compose.prod.yml ps
```

Alle Services sollten `running` oder `healthy` sein:

```
NAME         STATUS          PORTS
postgres     running         5432/tcp
redis        running         6379/tcp
nginx        running         0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
api          running         3000/tcp
```

---

## 13. Schritt 11: Datenbank initialisieren

### 13.1 Migrationen ausführen

```bash
docker compose -f docker-compose.prod.yml exec api node dist/db/migrations/migrate.js up
```

Erwartete Ausgabe: Alle Migrationen werden als `up` markiert.

### 13.2 Seed-Daten einspielen (Admin-Account)

```bash
docker compose -f docker-compose.prod.yml exec api node dist/db/seed.js
```

Erwartete Ausgabe: Admin-Zugangsdaten werden in der Konsole ausgegeben.

---

## 14. Schritt 12: Autostart einrichten

Der Systemd-Service sorgt dafür, dass Timing Hub automatisch startet, wenn der Pi bootet.

```bash
sudo cp /home/pi/timing-hub/infra/systemd/timing-hub.service /etc/systemd/system/
```

Systemd neu laden:

```bash
sudo systemctl daemon-reload
```

Service aktivieren (Autostart):

```bash
sudo systemctl enable timing-hub
```

Service jetzt starten (optional, falls noch nicht über Docker Compose gestartet):

```bash
sudo systemctl start timing-hub
```

Status prüfen:

```bash
sudo systemctl status timing-hub
```

---

## 15. Schritt 13: SSL-Erneuerung automatisieren

Let's Encrypt-Zertifikate laufen nach 90 Tagen ab. Der folgende Cron Job erneuert sie automatisch.

Cron-Datei bearbeiten:

```bash
crontab -e
```

Folgende Zeilen am Ende einfügen (zusätzlich zum DuckDNS-Eintrag aus Schritt 1):

```
# SSL-Zertifikat erneuern (täglich um 3:15 Uhr)
15 3 * * * /home/pi/timing-hub/infra/scripts/ssl-renew.sh >> /home/pi/timing-hub/logs/ssl-renew.log 2>&1

# Tägliches Backup (täglich um 2:00 Uhr)
0 2 * * * /home/pi/timing-hub/infra/scripts/backup.sh >> /home/pi/timing-hub/logs/backup.log 2>&1
```

Scripts ausführbar machen:

```bash
chmod +x /home/pi/timing-hub/infra/scripts/ssl-renew.sh
chmod +x /home/pi/timing-hub/infra/scripts/backup.sh
```

Log-Verzeichnis anlegen:

```bash
mkdir -p /home/pi/timing-hub/logs
```

SSL-Erneuerung manuell testen (Dry-Run):

```bash
docker compose -f /home/pi/timing-hub/infra/docker-compose.prod.yml run --rm certbot renew --dry-run
```

Erwartete Ausgabe: `Congratulations, all simulated renewals succeeded`

---

## 16. Schritt 14: Testen

### 16.1 Erreichbarkeit prüfen

| URL | Erwartetes Ergebnis |
|---|---|
| `https://timinghub.de` | Frontend lädt (HTTP 200) |
| `https://www.timinghub.de` | Redirect zu `timinghub.de` (HTTP 301) |
| `https://api.timinghub.de/health` | `{"status":"ok"}` (HTTP 200) |
| `http://timinghub.de` | Redirect zu HTTPS (HTTP 301) |

Testen mit curl:

```bash
curl -I https://timinghub.de
curl -I https://www.timinghub.de
curl https://api.timinghub.de/health
curl -I http://timinghub.de
```

### 16.2 SSL-Zertifikat prüfen

```bash
curl -v https://timinghub.de 2>&1 | grep -E "SSL|certificate|expire"
```

Oder mit openssl:

```bash
echo | openssl s_client -connect timinghub.de:443 2>/dev/null | openssl x509 -noout -dates
```

### 16.3 Logs beobachten

API-Logs in Echtzeit:

```bash
docker compose -f /home/pi/timing-hub/infra/docker-compose.prod.yml logs -f api
```

Nginx-Logs:

```bash
docker compose -f /home/pi/timing-hub/infra/docker-compose.prod.yml logs -f nginx
```

Alle Services auf einmal:

```bash
docker compose -f /home/pi/timing-hub/infra/docker-compose.prod.yml logs -f
```

### 16.4 Service-Status prüfen

```bash
docker compose -f /home/pi/timing-hub/infra/docker-compose.prod.yml ps
```

---

## 17. Updates einspielen

```bash
./infra/scripts/deploy.sh
```

Das Deploy-Script führt folgende Schritte aus:
1. `git pull` — aktuellen Code holen
2. Docker-Images neu bauen
3. Services rolling restart
4. Migrationen ausführen (falls neue vorhanden)

Für ein manuelles Update:

```bash
cd /home/pi/timing-hub
git pull
docker compose -f infra/docker-compose.prod.yml build
docker compose -f infra/docker-compose.prod.yml up -d
docker compose -f infra/docker-compose.prod.yml exec api node dist/db/migrations/migrate.js up
```

---

## 18. Ressourcenverbrauch Pi 5

### RAM (Schätzung bei Normalbetrieb)

| Service | RAM-Verbrauch (ca.) |
|---|---|
| Raspberry Pi OS (Basis) | ~300 MB |
| Docker Engine | ~100 MB |
| PostgreSQL | ~80–150 MB |
| Redis | ~20–30 MB |
| Node.js API | ~100–200 MB |
| Nginx | ~10–20 MB |
| Pi-hole (lighttpd) | ~30–50 MB |
| **Gesamt** | **~640–850 MB** |

Mit 4 GB RAM ist ausreichend Puffer für Last-Spitzen vorhanden. Mit 8 GB ist genug Headroom für zukünftige Erweiterungen.

### CPU

- Im Idle: ~2–5 % CPU-Auslastung
- Bei aktiver Nutzung (mehrere gleichzeitige Requests): ~10–30 %
- Der Pi 5 mit seinem Cortex-A76 Quad-Core ist für dieses Workload sehr gut geeignet

### Disk

| Bereich | Platzbedarf (ca.) |
|---|---|
| Raspberry Pi OS | ~4–6 GB |
| Docker Images (alle Services) | ~1–2 GB |
| PostgreSQL-Daten | wächst je nach Nutzung |
| Let's Encrypt Zertifikate | < 1 MB |
| Logs | ~50–200 MB (je nach Rotation) |
| **Empfehlung** | **mindestens 32 GB SD-Karte oder SSD** |

> **Empfehlung:** Für Produktionsbetrieb eine SSD per USB 3.0 oder direkt über den PCIe-Slot (NVMe HAT) verwenden. SD-Karten unterliegen hohem Verschleiß durch kontinuierliche Schreibzugriffe von Logs und Datenbank.

---

## 19. Troubleshooting

### Port nicht erreichbar (Timeout von außen)

**Symptom:** `curl https://timinghub.de` hängt oder gibt `Connection refused`.

**Ursachen und Lösungen:**

1. Port-Forwarding im Router prüfen:
   - Fritz!Box: Internet -> Freigaben -> Portfreigaben
   - Sind Einträge für Port 80 und 443 aktiv?

2. Nginx läuft prüfen:
   ```bash
   docker compose -f /home/pi/timing-hub/infra/docker-compose.prod.yml ps nginx
   ```

3. Lokaler Test (vom Pi selbst):
   ```bash
   curl http://localhost
   ```

4. ISP blockiert Port 80/443? Testweise mit Port 8080 testen.

---

### SSL-Fehler / Zertifikat ungültig

**Symptom:** Browser zeigt "Nicht sicher" oder Certbot schlägt fehl.

**Ursachen und Lösungen:**

1. DNS noch nicht propagiert:
   ```bash
   nslookup timinghub.de 8.8.8.8
   ```
   Muss die öffentliche IP des Routers zurückgeben.

2. Let's Encrypt Rate Limit erreicht (max. 5 Zertifikate/Woche pro Domain):
   ```bash
   # Staging-Umgebung zum Testen verwenden
   docker compose -f /home/pi/timing-hub/infra/docker-compose.prod.yml run --rm certbot certonly \
     --webroot -w /var/www/certbot \
     -d timinghub.de -d www.timinghub.de -d api.timinghub.de \
     --email YOUR@EMAIL.DE --agree-tos --non-interactive \
     --staging
   ```

3. ACME-Challenge nicht erreichbar:
   ```bash
   curl http://timinghub.de/.well-known/acme-challenge/test
   ```
   Muss HTTP 404 zurückgeben (nicht Timeout oder Connection refused).

---

### Service startet nicht

**Symptom:** `docker compose ps` zeigt Service als `exited` oder `restarting`.

**Diagnose:**

```bash
docker compose -f /home/pi/timing-hub/infra/docker-compose.prod.yml logs api
docker compose -f /home/pi/timing-hub/infra/docker-compose.prod.yml logs postgres
docker compose -f /home/pi/timing-hub/infra/docker-compose.prod.yml logs nginx
```

Häufige Ursachen:
- `.env.prod` fehlt oder enthält Platzhalter (`CHANGE_ME`)
- PostgreSQL noch nicht bereit beim API-Start (kurz warten, dann neu starten):
  ```bash
  docker compose -f /home/pi/timing-hub/infra/docker-compose.prod.yml restart api
  ```

---

### Pi-hole DNS kaputt nach Änderung

**Symptom:** Pi-hole Admin nicht erreichbar, DNS-Auflösung gestört.

**Diagnose:**

```bash
sudo systemctl status lighttpd
```

Fehlerlog prüfen:

```bash
sudo journalctl -u lighttpd -n 50
```

Häufige Ursachen:
- Port 8081 bereits belegt: `sudo ss -tlnp | grep 8081`
- Konfigurationsfehler in `lighttpd.conf`: `sudo lighttpd -t -f /etc/lighttpd/lighttpd.conf`

Neu starten:

```bash
sudo systemctl restart lighttpd
```

---

### Datenbankprobleme

**Symptom:** API gibt Datenbankfehler zurück, Migrationen schlagen fehl.

**PostgreSQL-Konsole öffnen:**

```bash
docker compose -f /home/pi/timing-hub/infra/docker-compose.prod.yml exec postgres psql -U postgres -d timinghub
```

Nützliche SQL-Befehle:

```sql
-- Alle Tabellen anzeigen
\dt

-- Verbindungen anzeigen
SELECT * FROM pg_stat_activity;

-- Datenbankgröße prüfen
SELECT pg_size_pretty(pg_database_size('timinghub'));

-- Beenden
\q
```

Migrationen-Status prüfen:

```bash
docker compose -f /home/pi/timing-hub/infra/docker-compose.prod.yml exec api node dist/db/migrations/migrate.js status
```

---

### DuckDNS aktualisiert nicht

**Symptom:** `timinghub.duckdns.org` zeigt alte IP.

**Script manuell testen:**

```bash
/home/pi/timing-hub/infra/scripts/duckdns-update.sh
```

Erwartete Ausgabe: `OK`

Wenn `KO` zurückkommt: Token in der Script-Datei prüfen.

Cron-Log prüfen:

```bash
crontab -l
grep CRON /var/log/syslog | tail -20
```

---

*Letzte Aktualisierung: 2026 — Raspberry Pi OS Bookworm, Docker Compose v2, Let's Encrypt*
