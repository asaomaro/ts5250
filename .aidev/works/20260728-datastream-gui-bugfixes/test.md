# テスト結果

実施: 2026-07-28 / 対象: `Bugfix.pdf` の修正 A〜J

## 受け入れ基準の検証

| # | 受け入れ基準（requirement.md） | 結果 | 根拠 |
|---|---|---|---|
| 1 | 修正 A〜J の 10 件がすべて適用されている | ✅ | `tasks.md` 1〜9（G と H は 1 か所に統合。`spec.md` §3-2） |
| 2 | `wdsf-applier-grid-lines.test.ts` が新規追加され 2 件通る | ✅ | 下記 T3 |
| 3 | 未知オーダー後続の WRITE/READ が失われない | ✅ | 下記 T4 |
| 4 | `0x1C` が `"*"` を 1 桁書き、`rawByte` が付かない | ✅ | 下記 T5 |
| 5 | WRITE_ERROR_CODE の実機トレースから「機能キーは使用できません。」 | ✅ | 下記 T6 |
| 6 | 黄・青緑で `a-colsep` が付かず、他の色では従来どおり付く | ✅ | 下記 T7＋既存 3 件 |
| 7 | 修正 J の再現テストが通り、修正前に戻すと fail する | ✅ | 下記 T8・「再現性の確認」 |
| 8 | vitest（core / web-ui）・eslint・vue-tsc がすべて成功 | ⚠️ | 「一括検証」参照（eslint のみ注記あり） |
| 9 | 原典との対応表が `source-notes.md` に残る | ✅ | `source-notes.md`（全 18 ページの書き起こし） |

## 個別テストの結果

```
✓ wdsf-applier-grid-lines.test.ts > CLEAR UNIT ALTERNATE と罫線の共存
    > 罫線を描いた直後の CLEAR UNIT ALTERNATE で罫線が消えない            [T3]
    > REM_ALL_GUI_CONSTRUCTS では引き続き罫線が消える（専用コマンドは効く）  [T3]
✓ wdsf-gui.test.ts > WDSF GUI — 除去コマンド
    > CLEAR UNIT で GUI がクリアされる                                    [T1 / 修正D の回帰]
✓ wdsf-grid-border.test.ts > ScreenBuffer のグリッド線状態
    > 繰り返し無し（value1/value2 既定 0xFF）は 0 に倒す                    [T2]
✓ wtd-applier.test.ts > applyDataStream — 合成データ
    > 未知オーダーは警告するが次の ESC から復帰する（レコード全体は打ち切らない） [T4]
    > 0x1C は "*" 1 文字を表示し、後続の表示データを取りこぼさない            [T5]
    > WRITE_ERROR_CODE の DBCS メッセージが文字化けしない（実機トレース）      [T6]
    > WRITE_ERROR_CODE が systemMessage に載る                            [既存・退行なし]
✓ screen-grid-colsep.test.ts > DSPATR(CS) 桁区切りの描画
    > 黄地のセルには columnSeparator が立っていても a-colsep を出さない       [T7]
    > 青緑地のセルには columnSeparator が立っていても a-colsep を出さない     [T7]
    > columnSeparator のセルに a-colsep が付く                            [既存・退行なし]
    > 他の属性と併用できる（下線・反転と同じランに載る）                      [既存・退行なし]
✓ config-card-ownership.test.ts > 新規セッションの保存先は親システムに従う
    > 親がサーバー設定（srv:）ならサーバー設定へ保存する                      [T8]
    > 親が自分の設定（own:）なら自分の設定へ保存する                          [T8]
```

**修正E の退行確認**: 既存の「columnSeparator のセルに a-colsep が付く」「他の属性と併用できる」
（どちらも既定色 green / red）が通り続けている＝**黄・青緑以外の桁区切りは今までどおり出る**。
原典の再現手順 c）の後半（「退行していないことの確認」）に対応する。

## 一括検証

