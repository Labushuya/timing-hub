<script lang="ts">
  // ---- Props ------------------------------------------------------------------

  interface Props {
    eventSlug: string;
    postenCodes: string[];   // Known posten codes for validation
    onImported: (result: ImportResult) => void;
    onClose: () => void;
  }

  let { eventSlug, postenCodes, onImported, onClose }: Props = $props();

  const API_BASE = (import.meta.env.VITE_API_BASE ?? '/api') as string;

  // ---- Types ------------------------------------------------------------------

  interface ParsedRow {
    rowIndex: number;
    startnummer: string;
    posten_code: string;
    timestamp: string;
    lap_number: number;
    raw: string[];
    errors: string[];
  }

  interface ImportResult {
    imported: number;
    errors: number;
    error_details: Array<{ row: number; message: string }>;
  }

  // ---- State ------------------------------------------------------------------

  type Stage = 'drop' | 'preview' | 'result';
  let stage = $state<Stage>('drop');
  let dragOver = $state(false);
  let parseError = $state<string | null>(null);
  let importing = $state(false);
  let importError = $state<string | null>(null);
  let importResult = $state<ImportResult | null>(null);

  let parsedRows = $state<ParsedRow[]>([]);
  // Mapping: csv posten_code → configured posten code
  let codeMapping = $state<Record<string, string>>({});
  let unknownCodes = $state<string[]>([]);

  // ---- Parsing ----------------------------------------------------------------

  function stripBom(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  function detectDelimiter(line: string): ',' | ';' {
    const semi = (line.match(/;/g) ?? []).length;
    const comma = (line.match(/,/g) ?? []).length;
    return semi >= comma ? ';' : ',';
  }

  /**
   * Expected CSV format (with or without header):
   *   Startnummer ; Posten-Code ; Zeitstempel ; Lauf-Nummer
   * Zeitstempel: HH:MM:SS.mmm or HH:MM:SS,mmm
   */
  function parseTimestamp(raw: string): string | null {
    // Normalize decimal separator
    const s = raw.trim().replace(',', '.');
    // HH:MM:SS.mmm
    const match = s.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!match) return null;
    const ms = match[4] ? match[4].padEnd(3, '0') : '000';
    return `${match[1]!.padStart(2, '0')}:${match[2]!}:${match[3]!}.${ms}`;
  }

  function parseCsvText(text: string): void {
    parseError = null;
    const clean = stripBom(text);
    const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== '');

    if (lines.length < 1) {
      parseError = 'Die Datei ist leer.';
      return;
    }

    const delim = detectDelimiter(lines[0]!);

    // Skip header line if first field is not numeric (looks like a header)
    let dataStart = 0;
    const firstField = lines[0]!.split(delim)[0]?.trim() ?? '';
    if (isNaN(Number(firstField)) && firstField !== '') {
      dataStart = 1;
    }

    const rows: ParsedRow[] = [];
    const foundCodes = new Set<string>();

    for (let i = dataStart; i < lines.length; i++) {
      const line = lines[i]!;
      const cols = line.split(delim).map((c) => c.trim());
      const rowNum = i + 1;

      const startnummer = cols[0] ?? '';
      const posten_code = cols[1] ?? '';
      const timestampRaw = cols[2] ?? '';
      const lapRaw = cols[3] ?? '1';

      const errors: string[] = [];

      if (!startnummer) errors.push('Startnummer fehlt');
      if (!posten_code) errors.push('Posten-Code fehlt');

      const timestamp = parseTimestamp(timestampRaw);
      if (!timestamp) errors.push(`Ungültiger Zeitstempel: "${timestampRaw}"`);

      const lap_number = parseInt(lapRaw, 10);
      if (isNaN(lap_number) || lap_number < 1) errors.push('Ungültige Laufnummer');

      if (posten_code) foundCodes.add(posten_code);

      rows.push({
        rowIndex: rowNum,
        startnummer,
        posten_code,
        timestamp: timestamp ?? timestampRaw,
        lap_number: isNaN(lap_number) ? 1 : lap_number,
        raw: cols,
        errors
      });
    }

    if (rows.length === 0) {
      parseError = 'Keine Datenzeilen gefunden.';
      return;
    }

    // Find unknown codes and build initial mapping
    const initMapping: Record<string, string> = {};
    const unknown: string[] = [];
    for (const code of foundCodes) {
      if (postenCodes.includes(code)) {
        initMapping[code] = code;
      } else {
        unknown.push(code);
        initMapping[code] = postenCodes[0] ?? '';
      }
    }

    parsedRows = rows;
    codeMapping = initMapping;
    unknownCodes = unknown;
    stage = 'preview';
  }

  function processFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') {
      parseError = 'Nur CSV-Dateien werden unterstützt.';
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      parseCsvText(e.target?.result as string);
    };
    reader.onerror = () => {
      parseError = 'Datei konnte nicht gelesen werden.';
    };
    reader.readAsText(file, 'UTF-8');
  }

  // ---- Drag & Drop ------------------------------------------------------------

  function onDragOver(e: DragEvent) { e.preventDefault(); dragOver = true; }
  function onDragLeave() { dragOver = false; }
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
    document.getElementById('time-csv-file-input')?.click();
  }

  // ---- Derived ----------------------------------------------------------------

  const validRows = $derived(parsedRows.filter((r) => r.errors.length === 0));
  const invalidRows = $derived(parsedRows.filter((r) => r.errors.length > 0));
  const previewRows = $derived(parsedRows.slice(0, 5));
  const hasUnknownCodes = $derived(unknownCodes.length > 0);

  // ---- Import -----------------------------------------------------------------

  async function doImport() {
    if (validRows.length === 0 || importing) return;
    importing = true;
    importError = null;

    const payload = validRows.map((r) => ({
      startnummer: r.startnummer,
      posten_code: codeMapping[r.posten_code] ?? r.posten_code,
      timestamp: r.timestamp,
      lap_number: r.lap_number
    }));

    try {
      const res = await fetch(`${API_BASE}/v1/events/${encodeURIComponent(eventSlug)}/times/import-csv`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ times: payload })
      });
      const body = await res.json();
      if (!res.ok) {
        importError = (body as { message?: string }).message ?? `HTTP ${res.status}`;
        return;
      }
      importResult = body as ImportResult;
      stage = 'result';
      onImported(importResult);
    } catch (err) {
      importError = err instanceof Error ? err.message : 'Import fehlgeschlagen';
    } finally {
      importing = false;
    }
  }

  function reset() {
    stage = 'drop';
    parsedRows = [];
    codeMapping = {};
    unknownCodes = [];
    parseError = null;
    importError = null;
    importResult = null;
  }
