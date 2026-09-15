# テスト結果: SEU でカーソルを保護欄に置いた状態で PageUp/PageDown すると、
カーソルがヘッダーの入力欄へ強制移動してしまう不具合の修正

## 実行したもの

- `npm run lint`（`eslint .`、monorepo全体） — エラー・警告 0
- `npm run build`（`tsc -b && vue-tsc -b`、monorepo全体） — エラー 0
- `npm run test`（`--workspaces --if-present`、monorepo全体、CI と同一コマンド）
  - `@ts5250/tn5250`: 591 passed（新規回帰テスト2件を含む）
  - `@ts5250/web-ui`: 2035 passed（`screen-grid-cursor-restore.test.ts` の5件を含む）
  - `@ts5250/tn3270`: 254 passed / 38 skipped（既存の環境依存skip、本work と無関係）
  - `@ts5250/vt`: 202 passed
  - `@ts5250/gen-tables`: 10 passed
  - `@ts5250/hostserver-check`: テストファイル無し（対象外パッケージ）
  - 合計: 3092 passed / 41 skipped（既存の環境依存skipのみ、本 work によるものではない）

## 受け入れ基準ごとの判定

- AC1（保護欄で PageUp/PageDown してもカーソルがヘッダー入力欄へ強制移動しない）: pass —
  `cursor-stale-on-protected.test.ts` の新規 describe ブロック（PageUp/PageDown 両方向）で、
  実機トレースで観測した通りの合成 WTD（ホストが同じ保護欄位置へ IC を明示的に指し直す）を
  送り、カーソル位置 `{row:5,col:20}` が維持されることを確認。修正前のコードでは
  `{row:3,col:12}`（先頭入力欄）へ強制移動することを `git stash` で discrimination 確認済み
  （coding 工程・T3 タスク点検で実施）。**さらに review 工程で、修正後のビルドに対し
  `scripts/diag-seu-protected-cursor-pageup.mjs` を実機（SR-OSAKA/ASAOLIB）で再実行し、
  利用者の再現手順そのもの（10桁10行目の保護欄から PageUp/PageDown）で症状が解消した
  ことを直接確認済み**（`research.md` F6）。ユニットテストだけでなく実機でも pass。
- AC2（`PR#387` 本来のシナリオ＝Enter確定後の保護化に回帰が無い）: pass —
  `cursor-stale-on-protected.test.ts` の既存 describe ブロック（4テスト、Enter で確定）が
  全て green。`isPageKey` は Enter では false のままなので、既存の「先頭入力欄へ寄せる」動作は
  変わらない。
- AC3（実機トレースで試した具体的な条件と結果の記録）: pass — `research.md` に3ケースの
  比較表（F4）と、分岐ごとの直接ログによる判定結果（F2・F3）が記録済み（coding 前に完了、
  T5 で再確認済み）。
- AC4（修正方針が実機トレースの事実に基づいていること）: pass — `research.md` F2〜F5、
  `decisions.md` D4 に、当初の誤診断とその訂正過程を含めて記録済み。推測に基づく判断は無い。
- AC5（SEU 走査検索の回帰が無いこと）: pass — `screen-grid-cursor-restore.test.ts`
  （`@ts5250/web-ui`）5テストが全て green。SEU 走査検索は Enter で実行されるため
  `isPageKey` と無関係。

## 失敗の証跡

このラウンドでは失敗が発生していない（coding 工程のタスク点検で見つかった1件
（T1、コメントの出所引用の誤り）は指摘のその場修正であり、テストの failed には現れていない
— `review.md`「タスク点検ログ」参照）。

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
{"level":40,"time":1789447727610,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,"time":1789447727628,"host":"127.0.0.1","port":46351,"auth":false,"msg":"5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"}
smoke: /healthz ok, / が Web UI を返した (port 46351)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

この work は新しい入口（サブコマンド・オプション）を追加していないため、`smokeCommands` の
追加は不要（既存の `smokeCommand` で十分にカバーされる）。

## 未検証の穴（skip / 環境不足）

- **（review 工程で解消済み）** 当初この節には「修正版コードでの実機再確認は未実施」と
  記載していたが、review 工程の指摘（`review.md`「レビュー指摘」）を受けて実機
  （SR-OSAKA/ASAOLIB）で `scripts/diag-seu-protected-cursor-pageup.mjs` を修正後のビルドに
  対して再実行し、利用者の再現手順そのもので症状が解消したことを確認した
  （`research.md` F6）。したがってこの項目はもう「未検証の穴」ではない。
- `!result.cursorSet` 分岐（`branch1`）への `isPageKey` 適用は、対称性のための予防的措置であり、
  この work の実機トレースでは発火するケースを一度も観測できていない（`research.md` F4）。
  そのため、この分岐に対する直接の実機回帰確認は無い。
