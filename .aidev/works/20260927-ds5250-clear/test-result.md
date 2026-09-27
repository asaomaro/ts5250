# テスト結果: DS5250 のその他の差（CFT・SOH の ENPTUI の構造体）

## 実行したもの
- `cd packages/tn5250 && npx vitest run` — 1092 passed / 0 failed（`wdsf-gui.test.ts` 20 件）
- `cd packages/server && npx vitest run` — 1627 passed / 3 skipped（既存）、`cd packages/web-ui && npx vitest run` — 2859 passed
- `npx tsc -b`・`npm run lint` — エラーなし

## 受け入れ基準ごとの判定
- AC1: pass — 単体（SOH の後に同じ選択欄を定義し直しても 1 つ・窓は残る／CFT は窓も選択欄も捨てる）。原典の読み（ACS の構造体は `acs-probe` の文字の面の dump に出ないので実機では測れない）
- AC2: pass — 台帳

## 変異（verify-by-mutation）
- 3 通りすべて検出（CFT で閉じない・SOH で選択欄を捨てない・SOH を CFT と同じにする）

## 失敗の証跡
このラウンドでは失敗が発生していない。

## 未検証の穴（skip / 環境不足）
- ACS の構造体の状態は実機で測れない（原典の読み）

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 39450)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```
