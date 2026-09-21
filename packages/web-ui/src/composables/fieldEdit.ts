/**
 * 5250 フィールド編集モデル（純ロジック・テスト可能）。
 * native input 制御方式で使う: value・フィールド内カーソル・insert/overwrite モードを管理し、
 * 印字文字・Backspace・Delete・カーソル移動を 5250 の挙動で計算する。
 * 長さはフィールド長でクランプ（value は field.length 桁の枠内）。
 */
import { isRawSentinel, rawSentinel, sentinelByte } from "@ts5250/tn5250/browser";
export interface EditState {
  /** 現在値（末尾空白は含みうる。表示・送信時に整形） */
  chars: string[]; // 長さ = fieldLength（空白パディング）
  /** フィールド内カーソル位置（0..fieldLength-1） */
  cursor: number;
  /** true=挿入モード / false=上書きモード（5250 既定は上書き） */
  insertMode: boolean;
}

export function initEdit(value: string, fieldLength: number, cursor = 0): EditState {
  const chars = padTo(value.slice(0, fieldLength), fieldLength);
  // カーソルは 0..fieldLength（末尾＝最終文字の後ろ）を許可。末尾に置けると満杯欄でも
  // Backspace で最終文字を消せる（cursor===len で Backspace は index len-1 を削除）。
  return { chars, cursor: clamp(cursor, 0, fieldLength), insertMode: false };
}

/** value 文字列（末尾空白を保持したまま）を返す */
export function editValue(state: EditState): string {
  return state.chars.join("");
}

/** 印字文字を入力する（上書き既定 / 挿入モード）。フィールド長でクランプ */
export function typeChar(state: EditState, ch: string): EditState {
  const len = state.chars.length;
  if (state.cursor >= len) return state;
  if (state.insertMode) {
    // 挿入は余地を数える（~~末尾は溢れて落ちる~~——黙って字が消えた。`insertChar`）。余地が無ければ値を変えない
    return insertChar(state, ch, len - 1) ?? state;
  }
  const chars = [...state.chars];
  chars[state.cursor] = ch; // 上書き: カーソル位置を置換
  // カーソルは末尾（len）まで進む。cursor===len は「満杯」で以降の入力はブロックされる（field-exit 必要）
  return { ...state, chars, cursor: Math.min(state.cursor + 1, len) };
}

/** 余地を数えるときの空白（NUL も空き。ACS `reserveRoomForInsert` は NUL・空白・全角空白を数える） */
const isBlank = (c: string | undefined): boolean => c === " " || c === "\u0000" || c === "\u3000";

/**
 * **挿入モードで 1 文字入れる**（ACS `PS5250.insertChar` → `reserveRoomForInsert`。`20260921-insert-no-room`）。
 *
 * 余地が無ければ `undefined`（呼び出し側がエラー 0012 を出し、値を変えない）。余地の数え方は ACS と同じ:
 * - カーソルが欄の**最終桁**（`chars.length - 1`）以上なら、その桁が空白でも余地なし
 * - そうでなければ `lastTypeable`（符号付き数値は符号桁の手前）からカーソルまで、**末尾に続く空白**だけを数える。
 *   途中の空白は数えない（実機: 途中に空白があっても末尾が埋まっていればエラー。research F3 の I4）
 *
 * 余地があればカーソル位置へ入れ、`lastTypeable` の空白を 1 つ落とす——**それより後ろ（符号桁）は動かない**。
 * 以前は splice のあと欄の長さで切り詰めており、末尾の字が黙って消え、符号付き数値欄では符号桁まで押し出して値が化けた。
 */
export function insertChar(state: EditState, ch: string, lastTypeable: number): EditState | undefined {
  const { chars, cursor } = state;
  if (cursor >= chars.length - 1 || cursor > lastTypeable) return undefined;
  if (!isBlank(chars[lastTypeable])) return undefined;
  const next = [...chars];
  next.splice(cursor, 0, ch);
  next.splice(lastTypeable + 1, 1); // 押し出された末尾の空白（符号桁はこの後ろなので動かない）
  return { ...state, chars: next, cursor: cursor + 1 };
}

