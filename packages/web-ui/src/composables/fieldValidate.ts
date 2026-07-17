import type { Field } from "@as400web/core";

/**
 * 文字がフィールドの型で受理されるか（web 入力時の拒否。core の validateFieldContent と整合）。
 * 数値型は数字・符号・小数点、A 型（SBCS）は非全角、J 型（pure DBCS）は全角のみ。
 * コードページ許容文字の厳密判定は core（送信時）で行い、ここは型ベースの一次フィルタ。
 */
export function acceptsChar(field: Field, ch: string): boolean {
  if (ch.length === 0) return false;
  const isWide = isFullWidth(ch);

  // DBCS 種別
  if (field.dbcsType === "pure" && !isWide) return false; // J 型: 全角のみ
  if (field.dbcsType === undefined && isWide) return false; // SBCS(A/数値)フィールドに全角不可
  // open/either は SBCS/DBCS 両方許可（追加制限なし）

  // 数値型
  if (field.numeric && !/[0-9.,+\-\s]/.test(ch)) return false;

  return true;
}

/**
 * 5250 送信時のバイト長を見積もる（core codec.encode と整合）。
 * SBCS=1 バイト。DBCS 連続ランは SO(0x0E)+2×N+SI(0x0F)＝SO/SI を 1 ペア共有。
 * フィールド長（`field.length`）は SO/SI・DBCS 2 バイトを含むバイト予算なので、
 * 桁数上限の判定はこの見積り長で行う（JS 文字数では DBCS を過小評価してしまう）。
 */
export function dbcsByteLength(value: string): number {
  let bytes = 0;
  let inDbcs = false;
  for (const ch of value) {
    if (isFullWidth(ch)) {
      if (!inDbcs) {
        bytes += 1; // SO（ラン開始）
        inDbcs = true;
      }
      bytes += 2; // DBCS 1 文字 = 2 バイト
    } else {
      if (inDbcs) {
        bytes += 1; // SI（ラン終了）
        inDbcs = false;
      }
      bytes += 1; // SBCS
    }
  }
  if (inDbcs) bytes += 1; // 末尾 SI
  return bytes;
}

/**
 * 純論理値（SBCS＋DBCS、SO/SI 無し）を「列ビュー」表示文字列へ変換する。
 * DBCS 連続ランの前に SO、後ろに SI を**半角スペース 1 個**として挿入する（ホスト表示と同じ桁配置）。
 * 例: "ABC あDEF" → "ABC  あ DEF"（あ の前に SO、後ろに SI のスペース）。
 * これは表示専用。送信値は純論理値のまま（codec が本物の SO/SI を付与）。
 */
export function columnView(logical: string, soMark = " ", siMark = " "): string {
  let out = "";
  let inDbcs = false;
  for (const ch of logical) {
    const wide = isFullWidth(ch);
    if (wide && !inDbcs) {
      out += soMark; // SO（ラン開始）
      inDbcs = true;
    } else if (!wide && inDbcs) {
      out += siMark; // SI（ラン終了）
      inDbcs = false;
    }
    out += ch;
  }
  if (inDbcs) out += siMark; // 末尾 SI
  return out;
}

/**
 * DBCS 欄の編集用レイアウト。純論理値から列ビュー文字列と、論理カーソル⇔列ビュー caret の
 * 相互マッピングを作る。SO/SI は半角スペースとして列ビューに入るが、caret は論理境界にしか
 * 止まらない（＝カーソル移動時に SO/SI をスキップする）。
 */
