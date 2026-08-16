<script setup lang="ts">
// **root ではなく browser 入口から**（root は node:net / node:tls を巻き込む）
import { fieldId } from "@ts5250/tn5250/browser";
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import type { ScreenSnapshot, Cell, Field, AidKey, GuiGridLine, GuiWindow } from "@ts5250/tn5250";
import {
  initEdit,
  editValue,
  typeChar,
  backspace,
  del,
  moveCursor,
  home,
  end,
  toggleInsert,
  eraseToEnd,
  fieldExit,
  fieldSign,
  dupFill,
  DUP_BYTE,
  type EditState
} from "../composables/fieldEdit.js";
import {
  acceptsChar,
  rejectReason,
  dbcsByteLength,
  dbcsViewLayout,
  columnViewLayout,
  isFullWidth,
  isCertainWideGlyph,
  type DbcsViewLayout,
  type RejectReason
} from "../composables/fieldValidate.js";
import { splitLinks, type LinkPart } from "../composables/linkify.js";
import {
  detectFkeyLegends,
  detectWindowRect,
  detectOptionHints,
  sameScreen,
  type FkeySpan,
  type WindowRect,
  type OptionSpan
} from "../composables/fkeyLegend.js";
import { GRID_COLOR } from "@ts5250/tn5250/browser";
import type { ButtonStyle, WindowFrame, WindowBackdrop, SbcsView, OptHintStyle } from "../stores/viewSettings.js";
import { MSG_PROTECTED, MSG_NO_ROOM, MSG_BY_REASON, MSG_OPT_HINTS, MSG_DUP_DISALLOWED } from "../composables/opMessages.js";
import { fitFont, GRID_PAD_X, GRID_PAD_Y, MIN_FONT_PX, MAX_FONT_PX } from "../composables/fitFont.js";
import { fieldAt, caretInField, roundToDbcsLead, wordRangeAt } from "../composables/useCursor.js";
import {
  fieldSlices,
  fieldSpan,
  posOfOffset,
  offsetOfPos,
  type FieldSlice
} from "../composables/fieldSlices.js";
// **表示コード切替は `@ts5250/ebcdic/katakana` から直接取る**（930/939 の SBCS 部のみ）。
// バレルや `…/codec` に向けると DBCS 部込みの変換表が持ち込まれる——実測で本番バンドルが
// 約 600 KB 膨らんでいた。実際に要るのは SBCS 部 256 要素ずつだけ。
// **2 つで対**: 切替とは「もう一方の表で読み直すこと」なので、両方要る。
import { katakanaChar, latinChar } from "@ts5250/ebcdic/katakana";
// browser サブパスからブラウザ安全に import（root は node 依存を巻き込むため不可）
import {
  isAttrSentinel,
  isRawSentinel,
  attrSentinelByte,
  attrSentinel,
  rawSentinel,
  stripSentinels,
  decodeAttribute
} from "@ts5250/tn5250/browser";

// linkify は既定 ON。Vue は未指定の Boolean prop を false にキャストするため withDefaults で true を明示する
const props = withDefaults(
  defineProps<{
    snapshot: ScreenSnapshot;
    edits: Map<number, string>;
    focused: boolean;
    /** SO を { ・SI を } で表示する（ACS の Ctrl+F 相当。既定は空白） */
    showShiftMarks?: boolean;
    /**
     * SBCS の実効表示コード（ACS の表示コード切替）。`host` はホストの表のまま＝再解釈しない。
     * `kana`/`latin` は生バイトを対の表で読み直す（親が CCSID と突き合わせて決める）。
     */
    sbcsView?: SbcsView;
    /** 画面テキストの URL/メールをリンク化する（既定 ON。表示コード再解釈中は無効） */
    linkify?: boolean;
    /** 通信中（ホスト応答待ち）。入力欄を編集不可にしてプロテクトする */
    busy?: boolean;
    /**
     * **操作員メッセージ**（`20260802-message-line`）。画面の**最下行に重ねて**出す。
     *
     * ここで描くのは、ACS が**画面の 1 行として**出しているから——外側に置くと
     * 字の大きさが画面と揃わず、画面の一部に見えない（`.grid` が font-size を持つので、
     * 中に置けば桁も高さも自動で揃う）。
     */
    message?: string;
    /** 有効カーソル（override ?? snapshot.cursor）。オーバーレイ位置・field/free 判定に使う */
    cursor?: { row: number; col: number };
    /** カタカナ系ホストコードページ（930/5026）。実機（ACS）同様、半角英小文字を入力時に大文字化する */
    uppercaseInput?: boolean;
    /** 「押せるもの」の見せ方。none は機能キー凡例をボタン化しない（spec D5） */
    buttons?: ButtonStyle;
    /** ウィンドウそのもの（枠・面）の見せ方。none は枠を描かない */
    windowFrame?: WindowFrame;
    /** ウィンドウの背景（窓の外側）の見せ方。none は背景に何もしない */
    windowBackdrop?: WindowBackdrop;
    /** オプション欄の選択肢の見せ方（既定 none。推測を含む機能は勝手に有効化しない） */
    optHints?: OptHintStyle;
  }>(),
  {
    linkify: true, buttons: "none", windowFrame: "none", windowBackdrop: "none",
    optHints: "none", sbcsView: "host"
  }
);
const emit = defineEmits<{
  (e: "edit", fieldIndex: number, value: string): void;
  (e: "cursor", row: number, col: number): void;
  (e: "gui-select", fieldId: number, choiceIndex: number, selected: boolean): void;
  (e: "gui-submit", fieldId: number): void;
  /** 欄が最大桁まで埋まった（ACS の自動送り＝次の入力欄へ）。満杯になった欄の index を渡す
   *  （満杯時は sync が欄外へ論理カーソルを出し input が blur されるため、index で次欄を特定する） */
  (e: "field-full", fieldIndex: number): void;
  /** 矩形（ブロック）選択が解除された（親のキーボード選択アンカーもリセットさせる） */
  (e: "selection-cleared"): void;
  /** マウスドラッグで矩形（ブロック）選択が始まった。押下したセル＝始点を渡す。
   *  ACS は始点にカーソルを置くため親がカーソルを合わせる。"cursor" と分けているのは、
   *  こちらは reconcileFocus を通してはいけないから（入力欄へ再フォーカスすると選択が壊れる）。 */
  (e: "selection-start", row: number, col: number): void;
  /** クライアント側の操作員メッセージ（ACS の OIA 相当。ホストの systemMessage とは別物）。
   *  例: 挿入ペーストが入り切らないときの `MSG_NO_ROOM`。次のキー操作で消える。 */
  (e: "notice", text: string): void;
  /** 機能キー凡例のボタンが押された（親が sendKey する。spec B3） */
  (e: "aid", key: AidKey): void;
  /**
   * 欄の**先頭**で Backspace が押された。`field-full`（次の欄へ）と対になる。
   *
   * 実機は欄の先頭で Backspace を押すと**前の入力欄の末尾へカーソルを移す（削除はしない）**
   * ——GNU tn5250 `display.c` の `kf_backspace`。EDTMSK のように**ホストが 1 つの項目を
   * 複数の入力欄へ分解して送る**画面では、これが無いと欄をまたいで戻れない。
   */
  (e: "field-prev", fieldIndex: number): void;
}>();

const gui = computed(() => props.snapshot.gui);

/**
 * 入力 1 文字を格納する形へ直す。対象は半角 ASCII の a-z のみ（全角・カナ・記号には影響しない）。
 *
 * 大文字化する理由は**2 つあり、どちらか一方でも真なら大文字化する**。同じ結果でも根拠が別なので、
 * 片方を他方の代用にしてはいけない（片方を消すともう片方の画面が壊れる）。
 *
 * | 規則 | 理由 | 範囲 |
 * |---|---|---|
 * | `field.monocase`（FFW 0x0020） | **ホストがこの欄を大文字化しろと言っている** | その欄だけ |
 * | `uppercaseInput`（CCSID 930/5026） | **コードページに英小文字が無い**。大文字化しないと core の「マップ不能文字」検証で送信できなくなる | 全欄 |
 *
 * MONOCASE は実機では既定で立つ（DDS の文字欄は `CHECK(LC)` を書かない限り載る。SR-OSAKA で実測）。
 * 逆に `CHECK(LC)` 付きの欄では**小文字がそのまま残る**のが正しい。
 */
function inputChar(ch: string, field: Field): string {
  const upper = props.uppercaseInput || field.monocase === true;
  return upper && ch >= "a" && ch <= "z" ? ch.toUpperCase() : ch;
}

// 有効カーソル（未指定時は snapshot.cursor にフォールバック）
const effCursor = computed(() => props.cursor ?? props.snapshot.cursor);
// カーソルが編集可能フィールド上か（field モード）。true なら native キャレットが担うのでオーバーレイは隠す。
// 矩形選択中は入力欄を blur しているので native キャレットが居らず、位置が欄上でもオーバーレイに担わせる
// （さもないとカーソルが欄の中にある間キャレットが消える。ACS は始点にカーソルを残す）。
const cursorOnEditable = computed(() => {
  if (rectSel.value) return false;
  // **実際に入力欄へフォーカスがあるならそちらが担う**。
  // 画面遷移直後、ホストが報告するカーソルは (1,1) のまま入力欄に初期フォーカスが入ることがあり
  // （STRPDM など、コマンド入力欄へ飛ぶ画面）、位置だけで判定すると左上にセル選択が残る。
  if (inputFocused.value) return true;
  const f = fieldAt(effCursor.value.row, effCursor.value.col, props.snapshot.fields, props.snapshot.cols, props.snapshot.rows);
  return f !== undefined && !f.protected;
});

/**
 * この画面の入力欄がフォーカスを持っているか。
 * native キャレットとセル選択の二重表示を防ぐためだけに使う。
 */
const inputFocused = ref(false);
function onGridFocusIn(ev: FocusEvent): void {
  inputFocused.value = (ev.target as HTMLElement | null)?.classList.contains("grid-input") === true;
}
function onGridFocusOut(ev: FocusEvent): void {
  // 欄から欄へ移るだけなら維持する（間に false を挟むとカーソルが一瞬ちらつく）
  const to = ev.relatedTarget as HTMLElement | null;
  if (to?.classList.contains("grid-input")) return;
  inputFocused.value = false;
}

interface GuiChoiceLike {
  index: number;
  text: string;
  selected: boolean;
  available: boolean;
}
interface GuiSelectionLike {
  id: number;
  row: number;
  col: number;
  kind: "radio" | "checkbox" | "pushbutton" | "menu";
  multiple: boolean;
  choices: GuiChoiceLike[];
}

/** 選択肢クリック: ボタン/メニューは選択＋即送信、ラジオは選択、チェックはトグル */
function onChoiceClick(field: GuiSelectionLike, choice: GuiChoiceLike): void {
  if (!choice.available || props.snapshot.keyboardLocked) return;
  if (field.kind === "pushbutton" || field.kind === "menu") {
    emit("gui-select", field.id, choice.index, true);
    emit("gui-submit", field.id);
  } else if (field.kind === "checkbox") {
    emit("gui-select", field.id, choice.index, !choice.selected);
  } else {
    emit("gui-select", field.id, choice.index, true);
  }
}

/** GUI 要素の px 位置（cursor オーバーレイと同じ ch/em 基準） */
function guiPos(row: number, col: number): Record<string, string> {
  return { left: col - 1 + "ch", top: (row - 1) * 1.25 + "em" };
}

/** スクロールバーつまみ位置（総数に対する割合） */
function thumbStyle(bar: { horizontal: boolean; total: number; sliderPos: number }): Record<string, string> {
  const pct = (bar.total ? (bar.sliderPos / bar.total) * 100 : 0) + "%";
  return bar.horizontal ? { left: pct } : { top: pct };
}

/**
 * 窓の検出結果。**computed ではなく watch で持つ。**
 *
 * 判定が**前画面との差分**を見るようになったため（`detectWindowRect` の `prev`）、
 * 前画面を覚えておく必要がある。これを `decoWindow` の computed の中でやると、
 * 設定が none の間は早期 return で検出が走らず、**OFF→ON した瞬間に古い画面と比較**して
 * しまう。判定は設定に依らず毎画面走らせ、装飾側は結果を読むだけにする。
 *
 * `watch` のコールバックは第 2 引数で**前の値**を受け取れるので、前画面はここで自然に手に入る。
 *
 * **`displayChar` が依存する表示設定（SO/SI マーク・表示コード）は watch しない。**
 * 窓かどうかは画面の中身で決まるもので、表示設定を切り替えても窓であることは変わらない。
 * ここで引き直すと**前画面が無い状態で判定し直す**ことになり、`③` の誤検出が復活する
 * （前画面との差分こそが ③ を弾いている材料なので）。設定変更は次の画面更新から反映される。
 */
const detectedWindow = ref<WindowRect | null>(null);
watch(
  () => props.snapshot,
  (snap, prev) => {
    // **画面が前回とまったく同じなら判定を更新しない。** 情報が増えていないのに結論を変える
    // 理由が無く、更新すると「同じ帳票が無変化で再描画された」ときに窓へ化ける
    // （`window-prev-diff.test.ts` の「判定し直すと窓になってしまう」で固定）。
    if (prev && sameScreen(prev, snap, displayChar)) return;
    detectedWindow.value = detectWindowRect(snap, displayChar, prev ?? null);
  },
  { immediate: true }
);

/**
 * ウィンドウ装飾（画面設定「ウィンドウ設定」）の矩形。
 * 拡張5250 の窓と文字で描かれた窓の**両方**を同じ関数が返すので、装飾側は種類を意識しない。
 */
const decoWindow = computed<WindowRect | null>(() => {
  if (props.windowFrame === "none" && props.windowBackdrop === "none") return null;
  // **ホストが WDWBORDER で枠を指定している窓には、クライアント設定の枠を重ねない。**
  // ホスト指定こそ「実機と同じ見た目」なので、上から自前の枠を描くと二重になる
  // （ACS はホストの枠だけを出す）。
  if (props.snapshot.gui?.windows.some((w) => w.border !== undefined)) return null;
  return detectedWindow.value;
});

/**
 * 桁・行を絶対座標へ（`.gui-window` と同じ ch/em 基準。桁割りには影響しない）。
 * **Opt 欄のボタンと `F4` の導線で共有する**（同じ寸法・同じ係数にそろえるため）。
 */
function optBtnStyle(p: { row: number; col: number }): Record<string, string> {
  // **1 行 = 1.25em**（winRectStyle と同じ係数）。1em で置くと行がずれる
  return { left: p.col - 1 + "ch", top: (p.row - 1) * 1.25 + "em" };
}

/**
 * リストの位置。**入力エリアに重ねない**（利用者指示）——Opt 列とボタンの右側から始める。
 * 縦は開いている行の 1 行下（ボタン自身を隠さない）。
 */
function optListStyle(p: { row: number; col: number }): Record<string, string> {
  const hints = optionHints.value;
  const left = p.col - 1 + (hints ? hints.column.length + 1 : 2);
  return { left: left + "ch", top: p.row * 1.25 + "em" };
}

/**
 * モバイル・タブレットで出すソフトキーボードの種類。
 *
 * **ホストが「数字だけ」と申告した欄にだけ数字キーパッドを出す。** `digitsOnly`（FFW の
 * digits-only）は `field-validate.ts` の許容集合が `/^[0-9]*$/` で、**本当に数字しか通らない**。
 * ここを絞っても利用者が打てる文字は減らない。
 *
 * **`numeric` 全体には付けない。** 数値欄のうち numeric-only / signed-numeric は
 * `.` `,` `+` `-` を許容しており、`inputmode="numeric"` にするとそれらのキーが消えて
 * **打てるはずの文字が打てなくなる**（AGENTS.md「環境の検出結果で選択肢を塞がない」）。
 * 迷ったら既定のフルキーボードに任せる。
 */
function inputModeOf(f: Field): "numeric" | undefined {
  return f.digitsOnly && !f.protected ? "numeric" : undefined;
}

/** 桁の閉区間 → 重ねる要素の位置・寸法（.gui-window と同じ ch/em 基準） */
function winRectStyle(r: { row1: number; row2: number; col1: number; col2: number }): Record<string, string> {
  return {
    left: r.col1 - 1 + "ch",
    top: (r.row1 - 1) * 1.25 + "em",
    width: r.col2 - r.col1 + 1 + "ch",
    height: (r.row2 - r.row1 + 1) * 1.25 + "em",
  };
}

/**
 * スモーク（窓の外を暗くする）用の 4 枚。窓の**上・下・左・右**を覆い、窓の中は覆わない
 * （読みやすさを落とさないため。spec D3）。幅・高さが 0 のものは描かない。
 */
function smokeRects(r: WindowRect): Record<string, string>[] {
  const rows = props.snapshot.rows;
  const cols = props.snapshot.cols;
  const out: { row1: number; row2: number; col1: number; col2: number }[] = [];
  if (r.row1 > 1) out.push({ row1: 1, row2: r.row1 - 1, col1: 1, col2: cols });
  if (r.row2 < rows) out.push({ row1: r.row2 + 1, row2: rows, col1: 1, col2: cols });
  if (r.col1 > 1) out.push({ row1: r.row1, row2: r.row2, col1: 1, col2: r.col1 - 1 });
  if (r.col2 < cols) out.push({ row1: r.row1, row2: r.row2, col1: r.col2 + 1, col2: cols });
  return out.map(winRectStyle);
}

/**
 * **ホストが引いたグリッド罫線（GRDATR/GRDLIN）を 1 本ずつの矩形に展開する。**
 *
 * ホストは「箱」や「片側の線」をまとめて指定してくるので、描画しやすいよう
 * 上辺・下辺・左辺・右辺・内部罫線に分解する。線種は CSS の border-style へ落とす
 * （太字・二重破線は最も近い見た目に寄せる。原典の線種はこちらの CSS より細かい）。
 */
function gridSegments(g: GuiGridLine): { style: Record<string, string>; cls: string }[] {
  const out: { style: Record<string, string>; cls: string }[] = [];
  // **グリッド線の色は 5250 の属性バイトではない**（DDS リファレンス GRDATR Table 14 の専用コード）。
  // decodeAttribute に渡すと全部緑になる。X'FF'（表示装置の既定）と未知の値は白に倒す。
  //
  // **ここは ACS に合わせない**（利用者の判断）。AGENTS.md「2.」は既存クライアントと同じ挙動を
  // 優先するが、罫線の色と線種はその例外。ACS はホストの指定を無視して**一律に青の実線**で描く
  // （画素で実測: `GRDATR((*COLOR RED))` の箱も `(*COLOR WHT)` の罫線も同じ青 rgb(120,144,240)、
  //  `(*LINTYP DSH)` の箱も実線）。合わせると DDS の書き手が指定した色と線種を捨てることになるので、
  // ホストの指定どおりに描く。**ACS と見比べて「色が違う」と気付いても直さないこと。**
  const color = GRID_COLOR[g.color] ?? "white";
  const cls = `grid-line c-${color} ${gridLineClass(g.lineStyle)}`;
  // **罫線はセルの中ではなく「セルの境界」に引く。**
  // 境界は画面原点から数えたセル数で表す（行 r の上端＝r-1、下端＝r）。
  // 箱の下辺は**最終行の下端**＝ row+height、右辺は**最終桁の右端**＝ col+width。
  // ここを行番号・桁番号のまま置くと下辺と右辺が 1 つ内側に寄り、
  // 辺の長さ（width/height）だけが正しいので**箱が閉じない**（ACS との比較で判明）。
  const top = g.row - 1;
  const left = g.col - 1;
  const bottom = top + Math.max(1, g.height);
  const right = left + Math.max(1, g.width);
  const hLine = (bound: number): Record<string, string> => ({
    left: left + "ch",
    top: bound * 1.25 + "em",
    width: right - left + "ch"
  });
  const vLine = (bound: number): Record<string, string> => ({
    left: bound + "ch",
    top: top * 1.25 + "em",
    height: (bottom - top) * 1.25 + "em"
  });
  const push = (style: Record<string, string>, extra: string): void => {
    out.push({ style, cls: `${cls} ${extra}` });
  };

  // **単独の罫線（0x00–0x03）では 2 つの数値の意味が箱と違う。**
  // 箱では「横罫の行間隔・縦罫の桁間隔」だが、GRDLIN では **(繰り返し数, 間隔)**。
  // SR-OSAKA で実測: `GRDLIN((*POS (4 3 40)) (*TYPE UPPER 3 2))` → 3 本を 2 行おき、
  // `GRDLIN((*POS (14 3 8)) (*TYPE LEFT 4 6))` → 4 本を 6 桁おき。
  // 同じ 2 バイトを型で読み分ける（ここを一律に扱うと単独罫線が 1 本しか出ない）。
  if (g.minorType <= 0x03) {
    const repeat = Math.max(1, g.value1);   // 本数
    const interval = Math.max(1, g.value2); // 本の間隔
    const horizontal = g.minorType <= 0x01;
    const base = g.minorType === 0x00 ? top : g.minorType === 0x01 ? bottom : g.minorType === 0x02 ? left : right;
    for (let i = 0; i < repeat; i++) {
      const at = base + i * interval;
      push(horizontal ? hLine(at) : vLine(at), horizontal ? "grid-h" : "grid-v");
    }
  } else {
    // 箱（0x04–0x07）は四辺
    push(hLine(top), "grid-h");
    push(hLine(bottom), "grid-h");
    push(vLine(left), "grid-v");
    push(vLine(right), "grid-v");
    // **内部罫線は「本数と間隔」ではなく「行の間隔・桁の間隔」**（DDS の *TYPE の 2 引数）。
    // `(*TYPE HRZVRT 2 8)` は「2 行ごとに横罫・8 桁ごとに縦罫」で、
    // 箱が 6 行 × 40 桁なら横 2 本・縦 4 本になる（ACS の表示と一致）。
    // 本数と読むと横が 0 本・縦が 2 本になり、実機の見た目と食い違う。
    const value1 = g.value1;
    const value2 = g.value2;
    if ((g.minorType === 0x05 || g.minorType === 0x07) && value1 > 0) {
      for (let b = top + value1; b < bottom; b += value1) push(hLine(b), "grid-h");
    }
    if ((g.minorType === 0x06 || g.minorType === 0x07) && value2 > 0) {
      for (let b = left + value2; b < right; b += value2) push(vLine(b), "grid-v");
    }
  }
  return out;
}

/**
 * 線種（原典 GRID_LINE_STYLE）→ CSS クラス。太字・二重破線は最も近い見た目へ寄せる。
 * ACS は線種を無視して実線で描くが、**こちらは指定どおり描く**（`gridSegments` の色の注記を参照）。
 */
function gridLineClass(style: number): string {
  switch (style) {
    case 0x01: // 太実線
      return "gl-thick";
    case 0x02: // 二重線
      return "gl-double";
    case 0x03: // 点線
      return "gl-dotted";
    case 0x08: // 破線
      return "gl-dashed";
    case 0x09: // 太破線
      return "gl-dashed gl-thick";
    case 0x0a: // 二重破線 — CSS に該当が無いので二重線で代替する
      return "gl-double";
    default: // 0x00 実線 / 0xFF 端末既定
      return "";
  }
}

/**
 * **ホストが WDWBORDER で指定した窓枠を文字で描く。**
 *
 * ホスト指定がある窓は「実機と同じ見た目」がそこにあるので、
 * クライアント設定（windowFrame）の枠より**そちらを優先**する。
 * 指定が無い窓は従来どおりクライアント設定で描く。
 *
 * 枠のセル範囲は線で描くとき（`hostBorderSegments`）と同じ——**窓の外側**。
 * 窓の本体に重ねると窓の中身を塗り潰してしまう。
 *
 * **枠文字は属性ごと描く。** `WDWBORDER((*COLOR BLU) (*DSPATR RI) (*CHAR '        '))`
 * のように「反転表示の空白 8 個」を指定すると、ホストは空白 8 個と属性 0x3B
 * （青・反転）を送ってくる（SR-OSAKA で実測）。色だけを文字色に使うと
 * **空白に青い文字色**＝何も見えない。反転を効かせて初めて「背景色のセルで描いた枠」になる。
 */
function hostBorderRows(w: GuiWindow): { text: string; style: Record<string, string> }[] {
  const c = w.border?.chars;
  if (!c) return []; // 文字指定が無ければ線で描く（hostBorderSegments）
  const height = w.height + 2; // 上下に 1 行ずつ
  const inner = Math.max(0, w.width + 2); // 左右に 2 桁ずつ（うち左右 1 桁ずつが隅）
  const rows: { text: string; style: Record<string, string> }[] = [];
  const at = (row: number, col: number, text: string): void => {
    rows.push({
      text,
      style: { left: col + "ch", top: (row - 1) * 1.25 + "em" }
    });
  };
  at(w.row, w.col, c.ulbc + c.tbc.repeat(inner) + c.urbc);
  // **側面は左右の枠桁だけを別々に置く。** 間を空白で埋めた 1 本の帯にすると、
  // 反転指定（DSPATR(RI)）のときに**窓の中身まで塗り潰す**（実機で確認）。
  for (let i = 1; i < height - 1; i++) {
    at(w.row + i, w.col, c.lbc);
    at(w.row + i, w.col + inner + 1, c.rbc);
  }
  at(w.row + height - 1, w.col, c.llbc + c.bbc.repeat(inner) + c.lrbc);
  return rows;
}