/** 5250 流バックスペース: カーソルを左へ、その位置以降を左詰め（破壊的） */
export function backspace(state: EditState): EditState {
  if (state.cursor <= 0) return state;
  const chars = [...state.chars];
  const pos = state.cursor - 1;
  chars.splice(pos, 1);
  chars.push(" "); // フィールド長を維持
  return { ...state, chars, cursor: pos };
}

/** Delete: カーソル位置を削除し以降を左詰め */
export function del(state: EditState): EditState {
  if (state.cursor >= state.chars.length) return state; // 末尾（後ろ）では削除対象が無い
  const chars = [...state.chars];
  chars.splice(state.cursor, 1);
  chars.push(" ");
  return { ...state, chars };
}

export function moveCursor(state: EditState, delta: number): EditState {
  // 上限は chars.length（末尾＝最終文字の後ろ）まで許可。右端でも末尾に止まれる。
  return { ...state, cursor: clamp(state.cursor + delta, 0, state.chars.length) };
}

export function home(state: EditState): EditState {
  return { ...state, cursor: 0 };
}

/**
 * End: 末尾の非空白の次（入力継続位置）へ。**最後の桁まで埋まっていれば最後の桁**（その文字の上）。
 * ~~満杯欄なら末尾（len）に到達する~~ → ACS `Field5250.getEndPosition`（`PS5250.processEndField` が使う）は
 * 欄の終わりから非空白を探し、見つけた桁が最後の桁ならそこを、そうでなければ次の桁を返す（`20260921-acs-default-keys`）
 */
export function end(state: EditState, from = 0): EditState {
  // `from` は探す下限（行をまたぐ欄の 2 行目以降では**今の行の先頭**。ACS `processEndField` がカーソルの行の先頭を下限に渡す）。
  // 下限から後ろに入力が無ければ下限に置く（ACS `getEndPosition` の `return n`。節目の点検の指摘: 欄全体を探して前の行へ戻っていた）
  const last = state.chars.length - 1;
  let i = last;
  while (i >= from && state.chars[i] === " ") i--;
  if (i < from) return { ...state, cursor: clamp(from, 0, state.chars.length) };
  return { ...state, cursor: clamp(i === last ? last : i + 1, 0, state.chars.length) };
}

/**
 * **継続欄（区切りの鎖）の End の行き先**（合成バッファの位置）。ACS `FFT5250.getEndPositionOfContField`: 最後の区切りから遡り、
 * 入力のある最初の区切りの中で「入力の直後。区切りの最後の桁まで埋まっていればその桁」。どの区切りにも入力が無ければ先頭の区切りの先頭
 */
export function continuedEnd(chars: readonly string[], lens: readonly number[]): number {
  let off = lens.reduce((a, b) => a + b, 0);
  for (let k = lens.length - 1; k >= 0; k--) {
    off -= lens[k]!;
    const last = off + lens[k]! - 1;
    let i = last;
    while (i >= off && chars[i] === " ") i--;
    if (i >= off) return i === last ? last : i + 1;
  }
  return 0;
}

export function toggleInsert(state: EditState): EditState {
  return { ...state, insertMode: !state.insertMode };
}

// ---------------------------------------------------------------------------
// ローカル編集キー（Field Exit / Erase EOF）の純ロジック
//
// **右寄せは端末の仕事**で、ホストは整形しない（実機で実測: 左詰めで送れば
// 左詰めのまま格納される）。適用の契機も Field Exit / Field± / DUP / 打鍵で満杯、に限られ、
// **Tab や Enter では適用しない**（GNU tn5250 `display.c` の `tn5250_display_field_adjust`
// 呼び出し元を全数確認）。
// ---------------------------------------------------------------------------

