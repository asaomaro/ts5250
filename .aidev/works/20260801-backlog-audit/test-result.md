# テスト結果（2026-08-01）

docs のみの変更なので、検証の中心は「**何を変えて、何を変えていないか**」の確認になる。
自動テストは回帰の確認として実行する。

## 1. 自動テスト

### `npm test`（全 workspace）

| workspace | Test Files | Tests |
|---|---|---|
| core | 89 passed | 1,092 passed |
| ebcdic | 8 passed | 83 passed |
| scs | 1 passed | 13 passed |
| **server** | 1 **failed** / 58 passed | **4 failed** / 793 passed |
| web-ui | 107 passed | 1,230 passed |
| tools/gen-tables | 1 passed | 10 passed |
| tools/hostserver-check | （テストファイル無し） | — |
| **合計** | | **3,221 passed / 4 failed** |

**失敗 4 件はすべて既知の環境要因**——`packages/server/test/zip-writer.test.ts` の
「外部の unzip が受け付けること」4 ケース（整合性検査 / バイト単位一致 / 空ファイル / 大きめのデータ）。

```
$ which unzip
（何も出ない＝未インストール）
```

この 4 件は本作業の変更範囲（`.md` 4 ファイル）とは無関係で、
`20260726-ccsid-table-bundling` の review でも同じ 4 件が環境要因として記録されている。

### `npm run lint`

**`npm run lint`（= `eslint .`）は 6 エラーで落ちるが、本作業とは無関係。**

| ファイル | 追跡状態 |
|---|---|
| `scripts/build-empsfl.mjs` | `??`（未追跡） |
| `scripts/shot-buttons.mjs` | `??` |
| `scripts/shot-crt.mjs` | `??` |
| `scripts/shot-empsfl.mjs` | `??` |
| `scripts/shot-fkey.mjs` | `??` |
| `scripts/shot-font.mjs` | `??` |

**6 件とも未追跡のローカル調査スクリプト**（`no-unused-vars`）で、本作業より前から作業ツリーにある。
PR には含まれない。

追跡下のソースだけを対象にすると**クリーン**:

```
$ npx eslint packages tools
（出力なし＝エラーゼロ）
```

なお `eslint.config.js` は `.md` を対象にしていないため、本作業の変更が lint 結果を動かすことは構造上ない。

## 2. 受け入れ基準の検証

| # | requirement の完了条件 | 結果 | 根拠 |
|---|---|---|---|
| 1 | 未チェック 41 件すべてに判定と根拠 | ✅ | `research.md` F1（完了 6）/ F2（部分完了 2）/ F3（未着手 33）＝ 41 件。F4 に `AGENTS.md` 残課題 5 件 |
| 2 | 完了と判定した項目が `- [x]` ＋ PR 番号または works slug | ✅ | `[x]` にした 8 項目すべてに併記。**検証中に 2 件の欠落を補った**（下記 3.） |
| 3 | 未着手と判定した項目の diff がゼロ | ✅（例外 1 件・宣言済み） | 変更 hunk は 15 箇所すべて意図した位置。例外は `decisions.md` D-C の誤帰属移動のみ |
| 4 | コードの diff がゼロ | ✅ | `git diff --name-only` に `packages/`・`tools/` なし。変更は `.md` 4 ファイル |
| 5 | `library-extraction.md:61` が実測値付きで閉じている | ✅ | 「**1,407,469 → 358,354 バイト**（2026-08-01 に再測）」を記載 |
| 6 | `hostserver.md:38-39` が `host_upload_table` / `TransferPane.vue` を根拠に閉じている | ✅ | 両方を明記（PR #93 / #94 / #104） |
| 7 | `aidev status` の todo 減少数が閉じた件数と一致 | ✅ | **41 → 35**（−6）。完全に閉じたのは 6 件で一致。割った 2 件は ±0 |
| 8 | `AGENTS.md` に deliver 時の backlog 更新規約 | ✅ | `## 記録の同期（deliver 時）` を `## 残課題` の直前に追加 |
| 9 | `npm test` / `npm run lint` が従来どおり通る | ✅ | 上記 1. のとおり。失敗はすべて既存の環境要因 |

