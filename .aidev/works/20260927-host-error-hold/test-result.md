# テスト結果: ホストのエラーの間の WTD の保留

## 実行したもの
- `npx vitest run packages/tn5250` — 1005 passed / 0 failed
- `npx vitest run packages/server` — 1 回目 4 failed（4 件とも 5000ms の時間切れ）→ 4 ファイルを流し直して 32 passed / 0 failed
- `cd packages/web-ui && npx vitest run` — 2809 passed / 1 failed（delete-word の時間切れ）→ 流し直して 33 passed / 0 failed
- `cd packages/web-ui && npx vue-tsc -b` — exit 0
- 変異: 溜めない・番号を見ない・AID で抜けない（core）、エラーの振り分けを先打ちの後に戻す（web-ui）——どれも落ちる
- 実機（2026-09-27・社内機）: `scripts/verify-error-msgline-wtd.mjs` pass=4（エラーの間は画面が変わらず、抜けた後の 24 行目が ACS の Reset の後と同じ）。点検の直しの後にもう一度 pass=4。片付け済み

## 受け入れ基準ごとの判定
- AC1: pass — `host-error-hold.test.ts` 10 件
- AC2: pass — `host-error-mode.test.ts`（矢印・Reset・施錠中・送り直し）・`ws-handler.test.ts`（4 件）
- AC3: pass — 実機 pass=4

## 失敗の証跡
```
$ npx vitest run packages/server   （1 回目）
      4 Error: Test timed out in 5000ms.
$ npx vitest run <落ちた 4 ファイル>
 Test Files  4 passed (4)
      Tests  32 passed (32)
$ cd packages/web-ui && npx vitest run   （1 回目）
 FAIL  test/delete-word.test.ts … Error: Test timed out in 5000ms.
      Tests  1 failed | 2809 passed (2810)
$ npx vitest run test/delete-word.test.ts
      Tests  33 passed (33)
```

## 起動確認（smoke）
```
smoke: /healthz ok, / が Web UI を返した (port 46199)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 再テスト（review ラウンド 1 の後）
- `npx vitest run packages/tn5250` — 1006 passed / 0 failed
- `npx vitest run packages/server` — 3 failed（時間切れ）→ 流し直して 27 passed
- web-ui: `host-error-mode.test.ts` 23 passed・`vue-tsc -b` exit 0

## 未検証の穴
- HLLAPI の文字をエラー中に拒否する分岐の単体テストは無い（読解で確かめた）（skip / 環境不足）
- ブラウザでの操作（Reset で止めた画面が流れる）は単体テストと core の実機で代えた
- SysReq の行の間の保留・同じレコードの WTD より前の CC2 の遅れ（backlog）
- ACS で AID がいつ応答扱いになるか（D4）
