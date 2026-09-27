# 仕様: 節目 9・10 の懸念と関連付けプリンターの残りの整理

## 依拠する既存の事実
- `fieldSign` は表に無い字を 0x40 扱いにする（`packages/web-ui/src/composables/fieldEdit.ts`）

## 受け入れ基準との対応
- AC1: `NUMERIC_ONLY_EBCDIC` に英大文字を足す（CCSID によらず同じバイトなので codec を引き込まない——web-ui のバンドルを増やさない）
- AC2: 台帳の 3 項目を閉じ、「節目の懸念の残り（測る手段がある分）」を足す
