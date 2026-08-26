<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { viewSettings, VIEW_ITEMS, type ViewSettings, type ViewItemDef } from "../stores/viewSettings.js";
import {
  listInstalledFonts,
  measureFontFit,
  fitsGrid,
  isLegacyId,
  sanitizeFamily,
  screenFontLabel,
  SYSTEM_FONT_ID,
  SYSTEM_FONT_LABEL,
  type InstalledFont
} from "../composables/screenFonts.js";
import { openHeaderMenu, toggleHeaderMenu, closeHeaderMenu } from "../composables/headerMenu.js";

/**
 * 表示設定ポップオーバー。各項目はセグメント（またはセレクト）で、選んだ値は**保存され**
 * （localStorage）、全画面に適用・再読み込み後も維持される。
 */
type Key = keyof ViewSettings;

const props = defineProps<{
  sessionId: string;
  /**
   * 出す項目を絞る（省略時は全部）。**ペインの種類ごとに中身が違う**ため
   * （`20260802-view-menu-refine`）——帳票を読む画面（プリンター・スプール）で
   * 5250 画面専用の項目を並べても効かない。並びは `VIEW_ITEMS` の順のまま。
   */
  keys?: readonly Key[] | undefined;
}>();

/**
 * **編集する層**（`20260802-appearance-and-view-cascade`）。
 *
 * `default`＝全体の既定（保存され、上書きしていないペインすべてに効く）／
 * `session`＝このセッションだけ。**既定の編集も同じメニューでできる**ようにするのが要点
 * ——別の場所を探させない。
 *
 * **初期は `全体の既定`。** これまで（全画面共通）と同じ使い勝手を保つため——
 * 開いて何か変えたら全画面に効く、が従来の挙動で、そこを黙って変えない。
 * 1 画面だけ変えたい人が `このセッション` へ切り替える、という opt-in にする。
 */
const layer = ref<"default" | "session">("default");

// ヘッダーのポップオーバーは同時に 1 つだけ（共有状態）。デザイン設定と排他になる。
const MENU_ID = "view";
const open = computed(() => openHeaderMenu.value === MENU_ID);
/** いま編集している層の値。`session` 層でも、上書きが無い項目は既定の値が見える */
const eff = computed(() =>
  layer.value === "default" ? viewSettings.settings : viewSettings.effective(props.sessionId)
);
/** 継承元（既定）の値。「既定に従う（CRT）」の併記に使う */
const defaults = computed(() => viewSettings.settings);
/** その項目をこのセッションで個別指定しているか（`default` 層では常に false） */
function overridden(key: Key): boolean {
  return layer.value === "session" && viewSettings.isOverridden(props.sessionId, key);
}
/**
 * その選択肢が**全体の既定**か（`このセッション` 層でだけ印を付ける）。
 *
 * 「既定に従う」という選択肢は**置かない**（利用者の指摘）。値の一覧に印を添えるだけにして、
 * 選択肢が 1 つ増えることによる横幅と読み取りの負担を無くす。
 */
function isDefault(key: Key, value: ViewSettings[Key]): boolean {
  return layer.value === "session" && defaults.value[key] === value;
}
/** このセッションに 1 つでも個別指定があるか（「すべて既定に戻す」を出す条件） */
const hasOverrides = computed(() => viewSettings.hasOverrides(props.sessionId));

// 項目定義（表示順・選択肢）は store の VIEW_ITEMS に集約（キー設定の順送りと共有）。
// フォントは選択肢が環境依存なのでここには含めず、下のセレクトで別途扱う。
const ROWS = computed(() => (props.keys ? VIEW_ITEMS.filter((i) => props.keys!.includes(i.key)) : VIEW_ITEMS));
/** フォントの欄を出すか（`keys` で絞られていれば含まれているときだけ） */
const showFont = computed(() => !props.keys || props.keys.includes("font"));

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
  for (const it of ROWS.value) {
    if (it.group) {
      if (seen.has(it.group)) continue;
      seen.add(it.group);
      const items = ROWS.value.filter((x) => x.group === it.group);
      out.push({ id: it.group, label: it.groupLabel ?? it.label, items, expandable: true, wide: false });
    } else {
      out.push({ id: String(it.key), label: it.label, items: [it], expandable: !!it.expandable, wide: !!it.wide });
    }
  }
  return out;
});