/** 欄の ADJUST 指定（core の `Field` から必要な分だけ受け取る） */
export interface AdjustSpec {
  adjust?: "right-zero" | "right-blank" | "mandatory-fill";
  signedNumeric?: boolean;
  /** 数値専用（FFW シフト 0x0300。DDS の Y・M）。Field− で最終桁のゾーンを D にする（`fieldSign`） */
  numericOnly?: boolean;
}

/** 数値専用の欄に入る文字の EBCDIC（ゾーンを D にするのに下位 4 ビットだけ使う。空白・未入力は 0x40 → 0） */
const NUMERIC_ONLY_EBCDIC: Readonly<Record<string, number>> = {
  "0": 0xf0, "1": 0xf1, "2": 0xf2, "3": 0xf3, "4": 0xf4, "5": 0xf5, "6": 0xf6, "7": 0xf7, "8": 0xf8, "9": 0xf9,
  ".": 0x4b, ",": 0x6b, "-": 0x60, "+": 0x4e, " ": 0x40
};

/** Erase EOF: カーソル位置から欄末尾までを空白にする。カーソルは動かさない */
export function eraseToEnd(state: EditState): EditState {
  const chars = [...state.chars];
  for (let i = state.cursor; i < chars.length; i++) chars[i] = " ";
  return { ...state, chars };
}

/**
 * 右寄せ。**GNU tn5250 `tn5250_display_shift_right`（lib5250/display.c）の移植**。
 *
 * 手順は原典どおり: ①先頭から続く空白を `fill` で置換 ②末尾が空白の間、1 桁ずつ右へずらして
 * 先頭に `fill` を置く。これにより
 *  - 末尾が既に非空白なら**1 桁も動かない**（満杯の欄は無変化）
 *  - 全桁が空白なら**何もしない**（原典に「そうしないと無限ループ」とある）
 *  - 語中の空白は保持されたまま一緒に動く（`"1 2  "` → RZ → `"001 2"`）
 *
 * `keepLastPosition` は符号付き数値欄用（最終桁＝符号桁を動かさない）。
 */
export function rightAdjust(
  state: EditState,
  fill: string,
  opts: { keepLastPosition?: boolean } = {}
): EditState {
  const chars = [...state.chars];
  const end = chars.length - 1 - (opts.keepLastPosition ? 1 : 0);
  if (end < 0) return state;

  let n = 0;
  for (; n <= end && chars[n] === " "; n++) chars[n] = fill;
  if (n > end) return state; // 全桁が空白 = 整形しない（原典の無限ループ回避と同じ判定）

  while (chars[end] === " ") {
    for (let i = end; i > 0; i--) chars[i] = chars[i - 1]!;
    chars[0] = fill;
  }
  // 右寄せ後は欄末尾（＝これ以上打てない位置）へ。Field Exit は直後に次の欄へ移るが、
  // 単独で呼んだときにカーソルが語の途中へ取り残されないようにする。
  return { ...state, chars, cursor: chars.length };
}

/**
 * FFW の指定どおりに右寄せする。
 *
 * **signed-num を ADJUST 指定より先に見る**のは原典どおり（tn5250 は signed-num の
 * `mand_fill_type` を無条件で `RIGHT_BLANK` へ差し替える。tn5250j も `adj===0` で同じ）。
 * 実機の DDS 数値欄は `6 0` も `6S 0` も signed-num で来るため、この規則が無いと
 * 数値欄で Field Exit が何もしないことになる。
 *
 * `mandatory-fill`（0x0007）は**右寄せではない**（「全桁を埋めよ」の検証指定）。両参照実装とも
 * 桁を動かさないので、ここでも動かさない。
 */
export function applyAdjust(state: EditState, field: AdjustSpec): EditState {
  if (field.signedNumeric) return rightAdjust(state, " ", { keepLastPosition: true });
  if (field.adjust === "right-zero") return rightAdjust(state, "0");
  if (field.adjust === "right-blank") return rightAdjust(state, " ");
  return state; // mandatory-fill / 無指定
}

