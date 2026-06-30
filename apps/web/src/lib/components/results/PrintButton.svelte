<script lang="ts">
  interface Props {
    slug: string;
    apiBase?: string;
    disabled?: boolean;
  }

  const { slug, apiBase = '/api', disabled = false }: Props = $props();

  function openPdf() {
    const url = `${apiBase}/v1/events/${encodeURIComponent(slug)}/results/pdf`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }
</script>

<button
  class="btn btn-ghost"
  onclick={openPdf}
  {disabled}
  title="Ergebnisliste als PDF drucken"
>
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    aria-hidden="true"
  >
    <polyline points="6 9 6 2 18 2 18 9" />
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    <rect x="6" y="14" width="12" height="8" />
  </svg>
  PDF drucken
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.875rem;
    border-radius: var(--radius-md, 6px);
    font-size: 0.875rem;
    font-weight: 600;
    font-family: inherit;
    border: 1px solid transparent;
    cursor: pointer;
    transition: all 150ms;
    white-space: nowrap;
  }

  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .btn-ghost {
    background: transparent;
    color: var(--color-text-muted);
    border-color: var(--color-border);
  }

  .btn-ghost:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-surface-2);
  }
</style>
