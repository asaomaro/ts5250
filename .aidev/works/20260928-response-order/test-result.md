# テスト結果: 応答をコマンドの順に送る

## 実行したもの
- `cd packages/tn5250 && npx vitest run` — 1163 passed
- `cd packages/server && npx vitest run` — 1660 passed / 3 skipped
- `cd packages/web-ui && npx vitest run` — 2960 passed
- `npm run lint`・`npm run build`
- 実機の ACS のコア: `scripts/acs-probe/response-order.txt`（relay のワイヤ。research F1）
- 実機（当 PJ のコア）: `scripts/verify-response-order.mjs` — `RESULT: pass=2 fail=0`（2 回）。直す前のコードでは `pass=0 fail=2`
- mutation 4 通り中 4 検出

## 受け入れ基準ごとの判定
- AC1: pass — `response-order.test.ts`「オペコード 03 の [WSF Query][SAVE SCREEN]」・実機の RESPORDER
- AC2: pass — 「オペコード 04 の [SAVE SCREEN][WSF Query]」・実機の RESPORDER2
- AC3: pass — `verify-response-order.mjs`（当 PJ のコアを実機へ。ブラウザを通さないが、応答はコアが送る）
- AC4: pass — 既存の全件（`save-screen-session.test.ts` のオペコードを 03 に——decisions D2）

## 失敗の証跡

```
$ npx vitest run  (packages/tn5250, 送信を順の一覧へ変えた直後)
 FAIL  test/save-screen-session.test.ts > 1 レコードに SAVE が 2 回 > 応答を 2 本返し、**どちらの段を復元しても警告が出ない**（＝両段に積荷が添えられている）
AssertionError: 退避 1 回につき応答 1 本: expected [ Uint8Array[ 0, 16, 18, 160, …(19) ] ] to have a length of 2 but got 1
```
（テストがオペコード 04 で 2 つの退避を送っていた。ACS の規則ではこのレコードは退避だけ——decisions D2）

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 38740)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 応答の中身の時点（decisions D1）・READ SCREEN を 2 回並べる形