/**
 * **文字指定の無い WDWBORDER を線の枠として描く。**
 *
 * 実機で `WDWBORDER((*COLOR PNK))` を出すとホストは**色だけ**を送り、罫線文字を載せない。
 * 字形はこちらで決めるしかないが、ACS は**枠のセルを 1 桁ずつ埋める破線**で描く。
 * 以前は `.` `:` の記号で描いていて、ACS の枠とはっきり違って見えていた。
 *
 * **枠は窓の外側に出る。** 5250 の窓は本体の上下に 1 行、左右に 2 桁を枠に使い、
 * さらにその左に枠の属性バイトが 1 桁入る。ホストが送るのは属性桁を含む位置（SBA）
 * なので、枠のセルは行 `row 〜 row+height+1`・桁 `col+1 〜 col+width+4` になる。
 * 線はそのセルの**中心**を通る（ACS もそう描く）。
 *
 * SR-OSAKA の `WINDOW(10 45 6 30)`（ホストは SBA 行 10 桁 44・30x6 を送る）で ACS を実測:
 * 枠は行 10〜17・桁 45〜78 に出て、窓内の定数 `2 3'HOST BORDER'` が行 12 桁 49 に載る。
 * どちらもこの式と一致する。
 */
function hostBorderSegments(w: GuiWindow): { style: Record<string, string>; cls: string }[] {
  const b = w.border;
  if (!b || b.chars) return []; // 文字指定があるならそちらを尊重する（hostBorderRows）
  const color = decodeAttribute(b.cba).color;
  // 枠セルの中心（画面原点から数えたセル数。行 n の中心 = n-0.5）
  const top = w.row - 0.5;
  const bottom = w.row + w.height + 0.5;
  const left = w.col + 0.5;
  const right = w.col + w.width + 3.5;
  const cls = `win-frame gui-window-border c-${color}`;
  const hStyle = { left: left + "ch", width: right - left + "ch" };
  const vStyle = { top: top * 1.25 + "em", height: (bottom - top) * 1.25 + "em" };
  return [
    { cls: `${cls} win-frame-h`, style: { ...hStyle, top: top * 1.25 + "em" } },
    { cls: `${cls} win-frame-h`, style: { ...hStyle, top: bottom * 1.25 + "em" } },
    { cls: `${cls} win-frame-v`, style: { ...vStyle, left: left + "ch" } },
    { cls: `${cls} win-frame-v`, style: { ...vStyle, left: right + "ch" } }
  ];
}

/**
 * **WDWTITLE の見出し／脚注を枠の辺の上に置く。**
 *
 * 見出しは窓の中ではなく**枠の行**に載り、既定は**中央寄せ**（原典
 * `vals_tn5250_wdsf_cw_tf_flag_orientation`: 0=中央 / 1=右 / 2=左）。
 * 実機（ASAOLIB/GRIDCL4）の `WDWTITLE((*TEXT 'CHAR BORDER') (*COLOR YLW))` は
 * 寄せ方 0・属性 0x32（黄）で来て、ACS は枠の上辺の中央に黄色で出す。
 * 窓の左上に置くと ACS と食い違う（画素で突き合わせて確認）。
 */
function hostTitle(w: GuiWindow): { text: string; style: Record<string, string>; cls: string } | null {
  const t = w.title;
  if (!t) return null;
  const cells = w.width + 4; // 枠の桁数（左右に 2 桁ずつ）
  const row = t.footer ? w.row + w.height + 1 : w.row;
  const pad = Math.max(0, cells - t.text.length);
  const off = t.align === "left" ? 0 : t.align === "right" ? pad : Math.floor(pad / 2);
  return {
    text: t.text,
    style: { left: w.col + off + "ch", top: (row - 1) * 1.25 + "em" },
    cls: `win-title ${decorAttrClass(t.cba)}`
  };
}

/**
 * ウィンドウ枠（`.gui-window`）の位置＋寸法。
 *
 * **ホストが送る位置は枠の左上で、中身はその 1 行下・3 桁右から始まる。**
 * 宣言された位置・大きさをそのまま置くと、実際の窓から**左上へずれた**矩形になる
 * （表示設定の枠・スモークは中身の範囲を使うので、両者が斜めにずれて見えていた）。
 * ここは枠そのものなので、ホストが WDWBORDER を出したときと同じ**枠の矩形**
 * （行 `row`〜`row+height+1` / 桁 `col+1`〜`col+width+4`）に合わせる。
 */
function windowStyle(w: { row: number; col: number; width: number; height: number }): Record<string, string> {
  return {
    ...guiPos(w.row, w.col + 1),
    width: w.width + 4 + "ch",
    height: (w.height + 2) * 1.25 + "em"
  };
}

const selectionFields = computed<GuiSelectionLike[]>(
  () => (gui.value?.selectionFields ?? []) as GuiSelectionLike[]
);

/** text セグメント内での凡例の位置（文字 index）。桁ではなく index なのは描画で分割に使うため。
 *  row/col は**画面上の位置**で、Tab の移動先をカーソル位置から決めるのに使う（EmulatorPane）。 */
interface LocalSpan {
  from: number;
  to: number;
  key: AidKey;
  row: number;
  col: number;
}

/**
 * 全角セルが**対（lead＋tail）を成しているか**。
 *
 * ホストは既に全角が書かれている桁へ属性バイトや別データを重ねて書くことがあり、そのとき
 * 片割れだけが残る（実機 SR-OSAKA: Attn の窓が 23 桁目から重なり、背面の「…コマンド」の
 * 最後の全角の tail が潰された）。対を失ったセルを 2 桁ぶん描くと隣の桁を侵し、
 * **以降の見た目が 1 桁ずれる**。ACS は 1 桁に切り詰めて描くので、それに合わせる。
 */
function hasTail(row: readonly Cell[], i: number): boolean {
  return row[i + 1]?.kind === "dbcs-tail";
}
function hasLead(row: readonly Cell[], i: number): boolean {
  return i > 0 && row[i - 1]?.kind === "dbcs-lead";
}

interface Segment {
  /** text=素のラン / input=入力欄 / wide=幅を保証する DBCS 1 文字（下記 wideBox 参照）
   *  / half=対を失った全角セル（1 桁に切り詰め。上記 hasTail/hasLead 参照） */
  kind: "text" | "input" | "wide" | "half";
  text: string;
  cls: string;
  /** このセグメントが始まる桁（1 始まり）。凡例 span を index へ写すのに使う */
  col?: number;
  /** このセグメントに完全に収まる機能キー凡例（spec B1-6） */
  spans?: LocalSpan[];
  field?: Field;
  /** input の表示桁数（この行に出る桁数） */
  width?: number;
  /** 行またぎフィールドの何番目のスライスか（0 始まり。単一行なら 0） */
  slice?: number;
  /** このスライスがフィールド先頭から何桁目に当たるか */
  offset?: number;
  /**
   * input スライス内に**埋め込み属性**（欄途中の色替え）がある場合の色バンド。
   * `<input>` は 1 要素 1 色しか出せないので、これがある欄は色付き span の
   * オーバーレイを重ねて桁ごとの色を表現する（SEU の色付きソース等）。
   * バンドが 1 つ（＝色替え無し）の通常欄では未設定にして、描画を従来のままにする。
   */
  colorBands?: { start: number; len: number; cls: string }[];
}

/**
 * **表示できない SBCS は半角スペースにする（ACS と同じ）。**
 *
 * EBCDIC の SBCS 表にはマップの無いバイトがあり、コーデックはそこを U+FFFD で返す。
 * これをそのまま出すと、多くのフォントで **U+FFFD が全角幅**になるため 1 桁のはずが
 * 2 桁を占め、その行の後続がすべて右へずれる。表示コードページを切り替えると
 * （930 カナ表と 1027 表で未定義バイトの集合が違うため）実際に現れる。
 */
function displayText(s: string): string {
  return s.includes("\uFFFD") ? s.replaceAll("\uFFFD", " ") : s;
}

/**
 * 生バイトを実効表示コードで読み直す。**`sbcsView === "host"` のときは呼ばない**
 * （`recodes()` が先に false を返す）。
 */
function recodeChar(rawByte: number): string {
  return props.sbcsView === "kana" ? katakanaChar(rawByte) : latinChar(rawByte);
}

/**
 * このセルを再解釈するか。**再解釈の可否判定はここ 1 か所**——画面（displayChar）・
 * コピー（copyCharOf）・入力欄（recodeViewActive 経由）が同じ答えを使うことで、
 * 「画面はカナなのに入力欄は素のまま」のような食い違いを構造的に作らない。
 *
 * `rawByte` を持つのは SBCS セルだけ（DBCS・属性桁・オーダーが書いた文字は持たない）。
 * それらは読み直す元が無いので、ホストの表で解釈済みの `char` をそのまま使う。
 */
function recodes(c: Cell): boolean {
  return props.sbcsView !== "host" && c.kind === "sbcs" && c.rawByte !== undefined;
}

/** セルの表示文字（SO/SI マーク表示・表示コード再解釈・dbcs-tail 空白埋め） */
function displayChar(c: Cell): string {
  // **非表示（nonDisplay）桁は SO/SI マークも出さない。** ACS は非表示属性の桁に何も描かない
  // （DBCS ラベルが非表示のとき、UPDDTA 初期表示で SO/SI だけ { } と漏れて見えるのを防ぐ）。
  if (c.nonDisplay) return " ";
  if (props.showShiftMarks && c.kind === "so") return "{";
  if (props.showShiftMarks && c.kind === "si") return "}";
  // 表示コード切替: SBCS の生バイトを対の表で再解釈
  if (recodes(c)) return displayText(recodeChar(c.rawByte!));
  return c.char === "" ? " " : displayText(c.char);
}

// リンク化: 既定 ON（withDefaults）。再解釈表示中は文字が別解釈になるため無効化（誤検出・桁崩れ防止）
const linkEnabled = computed(() => props.linkify && props.sbcsView === "host");

/** text セグメントをプレーン/リンク部分に分割（リンク無効時は単一のプレーン部分） */
function linkParts(text: string): LinkPart[] {
  return linkEnabled.value ? splitLinks(text) : [{ text }];
}

/** 描画部品。href=リンク / aid=機能キーのボタン / どちらも無ければ素のテキスト */
interface DecoPart extends LinkPart {
  aid?: AidKey;
  /** ボタンの画面上の位置（Tab の移動先計算に使う） */
  row?: number;
  col?: number;
}

/**
 * text セグメントを「リンク・機能キーボタン・素のテキスト」に分割する。
 * **重なったら凡例を優先**する（凡例の範囲内ではリンク検出をかけない。spec B2）。
 * 実際には URL と凡例が同じ範囲に出ることはまず無い。
 */
function decoParts(seg: Segment): DecoPart[] {
  const spans = seg.spans;
  if (!spans || spans.length === 0) return linkParts(seg.text);
  const out: DecoPart[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.from < pos) continue; // 念のため（span 同士は重ならない）
    if (s.from > pos) out.push(...linkParts(seg.text.slice(pos, s.from)));
    out.push({ text: seg.text.slice(s.from, s.to), aid: s.key, row: s.row, col: s.col });
    pos = s.to;
  }
  if (pos < seg.text.length) out.push(...linkParts(seg.text.slice(pos)));
  return out;
}

/** 凡例ボタンの押下。ホストへは親（EmulatorPane）が送る。 */
function onFkeyClick(key: AidKey): void {
  if (props.busy || props.snapshot.keyboardLocked) return; // 通信中・ロック中は送らない
  emit("aid", key);
}

/**
 * **桁区切り（CS）ビットは黄・青緑では「書き手の意図」の印にならない。**
 *
 * 5250 の属性バイト表（SC30-3533）には黄・青緑を「修飾なし」で表す値が無く、
 * `COLOR(YLW)` を単体で指定しただけでも桁区切りビット付きの値（0x32 等）に
 * コンパイルされる（属性バイトだけを見ても DSPATR(CS) を本当に頼んだのか区別できない）。
 * 窓の見出し・枠（decorAttrClass）は既にこれを踏まえて桁区切りを出さないようにしていたが、
 * 通常のフィールドには適用しておらず、黄字の欄の頭に意図しない縦棒が出ていた
 * （利用者からのスクリーンショット報告で判明）。
 */
function hasRealColsep(color: string, columnSeparator: boolean): boolean {
  return columnSeparator && color !== "yellow" && color !== "turquoise";
}

/** cell の属性を CSS class 文字列にする */
function cellClass(c: Cell): string {
  const cls = [`c-${c.color}`];
  if (c.underline) cls.push("a-underline");
  if (c.reverse) cls.push("a-reverse");
  if (c.blink) cls.push("a-blink");
  // DSPATR(CS)＝桁区切り。core は解析してセルに持っていたが、描画側が**素通ししていた**ため
  // DSPF の区切り線が画面に一切出ていなかった（dspf-report (1)）。
  if (hasRealColsep(c.color, c.columnSeparator)) cls.push("a-colsep");
  // **ホストが「表せない」と言ってきた桁は塗り潰す**（ACS と同じ見せ方）。
  // 空白のままだと「ヘルプが虫食い」としか見えず、文字が落ちたことが分からない
  if (c.kind === "unmappable") cls.push("a-unmappable");
  return cls.join(" ");
}

/** input スライスの各桁を色クラスでまとめ、色替えの境界（バンド）を返す。
 *  埋め込み属性（欄途中の attr セル）があるとバンドが 2 つ以上になる。 */
function inputColorBands(
  row: readonly Cell[],
  cStart: number,
  width: number
): { start: number; len: number; cls: string }[] {
  const bands: { start: number; len: number; cls: string }[] = [];
  for (let k = 0; k < width; k++) {
    const cell = row[cStart + k];
    if (!cell) continue;
    const cls = cellClass(cell);
    const last = bands[bands.length - 1];
    if (last && last.cls === cls) last.len++;
    else bands.push({ start: k, len: 1, cls });
  }
  return bands;
}

/** 属性バイト（decodeAttribute の結果）を CSS class 文字列にする（cellClass と同じ体裁） */
function attrByteClass(byte: number): string {
  const a = decodeAttribute(byte);
  const cls = [`c-${a.color}`];
  if (a.underline) cls.push("a-underline");
  if (a.reverse) cls.push("a-reverse");
  if (a.blink) cls.push("a-blink");
  if (hasRealColsep(a.color, a.columnSeparator)) cls.push("a-colsep"); // cellClass と同じ体裁（片方だけ落とさない）
  return cls.join(" ");
}

/**
 * 窓の枠・見出しに使う属性クラス。**桁区切り（CS）だけは落とす。**
 *
 * 5250 の属性表では黄と青緑に桁区切りビット抜きの割り当てが無い（黄 = 0x32 は
 * 「黄＋桁区切り」）。そのため `WDWTITLE((*COLOR YLW))` のように色だけ指定した
 * 見出しにも縦棒が付いてしまう——DDS の書き手が頼んでいない印になる。
 * ACS も枠・見出しに桁区切りは出さない（画素で確認）。
 * 桁区切りは「欄の桁を仕切る」印なので、飾りの枠には持ち込まない。
 */
function decorAttrClass(byte: number): string {
  const a = decodeAttribute(byte);
  const cls = [`c-${a.color}`];
  if (a.underline) cls.push("a-underline");
  if (a.reverse) cls.push("a-reverse");
  if (a.blink) cls.push("a-blink");
  return cls.join(" ");
}

/**
 * その 1 文字が占める桁数。
 *
 * **センチネルは必ず 1 桁**（1 バイトを運ぶ印で、表示は空白 1 桁）。
 * `isFullWidth` は私用領域（U+E000–F8FF）を外字＝全角として扱うので、
 * センチネルをそのまま渡すと 2 桁と数えて桁がずれる——センチネルも私用領域に居るため。
 *
 * **この分岐は現在どの経路からも踏まれない**（定義上の保険）。DBCS 欄の休止表示は
 * `dbcsSliceText` が列ビューを作る段階でセンチネルを空白へ潰しており、SBCS 欄の
 * 値は既に欄長まで詰められているので末尾の追加詰めが 0 桁になる。
 * それでも残すのは、**桁数の定義をここ 1 箇所に閉じ込める**ため——
 * 上流が「センチネルを残したまま渡す」形に変わっても、桁がずれずに済む。
 * 落ちるテストを書けないので、テストは置いていない。
 */
function displayCols(ch: string): number {
  if (isRawSentinel(ch)) return 1; // 属性センチネルも含む（isRawSentinel は上位集合）
  return isFullWidth(ch) ? 2 : 1;
}

/**
 * 操作員メッセージを**ホストの行と同じ形**に整える（`20260802-message-line-parity`）。
 *
 * ACS はクライアント側のメッセージも**画面のテキストとして**置くので、全角の前後に
 * SO/SI が入り、`{ }` 表示（`showShiftMarks`）でも**ホストのメッセージと同じ見え方**になる。
 * こちらは自前の文字列をそのまま出していたため、**印が付かず開始桁も 1 桁ずれていた**
 * （利用者の指摘）。
 *
 * **SO/SI は印を出さないときも 1 桁を占める**（実機がそうだから）。だから
 * `showShiftMarks` が OFF でも空白 1 桁を入れる——ここを省くと、ホストの行だけ
 * 1 桁右にずれる。
 */
function withShiftCodes(text: string): string {
  const so = props.showShiftMarks ? "{" : " ";
  const si = props.showShiftMarks ? "}" : " ";
  let out = "";
  let inDbcs = false;
  for (const ch of text) {
    const wide = isFullWidth(ch);
    if (wide && !inDbcs) {
      out += so;
      inDbcs = true;
    } else if (!wide && inDbcs) {
      out += si;
      inDbcs = false;
    }
    out += ch;
  }
  if (inDbcs) out += si;
  return out;
}

/**
 * 表示用のメッセージ。**桁 1 を空けて桁 2 から始める**（`20260802-message-line-indent`）。
 *
 * ホストの操作員メッセージ行は**桁 1 が属性バイト**で、本文は桁 2 から始まる。
 * 桁 1 から描くと**ホストの行より 1 桁左にずれる**（利用者の指摘）。ACS も桁 2 から始まる。
 *
 * SO/SI の差し込み（`withShiftCodes`）とは別の話なので、ここで分けて足す
 * ——あちらは「全角の前後に符号が要る」、こちらは「行の左端に属性の 1 桁がある」。
 */
const shiftedMessage = computed(() => (props.message ? " " + withShiftCodes(props.message) : ""));

/** 桁オフセットに掛かる色バンドの class（範囲外は undefined） */
function classAtColumn(
  bands: { start: number; len: number; cls: string }[],
  col: number
): string | undefined {
  for (const b of bands) if (col >= b.start && col < b.start + b.len) return b.cls;
  return undefined;
}

/**
 * オーバーレイに出す色付きラン。色の出どころは**欄によって 2 通り**ある。
 *
 * **(A) 値にセンチネルがある欄（SBCS）**——値の中のセンチネル（＝埋め込み属性）で切り替える。
 * センチネルは編集で桁と一緒に動くので、**色も編集に追従する**。センチネル位置は新色の空白 1 桁。
 *
 * **(B) 値にセンチネルが無い欄（DBCS。SEU のソース欄）**——セル由来の `colorBands` で塗る。
 * core の `fieldValue` は DBCS 欄にセンチネルを載せない（SO/SI・2 バイトの都合で
 * 混ぜると**送信エンコードが壊れる**ため）。値だけを見ると色情報がゼロなので、
 * ここを (A) だけにすると**欄全体が先頭色 1 色になり、SEU の制御コードの色分けが消える**
 * （実機で報告された不具合。センチネル方式へ移行したときの見落とし）。
 *
 * (B) は**ホストが描いた位置**の色なので、編集しても色は動かない。
 * 「色が編集で少しずれる」より「色が全く出ない」方が悪い、という判断でこちらを採る。
 * 値に色を載せられるようになれば、条件は自動的に (A) 側へ移る。
 *
 * 分岐を `dbcsType` ではなく**センチネルの有無**で書いているのはそのため——
 * 判定したい事実は「値が色情報を持っているか」そのもの。
 */
function overlayRuns(seg: Segment): { text: string; cls: string }[] {
  // **末尾の詰めは「文字数」ではなく「桁」で数える。** 全角 1 文字は 2 桁を占めるので、
  // padEnd(文字数) だと全角のぶんだけ余計に埋まり、入力欄の表示値より長くなる（桁ずれ）。
  const raw = sliceValue(seg.field!, seg.slice ?? 0);
  let rawCols = 0;
  for (const ch of raw) rawCols += displayCols(ch);
  const value = raw + " ".repeat(Math.max(0, (seg.width ?? 0) - rawCols));
  const runs: { text: string; cls: string }[] = [];
  let cls = seg.cls; // 欄先頭の色（seg.cls = 先頭セルの cellClass）
  let text = "";
  const push = (): void => {
    if (text.length > 0) {
      runs.push({ text, cls });
      text = "";
    }
  };
  if (![...value].some((ch) => isAttrSentinel(ch))) {
    // (B) セル由来。**全角は 2 桁・センチネルは 1 桁**を占めるので、
    // 文字ごとに桁を進めて色を引く（桁の数え方は displayCols に集約する）。
    const bands = seg.colorBands ?? [];
    let col = 0;
    for (const ch of value) {
      const at = classAtColumn(bands, col) ?? seg.cls;
      if (at !== cls) {
        push();
        cls = at;
      }
      text += isRawSentinel(ch) ? " " : ch;
      col += displayCols(ch);
    }
    push();
    return runs;
  }
  for (const ch of value) {
    if (isAttrSentinel(ch)) {
      push();
      cls = attrByteClass(attrSentinelByte(ch));
      text += " "; // 属性桁は新色の空白 1 桁
    } else {
      // 表示できないバイトのセンチネルは色を変えない。空白 1 桁で桁だけ保つ
      text += isRawSentinel(ch) ? " " : ch;
    }
  }
  push();
  return runs;
}

/**
 * 機能キー凡例（`F3=終了` 等）。行ごとにまとめる。
 *
 * `displayChar` を渡すので SO/SI マーク表示・表示コードの設定が検出にも反映される
 * （設定と見た目が食い違わないようにするため）。snapshot だけに依存させ、
 * 入力のたびに再検出しないよう `rows` とは別の computed にしている。
 */
const legendsByRow = computed<Map<number, FkeySpan[]>>(() => {
  const map = new Map<number, FkeySpan[]>();
  if (props.buttons === "none") return map; // 意匠「なし」＝ボタン化しない（spec B2）
  for (const s of detectFkeyLegends(props.snapshot, displayChar)) {
    const list = map.get(s.row);
    if (list) list.push(s);
    else map.set(s.row, [s]);
  }
  return map;
});

/**
 * **オプション欄の選択肢**（`2=変更 3=コピー …`）。設定 ON のときだけ検出する。
 *
 * 検出は snapshot だけに依存させる（入力のたびに走らせない。`legendsByRow` と同じ理由）。
 */
const optionHints = computed(() =>
  props.optHints === "none" ? null : detectOptionHints(props.snapshot, displayChar)
);

/** フォーカス中の入力欄。ポップオーバーの開閉はこれに**完全に従属**させる。 */
const focusedField = ref<Field | null>(null);

/**
 * **フォーカス中の欄が Opt 列に属するか**（ボタンを出す条件）。
 *
 * ここではリストを開かない。**フォーカスしただけでリストが出ると、一覧を移動するたびに
 * 視界を塞ぐ**（利用者指摘）。出すのは右隣 1 桁のボタンだけで、開くのは明示操作のとき。
 */
const optTarget = computed<{ row: number; col: number; options: OptionSpan[] } | null>(() => {
  const hints = optionHints.value;
  const f = focusedField.value;
  if (!hints || !f) return null;
  if (f.col !== hints.column.col || !hints.column.rows.includes(f.row)) return null;
  return { row: f.row, col: f.col, options: hints.options };
});

/**
 * ボタンを置く桁（欄の右隣 1 桁）。**そこが実際に空いているときだけ**返す。
 *
 * 【DSPF で実地検証した根拠 — 実機 SR-OSAKA 2026-07-29 / `scripts/probe-opt-adjacency.mjs`】
 * 5250 の SF オーダーは属性バイトを**欄の手前**に置くので、欄と欄の間には最低 1 桁の隙間が要る。
 * 実際に隙間 0 の DSPF を作ると**コンパイルは通るのに実行時に 2 つ目の欄が消えた**。
 * よって**入力欄が右隣に来ることは無い**。
 *
 * ただし**「必ず属性バイト」ではない**。隙間 1 桁のときは `kind=attr` だったが、
 * 単独の欄や定数を置こうとした欄の右隣は**素の `sbcs` 空白**だった（閉じ属性が送られない）。
 * なので kind で決め打たず、**表示文字が空白であること**を実行時に見る。
 */
const optButtons = computed<{ row: number; col: number }[]>(() => {
  const hints = optionHints.value;
  if (!hints) return [];
  const col = hints.column.col + hints.column.length;
  if (col > props.snapshot.cols) return [];
  return hints.column.rows
    .filter((row) => {
      const c = props.snapshot.cells[row - 1]?.[col - 1];
      return c !== undefined && displayChar(c) === " "; // 埋まっていれば出さない
    })
    .map((row) => ({ row, col }));
});

/** リストを開いている Opt 欄の行。**明示操作（ボタン押下 / Alt+↓）でだけ入る** */
const optOpenRow = ref<number | null>(null);
watch(optionHints, () => { optOpenRow.value = null; }); // 画面が変わったら閉じる

/** 表示するリスト（開いているときだけ）。位置は開いている行から決める */
const optPopoverShown = computed<{ row: number; col: number; options: OptionSpan[] } | null>(() => {
  const hints = optionHints.value;
  const row = optOpenRow.value;
  if (!hints || row === null) return null;
  return { row, col: hints.column.col, options: hints.options };
});

/** その行の Opt 欄 */
function optFieldAtRow(row: number): Field | undefined {
  const col = optionHints.value?.column.col;
  return props.snapshot.fields.find((f) => f.row === row && f.col === col && !f.protected);
}

/** 開いた時点で欄に入っている値と一致する選択肢（あれば選択状態にする） */
const optSelectedValue = computed<string | null>(() => {
  const row = optOpenRow.value;
  if (row === null) return null;
  const f = optFieldAtRow(row);
  if (!f) return null;
  const cur = (inputForSlice(f, 0)?.value ?? f.value).trim();
  return optPopoverShown.value?.options.some((o) => o.value === cur) ? cur : null;
});