// ---- 画面フォント（セレクト）----
// **選択肢はインストール済みフォントそのもの。**「推奨」の固定一覧は廃止した（利用者の判断）。
// 一覧を出せないブラウザ（Local Font Access 非対応）のために、名前の直接入力を残す。
/** インストール済みフォント（Local Font Access が使えたときだけ。null＝列挙できない） */
const installed = ref<InstalledFont[] | null>(null);
/** 桁が揃うもの／ずれる可能性があるもの。ずれるほうも**選べる**（利用者の判断）。 */
const installedFit = computed(() => (installed.value ?? []).filter((f) => fitsGrid(f.fit)));
const installedOther = computed(() => (installed.value ?? []).filter((f) => !fitsGrid(f.fit)));

/** 一覧を取り直す。**メニューを開いた瞬間（クリック内）に呼ぶ**ことで
 *  Local Font Access の許可を得られる。 */
async function refreshFonts(): Promise<void> {
  installed.value = await listInstalledFonts();
}
/** ⚙ 画面ボタン。開閉と同時に、開いたときはフォント判定を更新（クリック＝ユーザー操作）。 */
function onToggle(): void {
  toggleHeaderMenu(MENU_ID);
  if (open.value) void refreshFonts();
}
const fontValue = computed(() => eff.value.font);
/**
 * 一覧のどれでもない値（名前を直接入力した／別環境で選んだ／旧「推奨」一覧の保存値）。
 * option を足さないと**選択状態が消えて「標準」に見えてしまう**ので、「指定中」として出す。
 */
const fontIsCustom = computed(
  () =>
    fontValue.value !== SYSTEM_FONT_ID &&
    !(installed.value ?? []).some((f) => f.family === fontValue.value)
);
/** 「指定中」の表示名。旧 id はラベル（`hackgen` ではなく「白源 HackGen」）で出す。 */
const fontCustomLabel = computed(() => screenFontLabel(fontValue.value));
/** いま選んでいるフォントで桁がずれないか。ずれるなら注意書きを出す（選択は妨げない）。 */
const fontMisfit = computed(() => {
  const v = fontValue.value;
  // 標準（既定スタック）と旧 id（版名を束ねたスタック）は 1:2 のものだけを並べてある
  if (v === SYSTEM_FONT_ID || isLegacyId(v)) return false;
  return !fitsGrid(measureFontFit(v));
});
function setFont(value: string): void {
  setVal("font", sanitizeFamily(value) as never);
}
function onFontChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  // 「標準」と旧 id は id として渡す（sanitize は名前指定のためのもの）
  if (v === SYSTEM_FONT_ID || isLegacyId(v)) setVal("font", v as never);
  else setFont(v);
}
/** 名前を直接入力（一覧に出ないフォント・Local Font Access 非対応ブラウザ向け）。 */
const fontName = ref("");
function onFontNameApply(): void {
  const v = sanitizeFamily(fontName.value);
  if (v) setFont(v);
  fontName.value = "";
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
  setVal(key, value);
}

/** その値がいまの設定値か。常にどれか 1 つが選択状態になる。 */
/** 選択状態は**実効値**（継承中なら既定の値が選ばれて見える） */
function isSel(key: Key, value: ViewSettings[Key]): boolean {
  return eff.value[key] === value;
}
/**
 * いま編集している層へ書く。
 *
 * **`このセッション` 層で既定と同じ値を選んだら、上書きを消して「追従」に戻す。**
 * これが無いと、一度個別指定したら二度と既定の変更に追従できなくなる
 * （`すべて既定に戻す` しか手が無くなる）。印はそのことの目印でもある。
 */
