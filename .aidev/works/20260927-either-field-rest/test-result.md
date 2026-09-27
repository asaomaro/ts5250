# テスト結果: E 欄の残り

## 実行したもの
- `cd packages/web-ui && npx vitest run` — 2859 passed / 0 failed（`either-field-mode.test.ts` 21 件）
- `cd packages/tn5250 && npx vitest run` — 1090 passed、`cd packages/server && npx vitest run` — 1627 passed / 3 skipped（既存）
- `npx vue-tsc -b`・`npm run lint` — エラーなし
- 実機の ACS のコア `scripts/acs-probe/either-empty.txt`（1 回）: 空にした E 欄は `0e`・X は `e7`

## 受け入れ基準ごとの判定
- AC1: pass — 単体（`XあB` → `X B`・全角の欄の先頭に `XY` → `XY`・全角の欄で飛ばした桁は全角空白・複数行も同じ）
- AC2: pass — 単体（半角の後の全角 → 0061・全角の途中の半角 → 0060・` X` は切り替えた状態で受ける）
- AC3: pass — research F3・台帳

## 変異（verify-by-mutation）
- 6 通りすべて検出（DBCS の経路・`firstRejection`・`overwriteInto`・`insertInto` の切り替え・状態の持ち回り・詰め物の空白）

## 失敗の証跡
このラウンドでは失敗が発生していない（コアの SO の実装は点検の must で取り下げた。decisions D1）。

## 未検証の穴（skip / 環境不足）
- 貼り付けは `acs-probe` で ACS に流せないので、ACS の挙動は原典の読み（decisions D3）

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 39678)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```