/** リストを開き、選択中（無ければ先頭）の項目へフォーカスを移す */
async function openOptAt(row: number): Promise<void> {
  optOpenRow.value = row;
  await nextTick();
  const list = gridEl.value?.querySelector<HTMLElement>(".opt-hints");
  const sel = list?.querySelector<HTMLElement>(".opt-hint[aria-selected='true']");
  (sel ?? list?.querySelector<HTMLElement>(".opt-hint"))?.focus();
}

/** Alt+↓ で開く（ペインの onKeydown から呼ぶ）。開ければ true */
function openOptHints(): boolean {
  const t = optTarget.value;
  if (!t) return false;
  void openOptAt(t.row);
  return true;
}

/**
 * リストを閉じる。既定では元の Opt 欄へフォーカスを戻す。
 *
 * `refocus: false` は**外側クリックで閉じるとき**に使う——利用者が別の場所を押したのに
 * こちらがフォーカスを奪い返すと、クリック先が効かない。
 */
function closeOptHints(refocus = true): void {
  const row = optOpenRow.value;
  optOpenRow.value = null;
  if (!refocus || row === null) return;
  const f = optFieldAtRow(row);
  if (f) inputForSlice(f, 0)?.focus();
}

/**
 * **リストの外側を押したら閉じる。**
 *
 * 閉じるだけで `preventDefault` も `stopPropagation` もしない——ここで止めると
 * 矩形選択のドラッグ開始（`onGridMousedown`）を潰してしまう。ボタン自身の上は除外する
 * （ボタンの click がトグルを担うので、ここで閉じると開き直しになる）。
 */
function onDocMousedownForOpt(ev: MouseEvent): void {
  const t = ev.target;
  if (t instanceof HTMLElement && t.closest(".opt-hints, .opt-btn")) return;
  closeOptHints(false);
}
watch(optOpenRow, (row) => {
  if (row === null) document.removeEventListener("mousedown", onDocMousedownForOpt);
  else document.addEventListener("mousedown", onDocMousedownForOpt);
});
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocMousedownForOpt));

/**
 * リスト内のキー操作。**Esc はここで握り潰す**——開いている間は他の Esc 割当
 * （矩形選択の解除等）を発火させない、という利用者指示。
 * 矢印はリスト内移動、Enter/Space は選択（`.opt-hint` は button なので既定で発火する）。
 */
function onOptListKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    closeOptHints();
    return;
  }
  if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
  ev.preventDefault();
  ev.stopPropagation();
  const items = Array.from(gridEl.value?.querySelectorAll<HTMLElement>(".opt-hint") ?? []);
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = ev.key === "ArrowDown" ? at + 1 : at - 1;
  items[(next + items.length) % items.length]?.focus();
}

/**
 * 選択肢を選んだ: **既存の貼り付け経路**で欄へ書く（値を直接いじらない）。
 *
 * 欄はフォーカス中なので `focus` 文脈を渡し、**打鍵と同じ扱い**（edit モデルの更新・sync）にする。
 * 渡さないと非フォーカス経路（`emit("edit")`）へ落ち、カーソルと編集状態が食い違う。
 */
function chooseOption(o: OptionSpan): void {
  const row = optOpenRow.value;
  const f = row === null ? undefined : optFieldAtRow(row);
  if (!f) return;
  const el = inputForSlice(f, 0);
  pasteFrom({ row: f.row, col: f.col }, o.value, el ? { f, el, startOffset: 0 } : undefined);
  optOpenRow.value = null;
  el?.focus(); // 選び終わったら欄へ戻す（以降の打鍵は通常どおり）
}

/**
 * 凡例（桁）を text セグメント内の文字 index へ写す。
 * セグメントに**完全に収まる**ものだけを返す（またがるものは捨てる。spec B1-6）。
 */
