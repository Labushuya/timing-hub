<script lang="ts">
  import { goto } from '$app/navigation';
  import { api } from '$lib/api/client.js';
  import type { EventFormat, GLPConfig, SPConfig, RundstreckeConfig, OrientierungConfig } from '@timing-hub/shared-types';

  // ---- Step state -------------------------------------------------------------

  let currentStep = $state(1);
  const TOTAL_STEPS = 3;

  // ---- Step 1: Basisinfo -------------------------------------------------------

  let name = $state('');
  let description = $state('');
  let format = $state<EventFormat | ''>('');
  let startsAt = $state('');
  let endsAt = $state('');
  let timezone = $state(Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Europe/Berlin');

  // ---- Step 2: Format-Konfiguration -------------------------------------------

  // GLP
  let glpScoring = $state<'absolute_deviation' | 'percentage_deviation'>('absolute_deviation');
  let glpPenaltyPerSecond = $state(1);
  let glpMaxPenalty = $state<string>('');
  let glpAllowMultiple = $state(false);
  let glpCountBestOf = $state<string>('');
  let glpHideTargetTimes = $state(false);
  let glpRunCount = $state(1);
  let glpRunScoring = $state<'best' | 'sum' | 'best_n_of_m'>('best');
  let glpBestN = $state<string>('');

  // SP sectors
  interface Sector { code: string; name: string; weight: number }
  let spSectors = $state<Sector[]>([{ code: 'S1', name: 'Sektor 1', weight: 1 }]);
  let spDnfTime = $state<string>('');
  let spTiesBrokenBy = $state<'earliest_start' | 'seed_time'>('earliest_start');

  // Rundstrecke
  let rsLaps = $state<string>('');
  let rsDurationMin = $state<string>('');
  let rsStandingStart = $state(false);

  // Orientierung sections
  interface OSection { code: string; name: string; target_min: string }
  let orSections = $state<OSection[]>([{ code: 'S1', name: 'Sektion 1', target_min: '' }]);
  let orLatePenalty = $state(1);
  let orEarlyPenalty = $state(1);

  // ---- Step 3: Erster Posten --------------------------------------------------

  let postenName = $state('');
  let postenCode = $state('');
  let postenRole = $state<'start' | 'finish' | 'intermediate' | 'sector_split'>('start');

  // ---- Submission state -------------------------------------------------------

  let submitting = $state(false);
  let submitError = $state<string | null>(null);

  // ---- Validation -------------------------------------------------------------

  function step1Valid(): boolean {
    return name.trim().length >= 2 && format !== '' && startsAt !== '';
  }

  function step2Valid(): boolean {
    if (!format) return false;
    if (format === 'sonderpruefung') {
      return spSectors.length > 0 && spSectors.every(s => s.code.trim() && s.name.trim());
    }
    if (format === 'orientierung') {
      return orSections.length > 0 && orSections.every(s => s.code.trim() && s.name.trim());
    }
    return true;
  }

  function step3Valid(): boolean {
    return postenName.trim().length >= 1 && postenCode.trim().length >= 1;
  }

  // ---- Navigation -------------------------------------------------------------

  function nextStep() {
    if (currentStep === 1 && step1Valid()) currentStep = 2;
    else if (currentStep === 2 && step2Valid()) currentStep = 3;
  }

  function prevStep() {
    if (currentStep > 1) currentStep--;
  }

  // ---- Sector / Section helpers -----------------------------------------------

  function addSector() {
    const n = spSectors.length + 1;
    spSectors = [...spSectors, { code: `S${n}`, name: `Sektor ${n}`, weight: 1 }];
  }

  function removeSector(i: number) {
    spSectors = spSectors.filter((_, idx) => idx !== i);
  }

  function addSection() {
    const n = orSections.length + 1;
    orSections = [...orSections, { code: `S${n}`, name: `Sektion ${n}`, target_min: '' }];
  }

  function removeSection(i: number) {
    orSections = orSections.filter((_, idx) => idx !== i);
  }

  // ---- Build config -----------------------------------------------------------

  function buildConfig() {
    switch (format) {
      case 'glp': {
        const cfg: GLPConfig = {
          format: 'glp',
          scoring: glpScoring,
          penalty_per_second: glpPenaltyPerSecond,
          max_penalty: glpMaxPenalty ? Number(glpMaxPenalty) : null,
          allow_multiple_attempts: glpAllowMultiple,
          count_best_of: glpCountBestOf ? Number(glpCountBestOf) : null,
          hide_target_times: glpHideTargetTimes,
          run_count: glpRunCount,
          ...(glpRunCount > 1 ? { run_scoring: glpRunScoring } : {}),
          ...(glpRunCount > 1 && glpRunScoring === 'best_n_of_m' && glpBestN
            ? { run_best_n: Number(glpBestN) }
            : {}),
        };
        return cfg;
      }
      case 'sonderpruefung': {
        const cfg: SPConfig = {
          format: 'sonderpruefung',
          sectors: spSectors.map(s => ({ code: s.code, name: s.name, weight: s.weight })),
          dnf_time_ms: spDnfTime ? Number(spDnfTime) * 1000 : null,
          ties_broken_by: spTiesBrokenBy
        };
        return cfg;
      }
      case 'rundstrecke': {
        const cfg: RundstreckeConfig = {
          format: 'rundstrecke',
          total_laps: rsLaps ? Number(rsLaps) : null,
          duration_ms: rsDurationMin ? Number(rsDurationMin) * 60_000 : null,
          standing_start: rsStandingStart
        };
        return cfg;
      }
      case 'orientierung': {
        const cfg: OrientierungConfig = {
          format: 'orientierung',
          sections: orSections.map(s => ({
            code: s.code,
            name: s.name,
            target_ms: s.target_min ? Math.round(Number(s.target_min) * 60_000) : null
          })),
          late_penalty_per_second: orLatePenalty,
          early_penalty_per_second: orEarlyPenalty
        };
        return cfg;
      }
      default:
        return undefined;
    }
  }

  // ---- Submit -----------------------------------------------------------------

  async function submit() {
    if (!step3Valid() || submitting) return;
    submitting = true;
    submitError = null;

    try {
      const config = buildConfig();
      const { event } = await api.events.createEvent({
        name: name.trim(),
        format: format as EventFormat,
        starts_at: new Date(startsAt).toISOString(),
        timezone,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(endsAt ? { ends_at: new Date(endsAt).toISOString() } : {}),
        ...(config ? { config } : {})
      });

      await api.posten.createPosten(event.slug, {
        code: postenCode.trim().toUpperCase(),
        name: postenName.trim(),
        role: postenRole,
        sort_order: 1
      });

      await goto(`/events/${event.slug}/posten`);
    } catch (err) {
      submitError = err instanceof Error ? err.message : 'Fehler beim Erstellen der Veranstaltung';
    } finally {
      submitting = false;
    }
  }

  // ---- Format card data -------------------------------------------------------

  const formatOptions = [
    {
      value: 'glp' as EventFormat,
      label: 'GLP',
      fullLabel: 'Gleichmäßigkeitsprüfung',
      desc: 'Sollzeit-basierte Wertung mit Strafpunkten',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`
    },
    {
      value: 'sonderpruefung' as EventFormat,
      label: 'SP',
      fullLabel: 'Sonderprüfung',
      desc: 'Mehrere Sektoren, schnellste Zeit gewinnt',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`
    },
    {
      value: 'rundstrecke' as EventFormat,
      label: 'Rundstrecke',
      fullLabel: 'Rundstreckenrennen',
      desc: 'Runden- oder zeitbasiertes Rennen',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0"/><path d="M3 12h4l3 3 2-6 3 3h6"/></svg>`
    },
    {
      value: 'orientierung' as EventFormat,
      label: 'Orientierung',
      fullLabel: 'Orientierungsfahrt',
      desc: 'Mehrere Sektionen mit Sollzeiten',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`
    }
  ];

  const roleLabels: Record<string, string> = {
    start: 'Start',
    finish: 'Ziel',
    intermediate: 'Zwischenzeit',
    sector_split: 'Sektorwechsel'
  };

  const timezones = [
    'Europe/Berlin',
    'Europe/Vienna',
    'Europe/Zurich',
    'Europe/London',
    'UTC'
  ];
</script>

<svelte:head>
  <title>Neue Veranstaltung — Timing Hub</title>
</svelte:head>

<div class="wizard-page">
  <div class="wizard-container">
    <!-- Header -->
    <div class="wizard-header">
      <a href="/dashboard" class="back-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        Dashboard
      </a>
      <h1 class="wizard-title">Neue Veranstaltung</h1>
    </div>

    <!-- Progress bar -->
    <div class="progress-bar" role="progressbar" aria-valuenow={currentStep} aria-valuemin={1} aria-valuemax={TOTAL_STEPS}>
      {#each { length: TOTAL_STEPS } as _, i}
        <div class="progress-step" class:completed={i + 1 < currentStep} class:active={i + 1 === currentStep}>
          <div class="step-circle">
            {#if i + 1 < currentStep}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            {:else}
              {i + 1}
            {/if}
          </div>
          <span class="step-label">
            {#if i === 0}Basisinfo{:else if i === 1}Konfiguration{:else}Erster Posten{/if}
          </span>
        </div>
        {#if i < TOTAL_STEPS - 1}
          <div class="progress-line" class:filled={i + 1 < currentStep}></div>
        {/if}
      {/each}
    </div>

    <div class="step-counter">Schritt {currentStep}/{TOTAL_STEPS}</div>

    <!-- Step 1: Basisinfo -->
    {#if currentStep === 1}
      <div class="step-content">
        <h2 class="step-title">Basisinformationen</h2>

        <div class="form-group">
          <label class="form-label" for="name">Name der Veranstaltung *</label>
          <input
            id="name"
            type="text"
            class="form-input"
            bind:value={name}
            placeholder="z.B. ADAC GLP Frühjahr 2025"
            maxlength="120"
            required
          />
        </div>

        <div class="form-group">
          <label class="form-label" for="description">Beschreibung</label>
          <textarea
            id="description"
            class="form-textarea"
            bind:value={description}
            placeholder="Optionale Beschreibung..."
            rows={3}
          ></textarea>
        </div>

        <div class="form-group">
          <div class="form-label">Format *</div>
          <div class="format-grid">
            {#each formatOptions as opt}
              <button
                type="button"
                class="format-card"
                class:selected={format === opt.value}
                onclick={() => (format = opt.value)}
              >
                <div class="format-icon" aria-hidden="true">
                  {@html opt.icon}
                </div>
                <div class="format-info">
                  <div class="format-label">{opt.label}</div>
                  <div class="format-full">{opt.fullLabel}</div>
                  <div class="format-desc">{opt.desc}</div>
                </div>
                {#if format === opt.value}
                  <div class="format-check" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  </div>
                {/if}
              </button>
            {/each}
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="starts-at">Datum / Startzeit *</label>
            <input
              id="starts-at"
              type="datetime-local"
              class="form-input"
              bind:value={startsAt}
              required
            />
          </div>
          <div class="form-group">
            <label class="form-label" for="ends-at">Enddatum / -zeit</label>
            <input
              id="ends-at"
              type="datetime-local"
              class="form-input"
              bind:value={endsAt}
            />
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="timezone">Zeitzone</label>
          <select id="timezone" class="form-select" bind:value={timezone}>
            {#each timezones as tz}
              <option value={tz}>{tz}</option>
            {/each}
          </select>
        </div>

        <div class="step-actions">
          <a href="/dashboard" class="btn btn-ghost">Abbrechen</a>
          <button
            type="button"
            class="btn btn-primary"
            onclick={nextStep}
            disabled={!step1Valid()}
          >
            Weiter
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </div>
      </div>
    {/if}

    <!-- Step 2: Format-Konfiguration -->
    {#if currentStep === 2}
      <div class="step-content">
        <h2 class="step-title">
          Format-Konfiguration
          <span class="step-format-badge">{formatOptions.find(f => f.value === format)?.label}</span>
        </h2>

        <!-- GLP -->
        {#if format === 'glp'}
          <div class="form-group">
            <div class="form-label">Sollzeit-Modus</div>
            <div class="radio-group">
              <label class="radio-option">
                <input type="radio" bind:group={glpScoring} value="absolute_deviation" />
                <span class="radio-label">Abweichung (absolut, Sekunden)</span>
              </label>
              <label class="radio-option">
                <input type="radio" bind:group={glpScoring} value="percentage_deviation" />
                <span class="radio-label">Abweichung (prozentual)</span>
              </label>
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="glp-penalty">Strafpunkte pro Sekunde</label>
              <input
                id="glp-penalty"
                type="number"
                class="form-input"
                bind:value={glpPenaltyPerSecond}
                min="0"
                step="0.1"
              />
            </div>
            <div class="form-group">
              <label class="form-label" for="glp-max">Max. Strafe (leer = kein Limit)</label>
              <input
                id="glp-max"
                type="number"
                class="form-input"
                bind:value={glpMaxPenalty}
                min="0"
                placeholder="Kein Limit"
              />
            </div>
          </div>

          <div class="form-group">
            <label class="form-check">
              <input type="checkbox" bind:checked={glpAllowMultiple} />
              <span>Mehrfachversuche erlauben</span>
            </label>
          </div>

          {#if glpAllowMultiple}
            <div class="form-group">
              <label class="form-label" for="glp-best-of">Beste X von N werten (leer = alle)</label>
              <input
                id="glp-best-of"
                type="number"
                class="form-input"
                bind:value={glpCountBestOf}
                min="1"
                placeholder="Alle Versuche"
              />
            </div>
          {/if}

          <div class="form-group">
            <label class="form-check toggle-row">
              <input type="checkbox" bind:checked={glpHideTargetTimes} />
              <span>Sollzeiten verbergen</span>
            </label>
            <p class="form-hint">Teilnehmer sehen die Sollzeiten nicht — erhöht die Spannung (Fahren nach Gefühl)</p>
          </div>

          <div class="form-group">
            <label class="form-label" for="glp-run-count">Anzahl Läufe</label>
            <input
              id="glp-run-count"
              type="number"
              class="form-input"
              bind:value={glpRunCount}
              min="1"
              max="10"
            />
          </div>

          {#if glpRunCount > 1}
            <div class="form-group">
              <div class="form-label">Lauf-Auswertung</div>
              <div class="radio-group">
                <label class="radio-option">
                  <input type="radio" bind:group={glpRunScoring} value="best" />
                  <span class="radio-label">
                    Bester Lauf
                    <span class="radio-hint">Nur der Lauf mit den wenigsten Strafpunkten zählt</span>
                  </span>
                </label>
                <label class="radio-option">
                  <input type="radio" bind:group={glpRunScoring} value="sum" />
                  <span class="radio-label">
                    Summe aller Läufe
                    <span class="radio-hint">Strafpunkte aller Läufe werden addiert</span>
                  </span>
                </label>
                <label class="radio-option">
                  <input type="radio" bind:group={glpRunScoring} value="best_n_of_m" />
                  <span class="radio-label">
                    Beste N von M Läufen
                    <span class="radio-hint">Die besten N Läufe fließen in die Wertung ein</span>
                  </span>
                </label>
              </div>
            </div>

            {#if glpRunScoring === 'best_n_of_m'}
              <div class="form-group">
                <label class="form-label" for="glp-best-n">Anzahl gewerteter Läufe (N)</label>
                <input
                  id="glp-best-n"
                  type="number"
                  class="form-input"
                  bind:value={glpBestN}
                  min="1"
                  max={glpRunCount - 1}
                  placeholder="z.B. 2"
                />
                <p class="form-hint">Die besten {glpBestN || 'N'} von {glpRunCount} Läufen zählen</p>
              </div>
            {/if}
          {/if}
        {/if}

        <!-- SP -->
        {#if format === 'sonderpruefung'}
          <div class="form-group">
            <div class="form-label">Sektoren</div>
            <div class="sector-list">
              {#each spSectors as sector, i}
                <div class="sector-row">
                  <input
                    type="text"
                    class="form-input sector-code"
                    bind:value={sector.code}
                    placeholder="Code"
                    maxlength="8"
                  />
                  <input
                    type="text"
                    class="form-input sector-name"
                    bind:value={sector.name}
                    placeholder="Name"
                  />
                  <input
                    type="number"
                    class="form-input sector-weight"
                    bind:value={sector.weight}
                    min="1"
                    title="Gewichtung"
                  />
                  <button type="button" class="btn-icon-danger" onclick={() => removeSector(i)} aria-label="Sektor entfernen" disabled={spSectors.length <= 1}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
              {/each}
            </div>
            <button type="button" class="btn btn-ghost btn-sm" onclick={addSector}>
              + Sektor hinzufügen
            </button>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="sp-dnf">DNF-Zeit (Sekunden, leer = kein Limit)</label>
              <input
                id="sp-dnf"
                type="number"
                class="form-input"
                bind:value={spDnfTime}
                min="0"
                placeholder="Kein Limit"
              />
            </div>
            <div class="form-group">
              <label class="form-label" for="sp-ties">Gleichstand-Regelung</label>
              <select id="sp-ties" class="form-select" bind:value={spTiesBrokenBy}>
                <option value="earliest_start">Frühester Start</option>
                <option value="seed_time">Seed-Zeit</option>
              </select>
            </div>
          </div>
        {/if}

        <!-- Rundstrecke -->
        {#if format === 'rundstrecke'}
          <div class="config-hint">Entweder Rundenanzahl oder Zeitlimit festlegen (oder beides).</div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="rs-laps">Anzahl Runden</label>
              <input
                id="rs-laps"
                type="number"
                class="form-input"
                bind:value={rsLaps}
                min="1"
                placeholder="z.B. 10"
              />
            </div>
            <div class="form-group">
              <label class="form-label" for="rs-duration">Zeitlimit (Minuten)</label>
              <input
                id="rs-duration"
                type="number"
                class="form-input"
                bind:value={rsDurationMin}
                min="1"
                placeholder="z.B. 60"
              />
            </div>
          </div>
          <div class="form-group">
            <label class="form-check">
              <input type="checkbox" bind:checked={rsStandingStart} />
              <span>Standing Start</span>
            </label>
          </div>
        {/if}

        <!-- Orientierung -->
        {#if format === 'orientierung'}
          <div class="form-group">
            <div class="form-label">Sektionen mit Sollzeiten</div>
            <div class="sector-list">
              {#each orSections as section, i}
                <div class="sector-row">
                  <input
                    type="text"
                    class="form-input sector-code"
                    bind:value={section.code}
                    placeholder="Code"
                    maxlength="8"
                  />
                  <input
                    type="text"
                    class="form-input sector-name"
                    bind:value={section.name}
                    placeholder="Name"
                  />
                  <input
                    type="number"
                    class="form-input sector-weight"
                    bind:value={section.target_min}
                    min="0"
                    step="0.1"
                    placeholder="Sollzeit (Min)"
                    title="Sollzeit in Minuten"
                  />
                  <button type="button" class="btn-icon-danger" onclick={() => removeSection(i)} aria-label="Sektion entfernen" disabled={orSections.length <= 1}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
              {/each}
            </div>
            <button type="button" class="btn btn-ghost btn-sm" onclick={addSection}>
              + Sektion hinzufügen
            </button>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="or-late">Spät-Strafe (Punkte/Sek)</label>
              <input id="or-late" type="number" class="form-input" bind:value={orLatePenalty} min="0" step="0.1" />
            </div>
            <div class="form-group">
              <label class="form-label" for="or-early">Früh-Strafe (Punkte/Sek)</label>
              <input id="or-early" type="number" class="form-input" bind:value={orEarlyPenalty} min="0" step="0.1" />
            </div>
          </div>
        {/if}

        <div class="step-actions">
          <button type="button" class="btn btn-ghost" onclick={prevStep}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Zurück
          </button>
          <button
            type="button"
            class="btn btn-primary"
            onclick={nextStep}
            disabled={!step2Valid()}
          >
            Weiter
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </div>
      </div>
    {/if}

    <!-- Step 3: Erster Posten -->
    {#if currentStep === 3}
      <div class="step-content">
        <h2 class="step-title">Erster Posten anlegen</h2>
        <p class="step-subtitle">Ein erster Posten wird benötigt, damit die Zeitnahme beginnen kann.</p>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="p-name">Name *</label>
            <input
              id="p-name"
              type="text"
              class="form-input"
              bind:value={postenName}
              placeholder="z.B. Startlinie"
              required
            />
          </div>
          <div class="form-group">
            <label class="form-label" for="p-code">Code *</label>
            <input
              id="p-code"
              type="text"
              class="form-input code-input"
              bind:value={postenCode}
              placeholder="z.B. S1"
              maxlength="8"
              required
            />
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="p-role">Rolle</label>
          <div class="role-grid">
            {#each Object.entries(roleLabels) as [val, label]}
              <button
                type="button"
                class="role-btn"
                class:selected={postenRole === val}
                onclick={() => (postenRole = val as typeof postenRole)}
              >
                {label}
              </button>
            {/each}
          </div>
        </div>

        {#if submitError}
          <div class="error-box" role="alert">{submitError}</div>
        {/if}

        <div class="step-actions">
          <button type="button" class="btn btn-ghost" onclick={prevStep}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Zurück
          </button>
          <button
            type="button"
            class="btn btn-primary"
            onclick={submit}
            disabled={!step3Valid() || submitting}
          >
            {#if submitting}
              <span class="btn-spinner" aria-hidden="true"></span>
              Erstelle...
            {:else}
              Veranstaltung erstellen
            {/if}
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .wizard-page {
    min-height: 100%;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 2rem 1rem;
  }

  .wizard-container {
    width: 100%;
    max-width: 680px;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .wizard-header {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .back-link {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.875rem;
    color: var(--color-text-muted);
    text-decoration: none;
    transition: color 150ms;
  }
  .back-link:hover { color: var(--color-text); }

  .wizard-title {
    font-size: 1.5rem;
    font-weight: 800;
    margin: 0;
    letter-spacing: -0.03em;
  }

  /* Progress bar */
  .progress-bar {
    display: flex;
    align-items: center;
    gap: 0;
  }

  .progress-step {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
  }

  .step-circle {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 2px solid var(--color-border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--color-text-muted);
    background: var(--color-surface);
    transition: all 200ms;
  }

  .progress-step.active .step-circle {
    border-color: var(--color-primary);
    color: var(--color-primary);
    box-shadow: 0 0 0 3px rgba(var(--color-primary-rgb, 99,102,241), 0.2);
  }

  .progress-step.completed .step-circle {
    border-color: var(--color-success, #22c55e);
    background: var(--color-success, #22c55e);
    color: white;
  }

  .step-label {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .progress-step.active .step-label { color: var(--color-text); }

  .progress-line {
    flex: 1;
    height: 2px;
    background: var(--color-border);
    margin: 0 0.5rem;
    margin-bottom: 1.375rem;
    transition: background 200ms;
  }
  .progress-line.filled { background: var(--color-success, #22c55e); }

  .step-counter {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    font-weight: 500;
  }

  /* Step content */
  .step-content {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: 2rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .step-title {
    font-size: 1.125rem;
    font-weight: 700;
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }

  .step-format-badge {
    font-size: 0.6875rem;
    font-weight: 700;
    padding: 0.2rem 0.6rem;
    border-radius: 9999px;
    background: var(--color-surface-2);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .step-subtitle {
    margin: -0.5rem 0 0;
    color: var(--color-text-muted);
    font-size: 0.9375rem;
  }

  /* Form elements */
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .form-label {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-text-subtle, var(--color-text-muted));
  }

  .form-input,
  .form-select,
  .form-textarea {
    background: var(--color-surface-2, var(--color-bg));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0.625rem 0.875rem;
    font-size: 0.9375rem;
    color: var(--color-text);
    transition: border-color 150ms, box-shadow 150ms;
    font-family: inherit;
    width: 100%;
    box-sizing: border-box;
  }

  .form-input:focus,
  .form-select:focus,
  .form-textarea:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(var(--color-primary-rgb, 99,102,241), 0.25);
  }

  .form-textarea { resize: vertical; min-height: 80px; }

  .form-select { cursor: pointer; }

  .form-check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9375rem;
    cursor: pointer;
  }

  .toggle-row { font-weight: 600; }

  .form-hint {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin: 0.25rem 0 0;
    line-height: 1.5;
  }

  .radio-hint {
    display: block;
    font-size: 0.75rem;
    color: var(--color-text-muted);
    font-weight: 400;
    margin-top: 0.15rem;
  }

  /* Format cards */
  .format-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .format-card {
    display: flex;
    align-items: flex-start;
    gap: 0.875rem;
    padding: 1rem;
    background: var(--color-surface-2, var(--color-bg));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-align: left;
    transition: border-color 150ms, box-shadow 150ms;
    position: relative;
    color: var(--color-text);
    font-family: inherit;
  }

  .format-card:hover {
    border-color: var(--color-primary);
  }

  .format-card.selected {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 1px var(--color-primary), inset 0 0 0 9999px rgba(var(--color-primary-rgb, 99,102,241), 0.06);
  }

  .format-icon {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    color: var(--color-primary);
    opacity: 0.8;
  }

  .format-icon :global(svg) {
    width: 100%;
    height: 100%;
  }

  .format-info { flex: 1; min-width: 0; }

  .format-label {
    font-size: 0.9375rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .format-full {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    margin-top: 0.1rem;
  }

  .format-desc {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    margin-top: 0.25rem;
    line-height: 1.4;
  }

  .format-check {
    position: absolute;
    top: 0.625rem;
    right: 0.625rem;
    width: 20px;
    height: 20px;
    background: var(--color-primary);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
  }

  /* Sector rows */
  .sector-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .sector-row {
    display: grid;
    grid-template-columns: 80px 1fr 70px 36px;
    gap: 0.5rem;
    align-items: center;
  }

  .sector-code { font-family: var(--font-mono, monospace); }

  .btn-icon-danger {
    width: 32px;
    height: 32px;
    min-width: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    cursor: pointer;
    transition: color 150ms, border-color 150ms, background 150ms;
  }
  .btn-icon-danger:hover:not(:disabled) {
    color: var(--color-danger, #ef4444);
    background: rgba(239,68,68,0.1);
    border-color: rgba(239,68,68,0.3);
  }
  .btn-icon-danger:disabled { opacity: 0.3; cursor: not-allowed; }

  .config-hint {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    background: var(--color-surface-2, var(--color-bg));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 0.625rem 0.875rem;
  }

  /* Role grid */
  .role-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.5rem;
  }

  .role-btn {
    padding: 0.625rem 1rem;
    background: var(--color-surface-2, var(--color-bg));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-text-muted);
    cursor: pointer;
    transition: all 150ms;
    font-family: inherit;
  }

  .role-btn:hover { border-color: var(--color-primary); color: var(--color-text); }

  .role-btn.selected {
    border-color: var(--color-primary);
    background: rgba(var(--color-primary-rgb, 99,102,241), 0.1);
    color: var(--color-primary);
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.625rem 1.25rem;
    border-radius: var(--radius-md);
    font-size: 0.9375rem;
    font-weight: 600;
    border: none;
    cursor: pointer;
    transition: all 150ms;
    font-family: inherit;
    text-decoration: none;
  }

  .btn-primary {
    background: var(--color-primary);
    color: white;
  }
  .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-ghost {
    background: transparent;
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
  }
  .btn-ghost:hover { color: var(--color-text); background: var(--color-surface-2); }

  .btn-sm { padding: 0.375rem 0.875rem; font-size: 0.875rem; }

  .step-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 0.5rem;
    border-top: 1px solid var(--color-border);
    margin-top: 0.5rem;
  }

  .btn-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255,255,255,0.4);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .code-input { font-family: var(--font-mono, monospace); text-transform: uppercase; }

  .error-box {
    padding: 0.75rem 1rem;
    background: rgba(239,68,68,0.1);
    border: 1px solid rgba(239,68,68,0.3);
    border-radius: var(--radius-md);
    color: var(--color-danger, #ef4444);
    font-size: 0.9375rem;
  }

  .radio-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .radio-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.9375rem;
  }

  @media (max-width: 560px) {
    .format-grid { grid-template-columns: 1fr; }
    .form-row { grid-template-columns: 1fr; }
    .role-grid { grid-template-columns: repeat(2, 1fr); }
    .step-content { padding: 1.25rem; }
  }
</style>
