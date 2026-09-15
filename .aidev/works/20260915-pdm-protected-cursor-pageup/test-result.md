# テスト結果: SEU でカーソルを保護欄に置いた状態で PageUp/PageDown すると、
カーソルがヘッダーの入力欄へ強制移動してしまう不具合の修正

## 実行したもの

**（D5 の再設計後に再実行。`isPageKey` を `cursorBeforeWasEnterable` へ全面置き換え）**

- `npm run lint`（`eslint .`、monorepo全体） — エラー・警告 0
- `npm run build`（`tsc -b && vue-tsc -b`、monorepo全体） — エラー 0
- `npm run test`（`--workspaces --if-present`、monorepo全体、CI と同一コマンド）
  - `@ts5250/tn5250`: 592 passed（新規回帰テスト3件を含む——うち1件は「AID キー種別では
    判定していないことの確認」テスト）
  - `@ts5250/web-ui`: 2035 passed（`screen-grid-cursor-restore.test.ts` の5件を含む）
  - `@ts5250/tn3270`: 254 passed / 38 skipped（既存の環境依存skip、本work と無関係）
  - `@ts5250/vt`: 202 passed
  - `@ts5250/gen-tables`: 10 passed
  - `@ts5250/hostserver-check`: テストファイル無し（対象外パッケージ）
  - 合計: 3093 passed / 41 skipped（既存の環境依存skipのみ、本 work によるものではない）

## 受け入れ基準ごとの判定

- AC1（保護欄で PageUp/PageDown してもカーソルがヘッダー入力欄へ強制移動しない）: pass —
  `cursor-stale-on-protected.test.ts` の新規 describe ブロック（PageUp/PageDown 両方向、
  `cursorBeforeWasEnterable=false` の合成 WTD）で、カーソル位置 `{row:5,col:20}` が
  維持されることを確認。修正前のコードでは `{row:3,col:12}`（先頭入力欄）へ強制移動
  することを discrimination 確認済み。**D5 の再設計後（`cursorBeforeWasEnterable` を
  実装した最終コード）に対して、実機（SR-OSAKA/ASAOLIB）で
  `scripts/diag-seu-protected-cursor-pageup.mjs`（境界・非境界の3ケース）と
  `scripts/diag-cursor-after-expand.mjs`（`PR#387` 元シナリオ＝CURSORCL3）の両方を
  再実行し、いずれも正しい結果（SEU側は維持、CURSORCL3側は寄せる）になることを
  直接確認済み**（`research.md` F8。review 工程で「F6・F7はこの確認を裏付けていない」
  という指摘を受け、実機再確認の記録を F8 として正しく追記した）。ユニットテストだけ
  でなく実機でも pass。
- AC2（`PR#387` 本来のシナリオ＝Enter確定後の保護化に回帰が無い）: pass —
  `cursor-stale-on-protected.test.ts` の既存 describe ブロック（4テスト、Enter で確定）が
  全て green。加えて、新規テスト（「送信前に入力可能だった欄が保護化された場合は、
  PageDown でも寄せる」）で、**AID キー種別に関係なく `cursorBeforeWasEnterable` に
  基づいて正しく判定されること**を直接確認した——`PR#387` の本来の判定条件
  （送信前は入力可能だった欄が保護化される、という遷移）は AID キーを問わず維持される。
- AC3（実機トレースで試した具体的な条件と結果の記録）: pass — `research.md` に3ケースの
  比較表（F4）、分岐ごとの直接ログによる判定結果（F2・F3）、およびフィールド構造の
  直接計測（F7、CURSORCL3と SEU の「送信前の入力可能性」の違い）が記録済み。
- AC4（修正方針が実機トレースの事実に基づいていること）: pass — `research.md` F2〜F7、
  `decisions.md` D4・D5 に、当初の誤診断（`!cursorSet` 分岐が原因）とその訂正、
  さらに deliver 後の利用者指摘を受けた再訂正（AID キー種別→`cursorBeforeWasEnterable`）
  の両方の経緯を含めて記録済み。推測に基づく判断は無い。
- AC5（SEU 走査検索の回帰が無いこと）: pass — `screen-grid-cursor-restore.test.ts`
  （`@ts5250/web-ui`）5テストが全て green。SEU 走査検索はカーソルが動くため
  `PR#387` 分岐の対象外——`cursorBeforeWasEnterable` とも無関係。

## 失敗の証跡

このラウンドでは失敗が発生していない（coding 工程のタスク点検で見つかった1件
（T1、コメントの出所引用の誤り）は指摘のその場修正であり、テストの failed には現れていない
— `review.md`「タスク点検ログ」参照）。

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
{"level":40,"time":1789455004715,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,"time":1789455004741,"host":"127.0.0.1","port":46545,"auth":false,"msg":"5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"}
smoke: /healthz ok, / が Web UI を返した (port 46545)
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
- **（D5 の再設計で解消済み）** 旧版では「`!result.cursorSet` 分岐への `isPageKey` 適用は
  対称性のための予防的措置で、実機での直接確認が無い」としていたが、D5 で `isPageKey` を
  撤去して `!cursorSet` 分岐を無条件へ戻したため、この項目自体が無くなった
  （`decisions.md` D5）。`!cursorSet` 分岐は元々の（この work 以前からの）挙動と
  同じであり、`cursor-default.test.ts` で回帰が無いことを確認済み。
- CURSORCL3（`PR#387` 元シナリオ）のフィールド属性（FFW=0x6020）の
  `FFW.MONOCASE` ビットが SEU の保護欄（FFW=0x6000）に無い、という差異を実機で観測したが
  （`research.md` F7）、カーソル判定には無関係と判断し、判別条件には含めなかった
  （調査過程の記録として `decisions.md` D5 に残す）。
