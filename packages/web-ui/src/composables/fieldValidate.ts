import type { Field } from "@as400web/core";

/**
 * 文字がフィールドの型で受理されるか（web 入力時の拒否。core の validateFieldContent と整合）。
 * 数値型は数字・符号・小数点、A 型（SBCS）は非全角、J 型（pure DBCS）は全角のみ。
 * コードページ許容文字の厳密判定は core（送信時）で行い、ここは型ベースの一次フィルタ。
 */
export function acceptsChar(field: Field, ch: string): boolean {
  return rejectReason(field, ch) === undefined;
}

/**
 * 弾く理由。**メッセージを出すには「なぜ弾いたか」が要る**ため、真偽値ではなく理由を返す。
 * 判定はここ 1 か所に置き、`acceptsChar` はこれに委譲する
 * （同じ事実の導出元を 2 つ持たない）。
 */
export type RejectReason =
  | "numeric" // 数値項目に許可外文字
  | "alphanumeric" // 半角(A)項目に全角
  | "dbcs-required"; // J 型(全角専用)項目に全角以外

export function rejectReason(field: Field, ch: string): RejectReason | undefined {
  if (ch.length === 0) return "alphanumeric";
  const isWide = isFullWidth(ch);

  // DBCS 種別
  if (field.dbcsType === "pure" && !isWide) return "dbcs-required"; // J 型: 全角のみ
  if (field.dbcsType === undefined && isWide) return "alphanumeric"; // SBCS(A/数値)に全角不可
  // open/either は SBCS/DBCS 両方許可（追加制限なし）

  // 数値型（数字・, . - + と空白を許可）
  if (field.numeric && !/[0-9.,+\-\s]/.test(ch)) return "numeric";

  return undefined;
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

/** DBCS 列ビューのレイアウト（view 文字列と桁⇔view の各種マッピング）。 */
export interface DbcsViewLayout {
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
  /** 桁範囲 [startCol, endCol) を 1 行として描画するときの view 範囲（境界にまたがる全角の扱い込み） */
  sliceRange: (startCol: number, endCol: number) => DbcsSliceRange;
  /** 列ビュー全体の表示桁数（＝送信バイト長。SO/SI=1・全角=2） */
  columns: number;
}

/**
 * DBCS 欄の編集用レイアウト。純論理値から列ビュー文字列と、論理カーソル⇔列ビュー caret の
 * 相互マッピングを作る。SO/SI は半角スペースとして列ビューに入るが、caret は論理境界にしか
 * 止まらない（＝カーソル移動時に SO/SI をスキップする）。
 */
export function dbcsViewLayout(logical: string, soMark = " ", siMark = " "): DbcsViewLayout {
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
  const sliceRange = (startCol: number, endCol: number): DbcsSliceRange => {
    let from = viewAtColumn(startCol);
    // 先頭桁が全角の後半に当たる＝前スライスからまたいで来た。実体は前スライスが描くので、
    // ここは空白 1 桁で場所だけ確保して次の文字から描く。
    const leadBlank = columnsBefore(from) < startCol;
    if (leadBlank) from += 1;
    let to = viewAtColumn(endCol);
    // 末尾桁が全角の前半に当たる＝次スライスへまたぐ。実体はこちらが描く（input 幅でクリップ）。
    if (columnsBefore(to) < endCol) to += 1;
    return { from, to, leadBlank };
  };
  return {
    view,
    caretOf,
    logicalOf,
    logicalAfter,
    columnsBefore,
    viewAtColumn,
    sliceRange,
    columns: columnsBefore(view.length)
  };
}

/**
 * **すでに組み上がった列ビュー文字列**から桁レイアウトを作る（休止表示専用）。
 * dbcsViewLayout が純論理値から SO/SI を再構成するのと違い、こちらは view をそのまま使うので、
 * SO/SI の空（{}）や不整合（{ だけ・} だけ）をセル由来のまま忠実に描ける。
 * caret 系（logicalOf 等）は休止表示では使わないため identity のスタブ（呼ばれない前提）。
 */
export function columnViewLayout(view: string): DbcsViewLayout {
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
      if (col < c + w) return i;
      c += w;
      i++;
    }
    return i;
  };
  const sliceRange = (startCol: number, endCol: number): DbcsSliceRange => {
    let from = viewAtColumn(startCol);
    const leadBlank = columnsBefore(from) < startCol;
    if (leadBlank) from += 1;
    let to = viewAtColumn(endCol);
    if (columnsBefore(to) < endCol) to += 1;
    return { from, to, leadBlank };
  };
  return {
    view,
    caretOf: (lc) => Math.min(lc, view.length),
    logicalOf: (vc) => vc,
    logicalAfter: (vc) => vc,
    columnsBefore,
    viewAtColumn,
    sliceRange,
    columns: columnsBefore(view.length)
  };
}

/**
 * 全角が行の折返し境界をまたぐとき、それを「前スライスの末尾」「次スライスの先頭」へどう割るか。
 *
 * 5250 のフィールドは画面バッファ上の連続バイト領域で、1 桁 = 1 バイト。全角の 2 バイトが
 * 行末と次行頭に落ちることは実際に起こり、ACS はそのグリフを左右に割って描画する
 * （＝桁揃えのスペースは入れない＝欄の容量は減らない）。ここもその桁割りに合わせる。
 *
 * <input> ではグリフを半分に割れないため、またぐ文字は前スライスの末尾に置いて input 幅で
 * クリップし（左半分が行末に見える）、次スライスは 1 桁ぶんの空白で始める。
 *
 * @param from   このスライスの先頭桁に対応する view インデックス（viewAtColumn の結果）
 * @param to     次スライスの先頭桁に対応する view インデックス
 */
export interface DbcsSliceRange {
  /** 実際に描画する view の開始インデックス */
  from: number;
  /** 実際に描画する view の終了インデックス（排他） */
  to: number;
  /** 先頭に空白 1 桁を置くか（＝前スライスからまたいで来た全角の後半桁） */
  leadBlank: boolean;
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
