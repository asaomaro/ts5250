<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { viewSettings, VIEW_ITEMS, type ViewSettings, type ViewItemDef } from "../stores/viewSettings.js";
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

/**
 * メニューの表示単位。`group` を持つ項目は**1 行にまとめ**、開いたときに
 * セクションで区切って並べる（例: ウィンドウ設定＝ウィンドウ／背景）。
 * 設定自体は項目ごとに独立している（キー設定の順送りも項目ごと）。
 */
interface MenuRow {
  /** 開閉・パレットの識別に使う（グループなら group 名、単独なら項目の key） */
  id: string;
  label: string;
  /** この行に属する設定項目（単独なら 1 つ、グループならその全部） */
  items: ViewItemDef[];
  expandable: boolean;
  wide: boolean;
}
const MENU_ROWS = computed<MenuRow[]>(() => {
  const out: MenuRow[] = [];
  const seen = new Set<string>();
  for (const it of ROWS) {
    if (it.group) {
      if (seen.has(it.group)) continue;
      seen.add(it.group);
      const items = ROWS.filter((x) => x.group === it.group);
      out.push({ id: it.group, label: it.groupLabel ?? it.label, items, expandable: true, wide: false });
    } else {
      out.push({ id: String(it.key), label: it.label, items: [it], expandable: !!it.expandable, wide: !!it.wide });
    }
  }
  return out;
});

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

// ---- デザイン候補パレット（spec D7/D9）----
// 選択肢が多い項目（入力項目設定・ボタン設定）は**畳んだ行**にする。既定では候補を出さず、
// ラベルの右の「開く」で展開する。同時に開くのは 1 行だけ（開いている行の key を持つ）。
const palette = ref<string | null>(null);
function isExpanded(id: string): boolean {
  return palette.value === id;
}
function togglePalette(id: string): void {
  palette.value = palette.value === id ? null : id;
}
/**
 * 候補から選ぶ。**設定メニューもパレットも開いたままにする**——見比べながら
 * 続けて別の候補を試せるようにするため（閉じると毎回開き直しになる）。
 */
