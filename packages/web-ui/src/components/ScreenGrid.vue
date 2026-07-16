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
import { acceptsChar, dbcsByteLength, columnView, dbcsViewLayout } from "../composables/fieldValidate.js";
import { splitLinks, type LinkPart } from "../composables/linkify.js";
import { fitFont, MIN_FONT_PX, MAX_FONT_PX } from "../composables/fitFont.js";
import { fieldAt, roundToDbcsLead } from "../composables/useCursor.js";
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
}>();

const gui = computed(() => props.snapshot.gui);

/** hidden（パスワード）欄の伏せ字。実値は edit モデルが持ち、DOM にはこの文字だけを置く。
 *  ASCII であることが要件: ● 等の記号は East Asian Width が Ambiguous で、フォントスタックの
 *  CJK フォント（BIZ UDGothic 等）に落ちて全角幅で描画され桁が崩れる（実測 16px＝2 桁）。 */
const MASK_CHAR = "*";

/** カタカナ系ホストコードページ（930/5026）では、実機（ACS）同様に半角英小文字を入力時点で
 *  大文字化する。対象は半角 ASCII の a-z のみ（全角・カナ・記号には影響しない）。 */
function inputChar(ch: string): string {
  return props.uppercaseInput && ch >= "a" && ch <= "z" ? ch.toUpperCase() : ch;
}

// 有効カーソル（未指定時は snapshot.cursor にフォールバック）
const effCursor = computed(() => props.cursor ?? props.snapshot.cursor);
// カーソルが編集可能フィールド上か（field モード）。true なら native キャレットが担うのでオーバーレイは隠す
const cursorOnEditable = computed(() => {
  const f = fieldAt(effCursor.value.row, effCursor.value.col, props.snapshot.fields);
  return f !== undefined && !f.protected;
});

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
  /** input の表示桁数（行残りにクランプ済み） */
  width?: number;
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

