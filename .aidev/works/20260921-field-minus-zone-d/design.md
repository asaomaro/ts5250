# 仕様: 数値専用の欄の Field−

## 設計方針
- `AdjustSpec` に `numericOnly` を足し、`fieldSign` が Field− のとき最終桁をセンチネル `rawSentinel(0xD0 | 下位4ビット)` にする（数字・空白の EBCDIC の下位 4 ビットを使う。
  既にセンチネルならそのバイト）。ScreenGrid は欄の種類から `numericOnly` を渡す。
- 表示はセンチネルなので空白になる（ACS はバイトの文字を出す。コードページごとの対応を web-ui が持たないので、この work では変えない）。

## 依拠する既存の事実
- research F1〜F3。`numeric` は 0x0300・0x0500・0x0700 だけ（`buffer.ts` の snapshot）。数値専用は `numeric && !digitsOnly && !signedNumeric`（`20260921-numpad-field-sign`）。

## 受け入れ基準との対応
- AC1: `packages/web-ui/test/field-sign-dup.test.ts`（純ロジックとグリッド）・`numpad-field-sign.test.ts`
- AC2: `packages/tn5250/test/numeric-only-zone-d.test.ts`（`F1 F2 40 40 40 D0`）
- AC3: mutation
