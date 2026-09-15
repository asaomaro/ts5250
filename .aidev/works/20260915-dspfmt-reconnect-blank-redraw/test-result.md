# テスト結果: `pendingAid` の解決条件を「Read 要求」に一本化する

## 実行したもの

- `npm run lint`（`eslint .`、monorepo全体） — 実装時にエラー2件（`scripts/diag-dspfmt-ws-e2e.mjs`
  の未使用変数）を検出・修正済み。最終確認でエラー・警告 0。
- `npm run build`（`tsc -b && vue-tsc -b`、monorepo全体） — エラー 0。
- `npm run test -w @ts5250/tn5250`（対象パッケージ単体） — **62ファイル 589 passed**
  （既存586件 + 本 work で追加した `pending-aid-multi-record.test.ts` 3件——review ラウンド1で
  "screen" イベント発火の不変条件を検証するケースを1件追加したため、coding 時点の2件から増えた）。
- `npm run test --workspaces --if-present`（monorepo全体、CI と同一コマンド）:
  - `@ts5250/tn5250`: 589 passed（上記と同じ）
  - `@ts5250/web-ui`: 2035件中 **1件 timeout 失敗**（`test/tab-visibility.test.ts`
    「全タブを畳んでもワークスペースに居られ、バッジは全数を出す」、5000ms timeout）。
    **本 work とは無関係**——タブの折りたたみ・ワークスペース表示に関する UI テストで、
    本 work が触った `packages/tn5250/src/session/session.ts` とは無関係。単体で
    再実行（`cd packages/web-ui && npx vitest run test/tab-visibility.test.ts`）した
    ところ **8件全て green**（`Test Files 1 passed`）——monorepo 全体を同時に走らせた
    ことによる環境要因（リソース競合、jsdom の "Not implemented: navigation" 警告が
    同時に出ていた）でのタイムアウトと判断する。既知の環境依存 flaky として扱う。
  - `@ts5250/tn3270`: 254 passed / 38 skipped（既存の環境依存skip、本work と無関係）
  - `@ts5250/vt`: 202 passed
  - `@ts5250/gen-tables`: 10 passed
  - 合計: 3089 passed / 1 flaky failed（単体再実行で green 確認済み）/ 既存の
    環境依存skipのみ

## 受け入れ基準ごとの判定

- AC1（`scripts/diag-dspfmt-ws-e2e.mjs` を複数回（8回以上）実行し、罫線のみで終わる
  ケースが0件）: pass — 修正後、8回中8回とも「正常（データ表示あり）」（下記「失敗の証跡」
  参照。修正前は同スクリプトで8回中5回、罫線のみが再現していた——`research.md` F2）。
- AC2（`scripts/diag-dspfmt-reconnect-blank.mjs`、`sendAid()` の解決値を直接チェックする
  形に改修済みを再実行し、修正前は複数回中すべてで再現していた不具合が修正後は複数回中
  すべてで解消していること）: pass — 修正前は8回中8回（後に3回でも再確認）「罫線のみ
  （不具合再現）」だったのが、修正後は8回中8回「正常（データ表示あり）」に変わった
  （discrimination 成立。`decisions.md` D1）。
- AC3（`sendAid()`/`pendingAid` の解決条件変更の設計判断が記録されている）: pass —
  `design.md`「設計方針」「振る舞いの詳細」、`decisions.md` D1・D2 に記録済み。
- AC4（複数レコード応答を合成した回帰テストの追加）: pass —
  `packages/tn5250/test/pending-aid-multi-record.test.ts`（3ケース。うち2ケースは
  coding 時点、3ケース目は review ラウンド1の指摘で追加した "screen" イベント発火の
  不変条件検証）。**3ケースとも**修正前のコードに対して実際に red になることを
  `git stash` で確認済み（下記「失敗の証跡」）。
- AC5（既存テストへの回帰が無いことを確認）: pass —
  `packages/tn5250` の既存586件は全て green のまま。`packages/web-ui` の1件timeout は
  上記の通り環境要因（本 work と無関係、単体実行で green）。