| コマンド | 結果 |
|---|---|
| `npm run build`（`tsc -b`） | ✅ エラーなし |
| `cd packages/core && npx vitest run` | ✅ **74 ファイル / 851 件 pass** |
| `cd packages/web-ui && npx vitest run` | ✅ **83 ファイル / 974 件 pass** |
| `cd packages/web-ui && npx vue-tsc -b tsconfig.json tsconfig.test.json` | ✅ エラーなし |
| `npx eslint .`（リポジトリルート） | ⚠️ 下記 |

### eslint の注記

**本作業で変更したファイルは 0 エラー**（個別に `npx eslint <変更ファイル…>` で確認）。

リポジトリ全体では 6 エラーが出るが、**すべて本作業と無関係の未追跡ファイル**である。

```
scripts/build-empsfl.mjs   'constant' is assigned a value but never used
scripts/shot-buttons.mjs   'has' is assigned a value but never used
scripts/shot-crt.mjs             'has' is assigned a value but never used
scripts/shot-empsfl.mjs    'has' is assigned a value but never used
scripts/shot-fkey.mjs      'probe' is defined but never used
scripts/shot-font.mjs      'has' is assigned a value but never used
```

これらは**このセッション開始時点の `git status` に既に `??`（未追跡）で存在**していた別作業の
プローブスクリプトで、本作業では作成も変更もしていない。deliver ではコミット対象に含めない。

なお `packages/web-ui/**` は eslint の対象外（`eslint.config.js:9` の `ignores`）。
web-ui 側の静的検査は `vue-tsc` が担う（上記で pass）。

### 実行時の注意（AGENTS.md の再確認）

- **web-ui の vitest はパッケージ dir から実行する**。ルートから実行すると Vite の vue plugin が
  適用されず `.vue` の解析に失敗する。
- **`vue-tsc` もパッケージ dir から実行する**。ルートからだと `tsconfig.test.json` が見つからず
  `error TS5083` になる（今回実際に踏んだ）。

## 再現性の確認（T8 が再現テストとして機能するか）

`ConfigCard.vue` の `isServer` を**修正前の実装に戻して** `config-card-ownership.test.ts` を実行:

```
FAIL  新規セッションの保存先は親システムに従う > 親がサーバー設定（srv:）ならサーバー設定へ保存する
AssertionError: expected 'personal' to be 'server'
  Tests  1 failed | 11 passed (12)
```

→ **修正前に fail し、修正後に pass する**ことを確認。原典の記録（「修正前に戻すと再現テスト 1 件が
fail することを確認済み」）と一致する。確認後、修正を復元して全件 pass を再確認済み。

## 未実施 — 実機確認

原典の「再現・検証手順」4 a〜g（実機接続での確認）は、**この環境から IBM i 実機へ接続できないため
実施していない**。以下は未検証のまま残る。

| | 内容 | 対応する自動テスト |
|---|---|---|
| a | YB0200R / YB0270R の KSN20 罫線が最初から最後まで出て、文字位置と重なる | T3 が「消えない」ことは担保。**描画位置（修正C）は担保しない** |
| b | PB1000R で窓を閉じたとき枠が残らない | T1（`wdsf-gui.test.ts`）が GUI クリアを担保 |
| c | COLOR(YLW)/COLOR(TRQ) の頭に縦棒が出ない／他の色では出る | T7＋既存テストで担保 |
| d | 「応答待ちのまま固まる」画面で応答がすぐ返る | T4 が `unlockKeyboard`/`readRequested` を担保 |
| e | DSPSPLF の明細が最後まで出て ACS と一致（`"仕*"`） | T5 が `"A*B"` で担保。**実画面との一致は未確認** |
| f | e) をカナ表示モードと英表示モードの両方で確認 | T5 が `rawByte === undefined` を担保。**実描画は未確認** |
| g | 日本語エラーメッセージが文字化けしない | T6 が実機トレースの生バイト列で担保 |

**特に a の後半（罫線の描画位置＝修正C）は自動テストで担保できていない**——CSS の
`margin: 8px 0 0 10px` はレイアウト計算を伴い、jsdom では画素位置が出ない。
原典が「上・左に数 px ずれる」を画素で確認した修正なので、**実機ないし実ブラウザでの目視確認が要る**。
`review.md` に残課題として記録する。