function localSpans(
  rowCells: readonly Cell[],
  startCol: number,
  endCol: number,
  spans: readonly FkeySpan[]
): LocalSpan[] {
  const out: LocalSpan[] = [];
  // その桁が表示文字を 1 つ持つか。DBCS の tail は lead が 2 桁ぶんを担うので数えないが、
  // **対を失った tail は空白 1 文字として描く**ため 1 つと数える
  // （描画と数えがずれると凡例リンクの下線位置が桁ずれする）。
  const counts = (c: number): boolean =>
    rowCells[c - 1]?.kind !== "dbcs-tail" || !hasLead(rowCells, c - 1);
  for (const s of spans) {
    if (s.col < startCol || s.col + s.width - 1 > endCol) continue;
    let from = 0;
    for (let c = startCol; c < s.col; c++) if (counts(c)) from++;
    let len = 0;
    for (let c = s.col; c <= s.col + s.width - 1; c++) if (counts(c)) len++;
    if (len > 0) out.push({ from, to: from + len, key: s.key, row: s.row, col: s.col });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** 各行を text/input セグメントに分解する（v-memo 用に行データの参照同一性を保つのは Vue の再評価に委ねる） */
const rows = computed<Segment[][]>(() => {
  const snap = props.snapshot;
  // addr → { field, スライス番号, オフセット }。行またぎ欄は折返し先の行にもスライスを置く
  const fieldAt = new Map<number, { field: Field; slice: number; offset: number }>();
  const sliceStart = new Map<number, { field: Field; slice: number; offset: number; width: number }>();
  for (const f of snap.fields) {
    if (f.row < 1 || f.row > snap.rows) continue;
    fieldSlices(f, snap.cols, snap.rows).forEach((s, i) => {
      sliceStart.set((s.row - 1) * snap.cols + (s.col - 1), { field: f, slice: i, offset: s.offset, width: s.width });
      for (let k = 0; k < s.width; k++) {
        fieldAt.set((s.row - 1) * snap.cols + (s.col - 1 + k), { field: f, slice: i, offset: s.offset });
      }
    });
  }
  const out: Segment[][] = [];
  for (let r = 0; r < snap.rows; r++) {
    const segs: Segment[] = [];
    const row = snap.cells[r];
    if (!row) {
      out.push(segs);
      continue;
    }
    let c = 0;
    while (c < snap.cols) {
      const addr = r * snap.cols + c;
      const start = sliceStart.get(addr);
      // **幅 0 のスライスは桁を占めない**——入力欄も置かず、桁も進めない。
      // ここで `c += 0` すると**同じ桁を回り続けて segs が無限に伸び、タブごと落ちる**。
      // 3270 は属性桁が隣接すると**長さ 0 の欄**ができる（IBM i の 3270 変換で実際に出た）。
      // 5250 では起きないので、この形は今回初めて踏んだ。
      if (start && start.width > 0) {
        // スライス内の色バンド（埋め込み属性で欄途中の色が変わる場合に 2 つ以上になる）
        const bands = inputColorBands(row, c, start.width);
        // スライス＝この行に出るぶんだけの input（行またぎ欄は行ごとに 1 つずつ）
        segs.push({
          kind: "input",
          text: "",
          // 先頭色を単色フォールバック（オーバーレイ非対応時・IME 変換中に効く）
          cls: cellClass(row[c]!),
          field: start.field,
          width: start.width,
          slice: start.slice,
          offset: start.offset,
          // 色替えがある欄だけオーバーレイ用のバンドを持たせる（通常欄は従来描画）
          ...(bands.length > 1 ? { colorBands: bands } : {})
        });
        c += start.width;
        continue;
      }
      // text ラン（同一 class をまとめる）。全角も同じランに入れる。
      //
      // 桁は「全角＝半角×2」の等幅前提で合う（--screen-mono はこれを満たす日本語等幅を並べ、
      // 総称 monospace も 1:2）。入力欄も同じ前提でプレーン文字列を出しており、全角だけ
      // 1 文字ずつ箱に入れても揃う範囲は変わらない。ラン化して DOM を減らす。
      //
      // **ただし East Asian Width が Ambiguous な DBCS 文字（U+2212 '−'・U+2010 '‐'・罫線・
      // ギリシャ等）は欧文等幅フォントが 1 桁で描く**ため、そのままランに混ぜると以降の桁が
      // 左へずれる（PDM の F1 ヘルプ「オプション−ヘルプ」で実測）。この種の文字だけ 2ch 幅の
      // 箱（wide セグメント）に入れて、フォントに依らず 2 桁を占めさせる。
      const cls = cellClass(row[c]!);
      const rowSpans = legendsByRow.value.get(r + 1) ?? [];
      let text = "";
      // このテキストランが始まる桁（0 始まり）。wide セグメントで割れるたびに更新する
      let textStart = c;
      const pushText = (endCol: number): void => {
        const startCol = textStart + 1;
        segs.push({
          kind: "text",
          text,
          cls,
          col: startCol,
          ...(rowSpans.length > 0 ? { spans: localSpans(row, startCol, endCol, rowSpans) } : {})
        });
      };
      const flushText = (): void => {
        if (text !== "") pushText(c);
        text = "";
      };
      while (c < snap.cols && !fieldAt.has(r * snap.cols + c)) {
        const cellHere = row[c]!;
        if (cellHere.kind === "dbcs-tail" && hasLead(row, c)) {
          c++; // lead 側で 1 文字書いており、2 桁ぶんはその文字が占める
          continue;
        }
        if (cellClass(cellHere) !== cls) break;
        const shown = displayChar(cellHere);
        // 対を失った全角セルは 1 桁に切り詰める。孤児 tail は文字を持たないので空白 1 桁。
        // **確実に全角のグリフでも必ず箱に入れる**——素のランへ積むとフォントが 2 桁で描き、
        // それがそのまま桁ずれになる。
        if (cellHere.kind === "dbcs-tail") {
          flushText();
          segs.push({ kind: "half", text: " ", cls, col: c + 1 });
          c++;
          textStart = c;
          continue;
        }
        if (cellHere.kind === "dbcs-lead" && !hasTail(row, c)) {
          flushText();
          segs.push({ kind: "half", text: shown, cls, col: c + 1 });
          c++;
          textStart = c;
          continue;
        }
        if (cellHere.kind === "dbcs-lead" && !isCertainWideGlyph(shown)) {
          flushText();
          segs.push({ kind: "wide", text: shown, cls, col: c + 1 });
          c++;
          textStart = c;
          continue;
        }
        if (text === "") textStart = c; // flush 直後は、ここが新しいランの先頭
        text += shown;
        c++;
      }
      pushText(c);
    }
    out.push(segs);
  }
  return out;
});

/** 編集モデルが扱う論理桁数（行またぎ欄は全スライスの合計＝実フィールド長）。
 *  表示は行ごとのスライスに割るが、値・カーソル・バイト予算はこの長さで一体に扱う。 */
function visLen(f: Field): number {
  return fieldSpan(f, props.snapshot.cols, props.snapshot.rows);
}

/** フィールドのスライス一覧（表示用）。 */
function slicesOf(f: Field): FieldSlice[] {
  return fieldSlices(f, props.snapshot.cols, props.snapshot.rows);
}

/** 論理オフセットを含むスライスの番号（末尾超過は最終スライス）。 */
function sliceIndexOf(f: Field, offset: number): number {
  const s = slicesOf(f);
  for (let i = 0; i < s.length; i++) if (offset < s[i]!.offset + s[i]!.width) return i;
  return s.length - 1;
}

/** 編集後の値が欄のバイト予算（SO/SI・DBCS 2 バイト込み）に収まるか。
 *  収まらない入力は拒否/切り捨てる（送信時の FIELD_OVERFLOW を入力段で防ぐ）。 */
function fitsBytes(candidate: EditState, f: Field): boolean {
  const trimmed = editValue(candidate).replace(/ +$/, "");
  return dbcsByteLength(trimmed) <= visLen(f);
}

/** 欄の純論理値（SBCS＋DBCS、SO/SI 無し＝送信データそのもの）。
 *  編集済みなら edits の値、未編集の DBCS 欄はセル種別から SO/SI・tail を除いて再構成する
 *  （ホスト値の f.value は SO/SI を空白として含むため、そのまま送ると二重 SO/SI・余分スペースになる）。 */
function logicalValue(f: Field): string {
  const edited = props.edits.get(f.index);
  if (edited !== undefined) return edited;
  if (f.dbcsType) return logicalFromCells(f);
  return f.value;
}

/** 未編集 DBCS 欄のセルから純論理値を復元（sbcs 文字・dbcs-lead 文字を採用、so/si/dbcs-tail は除外）。
 *  行またぎ欄は全スライス（折返し先の行）を順に読む。 */
function logicalFromCells(f: Field): string {
  let s = "";
  for (const sl of slicesOf(f)) {
    const row = props.snapshot.cells[sl.row - 1];
    if (!row) continue;
    for (let i = 0; i < sl.width; i++) {
      const cell = row[sl.col - 1 + i];
      if (!cell) continue;
      if (cell.kind === "sbcs" || cell.kind === "dbcs-lead") s += cell.char;
      // **埋め込み属性はセンチネルとして残す**（core の fieldValue と同じ扱い）。
      // 空白にすると、この値を編集して送り返した時点で core の setFieldValue が
      // ただの文字セルとして書き戻し、**属性が消えてホストのソースから制御コードが落ちる**。
      // 落とす（何も足さない）のは論外で、以降が 1 桁ずつ左へずれる。
      // 既定は 0x20（通常・緑）。**0 にしてはいけない**——属性センチネルの範囲は 0x20–0x3F で、
      // 0x00 は「生バイトセンチネル」と解釈され、書き戻しで属性セルにならない（静かに劣化する）。
      else if (cell.kind === "attr") s += attrSentinel(cell.rawByte ?? 0x20);
      // so / si / dbcs-tail は論理データに含めない（SO/SI は送信時に付け直す・tail は lead が保持）
    }
  }
  return s.replace(/ +$/, ""); // 末尾パディング空白を除去
}

/** 休止・未編集 DBCS 欄の列ビューを**セルから忠実に**組む（表示専用）。
 *  SO/SI は実位置のまま（空 {} や不整合 { だけ・} だけ も保持）、SBCS は displayChar で
 *  表示コード再解釈、全角は 1 文字（2 桁）で採用する。span（displayChar）と完全に一致する。
 *  純論理値からの再構成（dbcsViewLayout）と違い SO/SI を落とさない。 */
function restViewFromCells(f: Field, shiftMark?: string): string {
  let v = "";
  for (const sl of slicesOf(f)) {
    const row = props.snapshot.cells[sl.row - 1];
    if (!row) {
      v += " ".repeat(sl.width);
      continue;
    }
    for (let i = 0; i < sl.width; i++) {
      const cell = row[sl.col - 1 + i];
      if (!cell) {
        v += " ";
        continue;
      }
      if (cell.kind === "dbcs-tail") continue; // lead が 2 桁ぶんを担う
      // shiftMark 指定時は SO/SI をその印にする（コピー経路が制御桁を識別するため。SHIFT_MARK 参照）
      if (shiftMark !== undefined && (cell.kind === "so" || cell.kind === "si")) {
        v += shiftMark;
        continue;
      }
      // displayChar が SO/SI マーク・表示コード再解釈・nonDisplay 抑止をまとめて扱う（span と一致）
      v += displayChar(cell);
    }
  }
  return v;
}

/** 編集モデル初期値（純論理値をスペース埋め）。フォーカス中の input はこれを表示する。 */
function inputValue(f: Field): string {
  const v = logicalValue(f);
  if (f.hidden) return v;
  const vl = visLen(f);
  return v.length >= vl ? v.slice(0, vl) : v.padEnd(vl, " ");
}

// SO/SI の表示マーク。showShiftMarks（ACS Ctrl+F 相当）が ON なら { } 、既定は空白。
// displayChar（ホスト由来 SO/SI セル）と一致させる。
function soMark(): string {
  return props.showShiftMarks ? "{" : " ";
}
function siMark(): string {
  return props.showShiftMarks ? "}" : " ";
}

/** hidden 欄の表示値を作る（非 hidden はそのまま）。
 *
 *  type=password はパディング空白まで ● にしてしまい、空欄でも欄長ぶんの ● が並ぶ。かといって
 *  実入力分へ切り詰めると、native caret が値長までしか動けず未入力桁へカーソルを置けなくなる
 *  （5250 は欄内どこへでもカーソルを置ける）。そこで input は type=text とし、こちらで
 *  「入力済み桁＝●・未入力桁＝本物の空白」を組み立てて欄長までパディングする。
 *  これで ● の数は実入力分だけ・カーソルは欄内を自由に移動でき、かつ実値は DOM に出ない。 */
function maskSafe(f: Field, value: string): string {
  if (!f.hidden) return value;
  /**
   * **非表示欄は伏せ字も出さない（ACS 準拠）。** 打鍵の手応えは消えるが、ACS は
   * 非表示属性の欄に何も描かない。伏せ字を出すと「ACS には無いものが見える」状態になり、
   * ヘルプ画面の 1 桁欄で実際に食い違いとして現れた。
   * 桁は保つ必要があるため欄長ぶんの空白で埋める（カーソルは欄内を自由に動ける）。
   */
  return "".padEnd(visLen(f), " ");
}

/** スライス（行ごとの input）に表示する値。論理値の該当区間を切り出しスライス幅へ揃える。
 *  SBCS は 1 桁=1 文字なので単純な切り出し。DBCS は全角が 2 桁を占めるため「桁」で割る。 */
function sliceValue(f: Field, sliceIdx: number): string {
  const s = slicesOf(f)[sliceIdx];
  if (!s) return "";
  // 休止表示なので props 由来のレイアウトを使う（編集モデルを見ると blur で値が戻らない）
  if (isDbcsEdit(f)) return dbcsSliceText(dbcsRestLayout(f), s);
  // 表示コード再解釈中の休止 SBCS 欄は、span（displayChar）と同じくセルの生バイトから読み直す。
  // これをしないと span だけ再解釈・input は素のままで食い違う（表示コード切替が input に効かない）。
  if (usesShiftCells(f) || usesRecodedCells(f)) return shiftCellsView(s);
  if (s.offset === 0 && s.width >= visLen(f)) return displayValue(f); // 単一スライス
  return displayValue(f).slice(s.offset, s.offset + s.width).padEnd(s.width, " ");
}

/**
 * FCW で DBCS 宣言されていないのに SO/SI 混在データが書かれた欄か。
 *
 * ホストは**出力専用の欄に FCW を付けないことがある**（PDM のテキスト列など）。この欄は
 * `f.dbcsType` が undefined なので DBCS 用の描画経路（dbcsRestLayout）に入らず、
 * core の `fieldValue` が SO/SI を空白に潰した値をそのまま表示していた。結果、
 * SO/SI マーク表示（ACS の Ctrl+F 相当）が ON でも `{ }` が出ず、空白のままだった。
 *
 * 編集中の欄は編集モデルが真実なのでセルを見ない。
 */
function usesShiftCells(f: Field): boolean {
  if (f.dbcsType || f.hidden) return false;
  if (props.edits.get(f.index) !== undefined) return false;
  return slicesOf(f).some((s) => {
    const row = props.snapshot.cells[s.row - 1];
    if (!row) return false;
    for (let i = 0; i < s.width; i++) {
      const kind = row[s.col - 1 + i]?.kind;
      if (kind === "so" || kind === "si") return true;
    }
    return false;
  });
}

/** その欄を再解釈表示（セルの生バイトを対の表で読み直す）にするか。
 *  - 再解釈なし（host）・確定編集済み（props.edits にある）は対象外（編集値。送信値と食い違わせない）。
 *  - **フォーカス中でも、まだ打鍵していない（編集モデル＝元セル内容）なら再解釈を維持**。打鍵して
 *    編集モデルが元と変わった瞬間から編集値に戻す。これで「未編集欄はフォーカスしても
 *    再解釈のまま、編集し始めたら素の値」を satisfy する（送信値は常に元バイト）。 */
function recodeViewActive(f: Field): boolean {
  if (props.sbcsView === "host") return false;
  if (props.edits.get(f.index) !== undefined) return false;
  if (editFieldIndex === f.index && edit) {
    return editValue(edit).replace(/ +$/, "") === baselineValue(f);
  }
  return true; // 休止 or 未フォーカスの未編集欄
}

/** 再解釈表示中の SBCS 欄は、span（displayChar）と同じくセルの生バイトから読み直す。
 *  input の :value も cell ビューにしないと、span だけ再解釈・input は素のままになる。
 *  DBCS/hidden は対象外（DBCS は dbcsRestLayout、hidden は伏せ字）。 */
function usesRecodedCells(f: Field): boolean {
  if (f.dbcsType || f.hidden) return false;
  return recodeViewActive(f);
}

/** 欄のセルからそのまま列ビューを作る（SO/SI は表示マーク・表示コード再解釈・全角は 1 文字で 2 桁ぶん）。 */
function shiftCellsView(s: FieldSlice): string {
  const row = props.snapshot.cells[s.row - 1];
  if (!row) return "".padEnd(s.width, " ");
  let out = "";
  for (let i = 0; i < s.width; i++) {
    const cell = row[s.col - 1 + i];
    if (!cell) {
      out += " ";
      continue;
    }
    if (cell.kind === "dbcs-tail") continue; // lead 側が 2 桁ぶんを担う
    // displayChar が SO/SI マーク・カナ再解釈・nonDisplay 抑止をまとめて扱う（span と一致）
    out += displayChar(cell);
  }
  return out;
}

/** 列ビューをスライスの桁範囲で切り出す。境界にまたがる全角は前スライスの末尾に置き（input 幅で
 *  クリップされ左半分が行末に出る）、次スライスは空白 1 桁で始める＝ACS の桁割りと一致させる。 */
function dbcsSliceText(lay: DbcsViewLayout, s: FieldSlice): string {
  const r = lay.sliceRange(s.offset, s.offset + s.width);
  const text = (r.leadBlank ? " " : "") + lay.view.slice(r.from, r.to);
  const cols = (r.leadBlank ? 1 : 0) + lay.columnsBefore(r.to) - lay.columnsBefore(r.from);
  return text + " ".repeat(Math.max(0, s.width - cols)); // 予算に満たない末尾を桁まで埋める
}

/** スライス内 caret ⇔ 欄全体の列ビュー index。またがる全角のぶん（leadBlank）を吸収する。 */
function dbcsSliceRangeOf(f: Field, sliceIdx: number, lay: DbcsViewLayout) {
  const s = slicesOf(f)[sliceIdx] ?? slicesOf(f)[0]!;
  return { s, ...lay.sliceRange(s.offset, s.offset + s.width) };
}
function localCaret(r: { from: number; leadBlank: boolean }, viewIdx: number): number {
  return Math.max(0, (r.leadBlank ? 1 : 0) + (viewIdx - r.from));
}
function globalCaret(r: { from: number; leadBlank: boolean }, local: number): number {
  return r.from + Math.max(0, local - (r.leadBlank ? 1 : 0));
}

/** input の :value（休止時の表示）。DBCS 欄は列ビュー（SO/SI 込み）で表示する。 */
function displayValue(f: Field): string {
  if (f.hidden) return maskSafe(f, logicalValue(f));
  // DBCS も欄長までスペース埋めした列ビューにする。logicalValue は末尾空白除去済みのため、
  // ここで埋めないと休止表示だけ短くなり、未入力桁にカーソルを置けない・桁がずれる
  // （フォーカス中は beginEdit がパディングするので、休止時と座標系が食い違ってしまう）。
  if (f.dbcsType) return dbcsRestLayout(f).view;
  return inputValue(f);
}

/** 休止時（props 由来）の列ビューのレイアウト。編集モデルは見ない。
 *  :value バインド・blur の復帰・矩形コピーはこちら、編集中の同期は dbcsLayoutOf を使う。 */
function dbcsRestLayout(f: Field): DbcsViewLayout {
  // セルから忠実に列ビューを組む条件:
  //  - 休止・未編集: SO/SI の実位置・空・不整合を保持（#144）。
  //  - **フォーカス中でも recodeViewActive（未打鍵の再解釈表示欄）**: フォーカスしても再解釈を維持する。
  // 編集済み・打鍵後の欄は送信値（logicalValue）由来の再構成列ビューを使う（従来どおり・素の値）。
  const resting = editFieldIndex !== f.index && props.edits.get(f.index) === undefined;
  if (resting || recodeViewActive(f)) {
    return columnViewLayout(restViewFromCells(f));
  }
  return dbcsViewLayout(padDbcs(f, [...logicalValue(f)]).join(""), soMark(), siMark());
}

// ---- フィールド編集（native input 制御方式: keydown を制御して 5250 上書きモード等を実現） ----
//
// 【カーソル／編集モデルの協調（EmulatorPane との役割分担）】
//   - ScreenGrid（本ファイル）: フィールド内の「文字編集」の真実を持つ（`edit: EditState`）。
//     文字入力・上書き/挿入・バックスペース・欄内の桁移動を担う。
//   - EmulatorPane: フィールド「間」の移動（Tab/矢印/Home/End）を担い、対象 <input> に focus() して
//     setSelectionRange で桁を指定する（ScreenGrid の edit には直接触れない）。
//   - 両者を繋ぐ単一の真実は「native input の caret（selectionStart）」。EmulatorPane は caret を動かし、
//     ScreenGrid は onInputKeydown の冒頭で `edit.cursor` を native caret に追従させる（クリック配置も同様）。
//     これにより「どこにカーソルを置いても、そこから入力できる」（ACS 準拠）を分割設計のまま実現する。
//   - フォーカス時は onInputFocus / focusCursorField で caret を先頭へ置く（スペース埋め表示だと
//     value 再設定で caret が末尾へ飛ぶため、明示的に補正する）。
const composing = ref(false);
/**
 * blur 時に行を 1 度だけ再描画させるためのティック。編集した色付き欄のオーバーレイは
 * props.edits の値を反映するが、行は v-memo で編集中は再描画されない（入力は writeSlices で直更新）。
 * フォーカスが外れたら（onInputBlur で ++）オーバーレイを編集値の色付きに描き直す。
 * **フォーカス中は増やさない**——編集中に再描画するとキャレット/IME が乱れるため。
 */
const renderTick = ref(0);
const insertMode = defineModel<boolean>("insertMode", { default: false });
let edit: EditState | undefined;
let editFieldIndex = -1;
let composeStart = 0; // IME 合成を開始した欄内桁（compositionend で上書き開始位置に使う）
let composePrefixLen = 0; // 合成中の <input> に残した prefix の文字数（確定分の切り出し起点）
// 合成開始時に選択を削除したか。削除したなら確定文字は「挿入」で跡を埋める（上書きだと後続まで食う）
let composeReplacedSelection = false;

/** DBCS 欄はライブ列ビュー編集（純論理値・非パディング・挿入モード）で扱う。 */
function isDbcsEdit(f: Field): boolean {
  return !!f.dbcsType && !f.hidden;
}

function beginEdit(f: Field, inputEl: HTMLInputElement): void {
  if (isDbcsEdit(f)) {
    // 純論理値（SO/SI 無し）＋末尾空白パディング。列ビューは sync で導出、カーソルは論理インデックス。
    // パディングは SBCS 欄と同じ目的: 未入力桁にもカーソルを置けるようにする（5250 は欄内自由）。
    // 上書きが既定（Insert でトグル）で、これも SBCS 欄と揃える。
    edit = { chars: padDbcs(f, [...logicalValue(f)]), cursor: 0, insertMode: insertMode.value };
    editFieldIndex = f.index;
    return;
  }
  edit = initEdit(inputValue(f), visLen(f), inputEl.selectionStart ?? 0);
  edit.insertMode = insertMode.value;
  editFieldIndex = f.index;
}

// ---- DBCS 論理編集オペレーション（chars = 純論理値の配列＋末尾空白パディング） ----

/** バイト予算（SO/SI・全角 2 バイト込み）いっぱいまで末尾を空白で埋める。
 *  未入力桁へカーソルを置けるようにするため（SBCS 欄の inputValue と同じ役割）。 */
function padDbcs(f: Field, chars: readonly string[]): string[] {
  const budget = visLen(f);
  const out = [...chars];
  while (dbcsByteLength(out.join("")) < budget) out.push(" ");
  // 予算超過（ホスト値がそもそも長い等）は末尾から削る
  while (out.length > 0 && dbcsByteLength(out.join("")) > budget) out.pop();
  return out;
}

/** 予算超過ぶんを末尾の空白パディングで吸収する（全角は SO/SI で最大 4 桁ぶん増えるため）。
 *  カーソルより後ろの空白だけを削り、既入力は守る。削り切れなければ undefined（＝入力を拒否）。 */
function absorbDbcs(chars: string[], budget: number, cursor: number): string[] | undefined {
  const out = [...chars];
  while (dbcsByteLength(out.join("")) > budget) {
    if (out.length <= cursor || out[out.length - 1] !== " ") return undefined;
    out.pop();
  }
  return out;
}

/**
 * **上書きで変わったバイト長（＝桁数）を元へ戻す。後続の桁を動かさないための調整（ACS 相当）。**
 *
 * 全角は SO/SI 込みで最大 4 桁を占め、半角で潰せば逆に桁が余る。1 文字を置換して終わりにすると
 * 欄のバイト長が変わり、離れた桁の文字まで左右へずれる。そこで置換後、**バイト長が元と同じに
 * 戻るまで**「後続を 1 文字食う」「空白を 1 桁足す」を `at` の直後で繰り返す。
 * 潰れかけた全角は消え、空いた桁は空白になり、その先の文字は元の桁に残る。
 *
 *   " あいう    #" の先頭桁へ全角 `１` → `{１} {う}    #`（`あ` と `い` が潰れ `う` は元の桁）
 *   "あいうえお    #" を半角空白で潰す → 全角が消えても後ろの `#` は動かない
 *   `{１}    AAA` の先頭桁へ半角 `AAA` → 全角は消えるが `AAA` は元の桁のまま
 *
 * 空白を足すと全角ランが分断されて **行き過ぎる**（SO/SI が 1 組増える）ことがある。
 * そのときは先に後続を 1 文字食ってから足す（上の `{１} {う}` はこの経路で決まる）。
 * 打鍵（`dbcsType`）とペースト（`overwriteInto`）で同じ規則を使う。
 */
function keepByteLength(chars: string[], at: number, before: number, budget: number): void {
  const next = at + 1;
  // 1 回で「食う」か「足す」のどちらかが進むので、最大でも欄の桁数ぶんで収束する
  for (let guard = chars.length + budget; guard > 0; guard--) {
    const len = dbcsByteLength(chars.join(""));
    if (len === before) return;
    if (len < before) {
      const trial = [...chars];
      trial.splice(next, 0, " ");
      if (dbcsByteLength(trial.join("")) <= before) {
        chars.splice(next, 0, " ");
        continue;
      }
    }
    if (chars.length <= next) return; // 後続が無い＝これ以上は調整できない
    chars.splice(next, 1);
  }
}

/** 文字入力（5250 既定＝上書き。insertMode なら挿入）。 */
function dbcsType(e: EditState, ch: string, f: Field): EditState | undefined {
  const budget = visLen(f);
  const chars = [...e.chars];
  if (e.insertMode || e.cursor >= chars.length) {
    chars.splice(e.cursor, 0, ch);
  } else {
    const before = dbcsByteLength(chars.join(""));
    chars[e.cursor] = ch;
    keepByteLength(chars, e.cursor, before, budget); // 上書きで桁を動かさない
  }
  const fit = absorbDbcs(chars, budget, e.cursor + 1);
  if (!fit) return undefined;
  return { ...e, chars: padDbcs(f, fit), cursor: e.cursor + 1 };
}

function dbcsBackspace(e: EditState, f: Field): EditState {
  if (e.cursor <= 0) return e;
  const chars = [...e.chars];
  chars.splice(e.cursor - 1, 1);
  return { ...e, chars: padDbcs(f, chars), cursor: e.cursor - 1 };
}
function dbcsDelete(e: EditState, f: Field): EditState {
  if (e.cursor >= e.chars.length) return e;
  const chars = [...e.chars];
  chars.splice(e.cursor, 1);
  return { ...e, chars: padDbcs(f, chars) };
}
function dbcsMove(e: EditState, delta: number): EditState {
  return { ...e, cursor: Math.max(0, Math.min(e.cursor + delta, e.chars.length)) };
}

/** sync が起こす focus 中は true。onInputFocus に編集モデルを作り直させないための印。 */
let syncingFocus = false;

/**
 * DBCS 欄の座標変換の単一の入口。
 *
 * DBCS 欄には座標系が 4 つある:
 *   - 論理   : edit.chars の index（純 Unicode・SO/SI 無し。折返しの桁揃えスペースは含む）
 *   - 列ビュー: columnView 文字列の index（SO/SI が 1 文字・全角も 1 文字）
 *   - 表示桁 : 欄先頭からの桁（全角は 2 桁・SO/SI は 1 桁）
 *   - スライド内 caret: 行ごとの <input> の selectionStart（＝列ビュー index からスライス先頭を引いた値）
 * これらは全角があると一致しない。各ハンドラが dbcsViewLayout を個別に呼んで引数を組み立てて
 * いたため、「trim 済みを渡す」「SO/SI マークを渡し忘れる」といった食い違いが繰り返し混入した
 * （未入力欄で logicalOf が 0 を返し先頭へ飛ぶ、{ } 表示で caret がずれる 等）。
 *
 * 値は常に「パディング込みの編集値」、マークは常に現在の soMark/siMark を使う。呼び出し側は
 * 引数を組み立てないこと。編集中でない欄では props 由来の論理値をパディングして使う。
 */
function dbcsLayoutOf(f: Field): ReturnType<typeof dbcsViewLayout> {
  const value =
    edit && editFieldIndex === f.index ? editValue(edit) : padDbcs(f, [...logicalValue(f)]).join("");
  return dbcsViewLayout(value, soMark(), siMark());
}

/** DBCS 欄で、その <input> が担当するスライスの範囲（native caret ⇔ 欄全体の view 座標の変換用）。 */
function rangeOfInput(f: Field, el: HTMLInputElement, lay = dbcsLayoutOf(f)) {
  return dbcsSliceRangeOf(f, Number(el.dataset["slice"] ?? 0), lay);
}

/** その <input> が担当するスライスの論理オフセット（data-slice から引く）。 */
function sliceOffsetOf(f: Field, el: HTMLInputElement): number {
  const si = Number(el.dataset["slice"] ?? 0);
  return slicesOf(f)[si]?.offset ?? 0;
}

/** フィールドの指定スライスの <input> を引く（行またぎ欄は行ごとに存在する）。 */
function inputForSlice(f: Field, sliceIdx: number): HTMLInputElement | undefined {
  return (
    gridEl.value?.querySelector<HTMLInputElement>(
      `input.grid-input[data-field-index="${f.index}"][data-slice="${sliceIdx}"]`
    ) ?? undefined
  );
}

/** 論理値を全スライスの <input> へ書き戻す（hidden は伏せ字化してから割る）。 */
function writeSlices(f: Field, full: string): void {
  // 未打鍵の再解釈表示欄はフォーカス中もセル由来の再解釈列ビューを保つ（打鍵で editVal!=baseline になれば素の値へ）。
  const recoded = recodeViewActive(f);
  const masked = maskSafe(f, full);
  slicesOf(f).forEach((s, i) => {
    const el = inputForSlice(f, i);
    if (!el) return;
    // 表示はセンチネル→空白（編集モデルはセンチネル込みのまま。見た目は従来どおりの空白）
    el.value = recoded
      ? displayText(stripSentinels(sliceValue(f, i)))
      : displayText(stripSentinels(masked.slice(s.offset, s.offset + s.width))).padEnd(s.width, " ");
  });
}

/**
 * この欄の「最後に確定した値」。編集済みなら edits の値、未編集なら元の論理値。
 * **カーソル移動だけで編集（MDT）扱いにしない**ための基準——値が変わっていなければ
 * `emit("edit")` を出さず、edits に載せない（載ると送信され core が MDT を立て、
 * ホスト側で行が変更扱いになり、埋め込み色属性まで失われる）。
 */
function baselineValue(f: Field): string {
  const edited = props.edits.get(f.index);
  if (edited !== undefined) return edited;
  return (f.dbcsType ? logicalFromCells(f) : f.value).replace(/ +$/, "");
}

function sync(inputEl: HTMLInputElement, f: Field): void {
  if (!edit) return;
  if (isDbcsEdit(f)) {
    syncDbcs(inputEl, f);
    return;
  }
  const full = editValue(edit);
  const trimmed = full.replace(/ +$/, "");
  // キャレットのあるスライスへ先にフォーカスを移す。focus/blur ハンドラは props（emit 前で古い）から
  // 値を書くため、その後に writeSlices で全スライスを正しい値へ上書きする（順序が逆だと古い値が残る）。
  const si = sliceIndexOf(f, edit.cursor);
  const slice = slicesOf(f)[si]!;
  const target = inputForSlice(f, si) ?? inputEl;
  if (document.activeElement !== target) {
    syncingFocus = true; // onInputFocus に編集モデルを作り直させない（下の writeSlices が確定する）
    target.focus();
    syncingFocus = false;
  }
  // 行またぎ欄は行ごとに input が分かれるため、全スライスへ書き戻す（v-memo で :value 再描画が来ない）。
  // 送信値（emit）は常に末尾空白除去。
  writeSlices(f, full);
  const c = Math.min(edit.cursor - slice.offset, target.value.length);
  target.setSelectionRange(c, c);
  insertMode.value = edit.insertMode;
  // **値が変わったときだけ編集を発火**（カーソル移動だけでは MDT にしない・バグ1）
  if (trimmed !== baselineValue(f)) emit("edit", f.index, trimmed);
  // 欄内のキャレット移動・入力で論理カーソルも追従させる（AID 送信位置・オーバーレイ整合）。
  // 末尾（cursor===visLen）は欄の右端境界を指し、reconcileFocus がそれを「欄の末尾」として欄内に留める。
  const pos = posOfOffset(f, Math.min(edit.cursor, visLen(f)), props.snapshot.cols, props.snapshot.rows);
  emit("cursor", pos.row, pos.col);
}

/** DBCS 欄の sync: 列ビュー（SO/SI スペース込み）を行ごとのスライスへ割り、caret を論理カーソルの桁へ。 */
function syncDbcs(inputEl: HTMLInputElement, f: Field): void {
  if (!edit) return;
  // 表示はパディング込みの列ビュー（未入力桁にもカーソルを置けるようにするため）。
  // 送信値（emit）は末尾パディングを除いた純論理値。
  const logical = editValue(edit).replace(/ +$/, "");
  const lay = dbcsLayoutOf(f);
  const caret = lay.caretOf(edit.cursor); // 欄全体の列ビュー index
  const col = Math.min(lay.columnsBefore(caret), visLen(f) - 1); // 欄先頭からの表示桁
  const si = sliceIndexOf(f, col);
  const s = slicesOf(f)[si]!;
  // キャレットのあるスライスへ先にフォーカスを移す（focus/blur ハンドラが古い props から
  // 書き戻すため、そのあとに全スライスを正しい値で上書きする）。
  const target = inputForSlice(f, si) ?? inputEl;
  if (document.activeElement !== target) {
    syncingFocus = true; // onInputFocus に編集モデルを作り直させない
    target.focus();
    syncingFocus = false;
  }
  // 未打鍵の再解釈表示欄はフォーカス中もセル由来の再解釈列ビュー（打鍵で editVal!=baseline になれば素の値へ）。
  // caret は編集モデル（lay）で決めるが、未打鍵欄は列構造が一致するので桁はズレない。
  const recoded = recodeViewActive(f);
  slicesOf(f).forEach((sl, i) => {
    const el = inputForSlice(f, i);
    // **フォーカス中もセンチネルは見せない。** 休止時はテンプレートが stripSentinels を通すが、
    // ここは同期処理が直接代入するので、同じ処理を通さないと制御コードが豆腐で見える。
    if (el) el.value = recoded ? displayText(stripSentinels(sliceValue(f, i))) : stripSentinels(dbcsSliceText(lay, sl));
  });
  const local = localCaret(lay.sliceRange(s.offset, s.offset + s.width), caret); // スライス内 caret
  target.setSelectionRange(local, local);
  insertMode.value = edit.insertMode;
  // **値が変わったときだけ編集を発火**（カーソル移動だけでは MDT にしない・バグ1）
  if (logical !== baselineValue(f)) emit("edit", f.index, logical);
  // 論理カーソルの表示桁（DBCS=2 桁）を AID 位置へ反映
  emit("cursor", s.row, s.col + (col - s.offset));
}

/**
 * ACS の自動送り: **カーソルが欄の末尾まで進んだら**次の入力欄へ送るよう通知。
 *
 * 条件は SBCS / DBCS 欄で共通にする。以前は DBCS 欄だけ「バイト予算が満杯か」で判定していたが、
 * **既に埋まっている欄では 1 打鍵目から真**になり、上書きで先頭を打ち替えただけで次の欄へ飛んでいた
 * （実機の CHGJOB プロンプト。日本語機は入力欄を `dbcsType: "open"` と宣言するので、
 * 見た目が半角だけの欄でもこの分岐に入る）。空欄を埋めるときは最後の文字で初めて真になるため
 * 正常に見えていたのがたちが悪い。
 *
 * カーソル基準でも DBCS の予算は取りこぼさない——全角入力で予算が尽きると `absorbDbcs` が
 * 末尾の空白を削って `chars` が短くなるので、カーソルはその分早く末尾に届く。
 */
function advanceIfFull(f: Field): void {
  if (!edit) return;
  if (edit.cursor < edit.chars.length) return;
  // **FER（FFW 0x0040）は自動送りしない。** ホストが「Field Exit を押して出ろ」と指定した欄。
  // 原典は FER 標識を立てて他キーまで抑止するが（GNU tn5250 `display.c:1035`）、本実装は
  // 満杯の欄に以降の打鍵が入らないので、自動送りを止めるだけで実機と同じ操作感になる
  // （Field Exit か Tab で出る）。FER と AUTO_ENTER が同時なら FER が勝つ——原典も
  // FER の枝の中では auto-enter を見ない。
  if (f.fieldExitRequired) return;
  if (f.autoEnter) {
    emit("aid", "Enter"); // AUTO_ENTER（FFW 0x0080）: 次欄へ送る代わりに Enter を自動送信
    return;
  }
  emit("field-full", f.index);
}

// ---------------------------------------------------------------------------
// ローカル編集キー（Field Exit / Erase EOF / Erase Input）
//
// **ホストへは送らない端末内の操作**。編集モデル（edit / editFieldIndex）を持つのはここなので
// 実行はこの component が担い、**欄から欄への移動は EmulatorPane**（従来の役割分担どおり）。
// キーの割り当ては `stores/keybindings.ts` の `local:*`。
// ---------------------------------------------------------------------------

/** 編集中の欄と、caret のあるスライスの <input>。編集中でなければ undefined。 */
function currentEditTarget(): { f: Field; el: HTMLInputElement } | undefined {
  if (!edit || editFieldIndex < 0) return undefined;
  const f = props.snapshot.fields.find((x) => x.index === editFieldIndex);
  if (!f || f.protected) return undefined;
  const el = inputForSlice(f, sliceIndexOf(f, edit.cursor));
  return el ? { f, el } : undefined;
}

/**
 * Field Exit: カーソル以降を消し、FFW の ADJUST どおり右寄せして次の入力欄へ。
 *
 * **DBCS 欄では右寄せしない**（消去と欄移動だけ）。全角は SO/SI と 2 バイトで桁を占めるため、
 * 桁単位で寄せると対を壊す。実機に DBCS ＋ ADJUST の構成を確認できていないので、
 * 分からないものを整形しない側へ倒す。
 */
function fieldExitKey(): void {
  const t = currentEditTarget();
  if (!t || !edit) {
    emit("notice", MSG_PROTECTED);
    return;
  }
  edit = isDbcsEdit(t.f) ? eraseToEnd(edit) : fieldExit(edit, t.f);
  sync(t.el, t.f); // 値が変われば emit("edit") が出る＝MDT が立つ
  // AUTO_ENTER 欄は**次欄へ移らず Enter を送る**（原典は Field Exit / Field± / Dup の
  // すべてで同じ形。GNU tn5250 `display.c:1637`）。FER 欄でも Field Exit なら出られるので、
  // ここは advanceIfFull と違って FER を見ない。
  if (t.f.autoEnter) {
    emit("aid", "Enter");
    return;
  }
  emit("field-full", t.f.index); // 次の入力欄へ（自動送りと同じ経路）
}

/**
 * Field− / Field+: Field Exit と同じ整形をしてから**符号桁に符号を確定**し、次の欄へ。
 *
 * **符号付き数値欄でだけ符号が付く**（それ以外は Field Exit と同じ。`fieldEdit.fieldSign` の
 * コメント参照）。DBCS 欄は Field Exit と同じく右寄せしない。
 */
function fieldSignKey(negative: boolean): void {
  const t = currentEditTarget();
  if (!t || !edit) {
    emit("notice", MSG_PROTECTED);
    return;
  }
  edit = isDbcsEdit(t.f) ? eraseToEnd(edit) : fieldSign(edit, t.f, negative);
  sync(t.el, t.f);
  if (t.f.autoEnter) {
    emit("aid", "Enter");
    return;
  }
  emit("field-full", t.f.index);
}

/**
 * Dup: カーソルから欄末尾までを複写文字（EBCDIC `0x1C`）で埋めて次の欄へ。
 *
 * **ホストが `DUP_ENABLE` を立てた欄でだけ効く**（原典 `display.c:1795-1835`）。
 * 立っていない欄では**値を変えずに**操作員メッセージだけ出す。
 */
function dupKey(): void {
  const t = currentEditTarget();
  if (!t || !edit) {
    emit("notice", MSG_PROTECTED);
    return;
  }
  if (!t.f.dupEnable) {
    emit("notice", MSG_DUP_DISALLOWED);
    return;
  }
  edit = dupFill(edit, rawSentinel(DUP_BYTE));
  sync(t.el, t.f);
  // FER 欄は満杯でも欄に留まるのが実機（原典も Dup の後に FER を見る）
  if (t.f.fieldExitRequired) return;
  if (t.f.autoEnter) {
    emit("aid", "Enter");
    return;
  }
  emit("field-full", t.f.index);
}

/**
 * **数値欄で `-` / `+` を打ったら文字として入れず Field− / Field+ を走らせる**（原典の
 * `sign_key_hack`。GNU tn5250 `display.c:927-940`）。処理したら true。
 *
 * これが無いと `-12` と打てて**そのまま送れてしまう**が、ホストは先頭の符号を無視して
 * `12` を受け取る——**利用者は負値を入れたつもりで正値を送る**（SR-OSAKA で実測）。
 * 打った通りに送れないなら打たせない、という方に倒す。
 *
 * ペースト・マクロ・MCP はこの経路を通らない（打鍵だけの規則）。
 */
function signKeyHack(f: Field, key: string): boolean {
  if (!f.numeric || (key !== "-" && key !== "+")) return false;
  fieldSignKey(key === "-");
  return true;
}

/** Erase EOF: カーソルから欄末尾まで消す。**欄は出ず・カーソルも動かさず・右寄せもしない**。 */
function eraseEofKey(): void {
  const t = currentEditTarget();
  if (!t || !edit) {
    emit("notice", MSG_PROTECTED);
    return;
  }
  edit = eraseToEnd(edit);
  sync(t.el, t.f);
}

/**
 * Erase Input: 画面上のすべての入力欄をクリアする。
 *
 * **中身のある欄だけ**を対象にする。もともと空の欄まで編集扱いにすると、触っていない欄に
 * MDT が立ってホストへ空白が送られる（画面は何も変わっていないのに変更として届く）。
 */
function eraseInputKey(): void {
  const editable = props.snapshot.fields.filter((f) => !f.protected);
  if (editable.length === 0) {
    emit("notice", MSG_PROTECTED);
    return;
  }
  for (const f of editable) {
    if (logicalValue(f).replace(/ +$/, "") === "") continue;
    emit("edit", f.index, "");
    writeSlices(f, " ".repeat(visLen(f)));
  }
  // 編集モデルは捨てる（値を消した欄の caret 位置を持ち越さない）。
  // フォーカスの移動は呼び出し側（EmulatorPane）が先頭の入力欄へ行う。
  edit = undefined;
  editFieldIndex = -1;
}

/** 画面のホストカーソル位置にある入力欄へフォーカスを当てる（無ければ先頭の入力欄）。
 *  フォーカスにより onInputFocus が発火し beginEdit＋cursor 通知が行われる。 */
function focusCursorField(): void {
  if (!gridEl.value) return;
  const snap = props.snapshot;
  const editable = snap.fields.filter((f) => !f.protected);
  if (editable.length === 0) return;
  const cur = snap.cursor;
  /**
   * **ホストが送ったカーソル位置を桁まで忠実に再現する。**
   * SEU は確定・F キー・スクロールの後もカーソルを元の桁に置いて返す（入力位置を保つ仕様）。
   * こちらが欄の先頭や第 1 欄へ寄せると、その意図を毎回潰してしまう。
   *
   * 旧実装には 2 つの取りこぼしがあった。
   *  - フィールド番号（欄単位）で、行またぎで分割された input（スライス単位）の NodeList を
   *    引いていた。SEU のように欄が折り返す画面では添字がずれ、無関係な欄へ飛ぶ。
   *  - 桁を捨てて常に先頭（offset 0）へ置いていた。
   */
  const f = fieldAt(cur.row, cur.col, snap.fields, snap.cols, snap.rows);
  if (!f || f.protected) {
    /**
     * **入力欄の外を指されたら、その位置に置く**（自由カーソル）。先頭欄へ寄せない。
     *
     * SEU の走査検索（表示モード）はまさにこれ——ホストは見つかった文字列の頭に
     * `IC` を送るが、表示モードではその桁が保護欄なので、先頭欄へ寄せると
     * `SEU==>` へ飛んでしまい**どこが見つかったのか分からなくなる**（利用者の指摘）。
     * ACS は指された桁にカーソルを置く。
     *
     * 「ホストがカーソルを置かなかった画面」を心配して先頭欄へ寄せていたが、
     * **その正規化は既に protocol 層で済んでいる**——`session.ts` は
     * `readRequested && !cursorSet` のときに `cursorToFirstInputField()` を通す。
     * ここまで来る「欄の外」は、ホストが**わざと**そこを指した場合だけ。
     */
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && gridEl.value.contains(active)) active.blur();
    // 親（`reconcileFocus`）が入力欄を外してペインへ focus し、オーバーレイで桁を出す
    emit("cursor", cur.row, cur.col);
    return;
  }
  const offset = caretInField(f, cur.row, cur.col, snap.cols, snap.rows);
  const slices = fieldSlices(f, snap.cols, snap.rows);
  let si = slices.findIndex((s) => offset < s.offset + s.width);
  if (si < 0) si = slices.length - 1;
  const el = gridEl.value.querySelector<HTMLInputElement>(
    `input.grid-input[data-field-index="${f.index}"][data-slice="${si}"]`
  );
  if (!el) return;
  el.focus();
  if (isDbcsEdit(f)) {
    // DBCS 欄は列ビュー（全角=2 桁・SO/SI 込み）で caret を測るため専用経路へ委ねる
    setDbcsCaretAtColumn(f.index, cur.row, cur.col);
    return;
  }
  // スペース埋め表示だと value 再設定でカーソルが末尾へ行くため明示的に置く
  // （既にフォーカス済みだと focus() では onInputFocus が発火しないため）
  const caret = offset - slices[si]!.offset;
  el.setSelectionRange(caret, caret);
  if (edit) edit.cursor = offset;
}

// 画面遷移（新 snapshot）で編集状態をリセットし、キーボード解放時はカーソル欄へ自動フォーカス。
// これで「同じ field index の別画面で直前のコマンドが残る」問題を防ぎ、遷移後すぐ入力できる。
watch(
  () => props.snapshot,
  (snap) => {
    edit = undefined;
    editFieldIndex = -1;
    if (props.focused && snap && !snap.keyboardLocked) {
      nextTick(() => focusCursorField());
    }
  }
);

// このペインがフォーカスされたとき（タブ切替等）もカーソル欄へフォーカス
watch(
  () => props.focused,
  (isFocused) => {
    if (isFocused && !props.snapshot.keyboardLocked) nextTick(() => focusCursorField());
  }
);

// Shift 併用で範囲選択に使う移動キー（横方向のみ。上下は欄間移動なので対象外）
const SELECT_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/** native 選択（範囲）があれば edit モデルから削除し cursor を選択開始へ寄せる。削除したら true。
 *  Backspace/Delete/文字入力で「選択を消す/置換する」通常のテキストエディタ挙動に使う。 */
function deleteSelection(f: Field, el: HTMLInputElement): boolean {
  if (!edit) return false;
  if (isDbcsEdit(f)) {
    const sel = dbcsSelection(f, el); // 列ビュー選択 → 論理範囲 [ls,le)（SO/SI は含まない）
    if (!sel) return false;
    const chars = [...edit.chars];
    chars.splice(sel.ls, sel.le - sel.ls);
    edit = { ...edit, chars, cursor: sel.ls };
    return true;
  }
  const base = sliceOffsetOf(f, el); // 行またぎ欄: この input が担当する論理オフセット
  const s = base + (el.selectionStart ?? 0);
  const e = base + (el.selectionEnd ?? 0);
  if (s === e) return false;
  const chars = [...edit.chars];
  chars.splice(s, e - s);
  while (chars.length < visLen(f)) chars.push(" "); // 欄長（パディング）維持
  edit = { ...edit, chars, cursor: Math.min(s, visLen(f)) };
  return true;
}

/** input の keydown 制御。印字文字は上書き/挿入、編集キーは 5250 挙動、AID/移動キーはペインへ委譲 */
function onInputKeydown(f: Field, ev: KeyboardEvent): void {
  if (props.busy) {
    ev.preventDefault(); // 通信中は入力プロテクト
    return;
  }
  if (f.protected) {
    // 非入力キー（F キー等）はペインの keymap に委譲するため preventDefault しない。
    // 文字入力・Backspace・Delete は ACS 同様に操作員メッセージを出す。
    if (ev.key.length === 1 || ev.key === "Backspace" || ev.key === "Delete") {
      ev.preventDefault();
      emit("notice", MSG_PROTECTED);
    }
    return;
  }
  if (composing.value) return; // IME 変換中は自前制御しない
  const el = ev.target as HTMLInputElement;
  if (!edit || editFieldIndex !== f.index) beginEdit(f, el);
  edit = edit!;
  // Shift+←/→/Home/End は欄内テキスト選択ではなく、画面の矩形（ブロック）選択にする
  // （マウス・欄外操作と同一の範囲指定）。preventDefault で欄内の native 選択を止め、
  // stopPropagation せずにペイン（EmulatorPane.onKeydown）へ委譲する。
  if (ev.shiftKey && SELECT_KEYS.has(ev.key)) {
    ev.preventDefault();
    return;
  }
  if (isDbcsEdit(f)) {
    onDbcsKeydown(f, ev, el);
    return;
  }
  // native カーソル位置（クリックや矢印での再配置）に編集カーソルを追従させる。
  // これで ACS 同様、欄内の任意桁にカーソルを置いてそこから入力できる。
  // 行またぎ欄では native caret はスライス内の位置なので、スライスのオフセットを足して論理化する。
  const nativeCaret = el.selectionStart;
  if (nativeCaret !== null) {
    const logical = Math.min(sliceOffsetOf(f, el) + nativeCaret, visLen(f));
    if (logical !== edit.cursor) edit = { ...edit, cursor: logical };
  }

  // **修飾キー付きは欄内編集で消費しない。** Ctrl+Delete / Ctrl+Backspace 等はキー設定で
  // ローカル編集キー（Erase EOF / Erase Input）に割り当てられており、ここで素の Delete /
  // Backspace として処理するとペインの割り当てと**二重に効く**（1 文字消えたうえに全欄が消える）。
  // 矢印キーが以前から同じ理由で修飾キーを除外しているのと同じ扱いに揃える。
  const plain = !ev.ctrlKey && !ev.altKey && !ev.metaKey;
  if (ev.key === "Insert" && plain) {
    ev.preventDefault();
    edit = toggleInsert(edit);
    insertMode.value = edit.insertMode;
    return;
  }
  if (ev.key === "Backspace" && plain) {
    ev.preventDefault();
    // 選択があればその削除が優先（先頭にキャレットがあっても選択は消す）
    if (deleteSelection(f, el)) {
      sync(el, f);
      return;
    }
    // **欄の先頭では削除せず前の欄の末尾へ移る**（原典どおり。`field-prev` のコメント参照）
    if (edit.cursor === 0) {
      emit("field-prev", f.index);
      return;
    }
    edit = backspace(edit);
    sync(el, f);
    return;
  }
  if (ev.key === "Delete" && plain) {
    ev.preventDefault();
    if (!deleteSelection(f, el)) edit = del(edit);
    sync(el, f);
    return;
  }
  if (ev.key === "Home" && plain) {
    // 欄内はカーソルを先頭へ。ペインのフィールド移動へ伝播させない
    ev.preventDefault();
    ev.stopPropagation();
    edit = home(edit);
    sync(el, f);
    return;
  }
  if (ev.key === "End" && plain) {
    ev.preventDefault();
    ev.stopPropagation();
    edit = end(edit);
    sync(el, f);
    return;
  }
  // Ctrl+矢印（語頭ジャンプ）・Alt+←/→（ペイン移動）は欄内で消費せず、ペイン keymap／
  // App のグローバルへ委譲する（ペイン側が preventDefault してブラウザ既定より優先する）。
  if (ev.key === "ArrowLeft" && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    ev.preventDefault();
    if (edit.cursor > 0) {
      // 欄内: キャレットを 1 桁戻す。ペインのセル移動へは伝播させない
      ev.stopPropagation();
      edit = moveCursor(edit, -1);
      sync(el, f);
    }
    // 左端（cursor===0）は stopPropagation せず、ペインの自由カーソル（セル移動）へ委譲する
    return;
  }
  if (ev.key === "ArrowRight" && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    ev.preventDefault();
    // 末尾（cursor===visLen＝最終文字の後ろ）まで欄内で移動できる。これで満杯欄でも末尾に止まれ、
    // Backspace で最終文字を削除できる。末尾に居るときの ArrowRight だけ委譲して欄の右隣セルへ出る。
    if (edit.cursor < visLen(f)) {
      ev.stopPropagation();
      edit = moveCursor(edit, 1);
      sync(el, f);
    }
    return;
  }
  // 印字可能な 1 文字（修飾なし）: 型・コードページ検証してから上書き/挿入
  if (ev.key.length === 1 && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    ev.preventDefault();
    if (signKeyHack(f, ev.key)) return; // 数値欄の `-` / `+` は Field− / Field+ へ
    const ch = inputChar(ev.key, f); // MONOCASE 欄／カタカナ系 CCSID は英小文字を大文字化
    const why = rejectReason(f, ch);
    if (why) {
      emit("notice", MSG_BY_REASON[why]); // 型違反は理由を示して拒否（ACS 準拠）
      return;
    }
    let trial: EditState;
    if (deleteSelection(f, el)) {
      // 選択を置換: 削除位置へ挿入（欄長維持・末尾溢れ切り捨て）
      const chars = [...edit.chars];
      chars.splice(edit.cursor, 0, ch);
      chars.length = visLen(f);
      trial = { ...edit, cursor: edit.cursor + 1, chars };
    } else {
      trial = typeChar(edit, ch);
    }
    if (!fitsBytes(trial, f)) return; // バイト予算（SO/SI・DBCS 込み）超過は拒否
    edit = trial;
    sync(el, f);
    advanceIfFull(f); // ACS: 満杯なら次の入力欄へ
    return;
  }
  // その他（Enter/F キー/PageUp/Down/Tab）はペインの keymap に委譲（preventDefault しない）
}

/** DBCS 欄の keydown: ライブ列ビュー上で論理カーソルを動かし、SO/SI をスキップする。
 *  chars = 純論理値（非パディング・挿入モード）。表示・caret は syncDbcs が列ビューへ変換する。 */
function onDbcsKeydown(f: Field, ev: KeyboardEvent, el: HTMLInputElement): void {
  edit = edit!;
  // 論理カーソルを単一の真実にする。native caret が「前回 sync で置いた位置」と食い違うとき
  // （クリック等での再配置）だけ論理へ写す。毎回 logicalOf で丸めると矢印移動が壊れるため。
  // 行またぎ欄では native caret はスライス内の位置なので、スライスの列ビュー先頭を足して欄全体へ写す。
  const vc = el.selectionStart;
  if (vc !== null) {
    const lay = dbcsLayoutOf(f);
    const g = globalCaret(rangeOfInput(f, el, lay), vc);
    if (lay.caretOf(edit.cursor) !== g) edit = { ...edit, cursor: lay.logicalOf(g) };
  }
  const k = ev.key;
  // SBCS 欄と同じ理由で修飾キー付きは欄内編集で消費しない（ローカル編集キーの割り当てと二重に効く）
  const plain = !ev.ctrlKey && !ev.altKey && !ev.metaKey;
  if (k === "Backspace" && plain) {
    ev.preventDefault();
    if (deleteSelection(f, el)) {
      syncDbcs(el, f);
      return;
    }
    // SBCS 欄と同じく、欄の先頭では前の欄の末尾へ移る（削除はしない）
    if (edit.cursor === 0) {
      emit("field-prev", f.index);
      return;
    }
    edit = dbcsBackspace(edit, f);
    syncDbcs(el, f);
    return;
  }
  if (k === "Delete" && plain) {
    ev.preventDefault();
    if (!deleteSelection(f, el)) edit = dbcsDelete(edit, f);
    syncDbcs(el, f);
    return;
  }
  if (k === "Home" && plain) {
    ev.preventDefault();
    ev.stopPropagation();
    edit = { ...edit, cursor: 0 };
    syncDbcs(el, f);
    return;
  }
  if (k === "End" && plain) {
    ev.preventDefault();
    ev.stopPropagation();
    edit = end(edit); // 末尾パディングを飛ばして実入力の直後へ（SBCS 欄と同じ意味）
    syncDbcs(el, f);
    return;
  }
  if (k === "ArrowLeft" && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    ev.preventDefault();
    if (edit.cursor > 0) {
      ev.stopPropagation(); // 欄内移動（SO/SI はスキップ）。左端は委譲してペインのセル移動へ
      edit = dbcsMove(edit, -1);
      syncDbcs(el, f);
    }
    return;
  }
  if (k === "ArrowRight" && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    ev.preventDefault();
    if (edit.cursor < edit.chars.length) {
      ev.stopPropagation();
      edit = dbcsMove(edit, 1);
      syncDbcs(el, f);
    }
    return;
  }
  if (k === "Insert") {
    ev.preventDefault();
    edit = toggleInsert(edit);
    insertMode.value = edit.insertMode;
    return;
  }
  // 印字可能な 1 文字（修飾なし）: 型・バイト予算検証してから上書き（Insert 時は挿入）
  if (k.length === 1 && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    ev.preventDefault();
    if (signKeyHack(f, k)) return; // 数値欄の `-` / `+` は Field− / Field+ へ
    const ch = inputChar(k, f); // MONOCASE 欄／カタカナ系 CCSID は半角英小文字を大文字化
    const why = rejectReason(f, ch);
    if (why) {
      emit("notice", MSG_BY_REASON[why]);
      return;
    }
    const replaced = deleteSelection(f, el); // 選択があれば削除（cursor が選択開始へ）→ そこへ挿入で置換
    // 選択置換の直後は「挿入」でないと消した分が埋まらないため一時的に挿入扱いにする
    const base = replaced ? { ...edit, insertMode: true } : edit;
    const trial = dbcsType(base, ch, f);
    if (!trial) return; // SO/SI 込みバイト予算超過は拒否（末尾パディングで吸収し切れない）
    edit = { ...trial, insertMode: edit.insertMode };
    syncDbcs(el, f);
    advanceIfFull(f); // ACS: バイト予算満杯なら次の入力欄へ
    return;
  }
  // その他はペイン keymap へ委譲（preventDefault しない）
}

function onInputFocus(f: Field, ev: FocusEvent, sliceIdx = 0): void {
  const el = ev.target as HTMLInputElement;
  // オプション選択肢の開閉はフォーカスにだけ従属させる（キーは 1 つも購読しない）
  focusedField.value = f;
  // sync がスライス間で focus を移したときは何もしない。ここで beginEdit すると props
  // （emit 前で古い）から編集モデルを作り直して直前の打鍵が消え、caret も先頭へ戻る。
  // 値・キャレットの確定は呼び出し元の sync が続けて行う。
  if (syncingFocus) return;
  beginEdit(f, el);
  if (isDbcsEdit(f)) {
    // DBCS 欄は編集中も列ビュー（SO/SI 込み）を表示。論理カーソルはこのスライスの先頭桁へ。
    const lay = dbcsLayoutOf(f);
    const r = dbcsSliceRangeOf(f, sliceIdx, lay);
    // 未打鍵の再解釈表示欄はフォーカスしても再解釈列ビューを保つ（caret は lay 由来。桁構造は一致）。
    el.value = recodeViewActive(f)
      ? displayText(stripSentinels(sliceValue(f, sliceIdx)))
      : stripSentinels(dbcsSliceText(lay, r.s)); // パディング込み＝未入力桁にも caret を置ける
    const lc = lay.logicalAfter(r.from); // 先頭桁が SO なら、その次の論理境界から
    if (edit) edit.cursor = lc;
    const local = localCaret(r, lay.caretOf(lc));
    el.setSelectionRange(local, local);
    emit("cursor", r.s.row, r.s.col + (lay.columnsBefore(lay.caretOf(lc)) - r.s.offset));
    return;
  }
  if (sliceIdx > 0 && edit) {
    // 折返し先のスライスへ直接フォーカスした場合、論理カーソルはそのスライスの先頭桁
    const s = slicesOf(f)[sliceIdx];
    if (s) {
      edit.cursor = s.offset;
      // 表示はセンチネル→空白。生のセンチネル（U+E020–E03F）を入れると、Nerd Font 等
      // PUA にアイコンを持つ等幅フォントで可視グリフになり（色制御文字が見える）、
      // 2 桁幅のグリフだと欄幅を超えて横スクロールし caret が行末へ飛ぶ。
      el.value = displayText(stripSentinels(sliceValue(f, sliceIdx)));
      el.setSelectionRange(0, 0);
      emit("cursor", s.row, s.col);
      return;
    }
  }
  // SBCS: 休止時 :value と編集ビューは同一（純論理値スペース埋め）。
  // ただし hidden はスペース埋めがそのまま伏せ字になるため実入力分のみ表示する。
  // 行またぎ欄では、この input が担当するスライスぶんだけを入れる（全長を入れると桁が溢れる）。
  // 表示はセンチネル→空白（writeSlices / :value / blur と同じ。生のセンチネルを入れると
  // Nerd Font で可視化・桁溢れし、色制御文字表示とカーソル行末飛びを起こす）。
  if (edit) el.value = displayText(stripSentinels(sliceValue(f, sliceIdx)));
  // スペース埋め表示だと Tab/フォーカスで native カーソルが末尾へ行き入力できなくなるため、
  // フォーカス時はフィールド先頭へ置く（クリックは mouseup で押下桁に上書きされる）。
  el.setSelectionRange(0, 0);
  if (edit) edit.cursor = 0;
  emit("cursor", f.row, f.col);
}

/** フォーカスアウト: 休止表示（DBCS は SO/SI 込みの列ビュー）へ戻す。
 *  行またぎ欄では、その input が担当するスライスぶんだけを戻す（全長を戻すと桁が溢れる）。 */
function onInputBlur(f: Field, ev: FocusEvent): void {
  if (composing.value) return; // IME 変換中の一時 blur は無視
  // 矩形選択の開始（onGridDragMove の blur）もここを通るので、選択と同時に選択肢が閉じる
  if (!syncingFocus) focusedField.value = null;
  const el = ev.target as HTMLInputElement;
  // **スライス間の一時 blur（syncingFocus）以外は編集状態を解除する。**
  // これをしないと、一度フォーカスした欄が blur 後も editFieldIndex に残って「編集中」扱いのままになり、
  // 休止表示の表示コード再解釈（usesRecodedCells / dbcsRestLayout）から除外され続ける
  // （アウトフォーカスで表示コードを切り替えても変わらない）。ここで解除すると休止表示（再解釈含む）に戻る。
  // el.value を組む前に解除するので、この blur 直後から休止の再解釈表示が反映される。
  if (!syncingFocus) {
    edit = undefined;
    editFieldIndex = -1;
  }
  el.value = displayText(stripSentinels(sliceValue(f, Number(el.dataset["slice"] ?? 0))));
  // フォーカスが外れたので、色付きオーバーレイを編集値で描き直す（元の値に戻さない）。
  // 行の v-memo に renderTick を含めてあるので、ここで ++ すると当該行が 1 度再描画される。
  // **欄内スライス間の一時 blur（syncingFocus）では ++ しない**——編集中に再描画すると
  // ライブの DBCS 表示（writeSlices）が rest レイアウトで上書きされて崩れるため。
  if (!syncingFocus) renderTick.value++;
}

/** DBCS 欄の選択範囲（列ビュー座標）を純論理値へ写す。SO/SI スペースは論理文字でないため含まれない。
 *  戻り値の text=論理文字列、[ls,le)=論理インデックス範囲（cut の削除に使う）。 */
function dbcsSelection(f: Field, el: HTMLInputElement): { text: string; ls: number; le: number } | undefined {
  if (!isDbcsEdit(f)) return undefined;
  const lay = dbcsLayoutOf(f);
  const r = rangeOfInput(f, el, lay); // スライス内 caret → 欄全体の列ビュー座標
  const start = globalCaret(r, el.selectionStart ?? 0);
  const end = globalCaret(r, el.selectionEnd ?? 0);
  if (start >= end) return undefined;
  const logical = (edit && editFieldIndex === f.index ? editValue(edit) : logicalValue(f)).replace(/ +$/, "");
  const { caretOf } = lay;
  let text = "";
  let ls = -1;
  let le = 0;
  for (let li = 0; li < logical.length; li++) {
    const vpos = caretOf(li); // logical[li] の文字が入る列ビュー位置（SO は含まない）
    if (vpos >= start && vpos < end) {
      if (ls < 0) ls = li;
      le = li + 1;
      text += logical[li];
    }
  }
  return ls < 0 ? undefined : { text, ls, le };
}

/** DBCS 欄のコピー: SO/SI（列ビューの半角スペース）を除いた純論理値をクリップボードへ。 */
function onInputCopy(f: Field, ev: ClipboardEvent): void {
  const sel = dbcsSelection(f, ev.target as HTMLInputElement);
  if (!sel) return; // SBCS 欄・選択なしは既定コピー
  ev.clipboardData?.setData("text/plain", sel.text);
  ev.preventDefault(); // SO/SI スペースを含む既定コピーを抑止
}

/** DBCS 欄のカット: 純論理値をコピーし、選択論理範囲を削除する。 */
function onInputCut(f: Field, ev: ClipboardEvent): void {
  const el = ev.target as HTMLInputElement;
  const sel = dbcsSelection(f, el);
  if (!sel) return;
  ev.clipboardData?.setData("text/plain", sel.text);
  ev.preventDefault();
  if (props.busy || f.protected) return; // 通信中・保護欄は削除しない
  if (!edit || editFieldIndex !== f.index) beginEdit(f, el);
  edit = edit!;
  const chars = [...edit.chars];
  chars.splice(sel.ls, sel.le - sel.ls);
  edit = { ...edit, chars, cursor: sel.ls };
  syncDbcs(el, f);
}

/** 入力欄クリック: 押下桁（native キャレット）を論理カーソルへ反映（AID 位置の正確化） */
function onInputClick(f: Field, ev: MouseEvent): void {
  const el = ev.target as HTMLInputElement;
  if (isDbcsEdit(f)) {
    if (!edit || editFieldIndex !== f.index) beginEdit(f, el);
    edit = edit!;
    // 列ビューの押下位置を論理カーソルへ写し、SO/SI に載ったら論理境界へスナップ。
    // 表示（syncDbcs）と同じ「パディング込み・同じ SO/SI マーク」でレイアウトすること。
    // trim 版で計算すると、未入力桁を押しても論理カーソル 0 に落ちる（＝先頭へ飛ぶ）。
    const lay = dbcsLayoutOf(f);
    const r = rangeOfInput(f, el, lay);
    const lc = lay.logicalOf(globalCaret(r, el.selectionStart ?? 0));
    edit = { ...edit, cursor: lc };
    const c = lay.caretOf(lc);
    el.setSelectionRange(localCaret(r, c), localCaret(r, c));
    const col = Math.min(lay.columnsBefore(c), visLen(f) - 1);
    const s = slicesOf(f)[sliceIndexOf(f, col)]!;
    emit("cursor", s.row, s.col + (col - s.offset));
    return;
  }
  const caret = Math.min(sliceOffsetOf(f, el) + (el.selectionStart ?? 0), visLen(f));
  const pos = posOfOffset(f, caret, props.snapshot.cols, props.snapshot.rows);
  emit("cursor", pos.row, pos.col);
}

/** 欄の値 base の offset 桁目から line を上書きする（ACS のペースト＝カーソル位置起点の上書き）。
 *  5250 の上書き入力と同じく、**書いた範囲だけ**を置き換えて前後の既存文字は残す
 *  （"123456" の先頭へ "789" を貼れば "789456"）。SO/SI 込みバイト予算で切り詰め、末尾空白は落とす。 */
function overwriteInto(field: Field, base: string, offset: number, line: string): string {
  const budget = visLen(field);
  const out = [...base];
  while (out.length < offset) out.push(" "); // 欄が offset に届いていなければ空白で埋める
  let i = offset;
  for (const raw of line) {
    if (raw === "\n" || raw === "\r") continue;
    const ch = inputChar(raw, field); // MONOCASE 欄／カタカナ系 CCSID は半角英小文字を大文字化
    if (!acceptsChar(field, ch)) {
      // **弾いた文字も桁を消費する（捨てて詰めない）。** ACS は入力不可文字の桁を
      // 元のまま残す。ここで i を進めないと後続が左へ詰まり、
      // 数値欄 "123" に "3A5" を貼ると "353"（正: "325"）になる。
      // out[i] に触れないので、既に入っている DBCS も壊さない（全角 1 文字 = 1 要素）。
      while (out.length <= i) out.push(" "); // 疎配列の穴は join で消えるため空白で埋める
      i++;
      continue;
    }
    while (out.length < i) out.push(" ");
    // 打鍵と同じ規則で上書きする: 桁数が変わったぶんは直後で調整し、後続の桁を動かさない
    // （全角の上に半角を貼ると 2 桁が 1 桁になり、その先の文字まで左へ詰まっていた）
    const before = dbcsByteLength(out.join(""));
    out[i] = ch; // 上書き（後ろの既存文字はそのまま残る）
    if (i < out.length - 1) keepByteLength(out, i, before, budget);
    i++;
  }
  while (out.length > 0 && dbcsByteLength(out.join("")) > budget) out.pop();
  return out.join("").replace(/\s+$/, "");
}

/** 挿入ペーストで最初に見つかる入力不可文字の理由。無ければ undefined。
 *  **挿入モードは 1 文字でも不可なら一切貼らない**（ACS）。上書きモードは桁を消費するだけで
 *  エラーにしないため、この判定は挿入経路でのみ使う。 */
function firstRejection(field: Field, text: string): RejectReason | undefined {
  for (const raw of text) {
    if (raw === "\n" || raw === "\r") continue;
    const why = rejectReason(field, inputChar(raw, field));
    if (why) return why;
  }
  return undefined;
}

/** 欄の値 base の offset 桁目へ line を挿入する（Insert モードのペースト）。後続は右へずれる。
 *  欄の予算に収まらなければ undefined を返す（呼び出し側が中断して MSG_NO_ROOM を出す）。
 *
 *  base の末尾空白は落としてから測る。画面上の欄は末尾まで空白で埋まっているが、その空白は
 *  挿入で押し出されて消えるだけなので、あふれ判定に数えてはいけない
 *  （10 桁欄の "123" に "123" を挿せる。"123123123" にもう 3 桁は挿せない＝これがエラー）。 */
function insertInto(field: Field, base: string, offset: number, line: string): string | undefined {
  const budget = visLen(field);
  const out = [...base.replace(/\s+$/, "")];
  while (out.length < offset) out.push(" ");
  let i = offset;
  for (const raw of line) {
    if (raw === "\n" || raw === "\r") continue;
    const ch = inputChar(raw, field); // MONOCASE 欄／カタカナ系 CCSID は半角英小文字を大文字化
    // 入力不可文字は呼び出し側（firstRejection）が先に弾く。ここへは来ない
    out.splice(i, 0, ch); // 挿入（後続は右へ）
    i++;
  }
  if (dbcsByteLength(out.join("")) > budget) return undefined; // 入り切らない
  return out.join("").replace(/\s+$/, "");
}

/** 行 row の col 桁以降で、最初に書き込める（非保護の）入力欄とその開始桁を返す。
 *  ACS はペースト開始位置が保護領域でも、**その行の右側に入力欄があればそこから**流し込む。 */
function nextWritableAt(row: number, col: number): { field: Field; col: number } | undefined {
  let best: { field: Field; col: number } | undefined;
  for (const f of props.snapshot.fields) {
    if (f.protected) continue;
    for (const sl of slicesOf(f)) {
      if (sl.row !== row) continue;
      const startCol = Math.max(col, sl.col);
      if (startCol > sl.col + sl.width - 1) continue; // この行の区間は col より左で終わっている
      if (!best || startCol < best.col) best = { field: f, col: startCol };
    }
  }
  return best;
}

/** (row, col) を含む欄の、その行の区間の右端桁（行またぎ欄はその行のスライスの右端）。 */
function bandEndCol(field: Field, row: number, col: number): number | undefined {
  const s = slicesOf(field).find((sl) => sl.row === row && col >= sl.col && col < sl.col + sl.width);
  return s ? s.col + s.width - 1 : undefined;
}

/** 複数行テキストを「帯」へ流し込む（ACS 実機挙動）。
 *
 *  帯 = ペースト開始桁から、その行の欄の右端まで。各行を帯の幅で折り返しながら流し、次の行は
 *  前の行が使い終わった次の帯行から始める。あふれた分は**次の行の 1 桁目ではなく同じ桁**へ回る
 *  （連続フィールドでも論理的な線形位置ではなく矩形の桁を優先する。独立欄でも同じ）。
 *
 *  例: 10 桁欄・矩形 111/222/333 を 9 桁目（帯幅 2）へ →
 *      row1 "11" / row2 "1" / row3 "22" / row4 "2" / row5 "33" / row6 "3"
 *
 *  行ごとの宛先を桁で引くので、1 行に複数の入力欄が並ぶ画面（SEU の行コマンド欄＋ソース欄）でも
 *  桁がずれない。行またぎ欄では複数行が同じ欄の別オフセットへ落ちる。 */
function pasteMultiline(f: Field, text: string, el: HTMLInputElement): void {
  const { cols, rows } = props.snapshot;
  // native caret は DBCS 欄では**列ビュー**の位置。開始桁は桁で引くので、桁オフセットへ直す
  const caret = sliceOffsetOf(f, el) + (el.selectionStart ?? 0);
  const startOffset = columnOffsetOfCaret(f, caret);
  pasteFrom(posOfOffset(f, startOffset, cols, rows), text, { f, el, startOffset });
}

/** DBCS 欄: 欄内の表示桁オフセット → 論理インデックス（全角 2 桁・SO/SI の 1 桁を吸収）。SBCS はそのまま。 */
function logicalOffsetOfColumn(f: Field, colOffset: number): number {
  if (!isDbcsEdit(f)) return colOffset;
  const lay = dbcsLayoutOf(f);
  return lay.logicalAfter(lay.viewAtColumn(colOffset));
}

/** DBCS 欄: 欄内の列ビュー caret → 表示桁オフセット。SBCS はそのまま。 */
function columnOffsetOfCaret(f: Field, viewCaret: number): number {
  if (!isDbcsEdit(f)) return viewCaret;
  return dbcsLayoutOf(f).columnsBefore(viewCaret);
}

/**
 * 画面座標 `start` を起点に流し込む。**欄外（保護領域）からのペーストもここを通る。**
 * `focus` は入力欄にフォーカスがある場合のみ渡す（編集モデルの更新に使う）。
 */
function pasteFrom(
  start: { row: number; col: number },
  text: string,
  focus?: { f: Field; el: HTMLInputElement; startOffset: number }
): void {
  const lines = text.split(/\r?\n/);
  const { cols, rows } = props.snapshot;
  // 帯行へ割り付ける。同じ欄に複数回書くことがある（行またぎ欄・帯の折返し）ため、欄ごとに
  // まとめてから 1 度だけ書く（1 行ずつ書くと、2 回目が 1 回目より前の値を土台にして消す）。
  const targets = new Map<number, { field: Field; parts: { offset: number; line: string }[] }>();
  let row = start.row;
  let stop = false;
  for (const line of lines) {
    if (stop) break;
    let rest = line;
    do {
      if (row > rows) { stop = true; break; }
      // **右が先、尽きたら下**（ACS）。開始桁が入力欄でなければその行を右へ走査し、
      // 最初の非保護欄から流し込む。1 行を使い切ったら次の行の同じ開始桁へ戻る。
      let col = start.col;
      let placedOnRow = false;
      while (rest.length > 0 && col <= cols) {
        const t = nextWritableAt(row, col);
        if (!t) break; // この行にはもう入力欄が無い → 次の行へ
        const from = Math.max(col, t.col);
        const end = bandEndCol(t.field, row, from);
        if (end === undefined) break;
        const width = end - from + 1;
        const e = targets.get(t.field.index) ?? { field: t.field, parts: [] };
        // 宛先は画面桁で引くが、書き込みは論理文字の配列で行う。DBCS 欄では両者が一致しない
        // （全角=2 桁・SO/SI=1 桁で論理 0 文字）ので、桁 → 論理インデックスへ変換する。
        // 変換しないと、欄の先頭にある全角のぶんだけ貼り付け位置が右へずれる。
        const offset = logicalOffsetOfColumn(t.field, caretInField(t.field, row, from, cols, rows));
        e.parts.push({ offset, line: rest.slice(0, width) });
        targets.set(t.field.index, e);
        rest = rest.slice(width);
        col = end + 1; // 同じ行の右隣を続けて探す
        placedOnRow = true;
      }
      if (!placedOnRow) {
        // この行には（右へ走査しても）入力欄が無い。**下へは飛ばさず打ち切る。**
        // ACS は保護領域の下に入力欄があっても流さず、判定は同一行で閉じる。
        stop = true;
        break;
      }
      row += 1;
    } while (rest.length > 0);
  }
  // 値を先に全部組み立てる。1 つでも入り切らなければ**何も書かない**（ACS: 問題ないと確定するまで
  // 書き換えない。挿入モードのみ。上書きモードは予算で切り詰めるだけでエラーにならない）。
  const built: { field: Field; val: string }[] = [];
  for (const { field, parts } of targets.values()) {
    let val = logicalValue(field);
    for (const p of parts) {
      if (insertMode.value) {
        // 挿入モードは 1 文字でも不可なら**一切貼らない**（ACS）。上書きは桁を消費するだけ
        const why = firstRejection(field, p.line);
        if (why) {
          emit("notice", MSG_BY_REASON[why]);
          return;
        }
      }
      const next = insertMode.value
        ? insertInto(field, val, p.offset, p.line)
        : overwriteInto(field, val, p.offset, p.line);
      if (next === undefined) {
        emit("notice", MSG_NO_ROOM);
        return;
      }
      val = next;
    }
    built.push({ field, val });
  }
  for (const { field, val } of built) {
    if (focus && field.index === focus.f.index) {
      const { f, el, startOffset } = focus;
      // フォーカス欄は edit モデルを置換して sync。カーソルはペースト開始桁のまま動かさない（ACS）。
      // initEdit は insertMode:false を返す。そのまま使うと直後の sync が
      // insertMode.value を false に戻し、ペーストのたびに挿入モードが解除される
      if (isDbcsEdit(f)) {
        // **開始桁は「桁」、edit.cursor は「論理インデックス」。** 貼った後の値で引き直す
        // （貼り付けで全角の並びが変わり得るため、貼る前のレイアウトでは桁が合わない）。
        // 変換せずに桁をそのまま入れると、カーソルが貼り付けた文字列の末尾側へ流れる。
        const chars = padDbcs(f, [...val]);
        const lay = dbcsViewLayout(chars.join(""), soMark(), siMark());
        edit = {
          chars,
          cursor: lay.logicalAfter(lay.viewAtColumn(startOffset)),
          insertMode: insertMode.value
        };
      } else {
        edit = { ...initEdit(val, visLen(f), startOffset), insertMode: insertMode.value };
      }
      editFieldIndex = f.index;
      sync(el, f);
    } else {
      emit("edit", field.index, val);
      // :value バインドは v-memo でキャッシュされ再評価されないため、全スライスの input を直接更新する
      // （表示はセンチネル→空白。生のセンチネルは Nerd Font で可視化・桁溢れするため）
      slicesOf(field).forEach((_s, i) => {
        const inp = inputForSlice(field, i);
        if (inp) inp.value = displayText(stripSentinels(sliceValue(field, i)));
      });
    }
  }
}

/** 通信中・保護欄では beforeinput をブロック（貼り付けは @paste で扱う）。 */
function onInputBeforeInput(f: Field, ev: InputEvent): void {
  if ((f.protected || props.busy) && ev.inputType === "insertFromPaste") ev.preventDefault();
}

/** paste（clipboardData から取得。単一行 input は beforeinput の data が改行を落とすため paste で扱う）。
 *  改行を含めば下方向の連続入力欄へ分配、単一行なら caret へ挿入（型・バイト予算で整形）。 */
function onInputPaste(f: Field, ev: ClipboardEvent): void {
  ev.preventDefault();
  if (props.busy) return;
  const text = ev.clipboardData?.getData("text") ?? "";
  if (!text) return;
  const el = ev.target as HTMLInputElement;
  if (f.protected) {
    // **保護欄で始めてもエラーにしない。** ACS はその行の右側に入力欄があれば
    // そこから流し込む。編集モデルは作らず、カーソル位置を起点にする。
    pasteFrom(props.cursor ?? { row: f.row, col: f.col }, text);
    return;
  }
  if (!edit || editFieldIndex !== f.index) beginEdit(f, el);
  /**
   * **単一行も複数行と同じ経路に通す。** 旧実装は単一行だけ typeChar ループで処理し、
   * 欄の右端で打ち切っていた。ACS は右の欄へ流し、右が尽きたら次の行へ回すため、
   * 規則を 2 か所に持たず pasteMultiline へ集約する。
   *
   * **ただし DBCS 欄の“単一行”だけは従来経路を残す（decisions.md D1 / README 既知の限界）。**
   * pasteMultiline は桁（列ビュー）で宛先を決め、書き込みは overwriteInto が
   * 論理文字の配列で行う。全角は SO+2+SI=4 桁を占めるため両者がずれ、
   * 既存の全角を壊す（"ABCDEF" の 1 桁目へ "日" を貼ると A日F になるべきところ A日CDEF）。
   *
   * **複数行は DBCS 欄でも pasteMultiline に流す**（各行を下の欄へ分配する）。ここを従来経路に
   * 通すと改行が acceptsChar で捨てられ、全行が 1 欄へ折り畳まれてしまう（STRSQL/SEU で発生）。
   * 桁計算は全角を含むと不正確になり得るが（README の既知の限界）、SBCS 内容なら一致する。
   */
  if (isDbcsEdit(f) && !/[\r\n]/.test(text)) {
    // native caret を論理カーソルへ写してから流し込む（列ビュー ⇄ 論理の変換）
    const vc = el.selectionStart;
    if (vc !== null) {
      const lay = dbcsLayoutOf(f);
      edit = { ...edit!, cursor: lay.logicalOf(globalCaret(rangeOfInput(f, el, lay), vc)) };
    }
    let e: EditState = edit!;
    const at = e.cursor;
    if (e.insertMode) {
      const why = firstRejection(f, text);
      if (why) {
        emit("notice", MSG_BY_REASON[why]);
        return;
      }
      if (insertInto(f, editValue(e), at, text) === undefined) {
        emit("notice", MSG_NO_ROOM);
        return;
      }
    }
    for (const raw of [...text]) {
      const ch = inputChar(raw, f);
      if (!acceptsChar(f, ch)) continue;
      const trial = dbcsType(e, ch, f);
      if (!trial || !fitsBytes(trial, f)) break; // 上書きは入るところまで
      e = trial;
    }
    edit = { ...e, cursor: at }; // ペーストではカーソルを動かさない（ACS）
    sync(el, f);
    return;
  }
  pasteMultiline(f, text, el);
  // advanceIfFull は呼ばない: ACS はペーストで満杯になっても次の欄へ送らない（カーソルは動かない）
}

/** IME 合成開始: スペース埋めを外し、合成開始桁より前の既入力だけを残す。
 *  非 hidden 欄はスペース埋めで maxlength を満たしており、その状態だと IME が確定文字を挿入できず
 *  空白のまま消える（DBCS 全角が入力できない）。かといって欄全体を空にすると、既入力が隠れ変換候補が
 *  欄先頭に出てしまう。合成開始桁より前の実文字を value に残し caret をその末尾へ置くことで、
 *  既入力を見せたまま候補を入力位置に出しつつ、以降の挿入余地（maxlength）を確保する。 */
function onCompositionStart(f: Field, ev: CompositionEvent): void {
  if (f.protected || props.busy) return;
  // hidden 欄は value が伏せ字（●）で実値ではないため、el.value を読む IME 経路に乗せてはならない
  // （乗せると ● 自体がモデルへ流れ込む）。パスワードに IME は不要なので合成を無効化する。
  if (f.hidden) {
    ev.preventDefault();
    return;
  }
  composing.value = true;
  const el = ev.target as HTMLInputElement;
  if (!edit || editFieldIndex !== f.index) beginEdit(f, el);
  edit = edit!;
  // 選択があれば削除して置換の起点にする（IME での選択置換）。無ければ native caret を合成開始桁へ。
  composeReplacedSelection = deleteSelection(f, el);
  if (!composeReplacedSelection) {
    const nativeCaret = el.selectionStart;
    if (nativeCaret !== null) {
      if (isDbcsEdit(f)) {
        const lay = dbcsLayoutOf(f);
        edit = { ...edit, cursor: lay.logicalOf(globalCaret(rangeOfInput(f, el, lay), nativeCaret)) };
      } else {
        edit = { ...edit, cursor: Math.min(sliceOffsetOf(f, el) + nativeCaret, visLen(f)) };
      }
    }
  }
  composeStart = edit.cursor;
  // 合成中は純論理値の prefix（SO/SI 無し）＋候補。確定後に列ビューへ整形する。
  // 行またぎ欄では、この <input> が担当するスライスの先頭から先だけを残す（欄全長を入れると桁が溢れる）。
  const from = composeLogicalStart(f, el);
  // 表示はセンチネル→空白（1:1 なので長さは不変＝composePrefixLen も確定分の切り出しも保つ）。
  // 生のセンチネルを prefix に残すと Nerd Font で色制御文字が見え・桁が溢れる。
  const prefix = displayText(stripSentinels(edit.chars.slice(from, composeStart).join("")));
  composePrefixLen = prefix.length;
  el.value = prefix;
  el.setSelectionRange(prefix.length, prefix.length); // 候補を入力位置（既入力の直後）に出す
}

/** 合成中の <input> に残す prefix の開始論理インデックス（＝その input が担当するスライスの先頭）。 */
function composeLogicalStart(f: Field, el: HTMLInputElement): number {
  if (!isDbcsEdit(f)) return sliceOffsetOf(f, el);
  const lay = dbcsLayoutOf(f);
  return lay.logicalAfter(rangeOfInput(f, el, lay).from);
}

function onCompositionEnd(f: Field, ev: CompositionEvent): void {
  composing.value = false;
  if (f.protected) return;
  if (f.hidden) return; // 伏せ字 value を読み込まない（onCompositionStart で合成自体を止めている）
  const el = ev.target as HTMLInputElement;
  if (!edit || editFieldIndex !== f.index) beginEdit(f, el);
  edit = edit!;
  // el.value = 既入力prefix + 確定文字。prefix（composePrefixLen 文字）を除いた確定分だけを
  // composeStart から流し込む（型フィルタ・バイト予算クランプ）。超過分は切り捨てる。
  const dbcs = isDbcsEdit(f);
  let e: EditState = { ...edit, cursor: composeStart };
  for (const raw of [...el.value].slice(composePrefixLen)) {
    const ch = inputChar(raw, f); // MONOCASE 欄／カタカナ系 CCSID は半角英小文字を大文字化
    if (!acceptsChar(f, ch)) continue;
    // DBCS も SBCS と同じく上書き既定（Insert 時のみ挿入）。ただし合成開始時に選択を削除して
    // いた場合はその跡を埋めるため挿入にする（上書きだと後続まで食ってしまう）。
    const base = composeReplacedSelection ? { ...e, insertMode: true } : e;
    const trial = dbcs ? dbcsType(base, ch, f) : typeChar(e, ch);
    if (!trial || !fitsBytes(trial, f)) break; // 桁超過分は切り捨て
    e = { ...trial, insertMode: e.insertMode };
  }
  edit = e;
  editFieldIndex = f.index;
  sync(el, f);
  advanceIfFull(f); // ACS: IME 確定で満杯なら次の入力欄へ
}

// ---- クリックでカーソル位置を算出（非入力セル。入力欄は @focus/@click で扱う） ----
/** 実測の 1 文字幅（px）。ルーラー要素から測る（fontPx*0.6 近似の桁ズレを解消） */
function charWidthPx(): number {
  const r = rulerEl.value;
  if (r) {
    const w = r.getBoundingClientRect().width / 10;
    if (w > 0) return w;
  }
  return fontPx.value * 0.6;
}

/** マウス座標 → セル (row,col)（1 始まり・画面内にクランプ）。グリッドの内側余白を差し引く。 */
function cellAt(ev: MouseEvent): { row: number; col: number } | undefined {
  const el = gridEl.value;
  if (!el) return undefined;
  const rect = el.getBoundingClientRect();
  const lineH = fontPx.value * 1.25;
  const col = Math.floor((ev.clientX - rect.left - GRID_PAD_X) / charWidthPx()) + 1;
  const row = Math.floor((ev.clientY - rect.top - GRID_PAD_Y) / lineH) + 1;
  return {
    row: Math.max(1, Math.min(row, props.snapshot.rows)),
    col: Math.max(1, Math.min(col, props.snapshot.cols))
  };
}

// ---- 矩形（ブロック）選択（ACS 相当。入力/非入力を問わず画面グリッドをドラッグで矩形選択） ----
const rectSel = ref<{ r1: number; c1: number; r2: number; c2: number } | undefined>();
let dragAnchor: { row: number; col: number } | null = null;
let dragMoved = false;
let copyBound = false;

function normRect(a: { row: number; col: number }, b: { row: number; col: number }) {
  return {
    r1: Math.min(a.row, b.row),
    r2: Math.max(a.row, b.row),
    c1: Math.min(a.col, b.col),
    c2: Math.max(a.col, b.col)
  };
}

function onGridMousedown(ev: MouseEvent): void {
  if (ev.button !== 0) return; // 左ボタンのみ
  const cell = cellAt(ev);
  if (!cell) return;
  clearRectSel(); // 新しいドラッグ開始で前回の選択を消す
  dragAnchor = cell;
  dragMoved = false;
  window.addEventListener("mousemove", onGridDragMove);
  window.addEventListener("mouseup", onGridDragUp);
}

function onGridDragMove(ev: MouseEvent): void {
  if (!dragAnchor) return;
  const cell = cellAt(ev);
  if (!cell) return;
  if (!dragMoved && (cell.row !== dragAnchor.row || cell.col !== dragAnchor.col)) {
    dragMoved = true;
    // 矩形選択に切替: 入力欄の native 選択/フォーカスを外す（画面全体を一様に選択するため）
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && gridEl.value?.contains(active)) active.blur();
    // ACS 同様、押下したセルにカーソルを置く（以降ドラッグで広げてもここから動かない）。
    // 全角の後半桁は前半へ丸める（桁間にはカーソルを置けない）。
    const at = roundToDbcsLead(dragAnchor, props.snapshot.cells);
    emit("selection-start", at.row, at.col);
  }
  if (dragMoved) {
    ev.preventDefault();
    window.getSelection()?.removeAllRanges();
    rectSel.value = normRect(dragAnchor, cell);
  }
}

