<script setup lang="ts">
/** ラベル/値の行を表示する汎用ポップオーバー。バックドロップ or 呼び出し側のトグルで閉じる。 */
defineProps<{ rows: { label: string; value: string }[] }>();
const emit = defineEmits<{ (e: "close"): void }>();
</script>

<template>
  <!-- バックドロップ: 外側クリックで閉じる（本体は click.stop で伝播させない） -->
  <div class="backdrop" @click="emit('close')" @mousedown.stop></div>
  <div class="popover" @click.stop @mousedown.stop>
    <div class="row" v-for="(r, i) in rows" :key="i">
      <span>{{ r.label }}</span><b>{{ r.value }}</b>
    </div>
    <slot />
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  background: transparent;
}
.popover {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 31;
  min-width: 240px;
  max-width: 340px;
  background: var(--crt-bezel, #1a1f1a);
  border: 1px solid var(--crt-line, #333);
  border-radius: 8px;
  padding: 8px;
  box-shadow: 0 10px 30px -12px rgba(0, 0, 0, 0.5);
  text-align: left;
}
.row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 6px;
  font-family: var(--mono);
  font-size: 11.5px;
}
.row > span:first-child {
  width: 7.5em;
  flex: none;
  white-space: nowrap;
  color: var(--muted);
}
.row b {
  color: var(--t-green);
  word-break: break-all;
}
</style>
