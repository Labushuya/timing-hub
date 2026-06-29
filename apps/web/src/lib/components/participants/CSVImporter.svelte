<script lang="ts">
  import { api, APIError } from '$lib/api/client.js';
  import type { CreateParticipantPayload, ImportParticipantsResult } from '$lib/api/client.js';

  interface Props {
    eventSlug: string;
    onImported: (result: ImportParticipantsResult) => void;
    onClose: () => void;
  }

  let { eventSlug, onImported, onClose }: Props = $props();

  // ---- States -----------------------------------------------------------------

  type Stage = 'drop' | 'preview' | 'result';
  let stage = $state<Stage>('drop');
  let dragOver = $state(false);
  let parseError = $state<string | null>(null);
  let importing = $state(false);
  let importError = $state<string | null>(null);
  let importResult = $state<ImportParticipantsResult | null>(null);
  let importMode = $state<'merge' | 'replace'>('merge');

  // ---- Parsed data ------------------------------------------------------------

  interface ParsedRow {
    rowIndex: number;
    data: Record<string, string>;
    mapped: Partial<CreateParticipantPayload>;
    errors: string[];
  }

  let rawHeaders = $state<string[]>([]);
  let parsedRows = $state<ParsedRow[]>([]);
  let columnMapping = $state<Record<string, string>>({});

  const API_FIELDS: { key: keyof CreateParticipantPayload; label: string }[] = [
    { key: 'startnummer', label: 'Startnummer *' },
    { key: 'driver_name', label: 'Fahrer *' },
    { key: 'co_driver_name', label: 'Beifahrer' },
    { key: 'car_make', label: 'Marke' },
    { key: 'car_model', label: 'Modell' },
    { key: 'car_year', label: 'Baujahr' },
    { key: 'class', label: 'Klasse' },
    { key: 'target_time_ms', label: 'Sollzeit (ms)' }
  ];

  // German/alternate header synonyms → canonical field
  const HEADER_SYNONYMS: Record<string, keyof CreateParticipantPayload> = {
    startnummer: 'startnummer',
    start_number: 'startnummer',
    'start nr': 'startnummer',
    startnr: 'startnummer',
    '#': 'startnummer',
    nr: 'startnummer',

    fahrer: 'driver_name',
    driver: 'driver_name',
    driver_name: 'driver_name',
    fahrername: 'driver_name',

    beifahrer: 'co_driver_name',
    co_driver: 'co_driver_name',
    co_driver_name: 'co_driver_name',
    navigator: 'co_driver_name',

    fahrzeug: 'car_make',
    marke: 'car_make',
    car_make: 'car_make',
    make: 'car_make',
    hersteller: 'car_make',

    modell: 'car_model',
    model: 'car_model',
    car_model: 'car_model',

    baujahr: 'car_year',
    year: 'car_year',
    car_year: 'car_year',
    jahrgang: 'car_year',

    klasse: 'class',
    class: 'class',
    gruppe: 'class',
    kategorie: 'class',

    sollzeit: 'target_time_ms',
    target_time: 'target_time_ms',
    target_time_ms: 'target_time_ms',
    zielzeit: 'target_time_ms'
  };

  function autoMapHeaders(headers: string[]): Record<string, string> {
    const mapping: Record<string, string> = {};
    for (const h of headers) {
      const norm = h.toLowerCase().trim();
      const field = HEADER_SYNONYMS[norm];
      if (field) mapping[h] = field;
    }
    return mapping;
  }

  // ---- CSV parsing ------------------------------------------------------------

  function stripBom(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  function detectDelimiter(firstLine: string): ',' | ';' | '\t' {
    const semiCount = (firstLine.match(/;/g) ?? []).length;
    const commaCount = (firstLine.match(/,/g) ?? []).length;
    const tabCount = (firstLine.match(/\t/g) ?? []).length;
    if (semiCount >= commaCount && semiCount >= tabCount) return ';';
    if (tabCount > commaCount) return '\t';
    return ',';
  }

  function parseCSVLine(line: string, delimiter: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }

  function parseCSV(text: string): { headers: string[]; rows: string[][] } | null {
    const clean = stripBom(text);
    const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2) return null;

    const delimiter = detectDelimiter(lines[0]!);
    const headers = parseCSVLine(lines[0]!, delimiter);
    const rows = lines.slice(1).map((l) => parseCSVLine(l, delimiter));
    return { headers, rows };
  }

  function buildParsedRows(
    headers: string[],
    rows: string[][],
    mapping: Record<string, string>
  ): ParsedRow[] {
    return rows.map((cols, idx) => {
      const data: Record<string, string> = {};
      headers.forEach((h, i) => {
        data[h] = cols[i] ?? '';
      });

      const mapped: Partial<CreateParticipantPayload> = {};
      for (const [csvCol, apiField] of Object.entries(mapping)) {
        const val = data[csvCol] ?? '';
        if (!val) continue;
        if (apiField === 'car_year') {
          const y = parseInt(val, 10);
          if (!isNaN(y)) (mapped as Record<string, unknown>)[apiField] = y;
        } else if (apiField === 'target_time_ms') {
          const ms = parseInt(val, 10);
          if (!isNaN(ms)) (mapped as Record<string, unknown>)[apiField] = ms;
        } else {
          (mapped as Record<string, unknown>)[apiField] = val;
        }
      }

      const errors: string[] = [];
      if (!mapped.startnummer) errors.push('Startnummer fehlt');
      if (!mapped.driver_name) errors.push('Fahrername fehlt');

      return { rowIndex: idx + 2, data, mapped, errors };
    });
  }

  function processFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') {
      parseError = 'Nur CSV-Dateien werden unterstützt.';
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const parsed = parseCSV(text);
      if (!parsed) {
        parseError = 'CSV konnte nicht gelesen werden. Mindestens eine Kopfzeile und eine Datenzeile erforderlich.';
        return;
      }

      rawHeaders = parsed.headers;
      columnMapping = autoMapHeaders(parsed.headers);
      parsedRows = buildParsedRows(parsed.headers, parsed.rows, columnMapping);
      parseError = null;
      stage = 'preview';
    };
    reader.onerror = () => {
      parseError = 'Datei konnte nicht gelesen werden.';
    };
    reader.readAsText(file, 'UTF-8');
  }

  // ---- Drag & Drop ------------------------------------------------------------

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function onDragLeave() {
    dragOver = false;
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const file = e.dataTransfer?.files[0];
    if (file) processFile(file);
  }

  function onFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) processFile(file);
    input.value = '';
  }

  function openFilePicker() {
    document.getElementById('csv-file-input')?.click();
  }

  // ---- Mapping UI updates -----------------------------------------------------

  function updateMapping(csvCol: string, apiField: string) {
    if (apiField === '') {
      const next = { ...columnMapping };
      delete next[csvCol];
      columnMapping = next;
    } else {
      columnMapping = { ...columnMapping, [csvCol]: apiField };
    }
    parsedRows = buildParsedRows(rawHeaders, parsedRows.map((r) => rawHeaders.map((h) => r.data[h] ?? '')), columnMapping);
  }

  // ---- Computed for preview ---------------------------------------------------

  const validRows = $derived(parsedRows.filter((r) => r.errors.length === 0));
  const invalidRows = $derived(parsedRows.filter((r) => r.errors.length > 0));
  const previewRows = $derived(parsedRows.slice(0, 5));

  // Check which required fields are unmapped
  const requiredFieldsMapped = $derived(
    Object.values(columnMapping).includes('startnummer') &&
    Object.values(columnMapping).includes('driver_name')
  );

  // ---- Import -----------------------------------------------------------------

  async function doImport() {
    if (!requiredFieldsMapped || validRows.length === 0) return;
    importing = true;
    importError = null;

    try {
      const participants = validRows.map((r) => r.mapped as CreateParticipantPayload);
      const result = await api.participants.importParticipants(eventSlug, {
        participants,
        mode: importMode
      });
      importResult = result;
      stage = 'result';
      onImported(result);
    } catch (err) {
      importError = err instanceof APIError ? err.message : 'Import fehlgeschlagen';
    } finally {
      importing = false;
    }
  }

  function reset() {
    stage = 'drop';
    rawHeaders = [];
    parsedRows = [];
    columnMapping = {};
    parseError = null;
    importError = null;
    importResult = null;
  }