/** 各行を text/input セグメントに分解する（v-memo 用に行データの参照同一性を保つのは Vue の再評価に委ねる） */
const rows = computed<Segment[][]>(() => {
  const snap = props.snapshot;
  // col(0-based) → field（その行で入力フィールドが占める桁）
  const fieldAt = new Map<number, Field>();
  for (const f of snap.fields) {
    if (f.row < 1 || f.row > snap.rows) continue;
    for (let i = 0; i < f.length; i++) {
      const col = f.col - 1 + i;
      if (Math.floor(col / snap.cols) === 0 && f.row - 1 + Math.floor((f.col - 1 + i) / snap.cols) === f.row - 1) {
        // 単一行に収まる範囲のみ（複数行フィールドの折返しは 04 で精緻化）
        if (col < snap.cols) fieldAt.set((f.row - 1) * snap.cols + col, f);
      }
    }
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
      const field = fieldAt.get(addr);
      if (field && field.col - 1 === c) {
        // 表示幅はその行の残り桁にクランプ（幅広フィールドのグリッドはみ出し防止）
        const visibleLen = Math.min(field.length, snap.cols - c);
        segs.push({ kind: "input", text: "", cls: cellClass(row[c]!), field, width: visibleLen });
        c += visibleLen;
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

/** フィールドの可視（単一行）桁数。複数行フィールド（コマンド行等）は可視行に収めて
 *  入力欄が次の行へ回り込むのを防ぐ。単一行フィールドはフィールド長そのまま。 */
function visLen(f: Field): number {
  return Math.min(f.length, props.snapshot.cols - (f.col - 1));
}

/** 編集後の値が欄のバイト予算（SO/SI・DBCS 2 バイト込み）に収まるか。
 *  収まらない入力は拒否/切り捨てる（送信時の FIELD_OVERFLOW を入力段で防ぐ）。 */
function fitsBytes(candidate: EditState, f: Field): boolean {
  return dbcsByteLength(editValue(candidate).replace(/ +$/, "")) <= visLen(f);
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

/** 未編集 DBCS 欄のセルから純論理値を復元（sbcs 文字・dbcs-lead 文字を採用、so/si/dbcs-tail は除外）。 */
function logicalFromCells(f: Field): string {
  const row = props.snapshot.cells[f.row - 1];
  if (!row) return f.value;
  let s = "";
  const len = visLen(f);
  for (let i = 0; i < len; i++) {
    const cell = row[f.col - 1 + i];
    if (!cell) continue;
    if (cell.kind === "sbcs" || cell.kind === "dbcs-lead") s += cell.char;
    // so / si / dbcs-tail / attr は論理データに含めない
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
  const typed = value.replace(/ +$/, "").length;
  return MASK_CHAR.repeat(typed).padEnd(visLen(f), " ");
}

/** input の :value（休止時の表示）。DBCS 欄は列ビュー（SO/SI 込み）で表示する。 */
function displayValue(f: Field): string {
  if (f.hidden) return maskSafe(f, logicalValue(f));
  if (f.dbcsType) return columnView(logicalValue(f), soMark(), siMark());
  return inputValue(f);
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

/** DBCS 欄はライブ列ビュー編集（純論理値・非パディング・挿入モード）で扱う。 */
function isDbcsEdit(f: Field): boolean {
  return !!f.dbcsType && !f.hidden;
}

function beginEdit(f: Field, inputEl: HTMLInputElement): void {
  if (isDbcsEdit(f)) {
    // 純論理値（SO/SI 無し）をそのまま chars に。列ビューは sync で導出、カーソルは論理インデックス。
    edit = { chars: [...logicalValue(f)], cursor: 0, insertMode: true };
    editFieldIndex = f.index;
    return;
  }
  edit = initEdit(inputValue(f), visLen(f), inputEl.selectionStart ?? 0);
  edit.insertMode = insertMode.value;
  editFieldIndex = f.index;
}

// ---- DBCS 論理編集オペレーション（chars = 純論理値の配列・非パディング） ----
function dbcsInsert(e: EditState, ch: string): EditState {
  const chars = [...e.chars];
  chars.splice(e.cursor, 0, ch);
  return { ...e, chars, cursor: e.cursor + 1 };
}
function dbcsBackspace(e: EditState): EditState {
  if (e.cursor <= 0) return e;
  const chars = [...e.chars];
  chars.splice(e.cursor - 1, 1);
  return { ...e, chars, cursor: e.cursor - 1 };
}
function dbcsDelete(e: EditState): EditState {
  if (e.cursor >= e.chars.length) return e;
  const chars = [...e.chars];
  chars.splice(e.cursor, 1);
  return { ...e, chars };
}
function dbcsMove(e: EditState, delta: number): EditState {
  return { ...e, cursor: Math.max(0, Math.min(e.cursor + delta, e.chars.length)) };
}

function sync(inputEl: HTMLInputElement, f: Field): void {
  if (!edit) return;
  if (isDbcsEdit(f)) {
    syncDbcs(inputEl, f);
    return;
  }
  const full = editValue(edit);
  const trimmed = full.replace(/ +$/, "");
  // 送信値（emit）は常に末尾空白除去。sync が input を直接制御する（v-memo で :value 再描画が来ないため）。
  inputEl.value = maskSafe(f, full);
  const c = Math.min(edit.cursor, inputEl.value.length);
  inputEl.setSelectionRange(c, c);
  insertMode.value = edit.insertMode;
  emit("edit", f.index, trimmed);
  // 欄内のキャレット移動・入力で論理カーソルも追従させる（AID 送信位置・オーバーレイ整合）。
  // これで field モード中も有効カーソルが native キャレットの桁を指す。末尾（cursor===visLen）は
  // 欄の右端境界（f.col+visLen）を指し、reconcileFocus がその境界を「欄の末尾」として欄内に留める。
  emit("cursor", f.row, f.col + Math.min(edit.cursor, visLen(f)));
}

/** DBCS 欄の sync: 列ビュー（SO/SI スペース込み）を表示し、caret を論理カーソルの列位置へ。 */
function syncDbcs(inputEl: HTMLInputElement, f: Field): void {
  if (!edit) return;
  const logical = editValue(edit).replace(/ +$/, ""); // 純論理値（末尾パディング無し）
  const { view, caretOf, columnsBefore } = dbcsViewLayout(logical, soMark(), siMark());
  inputEl.value = view;
  const caret = caretOf(edit.cursor);
  inputEl.setSelectionRange(caret, caret);
  emit("edit", f.index, logical);
  // 論理カーソルの表示列（DBCS=2 桁）を AID 位置へ反映
  emit("cursor", f.row, f.col + Math.min(columnsBefore(caret), visLen(f) - 1));
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
  const idx = editable.findIndex(
    (f) => f.row === cur.row && cur.col >= f.col && cur.col < f.col + f.length
  );
  const inputs = gridEl.value.querySelectorAll("input.grid-input:not([readonly])");
  const el = inputs[idx >= 0 ? idx : 0] as HTMLInputElement | undefined;
  if (!el) return;
  el.focus();
  // スペース埋め表示だと value 再設定でカーソルが末尾へ行くため、明示的に先頭へ置く
  // （既にフォーカス済みだと focus() では onInputFocus が発火しないため）
  el.setSelectionRange(0, 0);
  if (edit) edit.cursor = 0;
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
  const s = el.selectionStart ?? 0;
  const e = el.selectionEnd ?? 0;
  if (s === e) return false;
  if (isDbcsEdit(f)) {
    const sel = dbcsSelection(f, el); // 列ビュー選択 → 論理範囲 [ls,le)（SO/SI は含まない）
    if (!sel) return false;
    const chars = [...edit.chars];
    chars.splice(sel.ls, sel.le - sel.ls);
    edit = { ...edit, chars, cursor: sel.ls };
    return true;
  }
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
    // 非入力キー（F キー等）はペインの keymap に委譲するため preventDefault しない
    if (ev.key.length === 1) ev.preventDefault();
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
  const nativeCaret = el.selectionStart;
  if (nativeCaret !== null && nativeCaret !== edit.cursor) {
    edit = { ...edit, cursor: Math.min(nativeCaret, visLen(f)) };
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
    if (!acceptsChar(f, ch)) return; // 型違反は拒否
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
  const vc = el.selectionStart;
  if (vc !== null) {
    const { caretOf, logicalOf } = dbcsViewLayout(editValue(edit).replace(/ +$/, ""));
    if (caretOf(edit.cursor) !== vc) edit = { ...edit, cursor: logicalOf(vc) };
  }
  const k = ev.key;
  if (k === "Backspace") {
    ev.preventDefault();
    if (!deleteSelection(f, el)) edit = dbcsBackspace(edit);
    syncDbcs(el, f);
    return;
  }
  if (k === "Delete") {
    ev.preventDefault();
    if (!deleteSelection(f, el)) edit = dbcsDelete(edit);
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
    edit = { ...edit, cursor: edit.chars.length };
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
  // 印字可能な 1 文字（修飾なし）: 型・バイト予算検証してから論理挿入
  if (k.length === 1 && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    ev.preventDefault();
    const ch = inputChar(k); // 930/5026 は半角英小文字を大文字化
    if (!acceptsChar(f, ch)) return;
    deleteSelection(f, el); // 選択があれば削除（cursor が選択開始へ）→ そこへ挿入で置換
    const trial = dbcsInsert(edit, ch);
    if (!fitsBytes(trial, f)) return; // SO/SI 込みバイト予算超過は拒否
    edit = trial;
    syncDbcs(el, f);
    advanceIfFull(f); // ACS: バイト予算満杯なら次の入力欄へ
    return;
  }
  // その他はペイン keymap へ委譲（preventDefault しない）
}

function onInputFocus(f: Field, ev: FocusEvent): void {
  const el = ev.target as HTMLInputElement;
  beginEdit(f, el);
  if (isDbcsEdit(f)) {
    // DBCS 欄は編集中も列ビュー（SO/SI 込み）を表示。caret を論理先頭の列位置へ。
    const { view, caretOf } = dbcsViewLayout(editValue(edit!), soMark(), siMark());
    el.value = view;
    const c = caretOf(0);
    el.setSelectionRange(c, c);
    if (edit) edit.cursor = 0;
    emit("cursor", f.row, f.col);
    return;
  }
  // SBCS: 休止時 :value と編集ビューは同一（純論理値スペース埋め）。
  // ただし hidden はスペース埋めがそのまま ● になるため実入力分のみ表示する。
  if (edit) el.value = maskSafe(f, editValue(edit));
  // スペース埋め表示だと Tab/フォーカスで native カーソルが末尾へ行き入力できなくなるため、
  // フォーカス時はフィールド先頭へ置く（クリックは mouseup で押下桁に上書きされる）。
  el.setSelectionRange(0, 0);
  if (edit) edit.cursor = 0;
  emit("cursor", f.row, f.col);
}

/** フォーカスアウト: 休止表示（DBCS は SO/SI 込みの列ビュー）へ戻す。 */
function onInputBlur(f: Field, ev: FocusEvent): void {
  if (composing.value) return; // IME 変換中の一時 blur は無視
  (ev.target as HTMLInputElement).value = displayValue(f);
}

/** DBCS 欄の選択範囲（列ビュー座標）を純論理値へ写す。SO/SI スペースは論理文字でないため含まれない。
 *  戻り値の text=論理文字列、[ls,le)=論理インデックス範囲（cut の削除に使う）。 */
function dbcsSelection(f: Field, el: HTMLInputElement): { text: string; ls: number; le: number } | undefined {
  if (!isDbcsEdit(f)) return undefined;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  if (start >= end) return undefined;
  const logical = (edit && editFieldIndex === f.index ? editValue(edit) : logicalValue(f)).replace(/ +$/, "");
  const { caretOf } = dbcsViewLayout(logical);
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
    // 列ビューの押下位置を論理カーソルへ写し、SO/SI に載ったら論理境界へスナップ
    const { logicalOf, caretOf, columnsBefore } = dbcsViewLayout(editValue(edit).replace(/ +$/, ""));
    const lc = logicalOf(el.selectionStart ?? 0);
    edit = { ...edit, cursor: lc };
    const c = caretOf(lc);
    el.setSelectionRange(c, c);
    emit("cursor", f.row, f.col + Math.min(columnsBefore(c), visLen(f) - 1));
    return;
  }
  const caret = Math.min(el.selectionStart ?? 0, f.length);
  emit("cursor", f.row, f.col + caret);
}

/** 欄の値を、開始桁 offset から line で上書きする（ACS のペースト＝カーソル位置起点）。
 *  offset より前は既存文字（無ければ空白）を残し、offset から型フィルタ済みの line を書く。
 *  SO/SI 込みバイト予算で切り詰め、末尾空白は落とす。 */
function overwriteFromOffset(field: Field, offset: number, line: string): string {
  const budget = visLen(field);
  const existing = [...logicalValue(field)];
  let out = "";
  for (let i = 0; i < offset; i++) {
    const ch = existing[i] ?? " ";
    if (dbcsByteLength(out + ch) > budget) return out.replace(/\s+$/, "");
    out += ch;
  }
  for (const raw of line) {
    if (raw === "\n" || raw === "\r") continue;
    const ch = inputChar(raw); // 930/5026 は半角英小文字を大文字化
    if (!acceptsChar(field, ch)) continue;
    if (dbcsByteLength(out + ch) > budget) break;
    out += ch;
  }
  return out.replace(/\s+$/, "");
}

/** 複数行テキストを、フォーカス欄から下方向へ「空行なく連続する入力欄」へ 1 行ずつ流し込む（ACS 相当）。
 *  ペースト開始桁（フォーカス欄の caret オフセット）を起点に、各行を同じオフセットから上書きする。 */
function pasteMultiline(f: Field, text: string, el: HTMLInputElement): void {
  const lines = text.split(/\r?\n/);
  const offset = el.selectionStart ?? 0; // ペースト開始桁（欄内オフセット）
  const editable = props.snapshot.fields.filter((fl) => !fl.protected);
  let cur: Field | undefined = f;
  let i = 0;
  while (cur && i < lines.length) {
    const field: Field = cur;
    const val = overwriteFromOffset(field, offset, lines[i] ?? "");
    if (field.index === f.index) {
      // 先頭行はフォーカス欄へ（edit モデルを置換して sync）
      edit = isDbcsEdit(f) ? { chars: [...val], cursor: val.length, insertMode: true } : initEdit(val, visLen(f), val.length);
      editFieldIndex = f.index;
      sync(el, f);
    } else {
      emit("edit", field.index, val);
      // :value バインドは v-memo でキャッシュされ再評価されないため、input を直接更新する
      const inp = gridEl.value?.querySelector<HTMLInputElement>(`input.grid-input[data-field-index="${field.index}"]`);
      if (inp) inp.value = displayValue(field);
    }
    cur = editable.find((fl) => fl.row === field.row + 1);
    i++;
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
  if (f.protected || props.busy) return;
  const text = ev.clipboardData?.getData("text") ?? "";
  if (!text) return;
  const el = ev.target as HTMLInputElement;
  if (!edit || editFieldIndex !== f.index) beginEdit(f, el);
  if (text.includes("\n")) {
    pasteMultiline(f, text, el); // 複数行 → 連続入力欄へ分配
    return;
  }
  // 単一行: native caret を論理カーソルへ写してから挿入
  const dbcs = isDbcsEdit(f);
  const vc = el.selectionStart;
  if (vc !== null) {
    if (dbcs) {
      const { logicalOf } = dbcsViewLayout(editValue(edit!).replace(/ +$/, ""));
      edit = { ...edit!, cursor: logicalOf(vc) };
    } else {
      edit = { ...edit!, cursor: Math.min(vc, visLen(f)) };
    }
  }
  let e: EditState = edit!;
  for (const raw of [...text]) {
    const ch = inputChar(raw); // 930/5026 は半角英小文字を大文字化
    if (!acceptsChar(f, ch)) continue;
    const trial = dbcs ? dbcsInsert(e, ch) : typeChar(e, ch);
    if (!fitsBytes(trial, f)) break;
    e = trial;
  }
  edit = e;
  sync(el, f);
  advanceIfFull(f); // ACS: 貼り付けで満杯なら次の入力欄へ
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
  if (!deleteSelection(f, el)) {
    const nativeCaret = el.selectionStart;
    if (nativeCaret !== null) {
      if (isDbcsEdit(f)) {
        const { logicalOf } = dbcsViewLayout(editValue(edit).replace(/ +$/, ""));
        edit = { ...edit, cursor: logicalOf(nativeCaret) };
      } else {
        edit = { ...edit, cursor: Math.min(nativeCaret, visLen(f)) };
      }
    }
  }
  composeStart = edit.cursor;
  const prefix = edit.chars.slice(0, composeStart).join(""); // 合成開始桁より前の既入力（純論理値）
  el.value = prefix; // 合成中は純論理値の prefix（SO/SI 無し）＋候補。確定後に列ビューへ整形する
  el.setSelectionRange(prefix.length, prefix.length); // 候補を入力位置（既入力の直後）に出す
}

function onCompositionEnd(f: Field, ev: CompositionEvent): void {
  composing.value = false;
  if (f.protected) return;
  if (f.hidden) return; // 伏せ字 value を読み込まない（onCompositionStart で合成自体を止めている）
  const el = ev.target as HTMLInputElement;
  if (!edit || editFieldIndex !== f.index) beginEdit(f, el);
  edit = edit!;
  // el.value = 既入力prefix + 確定文字。prefix（composeStart 桁分）を除いた確定分だけを
  // composeStart から流し込む（型フィルタ・バイト予算クランプ）。超過分は切り捨てる。
  const dbcs = isDbcsEdit(f);
  let e: EditState = { ...edit, cursor: composeStart };
  for (const raw of [...el.value].slice(composeStart)) {
    const ch = inputChar(raw); // 930/5026 は半角英小文字を大文字化
    if (!acceptsChar(f, ch)) continue;
    const trial = dbcs ? dbcsInsert(e, ch) : typeChar(e, ch);
    if (!fitsBytes(trial, f)) break; // 桁超過分は切り捨て
    e = trial;
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
  }
  if (dragMoved) {
    ev.preventDefault();
    window.getSelection()?.removeAllRanges();
    rectSel.value = normRect(dragAnchor, cell);
  }
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
function rectText(): string {
  const s = rectSel.value;
  if (!s) return "";
  const lines: string[] = [];
  for (let r = s.r1; r <= s.r2; r++) {
    let line = "";
    for (let c = s.c1; c <= s.c2; c++) {
      const cell = props.snapshot.cells[r - 1]?.[c - 1];
      line += cell ? copyCharOf(cell) : " ";
    }
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
    fontPx.value = Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, cur * ratio));
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
defineExpose({ setBlockSelection, clearBlockSelection: clearRectSel });

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
    @mousedown="onGridMousedown"
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
        <input
          v-if="seg.kind === 'input'"
          class="grid-input"
          :class="seg.cls"
          :style="{ width: (seg.width ?? seg.field!.length) + 'ch' }"
          :value="displayValue(seg.field!)"
          :readonly="seg.field!.protected"
          type="text"
          :autocomplete="seg.field!.hidden ? 'off' : undefined"
          :maxlength="seg.width ?? seg.field!.length"
          @keydown="onInputKeydown(seg.field!, $event)"
          @beforeinput="onInputBeforeInput(seg.field!, $event as InputEvent)"
          @paste="onInputPaste(seg.field!, $event as ClipboardEvent)"
          :data-field-index="seg.field!.index"
          @focus="onInputFocus(seg.field!, $event)"
          @blur="onInputBlur(seg.field!, $event as FocusEvent)"
          @copy="onInputCopy(seg.field!, $event as ClipboardEvent)"
          @cut="onInputCut(seg.field!, $event as ClipboardEvent)"
          @click="onInputClick(seg.field!, $event as MouseEvent)"
          @compositionstart="onCompositionStart(seg.field!, $event as CompositionEvent)"
          @compositionend="onCompositionEnd(seg.field!, $event as CompositionEvent)"
        />
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
  font-family: var(--mono);
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
.grid-input {
  font: inherit;
  height: 1.25em;
  padding: 0;
  margin: 0;
  border: none;
  background: transparent;
  color: var(--t-white);
  border-bottom: 1px solid color-mix(in srgb, var(--t-green) 55%, transparent);
  vertical-align: baseline;
  caret-color: var(--t-green);
}
.grid-input:focus {
  outline: none;
  background: color-mix(in srgb, var(--t-green) 12%, transparent);
}
/* 保護（表示専用）フィールドは編集不可。入力欄の下線・キャレット・フォーカス背景を出さない（ACS 準拠） */
.grid-input[readonly] {
  border-bottom-color: transparent;
  caret-color: transparent;
}
.grid-input[readonly]:focus {
  background: transparent;
}
/* 入力欄の下線は border-bottom（全桁）で表す。5250 の下線属性による text-decoration との
   二重下線（太く見える）を防ぐため、input では text-decoration を無効化する（ACS 準拠の単一下線） */
.grid-input.a-underline {
  text-decoration: none;
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