## 失敗の証跡

### 修正前のコードに対する discrimination（`git stash` で `session.ts` の変更のみ退避）

```
$ npx vitest run packages/tn5250/test/pending-aid-multi-record.test.ts
 FAIL  ... > 骨格レコード（unlockのみ・read無し）だけでは解決しない。実データレコード（read付き）で初めて解決し、その内容を反映する
AssertionError: expected {…} to be undefined
 ❯ packages/tn5250/test/pending-aid-multi-record.test.ts:120:22
    expect(resolved).toBeUndefined();

 FAIL  ... > 骨格レコードの段階では this.state もまだ ready にならない（keyboardLocked が保たれる）
AssertionError: expected false to be true
 ❯ packages/tn5250/test/pending-aid-multi-record.test.ts:144:47
    expect(session.snapshot().keyboardLocked).toBe(true);

 FAIL  ... > "screen" イベントは readSolicited の判定と無関係に、レコードごとに必ず発火する（design.md「振る舞いの詳細」の不変条件）
AssertionError: expected [ false ] to deeply equal [ true ]
 ❯ packages/tn5250/test/pending-aid-multi-record.test.ts:166:21
    expect(screens).toEqual([true]);

 Test Files  1 failed (1)
      Tests  3 failed (3)
```

（`git stash pop` で修正を復元後、同テストは3件とも green。実装ミスによる failed は
このラウンドでは発生していない——上記は discrimination のための意図的な退行確認のみ。
3件目は review ラウンド1で追加したテストだが、同じ `git stash` 手順で再確認し、
旧実装でも red になる——真の discrimination である——ことを確認した）。

### 実機診断（コア層、`scripts/diag-dspfmt-reconnect-blank.mjs`、修正後・8回）

```
$ node --env-file=.env --env-file=.env.verify scripts/diag-dspfmt-reconnect-blank.mjs 8
================ 試行 #1 (毎回フレッシュ接続) ================
受信レコード数=3
>>> ライブ snapshot()の最終状態: 正常　/　sendAid()の解決値(regression判定の本体): 正常（データ表示あり）
（以下 #2〜#8 まで同一パターンで全て「正常」。修正前は全て「罫線のみ（不具合再現）」だった）
```

### 実機診断（WS層経由、`scripts/diag-dspfmt-ws-e2e.mjs`、修正後・8回）

```
$ node --env-file=.env --env-file=.env.verify scripts/diag-dspfmt-ws-e2e.mjs 8
================ 試行 #1 (WS層経由、フレッシュ接続) ================
>>> 最終状態: 正常（データ表示あり）
（以下 #2〜#8 まで全て「正常」。修正前は8回中5回「罫線のみ（不具合再現）」だった
——research.md F2 参照）
```

## 起動確認（smoke）

```
$ node launcher/smoke.mjs; echo "exit=$?"
{"level":40,"time":1789483649254,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,"time":1789483649267,"host":"127.0.0.1","port":45555,"auth":false,"msg":"5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"}
smoke: /healthz ok, / が Web UI を返した (port 45555)
smoke: {"status":"ok","sessions":0}
exit=0
```

この work は新しい入口（サブコマンド・オプション）を追加していないため、
`smokeCommands` の追加は不要。

## 未検証の穴（skip / 環境不足）

- **本開発環境にブラウザ（実際の web-ui の Vue コンポーネント描画）が無いため、修正後に
  ブラウザ上で実際に正しく表示されることの目視確認はできていない**（`requirements.md`
  非機能要件の通り）。`scripts/diag-dspfmt-ws-e2e.mjs` は `packages/server` の WS
  プロトコル層まで（ブラウザが受け取るメッセージ列そのもの）を検証しており、
  `sessionsStore.updateScreen()` が無条件にメッセージを反映すること
  （`research.md` F8）を踏まえれば、これで十分な検証と判断する。
- `packages/tn3270`/`packages/vt` は本 work の対象外パッケージであり、テスト内容の
  詳細確認はしていない（既存の green/skip をそのまま記録したのみ）。
