<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";
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
  type EditState
} from "../composables/fieldEdit.js";
import {
  acceptsChar,
  rejectReason,
  dbcsByteLength,
  dbcsViewLayout,
  isFullWidth,
  type RejectReason
} from "../composables/fieldValidate.js";
import { splitLinks, type LinkPart } from "../composables/linkify.js";
import { MSG_PROTECTED, MSG_BY_REASON } from "../composables/opMessages.js";
import { fitFont, MIN_FONT_PX, MAX_FONT_PX } from "../composables/fitFont.js";
import { fieldAt, caretInField, roundToDbcsLead, wordRangeAt } from "../composables/useCursor.js";
import {
  fieldSlices,
  fieldSpan,
  posOfOffset,
  offsetOfPos,
  type FieldSlice
} from "../composables/fieldSlices.js";
// codec サブパスからブラウザ安全に import（root は pino/node 依存を巻き込むため不可）
import { katakanaChar } from "@as400web/core/codec";

// linkify は既定 ON。Vue は未指定の Boolean prop を false にキャストするため withDefaults で true を明示する
const props = withDefaults(
  defineProps<{
    snapshot: ScreenSnapshot;
    edits: Map<number, string>;
    focused: boolean;
    /** SO を { ・SI を } で表示する（ACS の Ctrl+F 相当。既定は空白） */
    showShiftMarks?: boolean;
    /** SBCS を半角カナ解釈で表示する（ACS の表示コード切替。英小文字位置がカナ化） */
    katakanaView?: boolean;
    /** 画面テキストの URL/メールをリンク化する（既定 ON。カタカナ表示中は無効） */
    linkify?: boolean;
    /** 通信中（ホスト応答待ち）。入力欄を編集不可にしてプロテクトする */
    busy?: boolean;
    /** 有効カーソル（override ?? snapshot.cursor）。オーバーレイ位置・field/free 判定に使う */
    cursor?: { row: number; col: number };
    /** カタカナ系ホストコードページ（930/5026）。実機（ACS）同様、半角英小文字を入力時に大文字化する */
    uppercaseInput?: boolean;
  }>(),
  { linkify: true }
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
   *  例: 挿入ペーストが入り切らないときの "No room to insert data."。次のキー操作で消える。 */
  (e: "notice", text: string): void;
}>();

const gui = computed(() => props.snapshot.gui);

/** カタカナ系ホストコードページ（930/5026）では、実機（ACS）同様に半角英小文字を入力時点で
 *  大文字化する。対象は半角 ASCII の a-z のみ（全角・カナ・記号には影響しない）。 */