/** ダブルクリックでカーソル下の語を矩形選択する（ACS 相当）。行はまたがない。
 *  イベント順は mousedown→mouseup→click→…→dblclick なので、直前の onGridMousedown が
 *  消した矩形をここで置き直す形になる。 */
function onGridDblclick(ev: MouseEvent): void {
  const cell = cellAt(ev);
  if (!cell) return;
  // 語の切り出しはコピーと同じ文字で行う（charAtForCopy は未送信の入力値を反映する）
  const range = wordRangeAt((c) => charAtForCopy(cell.row, c), props.snapshot.cols, cell.col);
  if (!range) return; // 空白・SO/SI 上では何もしない（直前の click がカーソルだけ置く）
  ev.preventDefault();
  // ドラッグ選択と同じく画面全体を一様に選択する: 入力欄の native 選択/フォーカスを外す。
  // dblclick は input 内に native の語選択を作るので、blur 前に畳んでおく
  // （残すと再フォーカス後の入力が選択範囲を巻き込んで消す）。
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && gridEl.value?.contains(active)) {
    const at = active.selectionStart ?? 0;
    active.setSelectionRange(at, at);
    active.blur();
  }
  window.getSelection()?.removeAllRanges();
  rectSel.value = { r1: cell.row, r2: cell.row, c1: range.c1, c2: range.c2 };
  bindCopy();
  emit("selection-start", cell.row, range.c1); // カーソルは選択の始点＝語頭へ（ドラッグと同じ規則）
}

