# テスト結果

## 1. ユニット / コンポーネント

| パッケージ | 結果 |
|---|---|
| `@as400web/core` | **890 passed / 0 failed**（77 ファイル） |
| `@as400web/server` | **641 passed / 4 failed**（50 ファイル） |
| `@as400web/web-ui` | **1020 passed / 0 failed**（88 ファイル） |

**server の 4 件は `zip-writer.test.ts` の環境要因**（`spawnSync unzip EACCES`＝この devcontainer に
`unzip` が入っていない）。本作業の変更とは無関係で、main でも同じく落ちる。

本作業で足したテスト（計 39 件）:

| ファイル | 件数 | 内容 |
|---|---|---|
| `packages/core/test/pc-command.test.ts` | 10 | **実機の受信レコードそのもの**を fixture にした標識検出（PAUSE 双方・123 文字の折返し・非表示マスク・1 バイト崩したら検出しない） |
| `packages/core/test/pc-command-session.test.ts` | 6 | セッションの振る舞い（実行係へ渡す・**実行係が無くても失敗しても実行キーを返す**・PAUSE で待つ/待たない・中間画面を出さない） |
| `packages/server/test/pc-command.test.ts` | 14 | 実行モジュール（既定無効・終了コード・上限で打ち切り・許可リストは**全体一致**・壊れた正規表現は不一致へ倒す） |
| `packages/server/test/pc-command-boundary.test.ts` | 9 | 信頼境界（個人設定はスキーマで拒否・露出は編集者限定・複製して返す・解決器は server×display のみ） |
| `packages/server/test/config-routes.test.ts`（追記） | 5 | route 越しの 2〜4 層（403 / 400 / printer 種別で落ちる / 壊れた allow を保存前に弾く） |
| `packages/web-ui/test/session-info-pc-command.test.ts` | 9 | 表示（有効無効・終了コード・起動/無効/許可外/失敗の出し分け・新しい順・実行先の言い換え） |

**空振りでないことの確認**: `PCO_START` の 1 バイト（`0x83` → `0x84`）を崩すと
core の 16 件中 **10 件が落ちる**。戻すと 16 件とも通る。

## 2. 実機 E2E（実機 / IBM i 7.x・CCSID 939）

`scripts/verify-pcocmd.mjs` — **28 アサーション全通過**。
ホスト側は `TESTLIB/PCOTEST`（`STRPCO` → `STRPCCMD`。データ域でコマンドと `PAUSE` を渡す CL）。

判定は**サーバー側でファイルが作られたか**で行う。ホストは実行の有無を検証しないので
「画面が進んだ」だけでは実行できた証拠にならない（research D5）。

| ケース | 設定 | 期待 | 結果 |
|---|---|---|---|
| `PAUSE(*YES)` | 有効 | 完了を待って `ran`・ファイルあり | ✅ |
| `PAUSE(*NO)` | 有効 | 待たず `started`・ファイルあり | ✅ |
| 無効（既定） | 未設定 | `disabled`・ファイル**なし**・**CL は先へ進む** | ✅ |
| 許可リスト外 | `allow: ["echo .*"]` | `denied`・ファイルなし・CL は先へ進む | ✅ |

各ケース共通で確認したこと:

- ホスト応答がタイムアウトしない
- CL が `STRPCCMD` の先へ進む（`PCOTEST DONE` の完了メッセージが届く）
- PC コマンドを**ちょうど 1 件**検出する（多重検出・取りこぼしなし）
- コマンド本文と `PAUSE` 指定が送信値と一致する

**1 ケース 1 セッション**にしている理由: 同じジョブで `STRPCO` を 2 回実行すると
`IWS4010 アプリケーション・エラー`になる（research D2 で実測）。

## 3. 型チェック / lint

- `npm run build`（`tsc -b`）通過。`vue-tsc -b`（web-ui のテンプレート型）通過。
- `npx eslint` は本作業の追加・変更ファイルで 0 件。
  リポジトリ全体の `npm run lint` は 6 件出るが、いずれも**本作業以前からある未追跡スクリプト**
  （`shot-*.mjs` 等。`git ls-files` に無い）で、コミット対象に含めていない。

## 4. 未検証として残るもの

- **PCO 終了標識**（`27 00 FC …`）。実機に `ENDPCO` コマンドが無く誘発できない（research D6）。
  実装は「一致したら実行せず実行キーだけ返す」に留め、コマンドとして解釈しない。
- **Windows での実行**。`spawn(..., { shell: true })` が `cmd.exe /c` に落ちる経路は
  この環境（Linux）で確認できない。
- **DBCS を含むコマンド**（SO/SI 入り）。実機で送っていない。
- V7R2 以降の 1023 文字上限（この機は 200 文字を受け付けず応答待ちになった）。