function pickFromPalette(key: Key, value: ViewSettings[Key]): void {
  viewSettings.set(key, value as never);
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
// メニューを閉じたらパレットも畳む。畳まないと**次に開いたとき勝手に展開された状態**で出る
// （review R2）。開き直しは「素の状態から」が期待される。
watch(open, (v) => {
  if (!v) palette.value = null;
});

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
      <template v-for="r in MENU_ROWS" :key="r.id">
        <!-- 畳んだ行: ラベルの右に「開く / 閉じる」。既定では候補を出さない -->
        <div v-if="r.expandable" class="vsm-row">
          <span class="vsm-label">{{ r.label }}</span>
          <button
            class="vsm-toggle"
            :class="{ on: isExpanded(r.id) }"
            :aria-expanded="isExpanded(r.id)"
            @click="togglePalette(r.id)"
          >
            {{ isExpanded(r.id) ? "閉じる" : "開く" }}
          </button>
        </div>
        <div v-else class="vsm-row" :class="{ wide: r.wide }">
          <span class="vsm-label">{{ r.label }}</span>
          <div class="seg" role="group" :aria-label="r.label">
            <button
              v-for="o in r.items[0]!.opts"
              :key="String(o.value)"
              :class="{ on: isSel(r.items[0]!.key, o.value) }"
              @click="setVal(r.items[0]!.key, o.value)"
            >
              {{ o.label }}
            </button>
          </div>
        </div>
        <!-- デザイン候補（現在値に印）。選んでも閉じない。
             複数の設定を持つ行（ウィンドウ設定）はセクションで区切る -->
        <template v-if="isExpanded(r.id)">
          <template v-for="it in r.items" :key="String(it.key)">
            <div v-if="r.items.length > 1" class="vsm-section">{{ it.label }}</div>
            <div class="vsm-palette" role="listbox" :aria-label="`${it.label}のデザイン`">
              <button
                v-for="o in it.opts"
                :key="String(o.value)"
                class="pal-item"
                role="option"
                :aria-selected="isSel(it.key, o.value)"
                :class="{ on: isSel(it.key, o.value) }"
                @click="pickFromPalette(it.key, o.value)"
              >
                <span class="pal-prev" :data-kind="it.key" :data-style="String(o.value)">Ab</span>
                <span class="pal-name">{{ o.label }}</span>
              </button>
            </div>
          </template>
        </template>
      </template>

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
/* 畳んだ行の「開く / 閉じる」。セグメントと高さを揃える */
.vsm-toggle {
  font-family: var(--sans);
  font-size: 10.5px;
  font-weight: 500;
  color: var(--muted);
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 10px;
  cursor: pointer;
}
.vsm-toggle:hover {
  color: var(--ink);
  border-color: var(--line);
}
.vsm-toggle.on {
  color: var(--accent);
  border-color: var(--accent);
}
/* 1 行に複数の設定を持つとき（ウィンドウ設定）の区切り見出し */
.vsm-section {
  font-size: 10px;
  color: var(--muted);
  padding: 4px 6px 0;
}
/* デザイン候補パレット（spec D9）。各候補にその意匠を当てた見本を出す。 */
.vsm-palette {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  padding: 2px 4px 6px;
}
.pal-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-family: var(--sans);
  font-size: 9.5px;
  color: var(--muted);
  background: none;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 5px 2px;
  cursor: pointer;
}
.pal-item:hover {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  border-color: transparent;
  color: var(--ink);
}
.pal-item.on {
  border-color: var(--accent);
  color: var(--accent);
}
/* 見本。実際の画面と同じ「文字は動かさず box-shadow などで見せる」流儀で描く。 */
.pal-prev {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 18px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink);
}
/* 入力項目の見本 */
.pal-prev[data-kind="controls"][data-style="underline"] { box-shadow: inset 0 -1.5px 0 var(--accent); }
.pal-prev[data-kind="controls"][data-style="filled"] { background: color-mix(in srgb, var(--ink) 10%, transparent); border-radius: 4px; }
.pal-prev[data-kind="controls"][data-style="box"] { box-shadow: inset 0 0 0 1px var(--line); border-radius: 4px; }
.pal-prev[data-kind="controls"][data-style="boxRound"] { box-shadow: inset 0 0 0 1px var(--line); border-radius: 999px; }
.pal-prev[data-kind="controls"][data-style="inset"] { background: color-mix(in srgb, var(--ink) 7%, transparent); box-shadow: inset 0 2px 3px -1px color-mix(in srgb, #000 35%, transparent); border-radius: 3px; }
.pal-prev[data-kind="controls"][data-style="dashed"] { outline: 1px dashed var(--muted); outline-offset: -1px; }
.pal-prev[data-kind="controls"][data-style="glow"] { box-shadow: 0 0 0 2px var(--accent-soft), 0 0 8px -2px var(--accent); border-radius: 3px; }
/* ウィンドウ本体の見本 */
.pal-prev[data-kind="windowFrame"][data-style="none"] { color: var(--muted); text-decoration: line-through; }
.pal-prev[data-kind="windowFrame"][data-style="shadow"] { background: var(--card); box-shadow: 0 3px 8px -2px color-mix(in srgb, #000 55%, transparent); }
.pal-prev[data-kind="windowFrame"][data-style="raised"] { background: color-mix(in srgb, var(--ink) 8%, transparent); box-shadow: 0 4px 10px -3px color-mix(in srgb, #000 60%, transparent); border-radius: 3px; }
.pal-prev[data-kind="windowFrame"][data-style="outline"] { box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 2px var(--accent-soft); border-radius: 3px; }
/* 背景の見本（枠の内側が窓・外側が背景のつもりで描く） */
.pal-prev[data-kind="windowBackdrop"][data-style="none"] { color: var(--muted); text-decoration: line-through; }
.pal-prev[data-kind="windowBackdrop"][data-style="smoke"] { background: color-mix(in srgb, #000 45%, transparent); color: #fff; }
.pal-prev[data-kind="windowBackdrop"][data-style="frost"] { background: color-mix(in srgb, var(--card) 60%, transparent); box-shadow: inset 0 0 0 1px var(--line); filter: blur(0.2px); }
.pal-prev[data-kind="windowBackdrop"][data-style="blur"] { filter: blur(1.1px); }
/* ボタンの見本 */
.pal-prev[data-kind="buttons"][data-style="none"] { color: var(--muted); text-decoration: line-through; }
.pal-prev[data-kind="buttons"][data-style="underline"] { box-shadow: inset 0 -1.5px 0 var(--accent); }
.pal-prev[data-kind="buttons"][data-style="filled"] { background: color-mix(in srgb, var(--ink) 12%, transparent); border-radius: 4px; }
.pal-prev[data-kind="buttons"][data-style="box"] { box-shadow: inset 0 0 0 1px var(--line); border-radius: 3px; }
.pal-prev[data-kind="buttons"][data-style="pill"] { background: color-mix(in srgb, var(--ink) 12%, transparent); border-radius: 999px; }
.pal-prev[data-kind="buttons"][data-style="ghost"] { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--line) 60%, transparent); border-radius: 3px; }
.pal-prev[data-kind="buttons"][data-style="raised"] { background: color-mix(in srgb, var(--ink) 10%, transparent); box-shadow: 0 1px 2px color-mix(in srgb, #000 30%, transparent); border-radius: 3px; }
.pal-prev[data-kind="buttons"][data-style="link"] { color: var(--accent); box-shadow: inset 0 -1px 0 var(--accent); }

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
