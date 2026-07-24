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

/**
 * 全角判定に使う範囲（昇順）。East Asian Width の **Wide/Fullwidth に加え Ambiguous も全角**として扱う。
 *
 * **DBCS 端末では Ambiguous（ギリシャ・キリル・約物・記号・罫線・幾何・私用外字）も 2 桁を占める。**
 * これらは DBCS 2 バイトからデコードされる（例: 0x445A → U+2010 '‐'）。Ambiguous を半角と見なすと、
 * ホストが DBCS で描いた文字が編集時に SBCS 扱いになり、表示（全角）と桁がずれる。
 * SBCS で使う半角カナ（U+FF61–FF9F）や ASCII は narrow のまま（この表に含めない）。
 */
const FULLWIDTH_RANGES: readonly (readonly [number, number])[] = [
  [0x00a1, 0x00a1], [0x00a4, 0x00a4], [0x00a7, 0x00a8], [0x00aa, 0x00aa], [0x00ad, 0x00ae],
  [0x00b0, 0x00b4], [0x00b6, 0x00ba], [0x00bc, 0x00bf], [0x00c6, 0x00c6], [0x00d0, 0x00d0],
  [0x00d7, 0x00d8], [0x00de, 0x00e1], [0x00e6, 0x00e6], [0x00e8, 0x00ea], [0x00ec, 0x00ed],
  [0x00f0, 0x00f0], [0x00f2, 0x00f3], [0x00f7, 0x00fa], [0x00fc, 0x00fc], [0x00fe, 0x00fe],
  [0x0101, 0x0101], [0x0111, 0x0111], [0x0113, 0x0113], [0x011b, 0x011b], [0x0126, 0x0127],
  [0x012b, 0x012b], [0x0131, 0x0133], [0x0138, 0x0138], [0x013f, 0x0142], [0x0144, 0x0144],
  [0x0148, 0x014b], [0x014d, 0x014d], [0x0152, 0x0153], [0x0166, 0x0167], [0x016b, 0x016b],
  [0x01ce, 0x01ce], [0x01d0, 0x01d0], [0x01d2, 0x01d2], [0x01d4, 0x01d4], [0x01d6, 0x01d6],
  [0x01d8, 0x01d8], [0x01da, 0x01da], [0x01dc, 0x01dc],
  [0x0251, 0x0251], [0x0261, 0x0261], [0x02c4, 0x02c4], [0x02c7, 0x02c7], [0x02c9, 0x02cb],
  [0x02cd, 0x02cd], [0x02d0, 0x02d0], [0x02d8, 0x02db], [0x02dd, 0x02dd], [0x02df, 0x02df],
  [0x0391, 0x03a1], [0x03a3, 0x03a9], [0x03b1, 0x03c1], [0x03c3, 0x03c9],
  [0x0401, 0x0401], [0x0410, 0x044f], [0x0451, 0x0451],
  [0x1100, 0x115f], // ハングル字母
  [0x2010, 0x2010], [0x2013, 0x2016], [0x2018, 0x2019], [0x201c, 0x201d], [0x2020, 0x2022],
  [0x2024, 0x2027], [0x2030, 0x2030], [0x2032, 0x2033], [0x2035, 0x2035], [0x203b, 0x203b],
  [0x203e, 0x203e], [0x2074, 0x2074], [0x207f, 0x207f], [0x2081, 0x2084], [0x20ac, 0x20ac],
  [0x2103, 0x2103], [0x2105, 0x2105], [0x2109, 0x2109], [0x2113, 0x2113], [0x2116, 0x2116],
  [0x2121, 0x2122], [0x2126, 0x2126], [0x212b, 0x212b], [0x2153, 0x2154], [0x215b, 0x215e],
  [0x2160, 0x216b], [0x2170, 0x2179], [0x2189, 0x2189],
  [0x2190, 0x2199], [0x21b8, 0x21b9], [0x21d2, 0x21d2], [0x21d4, 0x21d4], [0x21e7, 0x21e7],
  [0x2200, 0x2200], [0x2202, 0x2203], [0x2207, 0x2208], [0x220b, 0x220b], [0x220f, 0x220f],
  [0x2211, 0x2211], [0x2215, 0x2215], [0x221a, 0x221a], [0x221d, 0x2220], [0x2223, 0x2223],
  [0x2225, 0x2225], [0x2227, 0x222c], [0x222e, 0x222e], [0x2234, 0x2237], [0x223c, 0x223d],
  [0x2248, 0x2248], [0x224c, 0x224c], [0x2252, 0x2252], [0x2260, 0x2261], [0x2264, 0x2267],
  [0x226a, 0x226b], [0x226e, 0x226f], [0x2282, 0x2283], [0x2286, 0x2287], [0x2295, 0x2295],
  [0x2299, 0x2299], [0x22a5, 0x22a5], [0x22bf, 0x22bf], [0x2312, 0x2312],
  [0x2460, 0x24e9], [0x24eb, 0x254b], [0x2550, 0x2573], [0x2580, 0x258f], [0x2592, 0x2595],
  [0x25a0, 0x25a1], [0x25a3, 0x25a9], [0x25b2, 0x25b3], [0x25b6, 0x25b7], [0x25bc, 0x25bd],
  [0x25c0, 0x25c1], [0x25c6, 0x25c8], [0x25cb, 0x25cb], [0x25ce, 0x25d1], [0x25e2, 0x25e5],
  [0x25ef, 0x25ef],
  [0x2605, 0x2606], [0x2609, 0x2609], [0x260e, 0x260f], [0x2614, 0x2615], [0x261c, 0x261c],
  [0x261e, 0x261e], [0x2640, 0x2640], [0x2642, 0x2642], [0x2660, 0x2661], [0x2663, 0x2665],
  [0x2667, 0x266a], [0x266c, 0x266d], [0x266f, 0x266f], [0x273d, 0x273d], [0x2776, 0x277f],
  [0x2e80, 0x303e], // CJK 部首・記号
  [0x3041, 0x33ff], // ひらがな・カタカナ・CJK 記号
  [0x3400, 0x4dbf], // CJK 拡張A
  [0x4e00, 0x9fff], // CJK 統合漢字
  [0xe000, 0xf8ff], // 私用領域（外字・ユーザー定義 DBCS）
  [0xf900, 0xfaff], // CJK 互換漢字
  [0xff00, 0xff60], // 全角英数記号（半角カナ U+FF61–FF9F は含めない＝narrow のまま）
  [0xffe0, 0xffe6]
  // 注: U+FFFD は SBCS の表示不能バイト（センチネル）に使うため全角にしない（narrow のまま）。
];