function onGridDragUp(): void {
  window.removeEventListener("mousemove", onGridDragMove);
  window.removeEventListener("mouseup", onGridDragUp);
  if (dragMoved && rectSel.value) bindCopy(); // 矩形確定 → Ctrl+C を購読
  dragAnchor = null;
}

/**
 * コピー経路が SO/SI 桁を識別するための内部マーク。表示用の `{ }`／空白と違い、
 * **用途ごとに何を返すかを呼び出し側が決められる**ようにするための印。クリップボードにも編集値にも出さない。
 *
 * 制御文字を使う（私用領域は不可）。列ビューは桁数を `isFullWidth` で数えるが、
 * **私用領域（外字）は全角扱い**なので、マークが 2 桁に数えられて桁がずれる。
 */
const SHIFT_MARK = "\u0001";

/** セル 1 桁の文字。shift = SO/SI 桁に返す文字（語判定は " "＝区切り、クリップボードは ""＝落とす）。 */
function copyCharOf(cell: Cell, shift: string): string {
  if (cell.kind === "dbcs-tail") return ""; // 全角は lead で 1 文字（tail は畳む）
  if (cell.kind === "so" || cell.kind === "si") return shift;
  // 属性桁（色制御）・非表示桁は core が char=" " にしている＝空白 1 桁として写る（画面と同じ）
  if (recodes(cell)) return displayText(recodeChar(cell.rawByte!));
  // displayText: 表示できないバイト（U+FFFD）は画面と同じく空白にする（生の U+FFFD を載せない）
  return cell.char === "" ? " " : displayText(cell.char);
}

/**
 * 入力欄の列ビュー（コピー用）。SO/SI 桁は SHIFT_MARK にして識別できるようにする
 * （`displayValue` をそのまま使うと SO/SI が表示マーク `{ }` や空白になって区別できない）。
 *
 * **画面に出ていない文字はクリップボードにも載せない。** 欄の値には埋め込み属性（欄途中の色替え）や
 * 表示できないバイトが**私用面のセンチネル**として入っており、描画側は `stripSentinels`＋`displayText`
 * で空白にしている。同じ正規化をしないと、私用面の文字がそのままクリップボードへ乗るうえ、
 * `isFullWidth` が私用面を全角と見なすため桁の数え方まで狂う（桁がずれて文字が落ちる）。
 * センチネルを外すのは SBCS 欄だけ——DBCS 欄の値に入る私用面は**外字**（表示される実データ）で、
 * SBCS 表には私用面へのマッピングが無いため、こちらで取り違える心配は無い。
 */
function copyViewOf(f: Field): string {
  if (f.hidden) return maskSafe(f, logicalValue(f));
  if (f.dbcsType) {
    const resting = editFieldIndex !== f.index && props.edits.get(f.index) === undefined;
    const view = resting || recodeViewActive(f)
      ? restViewFromCells(f, SHIFT_MARK)
      : dbcsViewLayout(padDbcs(f, [...logicalValue(f)]).join(""), SHIFT_MARK, SHIFT_MARK).view;
    return displayText(view); // 外字は残す（センチネルは DBCS 欄の値には入らない）
  }
  return displayText(stripSentinels(inputValue(f)));
}

/**
 * 画面桁 (row,col) の文字。入力欄の桁は「現在の入力値」を優先する
 * （cells はホストが描いた内容しか持たないため、見ないと未送信の入力値が拾えない）。
 * shift は SO/SI 桁に返す文字（`charAtForCopy` / `charAtForClipboard` 参照）。
 */
function columnCharAt(row: number, col: number, shift: string): string {
  const f = fieldAt(row, col, props.snapshot.fields, props.snapshot.cols, props.snapshot.rows);
  if (f && !f.protected) {
    // 欄の表示（列ビュー/パディング込み）から該当桁を取り出す。DBCS は全角が 2 桁を占めるため
    // 桁で数える。hidden 欄は伏せ字がそのまま出る（実値は漏らさない）。
    const view = copyViewOf(f);
    const offset = offsetOfPos(f, row, col, props.snapshot.cols, props.snapshot.rows);
    if (offset === undefined) return " ";
    let c = 0;
    for (const ch of view) {
      const w = isFullWidth(ch) ? 2 : 1;
      // 全角の後半桁は畳む（lead で 1 文字）
      if (offset < c + w) return offset === c ? (ch === SHIFT_MARK ? shift : ch) : "";
      c += w;
    }
    return " ";
  }
  const cell = props.snapshot.cells[row - 1]?.[col - 1];
  return cell ? copyCharOf(cell, shift) : " ";
}

/** 語の判定用（頭出し・ダブルクリック選択）。**SO/SI は空白＝語の区切り**として扱う。 */
function charAtForCopy(row: number, col: number): string {
  return columnCharAt(row, col, " ");
}

