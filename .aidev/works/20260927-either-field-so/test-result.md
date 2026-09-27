# テスト結果: 空にした E 欄の全角・半角の状態

## 実行したもの
- `cd packages/tn5250 && npx vitest run` — 1100 passed / 0 failed
- `cd packages/server && npx vitest run` — 1629 passed / 3 skipped（既存。別 PJ の負荷で 1 件時間切れ、再実行で pass）
- `cd packages/web-ui && npx vitest run` — 2864 passed / 0 failed
- `npx tsc -b`・`npx vue-tsc -b`・`npm run lint` — エラーなし
- 実機（社内機・930）`scripts/verify-either-empty.mjs` — pass=3（E 欄 `0e`・E 欄 空・J 欄 `0e`＋NUL＋`0f`）
- 実機の ACS のコア — `either-empty.txt`・`either-switch-empty.txt`（2 回目の観測を兼ねる）・`either-erase-input.txt`

## 受け入れ基準ごとの判定
- AC1: pass — 実機・ACS・単体（core・server・web-ui の 3 層）
- AC2: pass — 単体（`opts` 無しの経路・ws は 2 引数で呼ぶ）

## 変異（verify-by-mutation）
- 15 通りすべて検出（画面の emit・ペインの保持・sendKey・ws の受け渡し・resolveField・セッション・core の上書き・SO の書き込み・欄ごとの状態・Erase Input・空白の NUL 化・J の構造・J の SI・継続欄の頭）。最初に生き残った 4 通り（server 2・セッション 1・継続欄 1）はテストを足して検出

## 失敗の証跡
このラウンドでは実装の失敗は発生していない。

## 未検証の穴（skip / 環境不足）
- 打鍵で空にした J 欄の ACS の送り方（Erase Input の後だけ測った。decisions D3）・E・J の継続欄（未確認）

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 39084)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```