</script>

<div class="csv-importer" role="dialog" aria-label="CSV-Importer" aria-modal="true">
  <div class="importer-header">
    <h2 class="importer-title">CSV-Import</h2>
    <button class="close-btn" type="button" onclick={onClose} aria-label="Schließen">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  </div>

  <!-- Step indicator -->
  <div class="steps" aria-hidden="true">
    <div class="step" class:active={stage === 'drop'} class:done={stage !== 'drop'}>
      <span class="step-num">1</span>
      <span class="step-label">Datei laden</span>
    </div>
    <div class="step-sep"></div>
    <div class="step" class:active={stage === 'preview'} class:done={stage === 'result'}>
      <span class="step-num">2</span>
      <span class="step-label">Vorschau & Mapping</span>
    </div>
    <div class="step-sep"></div>
    <div class="step" class:active={stage === 'result'}>
      <span class="step-num">3</span>
      <span class="step-label">Ergebnis</span>
    </div>
  </div>

  <!-- Stage: Drop zone -->
  {#if stage === 'drop'}
    <div
      class="drop-zone"
      class:drag-over={dragOver}
      role="button"
      tabindex="0"
      aria-label="CSV-Datei hier ablegen oder klicken"
      ondragover={onDragOver}
      ondragleave={onDragLeave}
      ondrop={onDrop}
      onclick={openFilePicker}
      onkeydown={(e) => e.key === 'Enter' || e.key === ' ' ? openFilePicker() : null}
    >
      <input
        id="csv-file-input"
        type="file"
        accept=".csv,text/csv"
        class="visually-hidden"
        onchange={onFileInput}
        aria-hidden="true"
        tabindex="-1"
      />
      <div class="drop-icon" aria-hidden="true">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
      </div>
      <p class="drop-primary">CSV-Datei hier ablegen oder klicken</p>
      <p class="drop-hint">Unterstützt Semikolon- und Komma-Trenner, Excel UTF-8 BOM</p>
    </div>

    <div class="format-info">
      <details>
        <summary class="format-summary">Spalten-Übersicht</summary>
        <div class="format-table-wrap">
          <table class="format-table">
            <thead>
              <tr><th>API-Feld</th><th>Erkannte Spaltenbezeichnungen</th></tr>
            </thead>
            <tbody>
              <tr><td><code>startnummer</code> *</td><td>Startnummer, start_number, Startnr, Nr, #</td></tr>
              <tr><td><code>driver_name</code> *</td><td>Fahrer, driver, Fahrername</td></tr>
              <tr><td><code>co_driver_name</code></td><td>Beifahrer, co_driver, Navigator</td></tr>
              <tr><td><code>car_make</code></td><td>Fahrzeug, Marke, make, Hersteller</td></tr>
              <tr><td><code>car_model</code></td><td>Modell, model</td></tr>
              <tr><td><code>car_year</code></td><td>Baujahr, year, Jahrgang</td></tr>
              <tr><td><code>class</code></td><td>Klasse, Gruppe, Kategorie</td></tr>
              <tr><td><code>target_time_ms</code></td><td>Sollzeit, target_time, Zielzeit (in ms)</td></tr>
            </tbody>
          </table>
        </div>
      </details>
    </div>

    {#if parseError}
      <div class="alert alert-error" role="alert">{parseError}</div>
    {/if}
  {/if}

  <!-- Stage: Preview & Mapping -->
  {#if stage === 'preview'}
    <div class="preview-section">
      <div class="mapping-header">
        <h3 class="section-title">Spalten-Mapping</h3>
        <p class="section-subtitle">
          {rawHeaders.length} Spalten erkannt · {parsedRows.length} Datenzeilen
        </p>
      </div>

      <div class="mapping-grid">
        {#each rawHeaders as header}
          <div class="mapping-row">
            <span class="csv-col">{header}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="mapping-arrow" aria-hidden="true">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
            <select
              class="mapping-select"
              value={columnMapping[header] ?? ''}
              onchange={(e) => updateMapping(header, (e.target as HTMLSelectElement).value)}
              aria-label="Mapping für Spalte {header}"
            >
              <option value="">(ignorieren)</option>
              {#each API_FIELDS as f}
                <option value={f.key}>{f.label}</option>
              {/each}
            </select>
          </div>
        {/each}
      </div>

      {#if !requiredFieldsMapped}
        <div class="alert alert-warning" role="alert">
          Pflichtfelder nicht zugeordnet: Startnummer und Fahrer sind erforderlich.
        </div>
      {/if}

      <!-- Preview table -->
      <div class="preview-header">
        <h3 class="section-title">Vorschau (erste 5 Zeilen)</h3>
        <div class="validity-badges">
          <span class="badge badge-ok">{validRows.length} gültig</span>
          {#if invalidRows.length > 0}
            <span class="badge badge-err">{invalidRows.length} fehlerhaft</span>
          {/if}
        </div>
      </div>

      <div class="table-wrap">
        <table class="preview-table">
          <thead>
            <tr>
              <th>Zeile</th>
              <th>Startnr.</th>
              <th>Fahrer</th>
              <th>Beifahrer</th>
              <th>Marke</th>
              <th>Klasse</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {#each previewRows as row}
              <tr class:row-error={row.errors.length > 0}>
                <td class="col-mono">{row.rowIndex}</td>
                <td class="col-mono">{row.mapped.startnummer ?? '—'}</td>
                <td>{row.mapped.driver_name ?? '—'}</td>
                <td>{row.mapped.co_driver_name ?? ''}</td>
                <td>{row.mapped.car_make ?? ''}</td>
                <td>{row.mapped.class ?? ''}</td>
                <td>
                  {#if row.errors.length > 0}
                    <span class="row-err-label" title={row.errors.join(', ')}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                      </svg>
                      {row.errors[0]}
                    </span>
                  {:else}
                    <span class="row-ok-label" aria-label="gültig">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    </span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      {#if parsedRows.length > 5}
        <p class="preview-more">… und {parsedRows.length - 5} weitere Zeilen</p>
      {/if}

      <!-- Import mode -->
      <div class="import-mode">
        <span class="mode-label">Import-Modus:</span>
        <label class="radio-label">
          <input type="radio" bind:group={importMode} value="merge" />
          Zusammenführen (bestehende Einträge bleiben erhalten)
        </label>
        <label class="radio-label">
          <input type="radio" bind:group={importMode} value="replace" />
          Ersetzen (alle bestehenden Teilnehmer werden gelöscht)
        </label>
      </div>

      {#if importError}
        <div class="alert alert-error" role="alert">{importError}</div>
      {/if}

      <div class="preview-actions">
        <button type="button" class="btn btn-ghost btn-sm" onclick={reset}>Zurück</button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          onclick={doImport}
          disabled={importing || !requiredFieldsMapped || validRows.length === 0}
        >
          {#if importing}
            <span class="btn-spinner" aria-hidden="true"></span>
          {/if}
          {validRows.length} Teilnehmer importieren
        </button>
      </div>
    </div>
  {/if}

  <!-- Stage: Result -->
  {#if stage === 'result' && importResult}
    <div class="result-section">
      <div class="result-icon" aria-hidden="true">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
      </div>
      <h3 class="result-title">Import abgeschlossen</h3>
      <p class="result-summary">
        <strong>{importResult.imported}</strong> Teilnehmer importiert
        {#if importResult.skipped > 0}
          · <strong>{importResult.skipped}</strong> übersprungen
        {/if}
      </p>

      {#if importResult.errors.length > 0}
        <div class="result-errors">
          <p class="result-errors-title">Fehler bei {importResult.errors.length} Zeilen:</p>
          <ul class="error-list">
            {#each importResult.errors.slice(0, 10) as e}
              <li>Zeile {e.row}: {e.message}</li>
            {/each}
            {#if importResult.errors.length > 10}
              <li>… und {importResult.errors.length - 10} weitere</li>
            {/if}
          </ul>
        </div>
      {/if}

      <div class="result-actions">
        <button type="button" class="btn btn-ghost btn-sm" onclick={reset}>Weitere importieren</button>
        <button type="button" class="btn btn-primary btn-sm" onclick={onClose}>Fertig</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .csv-importer {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    width: min(680px, 96vw);
    max-height: 90vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .importer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.25rem 1.5rem 0;
    position: sticky;
    top: 0;
    background: var(--color-surface);
    z-index: 1;
    border-bottom: 1px solid var(--color-border);
    padding-bottom: 1rem;
  }

  .importer-title {
    font-size: 1.125rem;
    font-weight: 700;
    margin: 0;
  }

  .close-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted);
    padding: 0.25rem;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    transition: color 150ms, background 150ms;
  }
  .close-btn:hover {
    color: var(--color-text);
    background: var(--color-surface-2);
  }

  /* Step indicator */
  .steps {
    display: flex;
    align-items: center;
    gap: 0;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--color-border);
  }

  .step {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    opacity: 0.4;
    transition: opacity 150ms;
  }

  .step.active { opacity: 1; }
  .step.done { opacity: 0.65; }

  .step-num {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    font-size: 0.75rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .step.active .step-num {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: white;
  }

  .step.done .step-num {
    background: rgba(34, 197, 94, 0.15);
    border-color: rgba(34, 197, 94, 0.4);
    color: #4ade80;
  }

  .step-label {
    font-size: 0.8125rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .step-sep {
    flex: 1;
    height: 1px;
    background: var(--color-border);
    margin: 0 0.5rem;
    min-width: 16px;
  }

  /* Drop zone */
  .drop-zone {
    margin: 1.5rem;
    border: 2px dashed var(--color-border);
    border-radius: var(--radius-lg);
    padding: 2.5rem 2rem;
    text-align: center;
    cursor: pointer;
    transition: border-color 150ms, background 150ms;
    user-select: none;
  }

  .drop-zone:hover,
  .drop-zone.drag-over {
    border-color: var(--color-primary);
    background: rgba(var(--color-primary-rgb, 99,102,241), 0.04);
  }

  .drop-icon {
    color: var(--color-text-muted);
    margin-bottom: 0.875rem;
    display: flex;
    justify-content: center;
  }

  .drop-primary {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text);
    margin: 0 0 0.375rem;
  }

  .drop-hint {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* Format info */
  .format-info {
    margin: 0 1.5rem 1.5rem;
  }

  .format-summary {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    cursor: pointer;
    padding: 0.25rem 0;
    user-select: none;
  }

  .format-table-wrap {
    overflow-x: auto;
    margin-top: 0.5rem;
  }

  .format-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }

  .format-table th,
  .format-table td {
    padding: 0.375rem 0.625rem;
    border-bottom: 1px solid var(--color-border);
    text-align: left;
    color: var(--color-text-muted);
  }

  .format-table th {
    font-weight: 600;
    color: var(--color-text);
    background: var(--color-surface-2);
  }

  .format-table code {
    font-family: var(--font-mono, monospace);
    font-size: 0.8rem;
    background: var(--color-surface-2);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }

  /* Preview section */
  .preview-section {
    padding: 1.25rem 1.5rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .mapping-header,
  .preview-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .section-title {
    font-size: 0.9375rem;
    font-weight: 700;
    margin: 0;
  }

  .section-subtitle {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  /* Mapping grid */
  .mapping-grid {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0.875rem 1rem;
    max-height: 220px;
    overflow-y: auto;
  }

  .mapping-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .csv-col {
    flex: 1;
    font-size: 0.875rem;
    font-family: var(--font-mono, monospace);
    color: var(--color-text-muted);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mapping-arrow {
    color: var(--color-text-muted);
    opacity: 0.5;
    flex-shrink: 0;
  }

  .mapping-select {
    flex: 1.5;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 0.3rem 0.5rem;
    font-size: 0.8125rem;
    color: var(--color-text);
    font-family: inherit;
    cursor: pointer;
  }

  .mapping-select:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  /* Validity badges */
  .validity-badges {
    display: flex;
    gap: 0.375rem;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 0.15rem 0.55rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 700;
  }

  .badge-ok {
    background: rgba(34, 197, 94, 0.12);
    color: #4ade80;
    border: 1px solid rgba(34, 197, 94, 0.25);
  }

  .badge-err {
    background: rgba(239, 68, 68, 0.1);
    color: var(--color-danger, #ef4444);
    border: 1px solid rgba(239, 68, 68, 0.25);
  }

  /* Preview table */
  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .preview-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }

  .preview-table th {
    padding: 0.5rem 0.75rem;
    background: var(--color-surface-2);
    font-weight: 600;
    text-align: left;
    color: var(--color-text-muted);
    border-bottom: 1px solid var(--color-border);
    white-space: nowrap;
  }

  .preview-table td {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text);
  }

  .preview-table tr:last-child td {
    border-bottom: none;
  }

  .preview-table .row-error td {
    background: rgba(239, 68, 68, 0.04);
  }

  .col-mono {
    font-family: var(--font-mono, monospace);
    color: var(--color-text-muted);
  }

  .row-err-label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--color-danger, #ef4444);
    font-size: 0.75rem;
  }

  .row-ok-label {
    color: #4ade80;
    display: inline-flex;
    align-items: center;
  }

  .preview-more {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin: 0;
    padding: 0.25rem 0;
  }

  /* Import mode */
  .import-mode {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .mode-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .radio-label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8125rem;
    color: var(--color-text);
    cursor: pointer;
  }

  /* Alerts */
  .alert {
    padding: 0.625rem 0.875rem;
    border-radius: var(--radius-md);
    font-size: 0.875rem;
  }

  .alert-error {
    background: rgba(239, 68, 68, 0.08);
    border: 1px solid rgba(239, 68, 68, 0.25);
    color: var(--color-danger, #ef4444);
  }

  .alert-warning {
    background: rgba(245, 158, 11, 0.08);
    border: 1px solid rgba(245, 158, 11, 0.3);
    color: #f59e0b;
  }

  /* Preview actions */
  .preview-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--color-border);
  }

  /* Result section */
  .result-section {
    padding: 2rem 1.5rem 1.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    text-align: center;
  }

  .result-icon {
    color: #4ade80;
  }

  .result-title {
    font-size: 1.125rem;
    font-weight: 700;
    margin: 0;
  }

  .result-summary {
    font-size: 1rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  .result-errors {
    width: 100%;
    text-align: left;
    background: rgba(239, 68, 68, 0.06);
    border: 1px solid rgba(239, 68, 68, 0.2);
    border-radius: var(--radius-md);
    padding: 0.75rem 1rem;
    margin-top: 0.5rem;
  }

  .result-errors-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-danger, #ef4444);
    margin: 0 0 0.5rem;
  }

  .error-list {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin: 0;
    padding-left: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .result-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    border-radius: var(--radius-md);
    font-weight: 600;
    border: 1px solid transparent;
    cursor: pointer;
    transition: all 150ms;
    font-family: inherit;
    white-space: nowrap;
    user-select: none;
  }

  .btn-sm { padding: 0.375rem 0.875rem; font-size: 0.875rem; min-height: 32px; }

  .btn-primary {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--color-primary-foreground, white);
  }
  .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }

  .btn-ghost {
    background: transparent;
    border-color: var(--color-border);
    color: var(--color-text-muted);
  }
  .btn-ghost:hover:not(:disabled) {
    background: var(--color-surface-2);
    color: var(--color-text);
  }

  .btn-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255,255,255,0.4);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
