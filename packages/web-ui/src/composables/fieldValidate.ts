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
export function columnView(logical: string): string {
  let out = "";
  let inDbcs = false;
  for (const ch of logical) {
    const wide = isFullWidth(ch);
    if (wide && !inDbcs) {
      out += " "; // SO（ラン開始）
      inDbcs = true;
    } else if (!wide && inDbcs) {
      out += " "; // SI（ラン終了）
      inDbcs = false;
    }
    out += ch;
  }
  if (inDbcs) out += " "; // 末尾 SI
  return out;
}

/** 全角判定（East Asian Width の Wide/Fullwidth 近似。DBCS 相当の判別に使う） */
function isFullWidth(ch: string): boolean {
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