/**
 * クリップボード用。**SO/SI 桁は落とす**（桁を持たせない）。
 *
 * SO/SI は DBCS のデータではなく構造で、貼り付け先の欄が全角ランに合わせて付け直す。
 * 空白として写すと、貼り付けたときに「元の SO/SI ぶんの空白」＋「付け直された SO/SI」で
 * 桁が二重になる。`{ }` 表示（showShiftMarks）中は、その表示マークがそのまま文字として
 * クリップボードへ乗ってしまう問題も同時に消える。
 */
function charAtForClipboard(row: number, col: number): string {
  return columnCharAt(row, col, "");
}

function rectText(): string {
  const s = rectSel.value;
  if (!s) return "";
  const lines: string[] = [];
  for (let r = s.r1; r <= s.r2; r++) {
    let line = "";
    for (let c = s.c1; c <= s.c2; c++) {
      const ch = charAtForClipboard(r, c);
      /**
       * **全角の片側しか矩形に入っていない桁は、何もコピーしない**（空白も置かない）。
       * 矩形の端が全角の途中を切る場合で、境目は 2 通りある:
       *   - 右端が前半桁（lead）… 後半桁が範囲外。そのまま出すと 1 桁の選択に 2 桁ぶんが乗る
       *   - 左端が後半桁（tail）… 前半桁が範囲外。文字は前半が持つので出す物が無い
       * 後半桁の判定に語判定用アクセサを使うのは、クリップボード用が SO/SI にも `""` を返すため。
       */
      const isDbcsTail = charAtForCopy(r, c) === "";
      if ((c === s.c2 && isFullWidth(ch)) || (c === s.c1 && isDbcsTail)) continue;
      line += ch;
    }
    lines.push(line);
  }
  /**
   * **選んだ矩形をそのまま（末尾の空白も落とさずに）コピーする**——ACS と同じ。
   *
   * ブロックコピーの空白は「余白」ではなくデータである。貼り付け先では上書きする桁を決めるので、
   * 落とすとその桁だけ元の文字が残る（"12345" へ 4 桁の "ABC␣" を貼ると "ABC 5" ではなく
   * "ABC45" になった）。桁を揃えて貼れることがブロック選択の目的なので、幅は選択のまま保つ。
   *
   * ただし**全行が空になったら空文字を返す**（全角の半分だけ・SO/SI だけを選んだ場合）。
   * 呼び出し側はクリップボードに触らない＝**何もコピーしない**。改行だけを載せない。
   */
  return lines.every((line) => line === "") ? "" : lines.join("\n");
}
function onDocCopy(ev: ClipboardEvent): void {
  if (!rectSel.value) return;
  const text = rectText();
  // 空（写す物が無い選択）ならクリップボードを書き換えない。既定コピーは止める（選択は DOM に無い）
  if (text !== "") ev.clipboardData?.setData("text/plain", text);
  ev.preventDefault();
  clearRectSel(); // コピー後は範囲選択を解除する
}
function bindCopy(): void {
  if (copyBound) return;
  document.addEventListener("copy", onDocCopy);
  copyBound = true;
}
function clearRectSel(): void {
  const had = !!rectSel.value;
  rectSel.value = undefined;
  if (copyBound) {
    document.removeEventListener("copy", onDocCopy);
    copyBound = false;
  }
  if (had) emit("selection-cleared"); // 親のキーボード選択アンカーもリセットさせる
}

const rectStyle = computed(() => {
  const s = rectSel.value;
  if (!s) return {};
  return {
    left: s.c1 - 1 + "ch",
    top: (s.r1 - 1) * 1.25 + "em",
    width: s.c2 - s.c1 + 1 + "ch",
    height: (s.r2 - s.r1 + 1) * 1.25 + "em"
  };
});

function onGridClick(ev: MouseEvent): void {
  if (dragMoved) return; // ドラッグ（矩形選択）だったのでクリック処理はしない
  const el = gridEl.value;
  if (!el || (ev.target as HTMLElement).tagName === "INPUT") return; // 入力欄は native focus で扱う
  const rect = el.getBoundingClientRect();
  const lineH = fontPx.value * 1.25;
  const col = Math.floor((ev.clientX - rect.left - GRID_PAD_X) / charWidthPx()) + 1;
  const row = Math.floor((ev.clientY - rect.top - GRID_PAD_Y) / lineH) + 1;
  if (row < 1 || row > props.snapshot.rows || col < 1 || col > props.snapshot.cols) return;
  // 非入力セルへのクリック = free モード。フォーカス中の入力欄を外してオーバーレイを出す
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && el.contains(active)) active.blur();
  // DBCS 後半桁をクリックしたら前半へ丸める（桁間にはカーソルを置けない）
  const pos = roundToDbcsLead({ row, col }, props.snapshot.cells);
  emit("cursor", pos.row, pos.col);
}

// ---- フォント自動フィット（ResizeObserver。paneWidth/cols で ch を算出） ----
const gridEl = ref<HTMLElement>();
const rulerEl = ref<HTMLElement>(); // 実測字幅用（10 文字幅を測る）
const fontPx = ref(14);
let ro: ResizeObserver | undefined;

function fit(): void {
  // 利用可能領域は「親（.screen-wrap）」で測る。.grid 自身はコンテンツサイズに縮める（中央寄せのため）
  // ので、grid を測ると縮尺のフィードバックループになる。親は grid 内容に依存せず一定。
  const host = gridEl.value?.parentElement;
  const ruler = rulerEl.value;
  if (!host) return;
  const cols = props.snapshot.cols;
  const rows = props.snapshot.rows;
  const availW = host.clientWidth - GRID_PAD_X * 2;
  const availH = host.clientHeight - GRID_PAD_Y * 2;
  // 実測字幅（現フォントでの 1 文字幅）を使う。0.6em 近似だと実フォントとずれ、
  // まだ横に余白があるのに幅制約が先に効いて早く縮小してしまう（右余白の主因）。
  const measured = ruler ? ruler.getBoundingClientRect().width / 10 : 0;
  if (measured > 0 && availW > 0 && availH > 0) {
    // フォント寸法は font-size に線形なので、現フォントでの実測比から目標フォントを一発算出する。
    const cur = fontPx.value;
    const charW = measured; // = cur に対する実測字幅
    const lineH = cur * 1.25; // .grid line-height:1.25 と一致
    const ratio = Math.min(availW / (charW * cols), availH / (lineH * rows));
    // **整数に丸める**。小数フォントだと 1 文字ごとの描画位置がサブピクセルにずれ、
    // 等幅グリッドでも文字がにじんで見える。1px 分の余白より鮮明さを優先する
    const next = Math.floor(Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, cur * ratio)));
    fontPx.value = Math.max(MIN_FONT_PX, next);
    return;
  }
  // レイアウト前（jsdom 等、ルーラー未計測）は近似でフォールバック。
  fontPx.value = fitFont(host.clientWidth, host.clientHeight, cols, rows);
}

// 画面サイズ切替（24x80⇔27x132）では親のボックスサイズが変わらず ResizeObserver が発火しないため、
// cols/rows の変化を監視して明示的に再フィットする（レイアウト確定後に測るため nextTick）。
watch(
  () => [props.snapshot.cols, props.snapshot.rows],
  () => nextTick(fit)
);

onMounted(() => {
  const host = gridEl.value?.parentElement;
  if (typeof ResizeObserver !== "undefined" && host) {
    ro = new ResizeObserver(() => fit());
    ro.observe(host);
  }
  fit();
  // 初期表示（接続直後の画面）でもフォーカス中ペインはカーソル欄へ
  if (props.focused && !props.snapshot.keyboardLocked) nextTick(() => focusCursorField());
});
// キーボード（自由カーソル）からの矩形選択制御を親（EmulatorPane）へ公開する。
// マウス選択と同じ rectSel を使い、コピー経路（onDocCopy）も共有する。
function setBlockSelection(rect: { r1: number; c1: number; r2: number; c2: number } | undefined): void {
  if (!rect) {
    clearRectSel();
    return;
  }
  rectSel.value = rect;
  bindCopy();
}
/**
 * DBCS 欄の論理カーソルを画面桁 col に合わせる（EmulatorPane 専用）。
 *
 * DBCS 欄の caret は列ビュー座標（全角=2 桁・SO/SI=1 桁）で、親の caretInField（1 桁=1 文字）
 * では正しく置けないため、reconcileFocus は DBCS 欄の caret を触らない設計になっている。
 * ただし矢印で欄外から入ってきたときだけは到達桁に合わせる必要があるので、その口をここに開ける。
 * （既にフォーカス中の欄には呼ばないこと。ScreenGrid が置いた caret を壊すため）
 */
function setDbcsCaretAtColumn(fieldIndex: number, row: number, col: number): void {
  const f = props.snapshot.fields.find((x) => x.index === fieldIndex);
  if (!f || !isDbcsEdit(f)) return;
  const offset = offsetOfPos(f, row, col, props.snapshot.cols, props.snapshot.rows);
  if (offset === undefined) return;
  const si = sliceIndexOf(f, offset);
  const el = inputForSlice(f, si);
  if (!el) return;
  if (!edit || editFieldIndex !== f.index) beginEdit(f, el);
  const lay = dbcsLayoutOf(f);
  // 列ビューは SO/SI を桁として含み、パディングで欄長まで埋まっている＝画面の桁割りそのもの。
  // よって「表示桁 → ビュー内 caret」を数えたら、それをそのまま native caret に置けばよい。
  //
  // ここで caretOf(logicalOf(c)) と往復してはいけない。logicalOf は「最も近い論理カーソル」への
  // スナップなので往復で元の位置に戻る保証がなく、SO/SI 境界やパディング境界で桁がずれる
  // （指定した桁と違う位置にキャレットが飛ぶ）。
  const c = lay.viewAtColumn(offset);
  const r = dbcsSliceRangeOf(f, si, lay);
  // モデルの論理カーソルは「その view 位置以降の最初の論理カーソル」を採る（logicalAfter）。
  // logicalOf（最も近い論理カーソル）は使えない: SI の桁は「直前の全角の手前」と「その直後」の
  // 両方から等距離で同点になり、先に見つかる左を選ぶ。すると以降の同期でキャレットが
  // 全角の手前まで引き戻され、指定桁より 2 桁左にずれる。
  edit = { ...edit!, cursor: lay.logicalAfter(c) };
  el.setSelectionRange(localCaret(r, c), localCaret(r, c));
}

/** 欄外（保護領域・非入力セル）からのペースト。EmulatorPane が呼ぶ。
 *  入力欄に focus が無い状態では @paste が input へ届かないため、ペイン側で拾って委譲する。 */
function pasteAt(row: number, col: number, text: string): void {
  pasteFrom({ row, col }, text);
}

defineExpose({
  setBlockSelection,
  clearBlockSelection: clearRectSel,
  setDbcsCaretAtColumn,
  pasteAt,
  // ローカル編集キー（ホストへ送らない）。ペインの onLocal から呼ぶ
  fieldExit: fieldExitKey,
  eraseEof: eraseEofKey,
  eraseInput: eraseInputKey,
  fieldMinus: () => fieldSignKey(true),
  fieldPlus: () => fieldSignKey(false),
  dup: dupKey,
  // 画面桁の表示文字（未送信の入力値込み）。ペインの頭出し（Ctrl+矢印）が語の判定に使う
  screenCharAt: charAtForCopy,
  // オプション欄のドロップダウン（ペインの Alt+↓・Esc から呼ぶ）
  openOptHints,
  optHintsOpen: () => optOpenRow.value !== null,
  closeOptHints
});

// 画面が更新されたら矩形選択は破棄する
watch(
  () => props.snapshot,
  () => clearRectSel()
);
onBeforeUnmount(() => {
  ro?.disconnect();
  clearRectSel();
  window.removeEventListener("mousemove", onGridDragMove);
  window.removeEventListener("mouseup", onGridDragUp);
});
</script>

<template>
  <div
    ref="gridEl"
    class="grid"
    :style="{
      fontSize: fontPx + 'px',
      '--grid-pad-x': GRID_PAD_X + 'px',
      '--grid-pad-y': GRID_PAD_Y + 'px'
    }"
    :data-focused="focused"
    :data-opt-hints="optHints"
    @click="onGridClick"
    @dblclick="onGridDblclick"
    @mousedown="onGridMousedown"
    @focusin="onGridFocusIn"
    @focusout="onGridFocusOut"
  >
    <!--
      操作員メッセージ。**画面の最下行に重ねる**（ACS と同じ）。
      `pointer-events: none` で背面のセルの操作を邪魔しない。
    -->
    <div v-if="message" class="opmsg" role="status">{{ shiftedMessage }}</div>
    <span ref="rulerEl" class="cell-ruler" aria-hidden="true">0000000000</span>
    <!-- 矩形（ブロック）選択のハイライト -->
    <div v-if="rectSel" class="rect-sel" :style="rectStyle" aria-hidden="true"></div>
    <div
      v-if="!cursorOnEditable"
      class="cursor"
      :class="{ live: focused }"
      :style="{ left: (effCursor.col - 1) + 'ch', top: (effCursor.row - 1) * 1.25 + 'em' }"
      aria-hidden="true"
    ></div>
    <!-- 拡張 5250 GUI オーバーレイ（ウィンドウ枠・選択フィールド・スクロールバー） -->
    <!-- ウィンドウ装飾（画面設定）。**重ねるだけ**で文字・桁に触れず、
         pointer-events:none で窓の中の操作（入力・クリック・矩形選択）を透過させる。 -->
    <!--
      オプション欄の選択肢。**矩形選択・コピー・貼り付けを妨げないことを最優先**にしている:
        - mousedown を .stop でグリッドへ伝播させない（伝播すると clearRectSel() が走り選択が消える）
        - mousedown を .prevent で既定のフォーカス移動ごと止める（入力欄にフォーカスを残す。
          奪うと貼り付け先が変わる）
        - キーイベントは 1 つも購読しない（Esc すら捕まえない）
      絶対配置なので <input> の桁割りには一切触れない。
    -->
    <!--
      右隣 1 桁のボタン。**リストは開かない**——開くのはクリックか Alt+↓ のときだけ。
      tabindex は開いている間だけ 0 にする: 常にタブ順へ入れると一覧を Tab で降りるときの
      停止数が倍になり、既存の使い勝手が変わってしまう。
    -->
    <button
      v-for="b in optButtons"
      :key="'ob' + b.row"
      type="button"
      class="opt-btn"
      :style="optBtnStyle(b)"
      :tabindex="optOpenRow === b.row ? 0 : -1"
      :aria-expanded="optOpenRow === b.row"
      :aria-label="MSG_OPT_HINTS"
      @mousedown.stop.prevent
      @click.stop="optOpenRow === b.row ? closeOptHints() : openOptAt(b.row)"
    >▾</button>

    <div
      v-if="optPopoverShown"
      class="opt-hints"
      :style="optListStyle(optPopoverShown)"
      role="listbox"
      :aria-label="MSG_OPT_HINTS"
      @mousedown.stop.prevent
      @keydown="onOptListKeydown"
    >
      <button
        v-for="o in optPopoverShown.options"
        :key="o.value"
        type="button"
        class="opt-hint"
        role="option"
        :tabindex="0"
        :aria-selected="o.value === optSelectedValue"
        @mousedown.stop.prevent
        @click.stop="chooseOption(o)"
      >
        <span class="opt-hint-n">{{ o.value }}</span>
        <span class="opt-hint-l">{{ o.label }}</span>
      </button>
    </div>

    <template v-if="decoWindow">
      <div
        v-for="(st, i) in windowBackdrop === 'none' ? [] : smokeRects(decoWindow)"
        :key="'sm' + i"
        class="win-smoke"
        :style="st"
        aria-hidden="true"
      ></div>
      <div
        v-if="windowFrame !== 'none'"
        class="win-deco"
        :style="winRectStyle(decoWindow)"
        aria-hidden="true"
      ></div>
    </template>
    <template v-if="gui">
      <!-- ホストが引いたグリッド罫線（GRDATR/GRDLIN）。1 本ずつの線に展開して重ねる -->
      <template v-for="g in gui.gridLines" :key="'g' + g.id">
        <div
          v-for="(seg, i) in gridSegments(g)"
          :key="'g' + g.id + '-' + i"
          :class="seg.cls"
          :style="seg.style"
          aria-hidden="true"
        ></div>
      </template>
      <div
        v-for="w in gui.windows"
        :key="'w' + w.id"
        class="gui-window"
        :class="{ 'no-outline': w.border !== undefined }"
        :style="windowStyle(w)"
        aria-hidden="true"
      ></div>
      <!-- WDWBORDER: ホスト指定の罫線文字で枠を描く（指定がある窓だけ） -->
      <template v-for="w in gui.windows" :key="'wb' + w.id">
        <div
          v-for="(ln, i) in hostBorderRows(w)"
          :key="'wb' + w.id + '-' + i"
          class="gui-window-border"
          :class="decorAttrClass(w.border!.cba)"
          :style="ln.style"
          aria-hidden="true"
        >{{ ln.text }}</div>
        <div
          v-for="(seg, i) in hostBorderSegments(w)"
          :key="'wl' + w.id + '-' + i"
          :class="seg.cls"
          :style="seg.style"
          aria-hidden="true"
        ></div>
        <div
          v-if="hostTitle(w)"
          :key="'wt' + w.id"
          :class="hostTitle(w)!.cls"
          :style="hostTitle(w)!.style"
          aria-hidden="true"
        >{{ hostTitle(w)!.text }}</div>
      </template>
      <div
        v-for="b in gui.scrollBars"
        :key="'b' + b.id"
        class="gui-scrollbar"
        :class="b.horizontal ? 'horizontal' : 'vertical'"
        :style="guiPos(b.row, b.col)"
        :title="`${b.horizontal ? 'horizontal' : 'vertical'} ${b.sliderPos}/${b.total}`"
        aria-hidden="true"
      >
        <div class="gui-thumb" :style="thumbStyle(b)"></div>
      </div>
      <div
        v-for="f in selectionFields"
        :key="'s' + f.id"
        class="gui-selection"
        :class="f.kind"
        :style="guiPos(f.row, f.col)"
        role="group"
      >
        <button
          v-for="c in f.choices"
          :key="c.index"
          type="button"
          class="gui-choice"
          :class="{ selected: c.selected, unavailable: !c.available }"
          :disabled="!c.available || snapshot.keyboardLocked"
          @click="onChoiceClick(f, c)"
        >
          <span v-if="f.kind === 'radio'" class="gui-marker">{{ c.selected ? "◉" : "○" }}</span>
          <span v-else-if="f.kind === 'checkbox'" class="gui-marker">{{ c.selected ? "☑" : "☐" }}</span>
          <span class="gui-choice-text">{{ c.text }}</span>
        </button>
      </div>
    </template>
    <div v-for="(segs, r) in rows" :key="r" class="grid-row" v-memo="[segs, linkEnabled, renderTick]">
      <template v-for="(seg, i) in segs" :key="i">
        <!-- 入力欄。埋め込み属性で色替えのある欄は色付きオーバーレイを重ねる（overlaid）。
             通常欄は input-cell が display:contents で素通し＝従来と同じレイアウト。 -->
        <span
          v-if="seg.kind === 'input'"
          class="input-cell"
          :class="{ overlaid: !!seg.colorBands }"
        >
          <input
            class="grid-input"
            :class="[seg.cls, { 'has-overlay': !!seg.colorBands }]"
            :style="{ width: (seg.width ?? seg.field!.length) + 'ch' }"
            :value="displayText(stripSentinels(sliceValue(seg.field!, seg.slice ?? 0)))"
            :readonly="seg.field!.protected"
            type="text"
            :autocomplete="seg.field!.hidden ? 'off' : undefined"
            :inputmode="inputModeOf(seg.field!)"
            :maxlength="seg.width ?? seg.field!.length"
            @keydown="onInputKeydown(seg.field!, $event)"
            @beforeinput="onInputBeforeInput(seg.field!, $event as InputEvent)"
            @paste="onInputPaste(seg.field!, $event as ClipboardEvent)"
            :data-field-index="seg.field!.index"
            :data-field="fieldId(seg.field!)"
            :data-slice="seg.slice ?? 0"
            @focus="onInputFocus(seg.field!, $event, seg.slice ?? 0)"
            @blur="onInputBlur(seg.field!, $event as FocusEvent)"
            @copy="onInputCopy(seg.field!, $event as ClipboardEvent)"
            @cut="onInputCut(seg.field!, $event as ClipboardEvent)"
            @click="onInputClick(seg.field!, $event as MouseEvent)"
            @compositionstart="onCompositionStart(seg.field!, $event as CompositionEvent)"
            @compositionend="onCompositionEnd(seg.field!, $event as CompositionEvent)"
          />
          <span v-if="seg.colorBands" class="input-overlay" aria-hidden="true"><span
            v-for="(run, ri) in overlayRuns(seg)"
            :key="ri"
            class="grid-span"
            :class="run.cls"
          >{{ run.text }}</span></span>
        </span>
        <!-- 幅が Ambiguous な DBCS 1 文字。2ch の箱に入れてフォントに依らず 2 桁を占めさせる
             （属性クラスも付けるので、反転の背景も下線も 2 桁ぶん出る） -->
        <span
          v-else-if="seg.kind === 'wide'"
          class="grid-span wide-cell"
          :class="seg.cls"
        >{{ seg.text }}</span>
        <!-- 対を失った全角セル。1 桁の箱に入れて左半分だけ見せる（ACS と同じ分断された見え方） -->
        <span
          v-else-if="seg.kind === 'half'"
          class="grid-span half-cell"
          :class="seg.cls"
        >{{ seg.text }}</span>
        <span v-else class="grid-span" :class="seg.cls"><template
          v-for="(p, j) in decoParts(seg)"
          :key="j"
        ><a
            v-if="p.href"
            class="grid-link"
            :href="p.href"
            target="_blank"
            rel="noopener noreferrer"
            @click.stop
          >{{ p.text }}</a><button
            v-else-if="p.aid"
            type="button"
            class="fkey-btn"
            :data-row="p.row"
            :data-col="p.col"
            :title="`${p.aid} を送る`"
            @mousedown.prevent
            @click.stop="onFkeyClick(p.aid)"
          >{{ p.text }}</button><template v-else>{{ p.text }}</template></template></span>
      </template>
    </div>
  </div>
</template>

<style scoped>
/**
 * 操作員メッセージ（ホスト側・クライアント側の両方）。**画面の最下行に重ねる**。
 *
 * `.grid` の中に置くので **font-size を継承**し、画面本文と字の大きさが揃う
 * （外側に置くと、画面だけが拡縮されて字だけ取り残される）。
 * 背面は画面の地色で塗り、下にある行を隠す——ACS も同じ場所を使う。
 */
