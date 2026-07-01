# Landing Page — Deployment

Die Dateien in diesem Ordner werden **automatisch via GitHub Actions zu timinghub.de deployed**,
sobald ein Push auf `master` Änderungen in `landing/` enthält.

**Manuelles Hochladen ist nicht mehr nötig.**

---

## Einmalige Einrichtung (nur beim ersten Mal)

### 1. FTP-Zugangsdaten bei Strato finden

Strato Kundenbereich → **Hosting** → **FTP-Zugangsdaten**

Du brauchst:
- **FTP-Host** (z.B. `ssh.strato.de` oder `ftp.stratoserver.net`)
- **FTP-Benutzername**
- **FTP-Passwort**

### 2. GitHub Secrets anlegen

GitHub Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret Name | Wert |
|---|---|
| `STRATO_FTP_HOST` | FTP-Host von Strato |
| `STRATO_FTP_USER` | FTP-Benutzername |
| `STRATO_FTP_PASSWORD` | FTP-Passwort |

### 3. Testen

Nach dem Anlegen der Secrets: eine kleine Änderung in `landing/index.html` committen und pushen.
Unter **Actions** im GitHub Repo kannst du den Deploy-Fortschritt live verfolgen.

---

## Workflow-Details

- Trigger: Push auf `master` mit Änderungen in `landing/`
- Manueller Trigger: GitHub Actions → "Deploy Landing Page to Strato" → "Run workflow"
- Zielverzeichnis: FTP-Root (wo `index.html` liegt)
- Datei: `.github/workflows/deploy-landing.yml`
