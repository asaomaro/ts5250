# 仕様: HLLAPI の Tab・Backtab

## 設計方針
- tn5250 の `screen/search.ts` に `tabPosition` / `backtabPosition`（1 起点の位置を返す純関数）を置き、ACS の手順（F2）をそのまま書き起こす。
- HLLAPI の `@T` は `tabPosition`（無ければホーム位置）、`@B` は `backtabPosition`（無ければ動かない）を使う。

## 依拠する既存の事実
- research F1〜F4。欄の番号（カーソル送りの送り先）はスナップショットの `index`（ペインの `backtab` と同じ突き合わせ）。

## 受け入れ基準との対応
- AC1・AC2: `packages/tn5250/test/tab-backtab-position.test.ts`（11 件）・`packages/server/test/hllapi.test.ts`（@B・@T）
- AC3: mutation
