<script lang="ts">
  import type { Participant } from '@timing-hub/shared-types';
  import type { CreateParticipantPayload } from '$lib/api/client.js';

  interface Props {
    participant?: Participant | null;
    existingStartnummern?: string[];
    isGlp?: boolean;
    saving?: boolean;
    error?: string | null;
    onSave: (payload: CreateParticipantPayload) => void;
    onCancel: () => void;
  }

  let {
    participant = null,
    existingStartnummern = [],
    isGlp = false,
    saving = false,
    error = null,
    onSave,
    onCancel
  }: Props = $props();

  // ---- Field state ------------------------------------------------------------

  let startnummer = $state(participant?.startnummer ?? '');
  let driverName = $state(participant?.driver_name ?? '');
  let coDriverName = $state(participant?.co_driver_name ?? '');
  let carMake = $state(participant?.car_make ?? '');
  let carModel = $state(participant?.car_model ?? '');
  let carYear = $state<string>(participant?.car_year ? String(participant.car_year) : '');
  let carClass = $state(participant?.class ?? '');
  let targetTimeRaw = $state(participant?.target_time_ms ? msToTimeString(participant.target_time_ms) : '');

  // ---- Validation -------------------------------------------------------------

  let touched = $state(false);

  const startnummerError = $derived.by(() => {
    if (!touched && !startnummer) return null;
    if (!startnummer.trim()) return 'Startnummer ist erforderlich';
    return null;
  });

  const startnummerWarning = $derived.by(() => {
    if (!startnummer.trim()) return null;
    const isDupe = existingStartnummern
      .filter((s) => s !== participant?.startnummer)
      .includes(startnummer.trim());
    return isDupe ? 'Diese Startnummer ist bereits vergeben' : null;
  });

  const driverError = $derived.by(() => {
    if (!touched && !driverName) return null;
    if (!driverName.trim()) return 'Fahrername ist erforderlich';
    return null;
  });

  const targetTimeError = $derived.by(() => {
    if (!targetTimeRaw.trim()) return null;
    return parseTimeToMs(targetTimeRaw) === null
      ? 'Format: mm:ss.mmm (z.B. 01:23.456)'
      : null;
  });

  const carYearError = $derived.by(() => {
    if (!carYear.trim()) return null;
    const y = parseInt(carYear, 10);
    if (isNaN(y) || y < 1900 || y > 2030) return 'Baujahr zwischen 1900 und 2030';
    return null;
  });

  const isValid = $derived(
    !!startnummer.trim() &&
    !!driverName.trim() &&
    !targetTimeError &&
    !carYearError
  );

  // ---- Helpers ----------------------------------------------------------------

  function msToTimeString(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const millis = ms % 1000;
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  function parseTimeToMs(val: string): number | null {
    // Accept: mm:ss.mmm  or  m:ss.mmm  or  ss.mmm
    const full = /^(\d{1,2}):(\d{2})\.(\d{1,3})$/.exec(val.trim());
    if (full) {
      const min = parseInt(full[1]!, 10);
      const sec = parseInt(full[2]!, 10);
      const msPart = parseInt(full[3]!.padEnd(3, '0'), 10);
      if (sec >= 60) return null;
      return (min * 60 + sec) * 1000 + msPart;
    }
    const secOnly = /^(\d{1,2})\.(\d{1,3})$/.exec(val.trim());
    if (secOnly) {
      const sec = parseInt(secOnly[1]!, 10);
      const msPart = parseInt(secOnly[2]!.padEnd(3, '0'), 10);
      return sec * 1000 + msPart;
    }
    return null;
  }

  // ---- Submit -----------------------------------------------------------------

  function handleSubmit() {
    touched = true;
    if (!isValid) return;

    const targetMs = isGlp && targetTimeRaw.trim() ? (parseTimeToMs(targetTimeRaw) ?? undefined) : undefined;

    const payload: CreateParticipantPayload = {
      startnummer: startnummer.trim(),
      driver_name: driverName.trim(),
      ...(coDriverName.trim() ? { co_driver_name: coDriverName.trim() } : {}),
      ...(carMake.trim() ? { car_make: carMake.trim() } : {}),
      ...(carModel.trim() ? { car_model: carModel.trim() } : {}),
      ...(carYear.trim() ? { car_year: parseInt(carYear, 10) } : {}),
      ...(carClass.trim() ? { class: carClass.trim() } : {}),
      ...(targetMs != null ? { target_time_ms: targetMs } : {})
    };

    onSave(payload);
  }
</script>

<div class="participant-form" role="form" aria-label={participant ? 'Teilnehmer bearbeiten' : 'Neuen Teilnehmer hinzufügen'}>
  <div class="form-grid">
    <!-- Startnummer -->
    <div class="form-group form-group-sm">
      <label class="form-label" for="pf-startnummer">
        Startnr. <span class="required" aria-hidden="true">*</span>
      </label>
      <input
        id="pf-startnummer"
        type="text"
        class="form-input"
        class:input-error={!!startnummerError}
        class:input-warning={!startnummerError && !!startnummerWarning}
        bind:value={startnummer}
        placeholder="z.B. 42"
        maxlength="20"
        autocomplete="off"
        disabled={saving}
        onblur={() => (touched = true)}
      />
      {#if startnummerError}
        <span class="field-error" role="alert">{startnummerError}</span>
      {:else if startnummerWarning}
        <span class="field-warning">{startnummerWarning}</span>
      {/if}
    </div>

    <!-- Fahrer -->
    <div class="form-group form-group-lg">
      <label class="form-label" for="pf-driver">
        Fahrer <span class="required" aria-hidden="true">*</span>
      </label>
      <input
        id="pf-driver"
        type="text"
        class="form-input"
        class:input-error={!!driverError}
        bind:value={driverName}
        placeholder="Vor- und Nachname"
        maxlength="120"
        disabled={saving}
        onblur={() => (touched = true)}
      />
      {#if driverError}
        <span class="field-error" role="alert">{driverError}</span>
      {/if}
    </div>

    <!-- Beifahrer -->
    <div class="form-group form-group-lg">
      <label class="form-label" for="pf-codriver">Beifahrer</label>
      <input
        id="pf-codriver"
        type="text"
        class="form-input"
        bind:value={coDriverName}
        placeholder="Optional"
        maxlength="120"
        disabled={saving}
      />
    </div>

    <!-- Marke -->
    <div class="form-group">
      <label class="form-label" for="pf-make">Marke</label>
      <input
        id="pf-make"
        type="text"
        class="form-input"
        bind:value={carMake}
        placeholder="z.B. BMW"
        maxlength="80"
        disabled={saving}
      />
    </div>

    <!-- Modell -->
    <div class="form-group">
      <label class="form-label" for="pf-model">Modell</label>
      <input
        id="pf-model"
        type="text"
        class="form-input"
        bind:value={carModel}
        placeholder="z.B. M3"
        maxlength="80"
        disabled={saving}
      />
    </div>

    <!-- Baujahr -->
    <div class="form-group form-group-xs">
      <label class="form-label" for="pf-year">Baujahr</label>
      <input
        id="pf-year"
        type="number"
        class="form-input"
        class:input-error={!!carYearError}
        bind:value={carYear}
        placeholder="2023"
        min="1900"
        max="2030"
        disabled={saving}
      />
      {#if carYearError}
        <span class="field-error" role="alert">{carYearError}</span>
      {/if}
    </div>

    <!-- Klasse -->
    <div class="form-group">
      <label class="form-label" for="pf-class">Klasse</label>
      <input
        id="pf-class"
        type="text"
        class="form-input"
        bind:value={carClass}
        placeholder="z.B. Gruppe H"
        maxlength="60"
        disabled={saving}
      />
    </div>

    <!-- Sollzeit (GLP only) -->
    {#if isGlp}
      <div class="form-group">
        <label class="form-label" for="pf-target">
          Sollzeit
          <span class="form-hint">(mm:ss.mmm)</span>
        </label>
        <input
          id="pf-target"
          type="text"
          class="form-input font-mono"
          class:input-error={!!targetTimeError}
          bind:value={targetTimeRaw}
          placeholder="01:23.456"
          maxlength="10"
          disabled={saving}
        />
        {#if targetTimeError}
          <span class="field-error" role="alert">{targetTimeError}</span>
        {/if}
      </div>
    {/if}
  </div>

  {#if error}
    <div class="form-error" role="alert">{error}</div>
  {/if}

  <div class="form-actions">
    <button
      type="button"
      class="btn btn-ghost btn-sm"
      onclick={onCancel}
      disabled={saving}
    >
      Abbrechen
    </button>
    <button
      type="button"
      class="btn btn-primary btn-sm"
      onclick={handleSubmit}
      disabled={saving || !isValid}
    >
      {#if saving}
        <span class="btn-spinner" aria-hidden="true"></span>
      {/if}
      {participant ? 'Speichern' : 'Hinzufügen'}
    </button>
  </div>
</div>

<style>
  .participant-form {
    padding: 1rem 0;
  }

  .form-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1rem;
    align-items: flex-start;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    min-width: 140px;
    flex: 1 1 160px;
  }

  .form-group-xs {
    flex: 0 1 90px;
    min-width: 80px;
  }

  .form-group-sm {
    flex: 0 1 110px;
    min-width: 90px;
  }

  .form-group-lg {
    flex: 2 1 220px;
    min-width: 160px;
  }

  .form-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .form-hint {
    font-weight: 400;
    font-size: 0.75rem;
    color: var(--color-text-muted);
    opacity: 0.75;
  }

  .required {
    color: var(--color-danger, #ef4444);
  }

  .form-input {
    background: var(--color-surface-2, var(--color-bg));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0.4rem 0.65rem;
    font-size: 0.9rem;
    color: var(--color-text);
    font-family: inherit;
    width: 100%;
    box-sizing: border-box;
    transition: border-color 150ms, box-shadow 150ms;
    min-height: 34px;
  }

  .form-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(var(--color-primary-rgb, 99,102,241), 0.2);
  }

  .form-input.input-error {
    border-color: var(--color-danger, #ef4444);
  }

  .form-input.input-warning {
    border-color: #f59e0b;
  }

  .form-input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .font-mono {
    font-family: var(--font-mono, monospace);
    letter-spacing: 0.03em;
  }

  .field-error {
    font-size: 0.75rem;
    color: var(--color-danger, #ef4444);
    line-height: 1.3;
  }

  .field-warning {
    font-size: 0.75rem;
    color: #f59e0b;
    line-height: 1.3;
  }

  .form-error {
    margin-top: 0.75rem;
    padding: 0.625rem 0.875rem;
    background: rgba(239, 68, 68, 0.08);
    border: 1px solid rgba(239, 68, 68, 0.25);
    border-radius: var(--radius-md);
    font-size: 0.875rem;
    color: var(--color-danger, #ef4444);
  }

  .form-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
    padding-top: 0.875rem;
    border-top: 1px solid var(--color-border);
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    border-radius: var(--radius-md);
    font-size: 0.9375rem;
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
  .btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }

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