export function dbcsViewLayout(
  logical: string,
  soMark = " ",
  siMark = " "
): {
  view: string;
  /** 論理カーソル lc（0..len）→ 列ビュー内の caret 位置 */
  caretOf: (lc: number) => number;
  /** 列ビューの caret 位置 → 最も近い論理カーソル（SO/SI はスキップ） */
  logicalOf: (viewCaret: number) => number;
  /** 列ビューの caret 位置 → その位置**以降**の最初の論理カーソル（SO/SI はスキップ）。
   *  logicalOf（最近傍スナップ）は SI 桁で左右が同点になり左へ倒れるため、
   *  「指定した桁から入力を始めたい」用途ではこちらを使う。 */
  logicalAfter: (viewCaret: number) => number;
  /** caret 位置より前の表示桁数（DBCS=2 桁） */
  columnsBefore: (viewCaret: number) => number;
  /** 表示桁 → その桁を含む文字の view インデックス（全角の後半桁は前半へ丸める） */
  viewAtColumn: (col: number) => number;
  /** 列ビュー全体の表示桁数（＝送信バイト長。SO/SI=1・全角=2） */
  columns: number;
} {
  let view = "";
  let inDbcs = false;
  const logToView: number[] = []; // logToView[li] = logical[li] の文字が入る view インデックス
  for (const ch of logical) {
    const wide = isFullWidth(ch);
    if (wide && !inDbcs) {
      view += soMark; // SO
      inDbcs = true;
    } else if (!wide && inDbcs) {
      view += siMark; // SI
      inDbcs = false;
    }
    logToView.push(view.length);
    view += ch;
  }
  if (inDbcs) view += siMark; // 末尾 SI
  const len = logToView.length;
  // 末尾カーソルは「最終文字の直後」。DBCS で終わる場合は末尾 SI の前に置く（SI を飛び越えない）。
  const endCaret = len > 0 ? logToView[len - 1]! + 1 : 0;
  const caretOf = (lc: number): number => (lc >= len ? endCaret : logToView[lc]!);
  const logicalOf = (vc: number): number => {
    let best = 0;
    let bestD = Infinity;
    for (let lc = 0; lc <= len; lc++) {
      const d = Math.abs(caretOf(lc) - vc);
      if (d < bestD) {
        bestD = d;
        best = lc;
      }
    }
    return best;
  };
  const logicalAfter = (vc: number): number => {
    let lc = 0;
    while (lc < len && caretOf(lc) < vc) lc++;
    return lc;
  };
  const columnsBefore = (vc: number): number => {
    let cols = 0;
    for (const ch of view.slice(0, vc)) cols += isFullWidth(ch) ? 2 : 1;
    return cols;
  };
  const viewAtColumn = (col: number): number => {
    let c = 0;
    let i = 0;
    for (const ch of view) {
      const w = isFullWidth(ch) ? 2 : 1;
      if (col < c + w) return i; // 全角の後半桁は前半へ丸まる（全角の途中には止まれない）
      c += w;
      i++;
    }
    return i;
  };
  return { view, caretOf, logicalOf, logicalAfter, columnsBefore, viewAtColumn, columns: columnsBefore(view.length) };
}

/**
 * 全角が「行の折返し境界」をまたがないよう、純論理値へ半角スペースを詰める（5250 の桁揃え）。
 *
 * 5250 は 1 画面桁 = 1 バイトなので、全角の 2 バイトが行末と次行頭に割れると描画できない。
 * 詰めるスペースは**送信値そのもの**へ入れる（列ビュー限定の飾りにしない）。こうすると codec が
 * SO/SI を組み直すだけで済み、表示・送信・バイト予算が単一の表現から導ける。
 *
 * @param bounds 欄先頭からの表示桁で表した折返し位置（＝次行の 1 桁目に当たる桁）
 * @param cursor 論理カーソル。手前へ詰めたぶんだけずらして返す
 */
export function alignDbcsWrap(
  chars: readonly string[],
  bounds: readonly number[],
  cursor = 0
): { chars: string[]; cursor: number } {
  const out = [...chars];
  let c = cursor;
  // 1 回の挿入で最低 1 桁は右へ動くので、桁数ぶん回せば必ず収束する（保険の上限）
  for (let guard = 0; guard <= out.length + bounds.length + 8; guard++) {
    const at = firstStraddle(out, bounds);
    if (at < 0) break;
    out.splice(at, 0, " ");
    if (at < c) c++;
  }
  return { chars: out, cursor: c };
}

/** 全角が折返し境界をまたぐ最初の論理インデックス（無ければ -1）。 */
function firstStraddle(chars: readonly string[], bounds: readonly number[]): number {
  if (bounds.length === 0) return -1;
  let col = 0;
  let inDbcs = false;
  for (let i = 0; i < chars.length; i++) {
    const wide = isFullWidth(chars[i]!);
    if (wide && !inDbcs) {
      col += 1; // SO
      inDbcs = true;
    } else if (!wide && inDbcs) {
      col += 1; // SI
      inDbcs = false;
    }
    if (wide && bounds.some((b) => col < b && b < col + 2)) return i;
    col += wide ? 2 : 1;
  }
  return -1;
}

/** 全角判定（East Asian Width の Wide/Fullwidth 近似。DBCS 相当の判別に使う） */
export function isFullWidth(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // ハングル字母
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首・記号
    (cp >= 0x3041 && cp <= 0x33ff) || // ひらがな・カタカナ・CJK 記号
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 拡張A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 統合漢字
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 互換漢字
    (cp >= 0xff00 && cp <= 0xff60) || // 全角英数記号
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}