.opmsg {
  position: absolute;
  /* **桁 1 の位置に合わせる。** `.grid` の内側余白と同じ値を使う
     （別々に書くと、片方を直したときに 1 桁ずれる） */
  left: var(--grid-pad-x);
  right: var(--grid-pad-x);
  bottom: var(--grid-pad-y);
  line-height: 1.25;
  background: var(--crt);
  color: var(--t-white, var(--ink));
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.grid {
  position: relative;
  /* 内側余白は `fitFont.ts` の `GRID_PAD_*` から流し込む（CSS に数字を置かない）。
     フィット計算・クリックの桁逆算・`.opmsg` の桁 1 が同じ値を見る */
  font-family: var(--screen-mono);
  line-height: 1.25;
  background: var(--crt);
  padding: var(--grid-pad-y) var(--grid-pad-x);
  white-space: pre;
  /* フォントを幅・高さ両方にフィットさせるためスクロールバーは出さない */
  overflow: hidden;
  /* コンテンツ（cols×rows）ちょうどのサイズに縮め、.screen-wrap 側で中央寄せする。
     min(幅,高) フィットで生じる余白が右下に偏らず上下・左右均等になる。 */
  flex: 0 0 auto;
  max-width: 100%;
  max-height: 100%;
}
/**
 * **重ねるものの余白補正——`margin: var(--grid-pad-y) 0 0 var(--grid-pad-x)` はこの節すべての約束事。**
 *
 * 絶対配置の基準は祖先の **padding box** なので、`left: 0` は余白の外側の縁になる。
 * 桁 1・行 1 に載せるには、`.grid` の padding と同じ量だけ内側へ寄せる必要がある。
 *
 * **数字を書いてはいけない。** ここは以前 `margin: 8px 0 0 10px` と直書きしていて、
 * 余白を ACS 相当へ詰めた (#274) ときに **12 か所が取り残された**——カーソルも罫線も窓枠も
 * 右へ 8px・下へ 7px ずれ、「カーソルと文字が合わない」と報告を受けた。
 * 余白の唯一の定義は `composables/fitFont.ts` の `GRID_PAD_X` / `GRID_PAD_Y` で、
 * `.grid` がインラインで `--grid-pad-x/y` に流し込んでいる（カスタムプロパティは継承する）。
 *
 * **フォールバック値（`var(--grid-pad-x, 2px)`）も書かない。** 数字を書いた時点で
 * 「唯一の定義」が崩れ、同じ食い違いの種になる。代わりにオーバーレイが `.grid` の
 * 子であることを `grid-overlay-offset.test.ts` が固定する。
 */
/* ホストのカーソル位置を示すブロックカーソル */
.cursor {
  position: absolute;
  margin: var(--grid-pad-y) 0 0 var(--grid-pad-x);
  width: 1ch;
  height: 1.25em;
  background: color-mix(in srgb, var(--t-green) 45%, transparent);
  pointer-events: none;
  /* 矩形選択（z-index:3）より上。カーソルは選択の始点＝必ず矩形の角に載るため、
     下に置くとハイライトに沈んで「始点にカーソルが見える」という ACS の挙動が崩れる */
  z-index: 4;
}
/* 矩形（ブロック）選択のハイライト */
.rect-sel {
  position: absolute;
  margin: var(--grid-pad-y) 0 0 var(--grid-pad-x);
  background: color-mix(in srgb, var(--t-turquoise, var(--t-white)) 35%, transparent);
  outline: 1px solid var(--t-turquoise, var(--t-white));
  pointer-events: none;
  z-index: 3;
}
.cursor.live {
  animation: cursorBlink 1.1s steps(1) infinite;
}
@keyframes cursorBlink {
  50% { opacity: 0.2; }
}
@media (prefers-reduced-motion: reduce) {
  .cursor.live { animation: none; }
}
/* 実測字幅用のルーラー（不可視・レイアウトに影響しない。font は .grid から継承） */
.cell-ruler {
  position: absolute;
  visibility: hidden;
  white-space: pre;
  pointer-events: none;
  top: 0;
  left: 0;
}
.grid-row {
  height: 1.25em;
  white-space: pre;
}
.grid-span {
  text-shadow: var(--t-glow) currentColor;
}
/* 画面の質感=CRT: フォスファのにじみを強め、文字が滲む CRT らしい見た目にする。
   （フラットは --t-glow:0 で滲み無し。CRT はテーマに依らずここで確実に滲ませる）
   **画面に文字を出す要素すべてに掛ける**——素のラン(.grid-span)だけでなく、入力欄(input)と
   拡張 GUI の選択肢も対象。要素が違うだけで、利用者にはどれも同じ「画面の文字」に見える。 */
.pane[data-surface="crt"] .grid-span,
.pane[data-surface="crt"] .grid-input,
.pane[data-surface="crt"] .gui-choice-text {
  text-shadow:
    0 0 1.2px currentColor,
    0 0 5px color-mix(in srgb, currentColor 45%, transparent);
}
/* East Asian Width が Ambiguous な DBCS 文字（'−' '‐' 罫線 等）の桁幅を保証する箱。
   欧文等幅フォントはこれらを 1 桁で描くため、素のテキストのままだと以降の桁が左へずれる。
   inline-block は text-decoration を親から継がないので、下線等は seg.cls を自分に付けて出す。 */
/* ホストが引いたグリッド罫線（GRDATR/GRDLIN）。文字セルの上に重ねる 1px の線。
   色は属性クラス（.c-*）の currentColor に従わせ、線種は border-style で表す。 */
.grid-line {
  position: absolute;
  margin: var(--grid-pad-y) 0 0 var(--grid-pad-x);
  pointer-events: none;
}
.grid-h { border-top: 1px solid currentColor; }
.grid-v { border-left: 1px solid currentColor; }
.grid-h.gl-dotted { border-top-style: dotted; }
.grid-v.gl-dotted { border-left-style: dotted; }
.grid-h.gl-dashed { border-top-style: dashed; }
.grid-v.gl-dashed { border-left-style: dashed; }
.grid-h.gl-double { border-top-style: double; border-top-width: 3px; }
.grid-v.gl-double { border-left-style: double; border-left-width: 3px; }
.grid-h.gl-thick { border-top-width: 2px; }
.grid-v.gl-thick { border-left-width: 2px; }
/* WDWBORDER（色だけの指定）: ACS と同じく「1 セルに 1 本」の破線で枠を描く。
   線は枠セルの中心を通るので、破線の位相を半セルずらしてセルの頭から引く。 */
.win-frame {
  position: absolute;
  margin: var(--grid-pad-y) 0 0 var(--grid-pad-x);
  pointer-events: none;
}
.win-frame-h {
  height: 2px;
  background: repeating-linear-gradient(to right, currentColor 0 0.9ch, transparent 0.9ch 1ch);
  background-position: 0.5ch 0;
}
.win-frame-v {
  width: 2px;
  background: repeating-linear-gradient(to bottom, currentColor 0 1.05em, transparent 1.05em 1.25em);
  background-position: 0 0.625em;
}
/* WDWBORDER: ホスト指定の罫線文字で描く枠。文字なので等幅グリッドにそのまま乗る */
/**
 * オプション欄の選択肢。**テーマ変数（styles.css）に乗せる**——独自の変数名を使うと
 * フォールバックの黒が常に出て、ライトテーマでも背景が黒くなる（実画面で発生した）。
 * 意匠は画面設定「オプション選択肢」（`data-opt-hints`）で切り替える。
 */
.opt-btn {
  /* 欄の隣 1 桁にちょうど収まる。桁割りには影響しない（絶対配置） */
  position: absolute;
  margin: var(--grid-pad-y) 0 0 var(--grid-pad-x);
  z-index: 6;
  width: 1ch;
  height: 1.25em;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  line-height: 1.25;
  cursor: pointer;
  opacity: 0.7;
}
.opt-btn:hover,
.opt-btn:focus-visible {
  opacity: 1;
}

.opt-hints {
  position: absolute;
  margin: var(--grid-pad-y) 0 0 var(--grid-pad-x);
  z-index: 7;
  display: flex;
  flex-direction: column;
  min-width: 14ch;
  max-height: 14em;
  overflow-y: auto;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
  box-shadow: 0 6px 18px rgb(0 0 0 / 28%);
  font-family: var(--sans);
  font-size: 0.8em;
  line-height: 1.5;
}
.opt-hint {
  display: flex;
  gap: 0.7em;
  align-items: baseline;
  padding: 2px 7px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.opt-hint:hover,
.opt-hint:focus-visible {
  background: var(--accent-soft);
}
.opt-hint[aria-selected="true"] {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
.opt-hint-n {
  min-width: 2ch;
  color: var(--accent);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.opt-hint-l {
  color: var(--muted);
}

/* 枠: 面を持たず輪郭だけ。画面の内容を隠しすぎたくないとき */
.grid[data-opt-hints="outline"] .opt-hints {
  background: var(--paper);
  border-color: var(--accent);
  box-shadow: none;
}

/* 端末調: CRT の緑に寄せる。画面と地続きに見せたいとき */
.grid[data-opt-hints="crt"] .opt-hints {
  background: var(--crt-bezel);
  color: var(--t-green);
  border-color: var(--crt-line);
  font-family: var(--screen-mono);
}
.grid[data-opt-hints="crt"] .opt-hint-n {
  color: var(--t-yellow);
}
.grid[data-opt-hints="crt"] .opt-hint-l {
  color: var(--t-green);
}
.grid[data-opt-hints="crt"] .opt-hint:hover,
.grid[data-opt-hints="crt"] .opt-hint:focus-visible {
  background: var(--crt-line);
}
.grid[data-opt-hints="crt"] .opt-btn {
  color: var(--t-turquoise);
}

.gui-window-border {
  position: absolute;
  margin: var(--grid-pad-y) 0 0 var(--grid-pad-x);
  white-space: pre;
  pointer-events: none;
  line-height: 1.25;
}

.wide-cell {
  display: inline-block;
  width: 2ch;
  text-align: center;
  vertical-align: baseline;
}
/* 対（lead＋tail）を失った全角セル。ホストが片割れの桁へ上書きすると出る。
   ACS は左半分だけを描いて分断された形にするので、1ch の箱でクリップして同じ見え方にする
   （空白に置き換えると桁は合うが ACS と別物になる）。

   **クリップは overflow ではなく clip-path で行う。** インラインブロックのベースラインは
   overflow が visible 以外だと「下マージン端」に変わる規定で、実測すると隣の文字に対して
   2px 上へずれ、その行全体が縦にずれて見える（利用者報告の「高さ方向のずれ」）。
   clip-path は描画だけを切りレイアウトに影響しないので、ずれずに同じ見た目になる。 */
.half-cell {
  display: inline-block;
  width: 1ch;
  clip-path: inset(0);
  vertical-align: baseline;
}
/* 暗い背景に明るい文字を置くと既定のサブピクセル描画で太く・にじんで見える。
   グレースケール描画にすると輪郭が締まる */
.grid {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
/* ==== 機能キー凡例のボタン（spec D4/B2） ====
   `linkify` と同じく**同一の .grid-span 内にインライン**で置く。padding/margin/border を持たせず
   font を継ぐことで桁を動かさない（入力欄の描画と同じ考え方）。色も指定せず、
   ホストが送った色（.c-* / 反転）をそのまま継ぐ。意匠は下の .pane[data-buttons] で足す。

   **ボタンとして普通に扱えること**（decisions D5）: タブ順に入り（tabindex を落とさない）、
   フォーカス中の Space で押せる。一方 mousedown は preventDefault する——マウス操作では
   フォーカス（＝5250 のカーソル位置）を奪わず、矩形選択の開始も妨げないため。 */
.fkey-btn {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  padding: 0;
  margin: 0;
  border-radius: 0;
  line-height: inherit;
  letter-spacing: inherit;
  vertical-align: baseline;
  cursor: pointer;
  /* 桁の途中で折り返さない（凡例は 1 行に収まる前提） */
  white-space: pre;
}
.fkey-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

/* 画面テキスト内のリンク（桁幅は変えずインライン。色は turquoise 系＋下線） */
.grid-link {
  color: var(--t-turquoise, var(--t-white));
  text-decoration: underline;
  cursor: pointer;
}
.grid-link:hover {
  color: var(--t-white);
}
/*
 * 埋め込み属性（欄途中の色替え）用のオーバーレイ。
 * 通常欄は display:contents で素通し＝レイアウト影響ゼロ。色替えのある欄だけ
 * inline-block+relative にして、input の上に色付き span を重ねる。
 */
.input-cell {
  display: contents;
}
.input-cell.overlaid {
  display: inline-block;
  position: relative;
  vertical-align: baseline;
}
.input-overlay {
  position: absolute;
  left: 0;
  top: 0;
  height: 1.25em;
  line-height: 1.25;
  white-space: pre;
  pointer-events: none; /* クリック・キャレットは下の input に通す */
}
/*
 * **フォーカス中（編集中）はオーバーレイを隠し、入力欄の文字をそのまま見せる**（単色）。
 * オーバーレイは props 由来なので編集中の打鍵に追従しない。入力欄を透明にしたままだと
 * 打った文字が見えなくなるため、透明化とオーバーレイ表示は**非フォーカス時だけ**にする。
 * フォーカスが外れれば色付きオーバーレイに復元される。
 */
.input-cell.overlaid:focus-within .input-overlay {
  display: none;
}
.grid-input.has-overlay:not(:focus) {
  color: transparent;
}

.grid-input {
  font: inherit;
  height: 1.25em;
  padding: 0;
  margin: 0;
  border: none;
  /* グローバルの input 既定（角丸 6px）を打ち消す。
     5250 の入力欄は下線 1 本で表すので、角が丸いと下線の端が浮いて見える */
  border-radius: 0;
  /*
   * **見た目は属性クラス（.c-green / .a-reverse）に決めさせる。** scoped の詳細度 (0,2,0) は
   * グローバルの属性クラス (0,1,0) に勝つので、ここで color / background を直に書くと
   * ホストが送った色と反転を必ず潰す（実際、色は白のまま・反転は消えていた）。
   * 背景だけはブラウザ既定を消す必要があるため、**属性が指定した値を優先する変数**で受ける。
   */
  background: var(--cell-bg, transparent);
  vertical-align: baseline;
  caret-color: currentColor;
}
.grid-input:focus {
  outline: none;
  /* 反転中はその背景を保つ。フォーカスの色づけは反転していない欄だけ */
  background: var(--cell-bg, color-mix(in srgb, var(--t-green) 12%, transparent));
}
/* 保護（表示専用）フィールドは編集不可。入力欄の下線・キャレット・フォーカス背景を出さない（ACS 準拠） */
.grid-input[readonly] {
  border-bottom-color: transparent;
  caret-color: transparent;
}
.grid-input[readonly]:focus {
  background: var(--cell-bg, transparent);
}
/* 入力欄の下線は border-bottom（全桁）で表す。5250 の下線属性による text-decoration との
   二重下線（太く見える）を防ぐため、input では text-decoration を無効化する（ACS 準拠の単一下線）。
   **下線を引くのは下線属性が付いた欄だけ。** 5250 で入力欄が下線付きに見えるのは
   ホストが下線属性を送っているからであって、入力欄だから引かれるわけではない。
   無条件に引くと、非表示属性の欄（ヘルプ画面など ACS が何も描かない箇所）に
   1 桁の枠が浮き出る。 */
.grid-input.a-underline {
  text-decoration: none;
  border-bottom: 1px solid color-mix(in srgb, currentColor 55%, transparent);
}

/* ==== コントロール表現（画面設定・セッションごと）====
   .pane[data-controls] は祖先(EmulatorPane)に付く。値ごとに**編集可能な**入力欄の見せ方を変える。
   ここ(ScreenGrid の scope)に置くのは、scoped の詳細度で base の .grid-input:focus に確実に勝たせるため。
   桁・ホスト色を崩さないよう色替えは box-shadow / 限定的な background のみ。plain は規則なし＝5250 準拠。
   readonly（保護欄）には一切出さない。 */
/* 枠: 枠付きボックス＋フォーカスリング */
.pane[data-controls="box"] .grid-input:not([readonly]) {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--t-white) 22%, transparent);
  border-radius: 4px;
}
.pane[data-controls="box"] .grid-input:not([readonly]):focus {
  box-shadow: inset 0 0 0 1.6px var(--accent), 0 0 0 3px var(--accent-soft);
  outline: none;
}
/* 丸枠: 枠と同じだが角丸を大きく取る */
.pane[data-controls="boxRound"] .grid-input:not([readonly]) {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--t-white) 24%, transparent);
  border-radius: 999px;
}
.pane[data-controls="boxRound"] .grid-input:not([readonly]):focus {
  box-shadow: inset 0 0 0 1.6px var(--accent), 0 0 0 3px var(--accent-soft);
  outline: none;
}
/* くぼみ: 上辺の内側に影を落として「へこんだ入力欄」に見せる */
.pane[data-controls="inset"] .grid-input:not([readonly]) {
  background: var(--cell-bg, color-mix(in srgb, var(--t-white) 6%, transparent));
  box-shadow: inset 0 2px 3px -1px color-mix(in srgb, #000 55%, transparent);
  border-radius: 3px;
}
.pane[data-controls="inset"] .grid-input:not([readonly]):focus {
  box-shadow: inset 0 2px 3px -1px color-mix(in srgb, #000 55%, transparent), 0 0 0 2px var(--accent-soft);
  outline: none;
}
/* 破線: outline は**レイアウトに影響しない**ので、桁を保ったまま破線が引ける（border は使えない） */
.pane[data-controls="dashed"] .grid-input:not([readonly]) {
  outline: 1px dashed color-mix(in srgb, var(--t-white) 35%, transparent);
  outline-offset: -1px;
}
.pane[data-controls="dashed"] .grid-input:not([readonly]):focus {
  outline: 1px dashed var(--accent);
}
/* 発光: 休止は控えめ、フォーカスでアクセントの光。端末の雰囲気に馴染む */
.pane[data-controls="glow"] .grid-input:not([readonly]) {
  box-shadow: inset 0 -1px 0 color-mix(in srgb, currentColor 30%, transparent);
}
.pane[data-controls="glow"] .grid-input:not([readonly]):focus {
  background: var(--cell-bg, color-mix(in srgb, var(--accent) 10%, transparent));
  box-shadow: 0 0 0 2px var(--accent-soft), 0 0 10px -2px var(--accent);
  outline: none;
}
/* 下線: Material 風。休止は淡い下線、フォーカスでアクセントの太線。box-shadow なので桁ズレ無し。 */
.pane[data-controls="underline"] .grid-input:not([readonly]) {
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--t-white) 32%, transparent);
}
.pane[data-controls="underline"] .grid-input:not([readonly]):focus {
  background: var(--cell-bg, transparent);
  box-shadow: inset 0 -2px 0 var(--accent);
  outline: none;
}
/* 塗り: Notion 風のうっすら背景ティント＋角丸。反転欄は cell 背景を優先する。 */
.pane[data-controls="filled"] .grid-input:not([readonly]) {
  background: var(--cell-bg, color-mix(in srgb, var(--t-white) 8%, transparent));
  border-radius: 4px;
}
.pane[data-controls="filled"] .grid-input:not([readonly]):focus {
  background: var(--cell-bg, color-mix(in srgb, var(--accent) 15%, transparent));
  box-shadow: 0 0 0 2px var(--accent-soft);
  outline: none;
}

/* ==== ボタン意匠（画面設定・spec D5/B4）====
   「押せるもの」＝機能キー凡例のボタンと、拡張5250 が宣言した選択肢の**両方**に同じ意匠を効かせる。
   色替えは box-shadow と限定的な背景のみ（桁とホスト色を崩さない。コントロール表現と同じ方針）。
   none は凡例をボタン化しない（描画側で分割しない）ため、ここでは .gui-choice を現状のままにする。 */
.pane[data-buttons="underline"] .fkey-btn {
  box-shadow: inset 0 -1px 0 color-mix(in srgb, currentColor 45%, transparent);
}
.pane[data-buttons="underline"] .fkey-btn:hover {
  box-shadow: inset 0 -2px 0 var(--accent);
}
.pane[data-buttons="filled"] .fkey-btn {
  background: color-mix(in srgb, currentColor 12%, transparent);
  border-radius: 3px;
}
.pane[data-buttons="filled"] .fkey-btn:hover {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
.pane[data-buttons="box"] .fkey-btn {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 40%, transparent);
  border-radius: 3px;
}
.pane[data-buttons="box"] .fkey-btn:hover {
  box-shadow: inset 0 0 0 1.5px var(--accent), 0 0 0 2px var(--accent-soft);
}
/* ピル: 塗り＋大きい角丸 */
.pane[data-buttons="pill"] .fkey-btn {
  background: color-mix(in srgb, currentColor 14%, transparent);
  border-radius: 999px;
}
.pane[data-buttons="pill"] .fkey-btn:hover {
  background: color-mix(in srgb, var(--accent) 26%, transparent);
}
/* ゴースト: 普段は無地。hover で枠が出る（画面を汚さず、押せることは分かる） */
.pane[data-buttons="ghost"] .fkey-btn:hover {
  box-shadow: inset 0 0 0 1px var(--accent);
  border-radius: 3px;
}
/* 立体: 影で浮かせる */
.pane[data-buttons="raised"] .fkey-btn {
  background: color-mix(in srgb, currentColor 12%, transparent);
  box-shadow: 0 1px 2px color-mix(in srgb, #000 45%, transparent);
  border-radius: 3px;
}
.pane[data-buttons="raised"] .fkey-btn:hover {
  box-shadow: 0 2px 5px -1px color-mix(in srgb, #000 55%, transparent);
}
/* リンク風: アクセント色＋下線。**ここだけ色を変える**（他はホスト色を継ぐ） */
.pane[data-buttons="link"] .fkey-btn {
  color: var(--accent);
  box-shadow: inset 0 -1px 0 currentColor;
}
.pane[data-buttons="link"] .fkey-btn:hover {
  box-shadow: inset 0 -2px 0 currentColor;
}

/* 拡張5250 の選択肢も同じ意匠に揃える。**selected / unavailable の区別は全意匠で残す**
   （下の .gui-choice.selected / .unavailable が後から効く）。 */
.pane[data-buttons="underline"] .gui-choice {
  background: none;
  border-color: transparent;
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--t-green) 55%, transparent);
  border-radius: 0;
}
.pane[data-buttons="filled"] .gui-choice {
  background: color-mix(in srgb, var(--t-green) 22%, transparent);
  border-color: transparent;
  border-radius: 4px;
}
.pane[data-buttons="box"] .gui-choice {
  background: none;
  border-color: color-mix(in srgb, var(--t-green) 70%, transparent);
  border-radius: 4px;
}
.pane[data-buttons="pill"] .gui-choice {
  background: color-mix(in srgb, var(--t-green) 22%, transparent);
  border-color: transparent;
  border-radius: 999px;
}
.pane[data-buttons="ghost"] .gui-choice {
  background: none;
  border-color: transparent;
}
.pane[data-buttons="ghost"] .gui-choice:hover {
  border-color: var(--t-green);
}
.pane[data-buttons="raised"] .gui-choice {
  background: color-mix(in srgb, var(--t-green) 16%, transparent);
  border-color: transparent;
  box-shadow: 0 1px 2px color-mix(in srgb, #000 45%, transparent);
  border-radius: 4px;
}
.pane[data-buttons="link"] .gui-choice {
  background: none;
  border-color: transparent;
  box-shadow: inset 0 -1px 0 var(--t-green);
  border-radius: 0;
}

/* ==== ウィンドウ装飾（画面設定「ウィンドウ設定」）====
   矩形は fkeyLegend.detectWindowRect（拡張5250 の宣言／罫線検出の両対応）から来る。
   **重ねるだけ**——文字・桁・ホスト色には触れない。操作は透過させる。
   重なり順: 文字より上（z:2）、カーソル(z:4)・矩形選択(z:3)より下にして選択を隠さない。 */
.win-smoke,
.win-deco {
  position: absolute;
  margin: var(--grid-pad-y) 0 0 var(--grid-pad-x);
  pointer-events: none;
  z-index: 2;
  box-sizing: border-box;
}
/* --- 背景（窓の外側）--- 既定では何もしない */
.win-smoke {
  background: none;
}
/* スモーク: 暗くして下の画面を引っ込める */
.pane[data-window-backdrop="smoke"] .win-smoke {
  background: color-mix(in srgb, #000 45%, transparent);
}
/* すりガラス: ぼかし＋うっすら地色。下に何かあることは分かるが読めない */
.pane[data-window-backdrop="frost"] .win-smoke {
  background: color-mix(in srgb, var(--crt) 55%, transparent);
  backdrop-filter: blur(3px) saturate(0.85);
}
/* ぼやけ: 色は足さず、ぼかすだけ */
.pane[data-window-backdrop="blur"] .win-smoke {
  backdrop-filter: blur(2.5px);
}

/* --- ウィンドウ本体 --- */
/* 影: 窓の外側に落とす */
.pane[data-window-frame="shadow"] .win-deco {
  box-shadow: 0 6px 24px -6px color-mix(in srgb, #000 75%, transparent);
}
/* 浮き出し: 影＋窓の面をわずかに持ち上げる（地色を薄く敷く） */
.pane[data-window-frame="raised"] .win-deco {
  background: color-mix(in srgb, var(--t-white) 7%, transparent);
  box-shadow: 0 8px 28px -8px color-mix(in srgb, #000 80%, transparent);
  border-radius: 3px;
}
/* 枠強調: アクセント色の枠線を重ねる */
.pane[data-window-frame="outline"] .win-deco {
  box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 2px var(--accent-soft);
  border-radius: 3px;
}

/* ==== 拡張 5250 GUI オーバーレイ ==== */
.gui-window {
  position: absolute;
  margin: var(--grid-pad-y) 0 0 var(--grid-pad-x);
  border: 1px solid color-mix(in srgb, var(--t-turquoise, var(--t-green)) 70%, transparent);
  box-shadow: 0 0 6px color-mix(in srgb, var(--t-green) 30%, transparent);
  pointer-events: none;
  box-sizing: border-box;
}
/* ホストが WDWBORDER で枠を指定した窓は、その枠だけを出す（ACS と同じ）。
   汎用の窓アウトラインを重ねると枠が二重になる。 */
.gui-window.no-outline {
  border-color: transparent;
  box-shadow: none;
}
/* WDWTITLE: 枠の辺に載る見出し／脚注。枠の罫線を隠すよう地色を敷く */
.win-title {
  position: absolute;
  /* **枠（.gui-window-border）と必ず揃えること**——見出しは枠の辺に載る文字なので、
     片方だけ補正すると見出しが枠から外れる（原典メモは .win-title を補正済みとしていたが、
     当リポジトリでは抜けていた。decisions.md D1 参照）。 */
  margin: var(--grid-pad-y) 0 0 var(--grid-pad-x);
  white-space: pre;
  pointer-events: none;
  line-height: 1.25;
  background: var(--crt);
}
.gui-selection {
  position: absolute;
  margin: var(--grid-pad-y) 0 0 var(--grid-pad-x);
  display: flex;
  gap: 2px;
  z-index: 2;
}
.gui-selection.radio,
.gui-selection.checkbox {
  flex-direction: column;
  align-items: flex-start;
}
.gui-selection.pushbutton,
.gui-selection.menu {
  flex-direction: row;
}
.gui-choice {
  font: inherit;
  color: var(--t-white);
  background: color-mix(in srgb, var(--t-green) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--t-green) 45%, transparent);
  padding: 0 0.4ch;
  line-height: 1.2em;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.4ch;
}
.gui-selection.radio .gui-choice,
.gui-selection.checkbox .gui-choice {
  border: none;
  background: transparent;
}
.gui-choice:hover:not(:disabled) {
  background: color-mix(in srgb, var(--t-green) 22%, transparent);
}
.gui-choice.selected {
  color: var(--t-green);
  border-color: var(--t-green);
}
.gui-choice.unavailable,
.gui-choice:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.gui-marker {
  font-size: 0.9em;
}
.gui-scrollbar {
  position: absolute;
  margin: var(--grid-pad-y) 0 0 var(--grid-pad-x);
  background: color-mix(in srgb, var(--t-green) 12%, transparent);
  pointer-events: none;
}
.gui-scrollbar.vertical {
  width: 1ch;
  height: 8.75em; /* 7 行相当の目安 */
}
.gui-scrollbar.horizontal {
  height: 1.25em;
  width: 20ch;
}
.gui-thumb {
  position: absolute;
  background: color-mix(in srgb, var(--t-green) 55%, transparent);
}
.gui-scrollbar.vertical .gui-thumb {
  left: 0;
  width: 100%;
  height: 1.5em;
}
.gui-scrollbar.horizontal .gui-thumb {
  top: 0;
  height: 100%;
  width: 2ch;
}
</style>