/**
 * Field Exit: ①カーソル以降を欄末尾まで消去 ②ADJUST を適用。
 * MDT を立てることと次の欄へ移ることは呼び出し側（`ScreenGrid`）の担当。
 */
export function fieldExit(state: EditState, field: AdjustSpec): EditState {
  return applyAdjust(eraseToEnd(state), field);
}

/**
 * Field− / Field+: Field Exit と同じ整形をしたうえで、**符号桁（最終桁）に符号を確定する**。
 *
 * 対象は**符号付き数値欄だけ**。5250 の符号付き数値欄はワイヤ上 `桁数 + 1` バイトで、
 * 最終桁が符号桁（空白 = 正 / `-` = 負）。送信時に core が符号桁を落として
 * 最終桁のゾーンを 0xD にする（`read-response.ts`）。
 *
 * **符号付き数値でない欄では Field Exit と同じ**にする。原典（GNU tn5250 `display.c`）は
 * num-only 欄で最終バイトのゾーンを直接 0xD にするが、**実機の数値入力欄はすべて
 * signed-num** で（実機実測）num-only の符号処理を確かめられない。
 * 確かめられないものは実装しない側へ倒す（原典にも `field_minus_in_char` という同じ逃げ道がある）。
 */
export function fieldSign(state: EditState, field: AdjustSpec, negative: boolean): EditState {
  const s = fieldExit(state, field);
  if (!field.signedNumeric) {
    // **数値専用の欄の Field− は、欄の最終桁のバイトのゾーンを D にする**（ACS `PS5250.processFieldPlusMinusAndExit` の
    // `HostPlane[end] & 0x0F | 0xD0`。`20260921-field-minus-zone-d`）。最終桁が空でも同じ（0x00 / 0x40 → 0xD0）——実機の ACS のコアで
    // `12` と打って Field− → `12   }`（`scripts/acs-probe/field-minus-numeric-only.txt`）。ホストはゾーン D を負の数として読む。
    // 生バイトで持つ（`read-response.ts` がそのまま送る）。表示は空白になる（ACS はそのバイトの文字——`}` や `J`〜`R`——を出す）
    if (negative && field.numericOnly === true && s.chars.length > 0) {
      const chars = [...s.chars];
      const last = chars[chars.length - 1]!;
      const b = isRawSentinel(last) ? sentinelByte(last) : (NUMERIC_ONLY_EBCDIC[last] ?? 0x40);
      chars[chars.length - 1] = rawSentinel(0xd0 | (b & 0x0f));
      return { ...s, chars };
    }
    return s;
  }
  const chars = [...s.chars];
  if (chars.length === 0) return s;
  chars[chars.length - 1] = negative ? "-" : " ";
  return { ...s, chars, cursor: chars.length };
}

/**
 * Dup: カーソルから**欄末尾まで**を Dup 文字（EBCDIC `0x1C`）で埋める。
 *
 * `0x1C` は表示できる文字ではないので、生バイトを運ぶセンチネルで持つ
 * （`read-response.ts` がセンチネルを生バイト 1 つとして書き出す）。
 * 実機で 6 桁ぶん送ってアプリが `x'1C1C1C1C1C1C'` として受け取ることを確認済み。
 *
 * 呼び出し側が `DUP_ENABLE` を確かめてから呼ぶ（原典 `display.c:1795-1835`）。
 */
export const DUP_BYTE = 0x1c;
export function dupFill(state: EditState, dupChar: string): EditState {
  const chars = [...state.chars];
  for (let i = state.cursor; i < chars.length; i++) chars[i] = dupChar;
  return { ...state, chars, cursor: chars.length };
}

/** paste: 複数文字を現在モードで順に入力（超過は切り詰め） */
export function paste(state: EditState, text: string): EditState {
  let s = state;
  for (const ch of text) {
    if (s.cursor >= s.chars.length) break;
    s = typeChar(s, ch);
  }
  return s;
}

function padTo(s: string, len: number): string[] {
  const arr = [...s];
  while (arr.length < len) arr.push(" ");
  return arr.slice(0, len);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
