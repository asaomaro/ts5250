# 仕様: SSLD

## 設計方針
`skip2b` に `onSsld` を渡し、D2 の `04 15 hh ll`（幅が 1 以上）で呼ぶ。呼び出し側は `col !== 1` なら `col = 1; row += 1`。D2 の他の制御は従来どおり長さぶん読み飛ばす。

## 依拠する既存の事実
- research F1〜F3

## 受け入れ基準との対応
- AC1: `packages/scs/test/scs.test.ts`