### 件数の内訳（受け入れ基準 7 の検算）

```
$ grep -c '^- [ ]' .aidev/backlog/*.md
datastream-commands.md   6 → 5
field-input.md           0 → 0
hostserver.md           23 → 19
input-assist.md          0 → 0
library-extraction.md    3 → 2
pc-command.md            8 → 8
session-lifetime.md      0 → 0
window-detect.md         1 → 1
                        41 → 35
```

`aidev status` の BACKLOG 表も「未着手 **35** 件」で grep と一致した。

**割った 2 件が集計から消えていないことを直接確認した**（spec D3 の前提）:

```
$ grep -n '^- \[ \]' .aidev/backlog/hostserver.md | grep -E 'パスワードレベル|7\.5'
66:- [ ] パスワードレベル 0/1 の**実機**での認証成功の確認
195:- [ ] IBM i 7.5 **以外のバージョン**での検証
```

親子（インデント）にしていたらここに出ず、残作業が backlog の件数から消えていた。

### 参照先の実在確認（plan のテスト方針「リンク切れ」）

注記に書いたパスと行を実際に開いて確認した。

| 参照 | 結果 |
|---|---|
| `README.md:162-164` | ✅ `--ifs-read-max-bytes` / `--ifs-zip-max-*` / `--ifs-delete-max-*` の表 |
| `packages/ebcdic/src/katakana.ts` | ✅ 実在 |
| `packages/ebcdic/test/katakana-no-dbcs.test.ts` | ✅ 実在 |
| `packages/web-ui/src/components/TransferPane.vue` | ✅ 実在 |
| `packages/core/src/hostserver/des.ts` | ✅ 実在（167 行） |
| `packages/core/src/protocol/wtd-applier.ts:143-152` | ✅ `case COMMAND.RESTORE_PARTIAL_SCREEN:` から始まる |
| `packages/core/src/hostserver/signon.ts:222` | ✅ `info.passwordLevel < MIN_SHA_PASSWORD_LEVEL` |
| `packages/core/src/hostserver/server-connect.ts:156` | ✅ `? passwordSubstituteDes(` |
| `packages/server/src/host-server-tools.ts` | ✅ 実在 |
| `20260720-sql-lob-locator/research.md`（F5） | ✅ 実在 |
| `20260719-hostserver-mcp-tools/test-result.md:49` | ✅ `MCH0802` の行 |

## 3. 検証中に見つけて直したもの（2 件）

受け入れ基準 2 の確認で、**根拠の書式が spec D2（works slug ＋ PR 番号 ＋ 裏取り）に届いていない
項目が 2 件**あった。coding へ差し戻すほどではないので、この工程内で補った。

| 項目 | 補う前 | 補った後 |
|---|---|---|
| `hostserver.md` CLI 引数を README に追記 | `README.md:162-164` だけ（PR も works slug も無し） | **PR #199** を追記（`git log -L162,164:README.md` で特定） |
| `datastream-commands.md` SAVE PARTIAL SCREEN | works slug のみ | **PR #223** を追記 |

補った後に件数を再確認し、**35 のまま**であることを確認した。

## 4. 未検証の穴（deliver へ引き継ぐ）

- **`zip-writer.test.ts` の 4 件**は `unzip` 不在のため未実行。zip の外部互換性はこの環境では確かめられない
  （本作業と無関係だが、green ではないので明示する）
- **`AGENTS.md` の DBCS 行末またぎ**（残課題）は**判定を保留**した。
  実機で行末またぎを確かめた記録が無いため（`decisions.md` D-D）
- **aidev harness 側は直していない**。原因は deliver 工程に backlog を閉じる経路が無いことだが、
  harness はリポジトリ外にあるので `AGENTS.md` に PJ 規約として置いた。
  **この PJ 以外では同じことが起きる**（`decisions.md` D-G）

## 判定

**passed 9 / failed 0**（受け入れ基準ベース）。coding への差し戻しは不要。