function setVal(key: Key, value: ViewSettings[Key]): void {
  if (layer.value === "default") {
    viewSettings.set(key, value as never);
    return;
  }
  if (defaults.value[key] === value) viewSettings.clearOverride(props.sessionId, key);
  else viewSettings.setOverride(props.sessionId, key, value as never);
}
/** このセッションの上書きを全部捨てる */
function resetAll(): void {
  viewSettings.clearAll(props.sessionId);
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
    <!--
      **名前は「表示」**（`20260802-appearance-and-view-cascade`・利用者の判断）。
      対象の広さを名前で示す——`外観`＝アプリ全体、`表示`＝そのペイン。
      後のスプールでも同じ名前のボタンを出す予定。
    -->
    <button class="vsm-btn" :class="{ on: open }" title="表示（このペインの見え方）" :aria-expanded="open" @click.stop="onToggle">
      ⚙ 表示
    </button>
    <div v-if="open" class="vsm-menu" role="menu">
      <div class="vsm-head">表示</div>
      <!--
        **編集する層。** 既定の編集も同じメニューでできるようにして、別の場所を探させない。
        `このセッション` 側は各項目の初期値が「既定に従う」。
      -->
      <div class="vsm-row">
        <span class="vsm-label">設定の対象</span>
        <div class="seg" role="group" aria-label="設定の対象">
          <button :class="{ on: layer === 'default' }" @click="layer = 'default'">全体の既定</button>
          <button :class="{ on: layer === 'session' }" @click="layer = 'session'">このセッション</button>
        </div>
      </div>
      <template v-for="r in MENU_ROWS" :key="r.id">
        <!-- 畳んだ行: ラベルの右に「開く / 閉じる」。既定では候補を出さない -->
        <div v-if="r.expandable" class="vsm-row">
          <span class="vsm-label">
            {{ r.label }}
            <span v-if="r.items.some((it) => overridden(it.key))" class="vsm-mark" title="このセッションで個別指定">●</span>
          </span>
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
          <span class="vsm-label">
            {{ r.label }}
            <!-- 個別指定の印。どれを自分で変えたかが一目で分かる -->
            <span v-if="overridden(r.items[0]!.key)" class="vsm-mark" title="このセッションで個別指定">●</span>
          </span>
          <div class="seg" role="group" :aria-label="r.label">
            <!--
              **選択肢は値だけ**（利用者の指摘）。どれが全体の既定かは小さな印で示し、
              その値を選べば追従に戻る（`setVal` の注記を参照）。
            -->
            <button
              v-for="o in r.items[0]!.opts"
              :key="String(o.value)"
              :class="{ on: isSel(r.items[0]!.key, o.value) }"
              :title="isDefault(r.items[0]!.key, o.value) ? '全体の既定（選ぶと既定に追従します）' : undefined"
              @click="setVal(r.items[0]!.key, o.value)"
            >
              {{ o.label }}<span v-if="isDefault(r.items[0]!.key, o.value)" class="vsm-def">·</span>
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
                :title="isDefault(it.key, o.value) ? '全体の既定（選ぶと既定に追従します）' : undefined"
                @click="pickFromPalette(it.key, o.value)"
              >
                <span class="pal-prev" :data-kind="it.key" :data-style="String(o.value)">Ab</span>
                <span class="pal-name">{{ o.label }}<span v-if="isDefault(it.key, o.value)" class="vsm-def">·</span></span>
              </button>
            </div>
          </template>
        </template>
      </template>

      <!-- フォント（画面グリッド）: インストール済みフォントから選ぶ（「推奨」の固定一覧は廃止）。
           桁が揃うものを先に出すが、ずれるものも選べる（注意書きを出すだけ） -->
      <div v-if="showFont" class="vsm-row wide">
        <span class="vsm-label">フォント（画面）</span>
        <select class="vsm-select" :value="fontValue" aria-label="画面フォント" @change="onFontChange">
          <option :value="SYSTEM_FONT_ID">{{ SYSTEM_FONT_LABEL }}</option>
          <optgroup v-if="installedFit.length" label="桁が揃うフォント">
            <option v-for="f in installedFit" :key="'i' + f.family" :value="f.family">{{ f.family }}</option>
          </optgroup>
          <optgroup v-if="installedOther.length" label="桁がずれるフォント">
            <option v-for="f in installedOther" :key="'o' + f.family" :value="f.family">{{ f.family }}</option>
          </optgroup>
          <!-- 一覧に無い値（名前指定・別環境で選んだ値・旧設定）。足さないと選択状態が消える -->
          <optgroup v-if="fontIsCustom" label="指定中">
            <option :value="fontValue">{{ fontCustomLabel }}</option>
          </optgroup>
        </select>
        <!-- 一覧を出せないブラウザ（Local Font Access 非対応）でも名前で指定できるようにする -->
        <div class="vsm-fontname">
          <input
            v-model="fontName"
            class="vsm-input"
            type="text"
            placeholder="フォント名を直接入力"
            aria-label="フォント名を直接入力"
            @keydown.enter.prevent="onFontNameApply"
          />
          <button class="vsm-toggle" :disabled="!fontName.trim()" @click="onFontNameApply">適用</button>
        </div>
        <p v-if="installed === null" class="vsm-note">
          このブラウザではインストール済みフォントを一覧できません。名前を直接入力してください。
        </p>
        <p v-if="fontMisfit" class="vsm-note warn">
          このフォントは半角:全角が 1:2 でないため、桁がずれて見えることがあります。
        </p>
      </div>
      <!-- 個別指定をまとめて解く口。1 つずつ「既定に従う」を押して回らせない -->
      <div v-if="layer === 'session' && hasOverrides" class="vsm-row">
        <button class="vsm-toggle" @click="resetAll">この画面の設定をすべて既定に戻す</button>
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
  /* キー・HTML（`.theme-btn`）と同じ高さ（利用者の指摘: 高い） */
  height: 22px;
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

/*
  画面に**重ねるポップオーバー**の見本（オプション欄の選択肢 / 日付・時刻ピッカー）。
  どちらも同じ意匠を着る（`.crt-pop`・styles.css）ので、見本も 1 組にまとめる——
  片方だけ直して食い違うのを防ぐ。**値は `.crt-pop` の実体と同じものを使う**
  （見本が本体と違う見た目を見せたら見本の意味が無い）。
*/
.pal-prev[data-kind="optHints"][data-style="none"],
.pal-prev[data-kind="dtPicker"][data-style="none"] {
  color: var(--muted);
  text-decoration: line-through;
}
/* パネル: 面＋枠＋影（素の状態） */
.pal-prev[data-kind="optHints"][data-style="panel"],
.pal-prev[data-kind="dtPicker"][data-style="panel"] {
  background: var(--card);
  box-shadow: inset 0 0 0 1px var(--line), 0 3px 7px -3px color-mix(in srgb, #000 55%, transparent);
  border-radius: 5px;
}
/* 枠: 面を持たず輪郭だけ（影も無い） */
.pal-prev[data-kind="optHints"][data-style="outline"],
.pal-prev[data-kind="dtPicker"][data-style="outline"] {
  background: var(--paper);
  box-shadow: inset 0 0 0 1px var(--accent);
  border-radius: 5px;
}
/* 端末調: CRT の緑に寄せる（本体は等幅の画面フォントに切り替わる） */
.pal-prev[data-kind="optHints"][data-style="crt"],
.pal-prev[data-kind="dtPicker"][data-style="crt"] {
  background: var(--crt-bezel);
  color: var(--t-green);
  box-shadow: inset 0 0 0 1px var(--crt-line);
  border-radius: 5px;
  font-family: var(--screen-mono);
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
/* 名前の直接入力（一覧を出せないブラウザ・一覧に無いフォント向け） */
.vsm-fontname {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}
.vsm-input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  font-family: var(--sans);
  font-size: 11px;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 5px 8px;
}
.vsm-input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.vsm-fontname .vsm-toggle:disabled {
  opacity: 0.5;
  cursor: default;
}
/* 補足・注意（選択は妨げず、見え方の断りだけ出す） */
.vsm-note {
  margin: 4px 0 0;
  font-family: var(--sans);
  font-size: 10px;
  line-height: 1.4;
  color: var(--muted);
}
.vsm-note.warn {
  color: var(--t-red);
}

/* 個別指定の印。項目名の右に小さく置く */
.vsm-mark {
  margin-left: 4px;
  font-size: 9px;
  color: var(--accent);
  vertical-align: middle;
}
/* 全体の既定を示す小さな印。値の右にそっと置く（選択肢を 1 つ増やさないための表現） */
.vsm-def {
  margin-left: 3px;
  color: var(--accent);
  font-weight: 700;
}
</style>