</script>

<div class="time-importer" role="dialog" aria-label="Zeiten-CSV-Import" aria-modal="true">
  <!-- Header -->
  <div class="importer-header">
    <h2 class="importer-title">Zeiten importieren (CSV)</h2>
    <button class="close-btn" type="button" onclick={onClose} aria-label="Schließen">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  </div>

  <!-- Steps -->
  <div class="steps" aria-hidden="true">
    <div class="step" class:active={stage === 'drop'} class:done={stage !== 'drop'}>
      <span class="step-num">1</span>
      <span class="step-label">Datei laden</span>
    </div>
    <div class="step-sep"></div>
    <div class="step" class:active={stage === 'preview'} class:done={stage === 'result'}>
      <span class="step-num">2</span>
      <span class="step-label">Vorschau</span>
    </div>
    <div class="step-sep"></div>
    <div class="step" class:active={stage === 'result'}>
      <span class="step-num">3</span>
      <span class="step-label">Ergebnis</span>
    </div>
  </div>

  <!-- Stage: Drop zone -->
  {#if stage === 'drop'}
    <div class="stage-body">
      <!-- Drop zone -->
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
        onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') ? openFilePicker() : null}
      >
        <input
          id="time-csv-file-input"
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
        <p class="drop-hint">Semikolon oder Komma als Trennzeichen — wird automatisch erkannt</p>
      </div>

      <!-- Format explanation -->
      <div class="format-info">
        <details>
          <summary class="format-summary">Erwartetes Format</summary>
          <div class="format-body">
            <p class="format-desc">Jede Zeile enthält eine Zeitmessung:</p>
            <pre class="format-example">Startnummer;Posten-Code;Zeitstempel;Lauf-Nr
42;START;10:15:23.456;1
42;ZIEL;10:18:07.891;1
17;START;10:15:25.123;2</pre>
            <ul class="format-notes">
              <li>Zeitstempel-Format: <code>HH:MM:SS.mmm</code> oder <code>HH:MM:SS,mmm</code></li>
              <li>Lauf-Nr ist optional (Standard: 1)</li>
              <li>Kopfzeile ist optional (wird automatisch erkannt)</li>
            </ul>
          </div>
        </details>
      </div>

      {#if parseError}
        <div class="alert alert-error" role="alert">{parseError}</div>
      {/if}
    </div>
  {/if}

  <!-- Stage: Preview -->
  {#if stage === 'preview'}
    <div class="stage-body">

      <!-- Unknown code mapping -->
      {#if hasUnknownCodes}
        <div class="alert alert-warning" role="alert">
          <strong>Unbekannte Posten-Codes</strong> — bitte den konfigurierten Posten zuordnen:
          <div class="code-mapping">
            {#each unknownCodes as code}
              <div class="code-map-row">
                <span class="code-badge unknown">{code}</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
                <select
                  class="mapping-select"
                  value={codeMapping[code] ?? ''}
                  onchange={(e) => { codeMapping = { ...codeMapping, [code]: (e.target as HTMLSelectElement).value }; }}
                  aria-label="Zuordnung für Code {code}"
                >
                  <option value="">(ignorieren)</option>
                  {#each postenCodes as pc}
                    <option value={pc}>{pc}</option>
                  {/each}
                </select>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Validity summary -->
      <div class="validity-row">
        <span class="badge badge-ok">{validRows.length} gültig</span>
        {#if invalidRows.length > 0}
          <span class="badge badge-err">{invalidRows.length} fehlerhaft</span>
        {/if}
        <span class="total-count">{parsedRows.length} Zeilen gesamt</span>
      </div>

      <!-- Preview table -->
      <div class="table-wrap">
        <table class="preview-table">
          <thead>
            <tr>
              <th>Zeile</th>
              <th>Startnr.</th>
              <th>Posten</th>
              <th>Zeitstempel</th>
              <th>Lauf</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {#each previewRows as row}
              <tr class:row-error={row.errors.length > 0}>
                <td class="mono">{row.rowIndex}</td>
                <td class="mono">{row.startnummer || '—'}</td>
                <td>
                  <span class="code-badge" class:unknown={unknownCodes.includes(row.posten_code)}>
                    {row.posten_code || '—'}
                  </span>
                </td>
                <td class="mono">{row.timestamp}</td>
                <td class="mono">{row.lap_number}</td>
                <td>
                  {#if row.errors.length > 0}
                    <span class="row-err-label" title={row.errors.join(', ')}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
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

      {#if importError}
        <div class="alert alert-error" role="alert">{importError}</div>
      {/if}

      <div class="preview-actions">
        <button type="button" class="btn btn-ghost btn-sm" onclick={reset}>Zurück</button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          onclick={doImport}
          disabled={importing || validRows.length === 0}
        >
          {#if importing}
            <span class="btn-spinner" aria-hidden="true"></span>
          {/if}
          {validRows.length} Zeiten importieren
        </button>
      </div>
    </div>
  {/if}

  <!-- Stage: Result -->
  {#if stage === 'result' && importResult}
    <div class="stage-body result-section">
      <div class="result-icon" aria-hidden="true">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
      </div>
      <h3 class="result-title">Import abgeschlossen</h3>
      <p class="result-summary">
        <strong>{importResult.imported}</strong> Zeiten importiert
        {#if importResult.errors > 0}
          · <strong>{importResult.errors}</strong> Fehler
        {/if}
      </p>

      {#if importResult.error_details?.length > 0}
        <div class="result-errors">
          <p class="result-errors-title">Fehler bei {importResult.error_details.length} Zeilen:</p>
          <ul class="error-list">
            {#each importResult.error_details.slice(0, 10) as e}
              <li>Zeile {e.row}: {e.message}</li>
            {/each}
            {#if importResult.error_details.length > 10}
              <li>… und {importResult.error_details.length - 10} weitere</li>
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
  .time-importer {
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
    padding: 1.25rem 1.5rem 1rem;
    position: sticky;
    top: 0;
    background: var(--color-surface);
    z-index: 1;
    border-bottom: 1px solid var(--color-border);
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
  .close-btn:hover { color: var(--color-text); background: var(--color-surface-2); }

  /* Steps */
  .steps {
    display: flex;
    align-items: center;
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
  .step.done   { opacity: 0.65; }

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
  .step.active .step-num { background: var(--color-primary); border-color: var(--color-primary); color: white; }
  .step.done .step-num   { background: rgba(34,197,94,0.15); border-color: rgba(34,197,94,0.4); color: #4ade80; }

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

  /* Stage body */
  .stage-body {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* Drop zone */
  .drop-zone {
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
    display: flex;
    justify-content: center;
    margin-bottom: 0.875rem;
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
    font-size: 0.8125rem;
  }

  .format-summary {
    color: var(--color-text-muted);
    cursor: pointer;
    user-select: none;
    padding: 0.25rem 0;
  }

  .format-body {
    margin-top: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .format-desc {
    color: var(--color-text-muted);
    margin: 0;
  }

  .format-example {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 0.625rem 0.875rem;
    font-family: var(--font-mono, monospace);
    font-size: 0.8125rem;
    color: var(--color-text);
    overflow-x: auto;
    margin: 0;
    white-space: pre;
  }

  .format-notes {
    padding-left: 1.25rem;
    margin: 0;
    color: var(--color-text-muted);
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .format-notes code {
    font-family: var(--font-mono, monospace);
    background: var(--color-surface-2);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }

  /* Alerts */
  .alert {
    padding: 0.625rem 0.875rem;
    border-radius: var(--radius-md);
    font-size: 0.875rem;
  }

  .alert-error {
    background: rgba(239,68,68,0.08);
    border: 1px solid rgba(239,68,68,0.25);
    color: var(--color-danger, #ef4444);
  }

  .alert-warning {
    background: rgba(245,158,11,0.08);
    border: 1px solid rgba(245,158,11,0.3);
    color: #f59e0b;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  /* Code mapping */
  .code-mapping {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.375rem;
  }

  .code-map-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .code-badge {
    font-family: var(--font-mono, monospace);
    font-size: 0.75rem;
    font-weight: 700;
    padding: 0.2rem 0.5rem;
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    color: var(--color-text);
    white-space: nowrap;
  }
  .code-badge.unknown {
    background: rgba(245,158,11,0.1);
    border-color: rgba(245,158,11,0.3);
    color: #f59e0b;
  }

  .mapping-select {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 0.25rem 0.5rem;
    font-size: 0.8125rem;
    color: var(--color-text);
    font-family: inherit;
    cursor: pointer;
  }

  /* Validity */
  .validity-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 0.15rem 0.55rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 700;
  }
  .badge-ok  { background: rgba(34,197,94,0.12); color: #4ade80; border: 1px solid rgba(34,197,94,0.25); }
  .badge-err { background: rgba(239,68,68,0.1); color: var(--color-danger, #ef4444); border: 1px solid rgba(239,68,68,0.25); }

  .total-count {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin-left: auto;
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

  .preview-table tr:last-child td { border-bottom: none; }
  .preview-table .row-error td   { background: rgba(239,68,68,0.04); }

  .mono { font-family: var(--font-mono, monospace); color: var(--color-text-muted); }

  .row-err-label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--color-danger, #ef4444);
    font-size: 0.75rem;
  }
  .row-ok-label { color: #4ade80; display: inline-flex; align-items: center; }

  .preview-more {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  /* Preview actions */
  .preview-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--color-border);
  }

  /* Result */
  .result-section {
    align-items: center;
    text-align: center;
  }

  .result-icon { color: #4ade80; }

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
    background: rgba(239,68,68,0.06);
    border: 1px solid rgba(239,68,68,0.2);
    border-radius: var(--radius-md);
    padding: 0.75rem 1rem;
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
  }

  .btn-sm { padding: 0.375rem 0.875rem; font-size: 0.875rem; min-height: 32px; }

  .btn-primary {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: white;
  }
  .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-ghost {
    background: transparent;
    border-color: var(--color-border);
    color: var(--color-text-muted);
  }
  .btn-ghost:hover:not(:disabled) { background: var(--color-surface-2); color: var(--color-text); }

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