/**
 * **どのフォントでも確実に 2 桁で描かれる**範囲（East Asian Width の Wide/Fullwidth のみ）。
 * `FULLWIDTH_RANGES` と違い Ambiguous・私用外字は含めない。
 *
 * DBCS の桁数（2 桁）は `isFullWidth` が決めるが、**実際に何桁ぶんの幅で描かれるかはフォント次第**。
 * Ambiguous（U+2212 '−'・U+2010 '‐'・罫線・ギリシャ等）は欧文等幅フォントが 1 桁で描くため、
 * 素のテキストとして流すと以降の桁が左へずれる。描画側はこの判定で「幅を保証する箱」に入れる。
 */
const CERTAIN_WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // ハングル字母
  [0x2e80, 0x303e], // CJK 部首・記号
  [0x3041, 0x33ff], // ひらがな・カタカナ・CJK 記号
  [0x3400, 0x4dbf], // CJK 拡張A
  [0x4e00, 0x9fff], // CJK 統合漢字
  [0xa000, 0xa4cf], // イ文字
  [0xac00, 0xd7a3], // ハングル音節
  [0xf900, 0xfaff], // CJK 互換漢字
  [0xfe10, 0xfe19], // 縦書き用約物
  [0xfe30, 0xfe6f], // CJK 互換形・小字形
  [0xff00, 0xff60], // 全角英数記号（半角カナ U+FF61–FF9F は含めない）
  [0xffe0, 0xffe6] // 全角記号（￠￡￢￣￤￥）
];

/** その 1 文字がフォントに依らず 2 桁幅で描かれるか（描画側の幅保証の要否判定に使う）。 */
export function isCertainWideGlyph(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  for (const [lo, hi] of CERTAIN_WIDE_RANGES) {
    if (cp < lo) break; // 昇順なので以降は該当しない
    if (cp <= hi) return true;
  }
  return false;
}

/** 全角判定（East Asian Width の Wide/Fullwidth/Ambiguous ＋私用外字。DBCS 相当の判別に使う）。 */
export function isFullWidth(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  for (const [lo, hi] of FULLWIDTH_RANGES) {
    if (cp < lo) break; // 昇順なので以降は該当しない
    if (cp <= hi) return true;
  }
  return false;
}
