/**
 * 5250 フィールド編集モデル（純ロジック・テスト可能）。
 * native input 制御方式で使う: value・フィールド内カーソル・insert/overwrite モードを管理し、
 * 印字文字・Backspace・Delete・カーソル移動を 5250 の挙動で計算する。
 * 長さはフィールド長でクランプ（value は field.length 桁の枠内）。
 */
export interface EditState {
  /**
   * 現在値（末尾空白は含みうる。表示・送信時に整形）。
   *
   * **不変条件は「長さ = `fieldLength`」**（`padTo` が空白で埋める）。
   *
   * ただし `typeChar` に `need=2`（全角）を渡すと、空白 2 個を捨てて 1 個を入れるので
   * **長さが 1 減って不変条件が破れる**。`isDbcsEdit` の欄は `dbcsType()` を通って
   * ここへ来ないので、起きるのは **SBCS 経路に落ちる欄**（`hidden` の DBCS 欄など）だけ。
   * 狭いが**偶然で守られている**ので明記する（`decisions.md` D9 / D11）。
   * ※ その場合「バイト数が保たれる」とも言い切れない——`padDbcs` / `dbcsByteLength` の
   *   数え方は SO/SI 込みで、新しい DBCS ランを作ると +4/−2 になる。実害は `fitsBytes` が止める。
   */
  chars: string[];
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

/**
 * 印字文字を入力する（上書き既定 / 挿入モード）。フィールド長でクランプ。
 *
 * 挿入モードの採否は ACS `PS5250.insertChar` に合わせる（`decisions.md` D4）:
 * **カーソルが最終桁の上なら空きの有無に関係なく拒否**し、
 * 空きが `need` に満たなければ**値を 1 桁も変えない**。
 *
 * @param opts.need     この文字が要する桁数（SBCS=1 / 全角=2）。ACS も
 *                      `reserveRoomForInsert` に同じものを渡す
 * @param opts.reserved 末尾へ取り置く桁数（`reservedTail`）。**符号桁・DBCS 桁を守る**
 */
export function typeChar(
  state: EditState,
  ch: string,
  opts: { need?: number; reserved?: number } = {}
): EditState {
  const len = state.chars.length;
  if (state.cursor >= len) return state;
  const chars = [...state.chars];
  if (state.insertMode) {
    const need = opts.need ?? 1;
    // ACS は `cursorSBA == getEndPos()` で即座に拒否する。**空きが残っていても拒否する**
    // ——実機で確認済み（research F11: 最終桁が空白でも弾かれ、1 つ手前は通った）。
    // 結果として「挿入モードでは最終桁に直接打てない」——手前から押し出して埋める
    if (state.cursor === len - 1) return state;
    // 空きが足りなければ**何も変えない**。従来はここで末尾を無条件に切り捨てており、
    // 符号付き数値欄では**符号桁が落ちて値の符号が反転していた**（実機で観測。test-result.md T1）
    if (trailingRoom(chars, { cursor: state.cursor, reserved: opts.reserved ?? 0 }) < need) return state;
    // 挿入: カーソル以降を右シフトし、**末尾の空白を need 個だけ捨てる**。
    // SBCS（`need=1`）は 1 個捨てて**長さが保たれる**。全角（`need=2`）は 2 個捨てて 1 個入るので
    // **長さが 1 減る**——この経路の注意は `EditState.chars` の doc に書いた
    chars.splice(state.cursor, 0, ch);
    // **捨てるのは「数えたのと同じ位置」から**——末尾ではない。
    // 取り置き桁は**非空白のことがある**（符号付き数値欄の `-` は最終桁に入る）ので、
    // 末尾から捨てようとすると 1 桁も捨てられず配列が欄長を超えて伸び、
    // 後段の `fitsBytes` が落として「空きがあるのに打てない」になる（review ラウンド 1 の must）
    for (let k = 0; k < need; k++) {
      // **毎回数え直す**——1 つ捨てるたびに配列が縮むので、位置を使い回すと範囲外へ出る
      const from = chars.length - 1 - (opts.reserved ?? 0);
      if (!isBlankCell(chars[from])) break; // 非空白は捨てない（上の検査を通れば起きない）
      chars.splice(from, 1);
    }
  } else {
    // 上書き: カーソル位置を置換
    chars[state.cursor] = ch;
  }
  // カーソルは末尾（len）まで進む。cursor===len は「満杯」で以降の入力はブロックされる（field-exit 必要）
  return { ...state, chars, cursor: Math.min(state.cursor + 1, len) };
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

/** End: 末尾の非空白の次（入力継続位置）へ。満杯欄なら末尾（len）に到達する。 */
export function end(state: EditState): EditState {
  let i = state.chars.length - 1;
  while (i >= 0 && state.chars[i] === " ") i--;
  return { ...state, cursor: clamp(i + 1, 0, state.chars.length) };
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
}

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
  if (!field.signedNumeric) return s;
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

/**
 * paste: 複数文字を現在モードで順に入力する。
 *
 * **挿入モードでは「超過は切り詰め」ではない**——`typeChar` が空き不足なら値を変えずに返し、
 * 最終桁では拒否する（`20260920-insert-mode-overflow`）。上書きモードは従来どおり桁を消費する。
 *
 * **`opts` は `typeChar` へそのまま渡す**。渡さないと取り置き（符号桁・DBCS 桁）が効かず、
 * この関数だけが不変条件を素通しする口になる——**同じ不変条件の片方だけを直す事故が
 * この work で 4 回起きている**ので、経路を増やさない。
 *
 * ※ 本番の呼び出し元は無い（テストのみ）。撤去の可否は台帳へ送ってある。
 */
export function paste(
  state: EditState,
  text: string,
  opts: { need?: number; reserved?: number } = {}
): EditState {
  let s = state;
  for (const ch of text) {
    if (s.cursor >= s.chars.length) break;
    s = typeChar(s, ch, opts);
  }
  return s;
}

/** 空白として扱う文字（`padTo` の半角空白・DBCS の全角空白・未書き込みの NUL） */
function isBlankCell(ch: string | undefined): boolean {
  return ch === " " || ch === "　" || ch === "\0";
}

/**
 * 挿入のために**末尾へ取り置く空白スロット数**。
 *
 * ACS `PS5250.insertChar` は `reserveRoomForInsert` を呼ぶ前に走査開始位置を
 * `isSignedNumericField()` で 1 桁、DBCS 側（`isDBCSOnlyField()` / either が DBCS 側）で
 * **全角 1 文字ぶん＝2 桁**ずらす。当方はその「ずらす量」をここに集約する。
 *
 * **空白は必ず SBCS（1 バイト）なので、この数は桁数でもバイト数でもある。**
 * 単位を 1 つに畳んでおかないと、桁をバイト予算から引くといった取り違えが起きる。
 *
 * `either` を取り置かない理由は `decisions.md` D5（「いま DBCS 側か」に当たる実行時状態が
 * 当方のモデルに無く、推測を実装へ埋めないため）。
 */
export function reservedTail(opts: { signedNumeric?: boolean; dbcsReserved?: boolean }): number {
  return (opts.signedNumeric ? 1 : 0) + (opts.dbcsReserved ? 2 : 0);
}

/**
 * **末尾から連続する空白**の数（ACS `PS5250.reserveRoomForInsert` と同じ数え方）。
 * 欄の途中にある空白は数えない——`["A","B"," "," ","C"," "]` の答えは **1**。
 *
 * @param cursor   これより手前は数えない（ACS もカーソルの手前で走査を打ち切る）
 * @param reserved **走査の開始位置を末尾から何桁ずらすか**（`reservedTail` の値）
 *
 * ⚠ `reserved` は**開始位置をずらす量**であって、**結果から引く数ではない**。
 * 符号付き数値欄の符号は**最終桁**にあるので、末尾から数えると必ず 0 で止まる
 * ——引き算にすると `"1    -"` のような通常の形で空きが 0 と出て、
 * **符号付き数値欄への挿入が一切できなくなる**（開始位置をずらせば 4）。
 */
export function trailingRoom(
  chars: readonly string[],
  opts: { cursor: number; reserved?: number }
): number {
  let n = 0;
  for (let i = chars.length - 1 - (opts.reserved ?? 0); i >= opts.cursor && isBlankCell(chars[i]); i--) n++;
  return n;
}

function padTo(s: string, len: number): string[] {
  const arr = [...s];
  while (arr.length < len) arr.push(" ");
  return arr.slice(0, len);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
