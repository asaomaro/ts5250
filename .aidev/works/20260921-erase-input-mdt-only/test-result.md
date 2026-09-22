# テスト結果: Erase Input が、中身のある全入力欄を消す

## 実行したもの
```
$ cd packages/web-ui && npx vitest run test/erase-input-mdt-only.test.ts
  Tests  4 passed (4)
```
全量・lint・build はバッチの節目でまとめて回す（利用者の方針）。

## 受け入れ基準ごとの判定
- AC1: pass — 未変更の既定値（`*LIBL`）は消えず、利用者が打った欄・ホストが MDT を立てた欄だけが消える。
- AC2: pass — 下記 mutation。

## 失敗の証跡
このラウンドでは失敗が発生していない。

## mutation（条項 `verify-by-mutation`）
```
消す条件を旧来の「中身のある欄」へ戻す → Tests  2 failed | 2 passed (4)
復元                                      → Tests  4 passed (4)
```

## 原典で確かめたこと
- `PS5250.processEraseInput` は `clearNonbypassFields(true)`（`iconst_1`＝MDT の立った欄だけ）。
- 着地は `getHomePos()`。`homePos` は `setInsertCursor`（IC オーダー）で決まり、
  無ければ `setDefaultInsertCursor`（既定）——当方の `focusCursorField` と同じ意味なのでそれに寄せた。

## 未検証の穴
- **着地位置は単体で固定していない**（`nextTick` 後のフォーカスを見るテストは書いていない）。
  以前は呼び出し側が常に先頭の入力欄へ置いていた。IC で別の欄を指す画面でのみ差が出る。
smoke: /healthz ok, / が Web UI を返した (port 44625)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
