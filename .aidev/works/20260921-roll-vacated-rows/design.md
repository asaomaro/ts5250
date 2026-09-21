# 仕様: ROLL

## 設計方針
- `roll` は ACS の条件で不正なら何もしない（false）。正しければ送る行だけを写し、空いた行はそのまま。

## 依拠する既存の事実
- `wtd-applier.ts` の ESC 0x23 は方向（0x80）・上端・下端を読んで `roll` を呼ぶ（戻り値は使わない）。

## 受け入れ基準との対応
- AC1: `screen-roll.test.ts`、実機 `scripts/verify-roll.mjs`
- AC2: `screen-roll.test.ts`
- AC3: mutation