function inputChar(ch: string): string {
  return props.uppercaseInput && ch >= "a" && ch <= "z" ? ch.toUpperCase() : ch;
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

/** ウィンドウ枠の位置＋寸法スタイル */
function windowStyle(w: { row: number; col: number; width: number; height: number }): Record<string, string> {
  return { ...guiPos(w.row, w.col), width: w.width + "ch", height: w.height * 1.25 + "em" };
}

const selectionFields = computed<GuiSelectionLike[]>(
  () => (gui.value?.selectionFields ?? []) as GuiSelectionLike[]
);

interface Segment {
  kind: "text" | "input" | "dbcs";
  text: string;
  cls: string;
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

/** セルの表示文字（SO/SI マーク表示・カタカナ再解釈・dbcs-tail 空白埋め） */
function displayChar(c: Cell): string {
  if (props.showShiftMarks && c.kind === "so") return "{";
  if (props.showShiftMarks && c.kind === "si") return "}";
  // カタカナ表示: SBCS の生バイトを半角カナで再解釈
  if (props.katakanaView && c.kind === "sbcs" && c.rawByte !== undefined) {
    return katakanaChar(c.rawByte);
  }
  return c.char === "" ? " " : c.char;
}

// リンク化: 既定 ON（withDefaults）。カタカナ表示中は文字が別解釈になるため無効化（誤検出・桁崩れ防止）
const linkEnabled = computed(() => props.linkify && !props.katakanaView);

/** text セグメントをプレーン/リンク部分に分割（リンク無効時は単一のプレーン部分） */
function linkParts(text: string): LinkPart[] {
  return linkEnabled.value ? splitLinks(text) : [{ text }];
}

/** cell の属性を CSS class 文字列にする */
function cellClass(c: Cell): string {
  const cls = [`c-${c.color}`];
  if (c.underline) cls.push("a-underline");
  if (c.reverse) cls.push("a-reverse");
  if (c.blink) cls.push("a-blink");
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

/**
 * オーバーレイに出す色付きラン。テキストは入力欄と同じ表示値（＝編集にも追従）、
 * 色はバンド境界（桁）で割る。**全角は 2 桁**を占めるので、桁で正しく切る。
 */
function overlayRuns(seg: Segment): { text: string; cls: string }[] {
  const value = sliceValue(seg.field!, seg.slice ?? 0);
  const bands = seg.colorBands ?? [];
  const runs: { text: string; cls: string }[] = [];
  let ji = 0; // value の JS index
  let col = 0; // スライス先頭からの桁
  for (const b of bands) {
    const target = b.start + b.len;
    let text = "";
    while (col < target && ji < value.length) {
      const ch = value[ji]!;
      text += ch;
      col += isFullWidth(ch) ? 2 : 1;
      ji++;
    }
    // 値が尽きた残り桁は空白で埋める（属性桁・末尾パディング）
    while (col < target) {
      text += " ";
      col++;
    }
    runs.push({ text, cls: b.cls });
  }
  return runs;
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
      if (start) {
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
      // DBCS lead セルは 2ch 幅の専用セグメント（tail は char="" なので実質畳まれる）
      if (row[c]!.kind === "dbcs-lead") {
        segs.push({ kind: "dbcs", text: row[c]!.char, cls: cellClass(row[c]!) });
        c += 2; // lead + tail の 2 桁
        continue;
      }
      // text ラン（同一 class をまとめる）。DBCS/SO/SI 桁はまたがない
      const cls = cellClass(row[c]!);
      let text = "";
      while (
        c < snap.cols &&
        !fieldAt.has(r * snap.cols + c) &&
        row[c]!.kind !== "dbcs-lead" &&
        cellClass(row[c]!) === cls
      ) {
        text += displayChar(row[c]!);
        c++;
      }
      segs.push({ kind: "text", text, cls });
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
      // **埋め込み属性は 1 桁の空白として残す**（桁ずれ防止・core の SBCS fieldValue と同じ扱い）。
      // 落とすと以降が 1 桁ずつ左へずれる（お書きの「SO/SI と違い無視されてずれる」の原因）。
      else if (cell.kind === "attr") s += " ";
      // so / si / dbcs-tail は論理データに含めない（SO/SI は送信時に付け直す・tail は lead が保持）
    }
  }
  return s.replace(/ +$/, ""); // 末尾パディング空白を除去
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
  if (s.offset === 0 && s.width >= visLen(f)) return displayValue(f); // 単一スライス
  return displayValue(f).slice(s.offset, s.offset + s.width).padEnd(s.width, " ");
}

/** 列ビューをスライスの桁範囲で切り出す。境界にまたがる全角は前スライスの末尾に置き（input 幅で
 *  クリップされ左半分が行末に出る）、次スライスは空白 1 桁で始める＝ACS の桁割りと一致させる。 */
function dbcsSliceText(lay: ReturnType<typeof dbcsViewLayout>, s: FieldSlice): string {
  const r = lay.sliceRange(s.offset, s.offset + s.width);
  const text = (r.leadBlank ? " " : "") + lay.view.slice(r.from, r.to);
  const cols = (r.leadBlank ? 1 : 0) + lay.columnsBefore(r.to) - lay.columnsBefore(r.from);
  return text + " ".repeat(Math.max(0, s.width - cols)); // 予算に満たない末尾を桁まで埋める
}

/** スライス内 caret ⇔ 欄全体の列ビュー index。またがる全角のぶん（leadBlank）を吸収する。 */
function dbcsSliceRangeOf(f: Field, sliceIdx: number, lay: ReturnType<typeof dbcsViewLayout>) {
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
function dbcsRestLayout(f: Field): ReturnType<typeof dbcsViewLayout> {
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

/** 文字入力（5250 既定＝上書き。insertMode なら挿入）。 */
function dbcsType(e: EditState, ch: string, f: Field): EditState | undefined {
  const budget = visLen(f);
  const chars = [...e.chars];
  if (e.insertMode || e.cursor >= chars.length) {
    chars.splice(e.cursor, 0, ch);
  } else {
    // 上書きは「新しい文字が占める桁ぶん後続を食う」。全角は SO/SI 込みで最大 4 桁を占めるため、
    // 1 文字置換するだけだとバイト長が増えて後続が右へずれ、挿入に見えてしまう。
    const before = dbcsByteLength(chars.join(""));
    chars[e.cursor] = ch;
    while (dbcsByteLength(chars.join("")) > before && chars.length > e.cursor + 1) {
      chars.splice(e.cursor + 1, 1);
    }
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
  const masked = maskSafe(f, full);
  slicesOf(f).forEach((s, i) => {
    const el = inputForSlice(f, i);
    if (el) el.value = masked.slice(s.offset, s.offset + s.width).padEnd(s.width, " ");
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
  slicesOf(f).forEach((sl, i) => {
    const el = inputForSlice(f, i);
    if (el) el.value = dbcsSliceText(lay, sl);
  });
  const local = localCaret(lay.sliceRange(s.offset, s.offset + s.width), caret); // スライス内 caret
  target.setSelectionRange(local, local);
  insertMode.value = edit.insertMode;
  // **値が変わったときだけ編集を発火**（カーソル移動だけでは MDT にしない・バグ1）
  if (logical !== baselineValue(f)) emit("edit", f.index, logical);
  // 論理カーソルの表示桁（DBCS=2 桁）を AID 位置へ反映
  emit("cursor", s.row, s.col + (col - s.offset));
}

/** ACS の自動送り: 欄が最大桁まで埋まったら次の入力欄へ送るよう通知。
 *  SBCS は cursor===chars.length（満杯）、DBCS はバイト予算（SO/SI 込み）が満杯のとき。 */
function advanceIfFull(f: Field): void {
  if (!edit) return;
  if (isDbcsEdit(f)) {
    if (dbcsByteLength(editValue(edit).replace(/ +$/, "")) >= visLen(f)) emit("field-full", f.index);
    return;
  }
  if (edit.cursor >= edit.chars.length) emit("field-full", f.index);
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
    // ホストがカーソルを入力欄の外に置いた場合は従来どおり先頭欄へ（サインオン等）
    const first = gridEl.value.querySelector<HTMLInputElement>(
      'input.grid-input:not([readonly])[data-slice="0"]'
    );
    if (!first) return;
    first.focus();
    first.setSelectionRange(0, 0);
    if (edit) edit.cursor = 0;
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

  if (ev.key === "Insert") {
    ev.preventDefault();
    edit = toggleInsert(edit);
    insertMode.value = edit.insertMode;
    return;
  }
  if (ev.key === "Backspace") {
    ev.preventDefault();
    if (!deleteSelection(f, el)) edit = backspace(edit);
    sync(el, f);
    return;
  }
  if (ev.key === "Delete") {
    ev.preventDefault();
    if (!deleteSelection(f, el)) edit = del(edit);
    sync(el, f);
    return;
  }
  if (ev.key === "Home") {
    // 欄内はカーソルを先頭へ。ペインのフィールド移動へ伝播させない
    ev.preventDefault();
    ev.stopPropagation();
    edit = home(edit);
    sync(el, f);
    return;
  }
  if (ev.key === "End") {
    ev.preventDefault();
    ev.stopPropagation();
    edit = end(edit);
    sync(el, f);
    return;
  }
  // Ctrl+←/→（語頭ジャンプ）・Alt+←/→（ペイン移動）は欄内で消費せず、
  // ペイン keymap／App グローバルへ委譲する（preventDefault しない）。
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
    const ch = inputChar(ev.key); // 930/5026 は英小文字を大文字化
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
  if (k === "Backspace") {
    ev.preventDefault();
    if (!deleteSelection(f, el)) edit = dbcsBackspace(edit, f);
    syncDbcs(el, f);
    return;
  }
  if (k === "Delete") {
    ev.preventDefault();
    if (!deleteSelection(f, el)) edit = dbcsDelete(edit, f);
    syncDbcs(el, f);
    return;
  }
  if (k === "Home") {
    ev.preventDefault();
    ev.stopPropagation();
    edit = { ...edit, cursor: 0 };
    syncDbcs(el, f);
    return;
  }
  if (k === "End") {
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
    const ch = inputChar(k); // 930/5026 は半角英小文字を大文字化
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
  // sync がスライス間で focus を移したときは何もしない。ここで beginEdit すると props
  // （emit 前で古い）から編集モデルを作り直して直前の打鍵が消え、caret も先頭へ戻る。
  // 値・キャレットの確定は呼び出し元の sync が続けて行う。
  if (syncingFocus) return;
  beginEdit(f, el);
  if (isDbcsEdit(f)) {
    // DBCS 欄は編集中も列ビュー（SO/SI 込み）を表示。論理カーソルはこのスライスの先頭桁へ。
    const lay = dbcsLayoutOf(f);
    const r = dbcsSliceRangeOf(f, sliceIdx, lay);
    el.value = dbcsSliceText(lay, r.s); // パディング込み＝未入力桁にも caret を置ける
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
      el.value = sliceValue(f, sliceIdx);
      el.setSelectionRange(0, 0);
      emit("cursor", s.row, s.col);
      return;
    }
  }
  // SBCS: 休止時 :value と編集ビューは同一（純論理値スペース埋め）。
  // ただし hidden はスペース埋めがそのまま伏せ字になるため実入力分のみ表示する。
  // 行またぎ欄では、この input が担当するスライスぶんだけを入れる（全長を入れると桁が溢れる）。
  if (edit) el.value = sliceValue(f, sliceIdx);
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
  const el = ev.target as HTMLInputElement;
  el.value = sliceValue(f, Number(el.dataset["slice"] ?? 0));
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
    const ch = inputChar(raw); // 930/5026 は半角英小文字を大文字化
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
    out[i] = ch; // 上書き（後ろの既存文字はそのまま残る）
    i++;
  }
  while (out.length > 0 && dbcsByteLength(out.join("")) > budget) out.pop();
  return out.join("").replace(/\s+$/, "");
}

/** ACS が挿入ペーストの入り切らないときに出す操作員メッセージ。 */
const NO_ROOM = "No room to insert data.";


/** 挿入ペーストで最初に見つかる入力不可文字の理由。無ければ undefined。
 *  **挿入モードは 1 文字でも不可なら一切貼らない**（ACS）。上書きモードは桁を消費するだけで
 *  エラーにしないため、この判定は挿入経路でのみ使う。 */
function firstRejection(field: Field, text: string): RejectReason | undefined {
  for (const raw of text) {
    if (raw === "\n" || raw === "\r") continue;
    const why = rejectReason(field, inputChar(raw));
    if (why) return why;
  }
  return undefined;
}

/** 欄の値 base の offset 桁目へ line を挿入する（Insert モードのペースト）。後続は右へずれる。
 *  欄の予算に収まらなければ undefined を返す（呼び出し側が中断して NO_ROOM を出す）。
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
    const ch = inputChar(raw); // 930/5026 は半角英小文字を大文字化
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
  const startOffset = sliceOffsetOf(f, el) + (el.selectionStart ?? 0);
  pasteFrom(posOfOffset(f, startOffset, cols, rows), text, { f, el, startOffset });
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
        e.parts.push({ offset: caretInField(t.field, row, from, cols, rows), line: rest.slice(0, width) });
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
        emit("notice", NO_ROOM);
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
      edit = isDbcsEdit(f)
        ? { chars: padDbcs(f, [...val]), cursor: startOffset, insertMode: insertMode.value }
        : { ...initEdit(val, visLen(f), startOffset), insertMode: insertMode.value };
      editFieldIndex = f.index;
      sync(el, f);
    } else {
      emit("edit", field.index, val);
      // :value バインドは v-memo でキャッシュされ再評価されないため、全スライスの input を直接更新する
      slicesOf(field).forEach((_s, i) => {
        const inp = inputForSlice(field, i);
        if (inp) inp.value = sliceValue(field, i);
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
   * **ただし DBCS 欄の単一行だけは従来経路を残す（decisions.md D1）。**
   * pasteMultiline は桁（列ビュー）で宛先を決め、書き込みは overwriteInto が
   * 論理文字の配列で行う。全角は SO+2+SI=4 桁を占めるため両者がずれ、
   * 既存の全角を壊す（"ABCDEF" の 1 桁目へ "日" を貼ると A日F になるべきところ A日CDEF）。
   */
  if (isDbcsEdit(f)) {
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
        emit("notice", NO_ROOM);
        return;
      }
    }
    for (const raw of [...text]) {
      const ch = inputChar(raw);
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
  const prefix = edit.chars.slice(from, composeStart).join("");
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
    const ch = inputChar(raw); // 930/5026 は半角英小文字を大文字化
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

/** マウス座標 → セル (row,col)（1 始まり・画面内にクランプ）。padding 8px/10px を差し引く。 */
function cellAt(ev: MouseEvent): { row: number; col: number } | undefined {
  const el = gridEl.value;
  if (!el) return undefined;
  const rect = el.getBoundingClientRect();
  const lineH = fontPx.value * 1.25;
  const col = Math.floor((ev.clientX - rect.left - 10) / charWidthPx()) + 1;
  const row = Math.floor((ev.clientY - rect.top - 8) / lineH) + 1;
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

/** 選択矩形をコピー用テキストへ。各行=矩形の桁範囲、行は改行区切り。全角後半・SO/SI を処理。 */
function copyCharOf(cell: Cell): string {
  if (cell.kind === "dbcs-tail") return ""; // 全角は lead で 1 文字（tail は畳む）
  if (cell.kind === "so" || cell.kind === "si") return " "; // 制御桁は空白として写す
  if (props.katakanaView && cell.kind === "sbcs" && cell.rawByte !== undefined) return katakanaChar(cell.rawByte);
  return cell.char === "" ? " " : cell.char;
}
/** 画面桁 (row,col) の文字。入力欄の桁は「現在の入力値」を優先する。
 *  cells はホストが描いた内容しか持たないため、これを見ないと未送信の入力値がコピーされない。 */
function charAtForCopy(row: number, col: number): string {
  const f = fieldAt(row, col, props.snapshot.fields, props.snapshot.cols, props.snapshot.rows);
  if (f && !f.protected) {
    // 欄の表示（列ビュー/パディング込み）から該当桁を取り出す。DBCS は全角が 2 桁を占めるため
    // 桁で数える。hidden 欄は伏せ字がそのまま出る（実値は漏らさない）。
    const view = displayValue(f);
    const offset = offsetOfPos(f, row, col, props.snapshot.cols, props.snapshot.rows);
    if (offset === undefined) return " ";
    let c = 0;
    for (const ch of view) {
      const w = isFullWidth(ch) ? 2 : 1;
      if (offset < c + w) return offset === c ? ch : ""; // 全角の後半桁は畳む（lead で 1 文字）
      c += w;
    }
    return " ";
  }
  const cell = props.snapshot.cells[row - 1]?.[col - 1];
  return cell ? copyCharOf(cell) : " ";
}

function rectText(): string {
  const s = rectSel.value;
  if (!s) return "";
  const lines: string[] = [];
  for (let r = s.r1; r <= s.r2; r++) {
    let line = "";
    for (let c = s.c1; c <= s.c2; c++) line += charAtForCopy(r, c);
    lines.push(line.replace(/\s+$/, "")); // 各行末尾の空白は落とす（矩形右端の余白）
  }
  return lines.join("\n");
}
function onDocCopy(ev: ClipboardEvent): void {
  if (!rectSel.value) return;
  ev.clipboardData?.setData("text/plain", rectText());
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
  const col = Math.floor((ev.clientX - rect.left - 10) / charWidthPx()) + 1; // padding 10px
  const row = Math.floor((ev.clientY - rect.top - 8) / lineH) + 1; // padding 8px
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
  const availW = host.clientWidth - 20; // padding 10px * 2
  const availH = host.clientHeight - 16; // padding 8px * 2
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

defineExpose({ setBlockSelection, clearBlockSelection: clearRectSel, setDbcsCaretAtColumn, pasteAt });

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
    :style="{ fontSize: fontPx + 'px' }"
    :data-focused="focused"
    @click="onGridClick"
    @dblclick="onGridDblclick"
    @mousedown="onGridMousedown"
    @focusin="onGridFocusIn"
    @focusout="onGridFocusOut"
  >
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
    <template v-if="gui">
      <div
        v-for="w in gui.windows"
        :key="'w' + w.id"
        class="gui-window"
        :style="windowStyle(w)"
        aria-hidden="true"
      >
        <span v-if="w.title" class="gui-window-title">{{ w.title }}</span>
      </div>
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
    <div v-for="(segs, r) in rows" :key="r" class="grid-row" v-memo="[segs, linkEnabled]">
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
            :value="sliceValue(seg.field!, seg.slice ?? 0)"
            :readonly="seg.field!.protected"
            type="text"
            :autocomplete="seg.field!.hidden ? 'off' : undefined"
            :maxlength="seg.width ?? seg.field!.length"
            @keydown="onInputKeydown(seg.field!, $event)"
            @beforeinput="onInputBeforeInput(seg.field!, $event as InputEvent)"
            @paste="onInputPaste(seg.field!, $event as ClipboardEvent)"
            :data-field-index="seg.field!.index"
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
        <span v-else-if="seg.kind === 'dbcs'" class="grid-span grid-dbcs" :class="seg.cls">{{ seg.text }}</span>
        <span v-else class="grid-span" :class="seg.cls"><template
          v-for="(p, j) in linkParts(seg.text)"
          :key="j"
        ><a
            v-if="p.href"
            class="grid-link"
            :href="p.href"
            target="_blank"
            rel="noopener noreferrer"
            @click.stop
          >{{ p.text }}</a><template v-else>{{ p.text }}</template></template></span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.grid {
  position: relative;
  /* 桁位置は ch 単位・DBCS=2ch を仮定するので、和欧 1:2 を保つ日本語等幅を使う（--screen-mono） */
  font-family: var(--screen-mono);
  line-height: 1.25;
  background: var(--crt);
  padding: 8px 10px;
  white-space: pre;
  /* フォントを幅・高さ両方にフィットさせるためスクロールバーは出さない */
  overflow: hidden;
  /* コンテンツ（cols×rows）ちょうどのサイズに縮め、.screen-wrap 側で中央寄せする。
     min(幅,高) フィットで生じる余白が右下に偏らず上下・左右均等になる。 */
  flex: 0 0 auto;
  max-width: 100%;
  max-height: 100%;
}
/* ホストのカーソル位置を示すブロックカーソル（padding 分オフセット） */
.cursor {
  position: absolute;
  margin: 8px 0 0 10px;
  width: 1ch;
  height: 1.25em;
  background: color-mix(in srgb, var(--t-green) 45%, transparent);
  pointer-events: none;
  /* 矩形選択（z-index:3）より上。カーソルは選択の始点＝必ず矩形の角に載るため、
     下に置くとハイライトに沈んで「始点にカーソルが見える」という ACS の挙動が崩れる */
  z-index: 4;
}
/* 矩形（ブロック）選択のハイライト（padding 分オフセット） */
.rect-sel {
  position: absolute;
  margin: 8px 0 0 10px;
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
/* 暗い背景に明るい文字を置くと既定のサブピクセル描画で太く・にじんで見える。
   グレースケール描画にすると輪郭が締まる */
.grid {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
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
/* DBCS（全角）は 2ch 幅を占有し中央寄せ（全角=半角×2 の桁対応を担保） */
.grid-dbcs {
  display: inline-block;
  width: 2ch;
  text-align: center;
  /* overflow:hidden は inline-block のベースラインを下端に変え全角が上へずれるため使わない。
     行(line-height:1.25)に合わせ text ベースラインで揃える。 */
  line-height: inherit;
  vertical-align: baseline;
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

/* ==== 拡張 5250 GUI オーバーレイ ==== */
.gui-window {
  position: absolute;
  margin: 8px 0 0 10px;
  border: 1px solid color-mix(in srgb, var(--t-turquoise, var(--t-green)) 70%, transparent);
  box-shadow: 0 0 6px color-mix(in srgb, var(--t-green) 30%, transparent);
  pointer-events: none;
  box-sizing: border-box;
}
.gui-window-title {
  position: absolute;
  top: -0.7em;
  left: 0.5ch;
  padding: 0 0.4ch;
  font-size: 0.85em;
  background: var(--crt);
  color: var(--t-turquoise, var(--t-white));
  white-space: nowrap;
}
.gui-selection {
  position: absolute;
  margin: 8px 0 0 10px;
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
  margin: 8px 0 0 10px;
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
