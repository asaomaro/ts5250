/**
 * 5250 フィールド編集モデル（純ロジック・テスト可能）。
 * native input 制御方式で使う: value・フィールド内カーソル・insert/overwrite モードを管理し、
 * 印字文字・Backspace・Delete・カーソル移動を 5250 の挙動で計算する。
 * 長さはフィールド長でクランプ（value は field.length 桁の枠内）。
 */
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
  const chars = [...state.chars];
  if (state.insertMode) {
    // 挿入: カーソル以降を右シフト（末尾は溢れて落ちる）
    chars.splice(state.cursor, 0, ch);
    chars.length = len; // フィールド長で切り詰め
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
