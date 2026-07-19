<script setup lang="ts">
/** 読み込み中の表示。0.5 秒を超えたときだけ出す想定（useDelayedLoading と組で使う） */
defineProps<{ label?: string }>();
</script>

<template>
  <div class="loading" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    <span>{{ label ?? "読み込み中…" }}</span>
  </div>
</template>

<style scoped>
.loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 8px;
  color: var(--muted);
  font-size: 0.82rem;
}
.spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 2.5s;
  }
}
</style>
