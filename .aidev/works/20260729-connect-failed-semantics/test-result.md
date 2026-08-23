# テスト結果: `CONNECT_FAILED` の意味を取り戻す

## 自動テスト

| 対象 | 結果 |
|---|---|
| core / server / ebcdic / scs | **1758 passed** / 146 ファイル（4 failed は既知の環境不足＝`unzip` 無し） |
| web-ui（パッケージ dir から実行） | **1178 passed** / 102 ファイル。unhandled error 0 |
| `tsc -b` / `vue-tsc -b` ＋ `vite build` | 通る |
| lint（変更した追跡ファイル） | error 0 |

### 新規テスト: `packages/server/test/error-code-semantics.test.ts`（14 件）

**「どのコードか」ではなく「その意味にそのコードが付くか」**を見る形にした。

| 節 | 見ているもの |
|---|---|
| セッション上限は `SESSION_LIMIT` | 表示・**プリンターの両方** / HTTP 409 / `CONNECT_FAILED` とは別のコード |
| 設定・指定の不備は `CONFIG_ERROR` | 設定ファイルが読めない / スキーマ違反 / 平文パスワード / users が読めない / users のスキーマ違反 / 接続先の指定不足 / `passwordEnv` 未設定 / **HTTP 400 のまま（後方互換）** |
| 不変条件 | `packages/server/src` を**丸ごと走査**して `CONNECT_FAILED` を throw する箇所が 0 件。判定側（`statusOf` の写像）は残っている |

不変条件はファイルの列挙にせず `src` の再帰走査にした（列挙だと**新しいファイルが素通りする**）。
走査そのものが空振りしていないことも確かめている（`files.length > 20`）。

### 追記したテスト

- `ws-lifetime.test.ts`（+3）: `fatal` が**状態**で決まる——`open` の失敗（指定不足）で true /
  `open` 前の `key` も true（セッションが無いのは事実）/ セッションが生きているうちのエラーは false
- `session-manager.test.ts`: 「上限を超えると `CONNECT_FAILED`」→「**`SESSION_LIMIT`**」に書き換え
- `host-ifs.test.ts` の写像表は据え置き（`CONNECT_FAILED` → 400 は正しい用途として残る）

## 空振り検証（mutation）: 14/14

実装を 1 か所ずつ壊し、対応するテストが落ちるかを確認（`0 件`＝全て検出）。

`statusOf` の `SESSION_LIMIT` 欠落（→ 502 に落ちる）/ `CONFIG_ERROR` の 400 写像欠落 /
上限を `CONNECT_FAILED` に戻す（表示・プリンター **それぞれ**）/ 設定系 7 箇所を 1 つずつ戻す /
`fatal` をコードの列挙に戻す / `fatal` を常に true にする。

**「上限を CONNECT_FAILED に戻す」がプリンター側でも落ちる**ことを確認している——
表示だけ直して満足する形になっていない。

## 実機スモークテスト（11/11）

この変更は `config-resolver` / `auth` / `config-store`（**接続のたびに通る経路**）に触るので、
`scripts/verify-browser-idle.mjs` を回して実機で接続・自動サインオン・解決が壊れていないことを確かめた。

- 1 回目は **10/11**。落ちたのは「DEV1（既定）でメインメニューに到達」で、
  画面は `CPF1296 サインオン情報が必要である`。**製品の回帰ではなくスクリプトの作りの問題**だった——
  サインオンの入力を待機ループの**外で 1 回だけ**試していたため、前回の実行が装置を掴んでいて
  最初の画面が「対話式ジョブの回復」だった場合に取りこぼし、以後は空のサインオンを
  Enter で送り続けていた（同じ形が `verify-browser-sign.mjs` にもある）
- **入力をループの中へ移して修正**し、到達できなかった場合は画面をログに出すようにした。
  再実行で **11/11**

## 未検証の穴（deliver へ引き継ぐ）

- **HTTP 409 になった経路を実 HTTP で叩いてはいない**（`statusOf` の単体で確認）。
  セッション上限を実際に踏ませるには `--max-sessions` を絞って同時接続する必要があり、
  写像そのものは純関数で押さえてある
- `packages/server/test/zip-writer.test.ts` の 4 件は**この環境に `unzip` が無い**ため失敗する
  （`main` でも同じ。今回の変更とは無関係）
