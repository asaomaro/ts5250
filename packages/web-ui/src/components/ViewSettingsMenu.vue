<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { viewSettings, VIEW_ITEMS, type ViewSettings } from "../stores/viewSettings.js";
import { SCREEN_FONTS, detectInstalledFontIds } from "../composables/screenFonts.js";
import { openHeaderMenu, toggleHeaderMenu, closeHeaderMenu } from "../composables/headerMenu.js";

/**
 * 表示設定ポップオーバー。各項目はセグメント（またはセレクト）で、選んだ値は**保存され**
 * （localStorage）、全画面に適用・再読み込み後も維持される。
 */
defineProps<{ sessionId: string }>();

// ヘッダーのポップオーバーは同時に 1 つだけ（共有状態）。デザイン設定と排他になる。
const MENU_ID = "view";
const open = computed(() => openHeaderMenu.value === MENU_ID);
/** 現在の設定値（保存済み）。 */
const eff = computed(() => viewSettings.settings);

type Key = keyof ViewSettings;
// 項目定義（表示順・選択肢）は store の VIEW_ITEMS に集約（キー設定の順送りと共有）。
// フォントは選択肢が環境依存なのでここには含めず、下のセレクトで別途扱う。
const ROWS = VIEW_ITEMS;

// ---- 画面フォント（セレクト）----
// styles.css の全フォントを候補にし、**導入済みのものだけ選択可**にする（未導入は disabled）。
const fontInstalled = ref<Record<string, boolean>>({});
/** 導入判定を更新する。可能なら Local Font Access（版名非依存・正確）、無ければ canvas 実測。
 *  **メニューを開いた瞬間（クリック内）に呼ぶ**ことで Local Font Access の許可を得られる。 */
async function refreshFonts(): Promise<void> {
  const ids = await detectInstalledFontIds();
  const map: Record<string, boolean> = {};
  for (const f of SCREEN_FONTS) map[f.id] = ids.has(f.id);
  fontInstalled.value = map;
}
/** ⚙ 画面ボタン。開閉と同時に、開いたときはフォント判定を更新（クリック＝ユーザー操作）。 */
function onToggle(): void {
  toggleHeaderMenu(MENU_ID);
  if (open.value) void refreshFonts();
}
const fontValue = computed(() => eff.value.font);
function onFontChange(e: Event): void {
  viewSettings.set("font", (e.target as HTMLSelectElement).value as never);
}

/** その値がいまの設定値か。常にどれか 1 つが選択状態になる。 */
function isSel(key: Key, value: ViewSettings[Key]): boolean {
  return eff.value[key] === value;
}
function setVal(key: Key, value: ViewSettings[Key]): void {
  viewSettings.set(key, value as never);
}

function onDocClick(e: MouseEvent): void {
  if (!(e.target as HTMLElement).closest?.(".vsm")) closeHeaderMenu(MENU_ID);
}
function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") closeHeaderMenu(MENU_ID);
}
onMounted(() => {
  void refreshFonts(); // 初期表示（ユーザー操作外なので canvas 実測になる）
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div class="vsm">
    <button class="vsm-btn" :class="{ on: open }" title="画面設定（このセッション）" :aria-expanded="open" @click.stop="onToggle">
      ⚙ 画面
    </button>
    <div v-if="open" class="vsm-menu" role="menu">
      <div class="vsm-head">画面設定</div>
      <div v-for="r in ROWS" :key="r.key" class="vsm-row" :class="{ wide: r.wide }">
        <span class="vsm-label">{{ r.label }}</span>
        <div class="seg" role="group" :aria-label="r.label">
          <button
            v-for="o in r.opts"
            :key="String(o.value)"
            :class="{ on: isSel(r.key, o.value) }"
            @click="setVal(r.key, o.value)"
          >
            {{ o.label }}
          </button>
        </div>
      </div>

      <!-- フォント（画面グリッド）: styles.css の全フォントから、導入済みのみ選択可（未導入は無効）。 -->
      <div class="vsm-row wide">
        <span class="vsm-label">フォント（画面）</span>
        <select class="vsm-select" :value="fontValue" aria-label="画面フォント" @change="onFontChange">
          <option
            v-for="f in SCREEN_FONTS"
            :key="f.id"
            :value="f.id"
            :disabled="!fontInstalled[f.id]"
          >
            {{ f.label }}<template v-if="!fontInstalled[f.id]">（未導入）</template>
          </option>
        </select>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vsm {
  position: relative;
  display: inline-flex;
}
.vsm-btn {
  display: inline-flex;
  align-items: center;
  height: 28px;
  box-sizing: border-box;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1;
  padding: 0 12px;
  background: var(--card);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.vsm-btn:hover,
.vsm-btn.on {
  color: var(--accent);
  border-color: var(--accent);
}
.vsm-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 90;
  width: 250px;
  padding: 8px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 16px 44px -14px rgba(0, 0, 0, 0.45);
  font-family: var(--sans);
}
.vsm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
  padding: 2px 4px 8px;
}
.vsm-scope {
  font-size: 10px;
  font-weight: 400;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 1px 6px;
}
.vsm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 4px;
}
.vsm-label {
  font-size: 11.5px;
  color: var(--ink);
}
/* 選択肢が多い行（コントロール表現）: ラベルを上・セグメントを下段全幅に */
.vsm-row.wide {
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
}
.vsm-row.wide .seg {
  width: 100%;
}
.vsm-row.wide .seg button {
  flex: 1;
  text-align: center;
}
.seg {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}
.seg button {
  font-family: var(--sans);
  font-size: 10.5px;
  font-weight: 500;
  border: none;
  background: transparent;
  color: var(--muted);
  padding: 3px 7px;
  border-radius: 0;
  cursor: pointer;
}
.seg button:hover {
  color: var(--ink);
  border-color: transparent;
}
.seg button.on {
  background: var(--accent);
  color: var(--card);
}
/* 画面フォントのセレクト */
.vsm-select {
  width: 100%;
  box-sizing: border-box;
  font-family: var(--sans);
  font-size: 11px;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 5px 8px;
  cursor: pointer;
}
.vsm-select:hover {
  border-color: var(--accent);
}
.vsm-select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>
