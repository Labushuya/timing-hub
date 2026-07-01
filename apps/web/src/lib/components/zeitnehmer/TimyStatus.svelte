<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  // ---- Types ------------------------------------------------------------------

  export interface DeviceTypeInfo {
    type: string;
    label: string;
    description: string;
  }

  export interface DevicesResponse {
    current_type: string;
    available_types: DeviceTypeInfo[];
    serial_ports: string[];
  }

  type StatusKind = 'connected' | 'disconnected' | 'connecting';

  // ---- Props ------------------------------------------------------------------

  interface Props {
    status: StatusKind;
    deviceType?: string;
    onDeviceChange?: (newType: string, serialPort: string, baudRate: number) => void;
  }

  let { status, deviceType = 'auto', onDeviceChange }: Props = $props();

  // ---- Local state ------------------------------------------------------------

  let panelOpen = $state(false);
  let devices = $state<DevicesResponse | null>(null);
  let loadingDevices = $state(false);
  let devicesError = $state<string | null>(null);

  let selectedType = $state('');
  let selectedPort = $state('');
  let selectedBaud = $state(9600);
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  let submitSuccess = $state(false);

  // Serial-port devices that require port selection.
  const serialDeviceTypes = new Set(['tag_heuer_cp', 'trentmann_rallystar']);

  const needsSerialPort = $derived(serialDeviceTypes.has(selectedType));

  // ---- Derived label from deviceType prop ------------------------------------

  const deviceLabel = $derived(() => {
    if (!devices) return labelForType(deviceType);
    const found = devices.available_types.find((d) => d.type === deviceType);
    return found ? found.label : labelForType(deviceType);
  });

  function labelForType(type: string): string {
    switch (type) {
      case 'alge_timy': return 'ALGE Timy 3';
      case 'tag_heuer_cp': return 'TAG Heuer CP';
      case 'trentmann_rallystar': return 'Trentmann RallyStar';
      case 'auto': return 'Automatisch';
      default: return type || 'Kein Gerät';
    }
  }

  // ---- Panel open/close ------------------------------------------------------

  async function openPanel() {
    panelOpen = true;
    submitSuccess = false;
    submitError = null;
    await loadDevices();
    // Pre-select current type
    selectedType = devices?.current_type ?? deviceType ?? 'auto';
    selectedPort = devices?.serial_ports?.[0] ?? '';
    selectedBaud = 9600;
  }

  function closePanel() {
    panelOpen = false;
    submitError = null;
    submitSuccess = false;
  }

  // ---- Load /devices ----------------------------------------------------------

  async function loadDevices() {
    loadingDevices = true;
    devicesError = null;
    try {
      const res = await fetch('http://localhost:7272/devices', {
        signal: AbortSignal.timeout(2000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      devices = await res.json();
    } catch (err) {
      devicesError = err instanceof Error ? err.message : 'Fehler beim Laden';
    } finally {
      loadingDevices = false;
    }
  }

  // ---- POST /device -----------------------------------------------------------

  async function submitDeviceChange() {
    if (submitting) return;
    submitting = true;
    submitError = null;
    submitSuccess = false;

    try {
      const body: { type: string; serial_port?: string; baud_rate?: number } = {
        type: selectedType
      };
      if (needsSerialPort) {
        body.serial_port = selectedPort;
        body.baud_rate = selectedBaud;
      }

      const res = await fetch('http://localhost:7272/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000)
      });

      if (!res.ok) {
        const text = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(text || `HTTP ${res.status}`);
      }

      const data = await res.json();
      submitSuccess = true;

      if (onDeviceChange) {
        onDeviceChange(data.current_type, selectedPort, selectedBaud);
      }

      // Auto-close panel after a short delay on success
      setTimeout(() => {
        closePanel();
      }, 1200);
    } catch (err) {
      submitError = err instanceof Error ? err.message : 'Verbindung fehlgeschlagen';
    } finally {
      submitting = false;
    }
  }

  // ---- Close panel on outside click -----------------------------------------

  let wrapperEl: HTMLDivElement | undefined;

  function handleGlobalClick(e: MouseEvent) {
    if (panelOpen && wrapperEl && !wrapperEl.contains(e.target as Node)) {
      closePanel();
    }
  }

  onMount(() => {
    document.addEventListener('click', handleGlobalClick, true);
  });

  onDestroy(() => {
    document.removeEventListener('click', handleGlobalClick, true);
  });
</script>

<div class="timy-status-wrap" bind:this={wrapperEl}>
  <!-- Status indicator row -->
  <div class="timy-indicator timy-{status}" title="Bridge-Status: {status}">
    <span class="timy-dot" aria-hidden="true"></span>
    <span class="timy-label">{deviceLabel()}</span>
    <button
      type="button"
      class="gear-btn"
      title="Gerät ändern"
      aria-label="Gerät ändern"
      onclick={openPanel}
    >
      &#9881;
    </button>
  </div>

  <!-- Inline device selector panel -->
  {#if panelOpen}
    <div class="device-panel" role="dialog" aria-label="Gerät auswählen">
      <div class="panel-header">
        <span class="panel-title">Gerät auswählen</span>
        <button type="button" class="close-btn" onclick={closePanel} aria-label="Schließen">
          &#x2715;
        </button>
      </div>

      {#if loadingDevices}
        <p class="panel-loading">Lade&hellip;</p>
      {:else if devicesError}
        <p class="panel-error">{devicesError}</p>
      {:else if devices}
        <div class="panel-body">
          <!-- Device type dropdown -->
          <label class="panel-label" for="device-type-select">Gerätetyp</label>
          <select
            id="device-type-select"
            class="panel-select"
            bind:value={selectedType}
          >
            {#each devices.available_types as d (d.type)}
              <option value={d.type}>{d.label}</option>
            {/each}
          </select>

          <!-- Serial port selector (conditional) -->
          {#if needsSerialPort}
            <label class="panel-label" for="serial-port-select">Serieller Port</label>
            {#if devices.serial_ports.length > 0}
              <select
                id="serial-port-select"
                class="panel-select"
                bind:value={selectedPort}
              >
                {#each devices.serial_ports as port (port)}
                  <option value={port}>{port}</option>
                {/each}
              </select>
            {:else}
              <input
                id="serial-port-select"
                type="text"
                class="panel-input"
                placeholder="z.B. COM3"
                bind:value={selectedPort}
              />
            {/if}

            <label class="panel-label" for="baud-rate-select">Baudrate</label>
            <select
              id="baud-rate-select"
              class="panel-select"
              bind:value={selectedBaud}
            >
              <option value={9600}>9600</option>
              <option value={19200}>19200</option>
              <option value={38400}>38400</option>
              <option value={57600}>57600</option>
              <option value={115200}>115200</option>
            </select>
          {/if}

          <!-- Feedback -->
          {#if submitError}
            <p class="panel-error">{submitError}</p>
          {/if}
          {#if submitSuccess}
            <p class="panel-success">Verbunden!</p>
          {/if}

          <!-- Actions -->
          <div class="panel-actions">
            <button
              type="button"
              class="btn-connect"
              onclick={submitDeviceChange}
              disabled={submitting || (needsSerialPort && !selectedPort)}
            >
              {submitting ? 'Verbinde…' : 'Verbinden'}
            </button>
            <button type="button" class="btn-cancel" onclick={closePanel}>
              Schlie&szlig;en
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .timy-status-wrap {
    position: relative;
    display: inline-flex;
    flex-direction: column;
    align-items: flex-end;
  }

  /* Status indicator */
  .timy-indicator {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .timy-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .timy-connected .timy-dot  { background: var(--color-success, #22c55e); }
  .timy-connecting .timy-dot { background: var(--color-warning, #f59e0b); animation: pulse 1.2s ease-in-out infinite; }
  .timy-disconnected .timy-dot { background: var(--color-danger, #ef4444); }

  .timy-connected    { color: var(--color-success, #22c55e); }
  .timy-connecting   { color: var(--color-warning, #f59e0b); }
  .timy-disconnected { color: var(--color-danger, #ef4444); }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* Gear button */
  .gear-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.875rem;
    line-height: 1;
    padding: 0 0.15rem;
    color: inherit;
    opacity: 0.7;
    transition: opacity 150ms;
  }
  .gear-btn:hover { opacity: 1; }

  /* Panel */
  .device-panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 200;
    width: 196px;
    background: var(--color-surface, #fff);
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 4px 16px rgba(0,0,0,0.12);
    padding: 0.625rem;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .panel-title {
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--color-text, #1a1a1a);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .close-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.75rem;
    color: var(--color-text-muted, #64748b);
    line-height: 1;
    padding: 0.1rem 0.2rem;
  }
  .close-btn:hover { color: var(--color-text, #1a1a1a); }

  .panel-body {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .panel-label {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--color-text-muted, #64748b);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-top: 0.25rem;
  }

  .panel-select,
  .panel-input {
    width: 100%;
    font-size: 0.8125rem;
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: var(--radius-sm, 4px);
    background: var(--color-bg, #f8fafc);
    color: var(--color-text, #1a1a1a);
    font-family: inherit;
    box-sizing: border-box;
  }

  .panel-select:focus,
  .panel-input:focus {
    outline: 2px solid var(--color-primary, #3b82f6);
    outline-offset: 1px;
  }

  .panel-loading {
    font-size: 0.75rem;
    color: var(--color-text-muted, #64748b);
    text-align: center;
    padding: 0.5rem 0;
  }

  .panel-error {
    font-size: 0.6875rem;
    color: var(--color-danger, #ef4444);
    margin: 0.25rem 0 0;
  }

  .panel-success {
    font-size: 0.6875rem;
    color: var(--color-success, #22c55e);
    font-weight: 600;
    margin: 0.25rem 0 0;
  }

  .panel-actions {
    display: flex;
    gap: 0.35rem;
    margin-top: 0.5rem;
  }

  .btn-connect {
    flex: 1;
    padding: 0.35rem 0;
    font-size: 0.8125rem;
    font-weight: 600;
    background: var(--color-primary, #3b82f6);
    color: #fff;
    border: none;
    border-radius: var(--radius-sm, 4px);
    cursor: pointer;
    font-family: inherit;
    transition: background 150ms;
  }
  .btn-connect:hover:not(:disabled) { background: var(--color-primary-dark, #2563eb); }
  .btn-connect:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-cancel {
    flex: 1;
    padding: 0.35rem 0;
    font-size: 0.8125rem;
    background: var(--color-surface-2, #f1f5f9);
    color: var(--color-text, #1a1a1a);
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: var(--radius-sm, 4px);
    cursor: pointer;
    font-family: inherit;
  }
  .btn-cancel:hover { background: var(--color-border, #e2e8f0); }
</style>
