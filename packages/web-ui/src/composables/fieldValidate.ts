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
