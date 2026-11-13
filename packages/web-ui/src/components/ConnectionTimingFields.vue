<script setup lang="ts">
import { computed } from "vue";
import { TCP_KEEPALIVE_DEFAULTS } from "@ts5250/base";
const props = defineProps<{
  enabled: boolean;
  options?: { initialDelayMs?: number | undefined; intervalMs?: number | undefined; count?: number | undefined } | undefined;
  hold?: number | "never" | undefined;
  showHold?: boolean;
}>();
const emit = defineEmits<{
  options: [value: { initialDelayMs?: number | undefined; intervalMs?: number | undefined; count?: number | undefined }];
  hold: [value: number | "never"];
}>();
const fields = [
  { key: "initialDelayMs", label: "確認開始まで（秒）", fallback: TCP_KEEPALIVE_DEFAULTS.initialDelayMs / 1000, scale: 1000, max: 32767 },
  { key: "intervalMs", label: "再試行間隔（秒）", fallback: TCP_KEEPALIVE_DEFAULTS.intervalMs / 1000, scale: 1000, max: 32767 },
  { key: "count", label: "応答なしの上限（回）", fallback: TCP_KEEPALIVE_DEFAULTS.count, scale: 1, max: 127 }
] as const;
/** 数値に変換しても、空欄や小数を妥当な既定値へ丸めない。親の保存検証で弾く。 */
function update(key: typeof fields[number]["key"], scale: number, event: Event): void {
  const text = (event.target as HTMLInputElement).value;
  emit("options", { ...props.options, [key]: text === "" ? NaN : Number(text) * scale });
}
const estimate = computed(() => ((props.options?.intervalMs ?? TCP_KEEPALIVE_DEFAULTS.intervalMs) * (props.options?.count ?? TCP_KEEPALIVE_DEFAULTS.count)) / 1000);
</script>

<template>
  <div class="connection-timing">
    <template v-if="enabled">
      <label v-for="field in fields" :key="field.key" class="timing-row">
        <span>{{ field.label }}</span>
        <input :data-setting="field.key" type="number" min="1" :max="field.max" step="1"
          :value="(options?.[field.key] ?? field.fallback * field.scale) / field.scale"
          @input="update(field.key, field.scale, $event)" />
      </label>
      <p>応答がない場合の待ち時間目安：{{ estimate }} 秒（確認開始後）</p>
    </template>
    <template v-if="showHold">
      <label class="timing-row">
        <span>ブラウザ切断後の接続保持</span>
        <select data-setting="connectionHoldMode" :value="hold === undefined || hold === 'never' ? 'never' : 'limited'"
          @change="emit('hold', ($event.target as HTMLSelectElement).value === 'never' ? 'never' : 10)">
          <option value="never">無期限</option><option value="limited">時間を指定</option>
        </select>
      </label>
      <label v-if="hold !== undefined && hold !== 'never'" class="timing-row">
        <span>保持時間（分）</span>
        <input data-setting="connectionHold" type="number" min="0" max="1440" step="1" :value="hold"
          @input="emit('hold', ($event.target as HTMLInputElement).value === '' ? NaN : Number(($event.target as HTMLInputElement).value))" />
      </label>
      <p>通信断・ハートビート消失の検出後から数えます。0 分は即時切断です。明示的な切断操作やタブを閉じた通知が届いた場合は保持しません</p>
    </template>
  </div>
</template>

<style scoped>
.connection-timing { display: grid; gap: 6px; min-width: 0; }
.timing-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(75px, 100px); gap: 8px; align-items: center; font-size: .76rem; }
input, select { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--line); border-radius: 5px; padding: 3px 6px; background: var(--paper); color: var(--ink); font: inherit; }
p { margin: 0; font-size: .7rem; color: var(--muted); }
</style>
