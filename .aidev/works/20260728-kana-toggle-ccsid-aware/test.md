# テスト結果

実施: 2026-07-28 / 対象: 英カナ表示切り替えの CCSID 対称化

## 受け入れ基準の検証

| # | 受け入れ基準（requirement.md） | 結果 | 根拠 |
|---|---|---|---|
| 1 | `latinChar()` が公開され全 256 バイトが固定されている | ✅ | `ebcdic/test/latin.test.ts` |
| 2 | `latinChar(0x81)==="a"` / `katakanaChar(0x81)==="ｱ"` | ✅ | 同上「表示コード切替は 2 表の往復」 |
| 3 | 到達可能性ガードが DBCS・`codec.ts` 非到達を固定し続ける | ✅ | `katakana-no-dbcs.test.ts`（**16 KB 上限は据え置き**） |
| 4 | 930 で `latin` を選ぶと SBCS が英小文字になる | ✅ | `screen-grid-sbcs-view.test.ts` |
| 5 | 939 で `kana` を選ぶとカタカナになる（退行なし） | ✅ | 同上＋既存 `screen-grid.test.ts` |
| 6 | `auto` はどの CCSID でも再解釈しない | ✅ | `view-settings-kana.test.ts` / `screen-grid-sbcs-view.test.ts` |
| 7 | 旧 `kana: true`/`false` → `"kana"`/`"auto"` | ✅ | `view-settings-kana.test.ts` |
| 8 | 画面・コピー・入力欄の 3 経路が同じ向き | ✅ | 再解釈判定を `recodes()` 1 か所に集約（下記「構造での担保」） |
| 9 | メニュー 3 択・`ctrl+F1` で 3 値順送り | ✅ | `view-settings-kana.test.ts` / `view-cycle-ui.test.ts` |
| 10 | build / vitest / vue-tsc が通る | ✅ | 下記「一括検証」 |

## 個別テスト

```
✓ ebcdic/test/latin.test.ts（6 件）
    latinChar（CCSID 939 の SBCS 部＝CP1027）
      > 全 256 バイトが実表と同一のコードポイントを返す
      > 期待値表そのものが 256 件ある（採取漏れの検出）
      > 常に 1 文字を返す（サロゲートペアにならない）
    表示コード切替は 2 表の往復
      > 英小文字位置とカタカナ位置が 2 表で入れ替わっている
      > 英数字・記号など共通の位置は 2 表で一致する（切替で動かない）
      > 2 表が同一ではない（片方だけで切替を作れない）

✓ web-ui/test/view-settings-kana.test.ts（9 件）
    resolveSbcsView — ホストの表と同じ向きなら再解釈しない
      > auto はどちらのホストでもホストの表のまま（＝既定の見た目を変えない）
      > 英小文字系ホスト（939 等）では kana だけが再解釈になる
      > カタカナ系ホスト（930/5026）では latin だけが再解釈になる   ← 本件の核
    表示コードの選択肢 > 3 値を扱える／cycle が 3 値を一巡する
    旧 kana: boolean の移行 > true→kana／false→auto／新 3 値はそのまま／既定 auto

✓ web-ui/test/screen-grid-sbcs-view.test.ts（6 件）
    表示コード切替は両方向に効く
      > 英小文字系ホストのセルを kana で読み直すとカタカナになる
      > カタカナ系ホストのセルを latin で読み直すと英小文字になる   ← 本件の核
      > host は再解釈しない（既定。ホストの表のまま）
      > 同じバイトが向きによって別の文字になる（2 表が鏡像である証拠）
    生バイトを持たないセルは触らない
      > rawByte の無い SBCS セルは再解釈されない
      > DBCS（全角）は再解釈されない
```

### 不具合が直っていることの直接確認

`0x81` を持つセルで、両方向が動くことを 1 バイトで確かめている。

| ホスト | セッションの解釈 | `kana` | `latin` |
|---|---|---|---|
| 英小文字系（939） | `a` | `ｱ`（930 の表で読み直す） | `a`（＝`host`。既にその向き） |
| カタカナ系（930） | `ｱ` | `ｱ`（＝`host`。既にその向き） | **`a`（939 の表で読み直す）** ← 以前は無反応 |

### 構造での担保（受け入れ基準 8）

3 経路（画面 `displayChar` / コピー `copyCharOf` / 入力欄 `recodeViewActive`）は
**いずれも `recodes()` と `recodeChar()` を通る**。判定と変換が 1 か所しかないので、
「画面はカナなのに入力欄は素のまま」という食い違いが**構造的に起こらない**。
以前は 3 箇所それぞれに `props.katakanaView && kind==="sbcs" && rawByte!==undefined` が
写経されていた。

## 既存テストの更新（挙動の変更ではなく API の追随）

| ファイル | 変更 |
|---|---|
| `web-ui/test/screen-grid.test.ts` | `katakanaView: true/false` → `sbcsView: "kana"/"host"`（11 箇所）。**アサーションは変えていない** |
| `web-ui/test/view-cycle-ui.test.ts` | `ctrl+F1` の順送りを 2 値→3 値に。通知文言も `半角カナ表示:` → `表示コード:` |
| `ebcdic/test/katakana-no-dbcs.test.ts` | 到達ファイルに `tables/ibm939-sbcs.ts` を追加。**上限・非到達条件は据え置き** |

## 一括検証

| コマンド | 結果 |
|---|---|
| `npm run build`（`tsc -b`） | ✅ エラーなし |
| `cd packages/ebcdic && npx vitest run` | ✅ 8 ファイル / **83 件** |
| `cd packages/core && npx vitest run` | ✅ 74 ファイル / **851 件** |
| `cd packages/web-ui && npx vitest run` | ✅ 85 ファイル / **989 件** |
| `cd packages/web-ui && npx vue-tsc -b tsconfig.json tsconfig.test.json` | ✅ エラーなし |
| `npx eslint`（変更した core/ebcdic の 7 ファイル） | ✅ 0 エラー |

`packages/web-ui/**` は eslint 対象外（`eslint.config.js:9`）。静的検査は `vue-tsc` が担う。

## バンドル規律の確認

`@as400web/ebcdic/katakana` から到達するのは 4 ファイル（入口・型・930 SBCS・939 SBCS）で
**約 12.7 KB**。既存の 16 KB 上限に収まっており、**ガードを緩めていない**。
DBCS 部・合成モジュール（`tables/ibm930.ts` 等）・`codec.ts` へ非到達であることも据え置きで固定。

対照テスト（`codec.ts` からは DBCS 部に到達する）も通っており、**検査が実際に効いている**。

## 未実施 — 実機確認

実機（IBM i）へ接続できないため、以下は未検証。

- 930 の実セッションで「英」を選んだときに、画面全体が読める英字になること
- カナ ⇔ 英を往復しても桁がずれないこと（DBCS 混在行を含む）
- クリップボードへのコピーが画面の見た目と一致すること
- 930 の「英」表示中の入力（`uppercaseInput` が大文字化する。`decisions.md` D2 参照）

自動テストは 1 セル単位・純関数単位では固定できているが、**実画面での通しの確認は残る**。
`review.md` の残課題に記録する。
