# 要件: CCSID テーブルの同梱単位を見直し、web-ui のバンドルから DBCS 表を外す

## 背景 / 課題

`.aidev/backlog/library-extraction.md` の「CCSID テーブルの同梱単位を見直す」を実施する。
2026-07-19 に原因が実測され、2026-07-27 の切り出し作業（`20260726-library-extraction-codec`）で
足場が整ったため着手できる状態になった。

### 実測（2026-07-26 に再測。すべて確認済みの事実）

**web-ui の本番バンドルは 1,407,469 バイトで、そこに EBCDIC の変換表が 2 つ丸ごと入っている。**

| 表（`packages/ebcdic/dist/tables/`） | サイズ | web-ui バンドルに入るか |
|---|---|---|
| `ibm930.js` | 350,204 バイト | **入る** |
| `ibm939.js` | 350,202 バイト | **入る** |
| `ibm1399.js` | 655,427 バイト | 入らない |
| `ibm273.js` | 8,488 バイト | 入らない |
| `ibm37.js` | 8,484 バイト | 入らない |

バンドル内の識別子を検索すると `ibm-930_P120-1999` / `ibm-930_P120-1999_SBCS` /
`ibm-939_P120-1999` / `ibm-939_P120-1999_SBCS` の 4 つが見つかる（他の 3 表は tree-shaking で落ちている）。

### なぜ入るのか

**web-ui が表に触れる経路はただ 1 本、`katakanaChar` 1 関数だけ**である。

```
packages/web-ui/src/components/ScreenGrid.vue:41
  → @as400web/core/codec
  → packages/core/src/codec/codec.ts（互換ファサード）
  → @as400web/ebcdic/codec
  → packages/ebcdic/src/codec.ts   ← ここで 5 表すべてを静的 import
```

`katakanaChar` の実体（`packages/ebcdic/src/codec.ts:210`）は
**`ibm930.sbcs.ebcdicToUnicode` の 256 要素しか読まない**。
にもかかわらず `codec.ts` に同居しているため、モジュール単位で表が引き込まれる。

`ibm939` まで残るのは、`codec.ts` が
`ibm1027 = { ...ibm939.sbcs }`（939 の SBCS 部を借りる日本語 SBCS）を
トップレベルで組み立てており、bundler がこの評価を落とせないため。

### 表の内訳（`ibm930.ts` 4,794 行の構成）

| 部分 | 行範囲 | 割合 |
|---|---|---|
| SBCS（`SB_E2U` / `SB_U2E`） | 6〜101 | **約 2%** |
| DBCS（`DB_E2U` / `DB_U2E`） | 102〜4,769 | **約 98%** |

つまり `katakanaChar` が必要とするのは表全体の **約 2%** で、残り 98% は使われないまま運ばれている。

### backlog に記録された制約

「直すには **(a) 遅延 import 化 / (b) サブパス export の分割 / (c) 生成物の形式変更**
のいずれかが要り、**ブラウザのバンドル方法に影響する**。
バンドルサイズを実測しながら進める独立作業にすること」

## 目的 / ゴール

**web-ui の本番バンドルから、使われていない DBCS 変換表を外す。**
`katakanaChar` が必要とする SBCS 256 要素だけが届く形にし、
半角カナ表示（`katakanaView`）の見た目と挙動は一切変えない。

## スコープ

### 対象

- `packages/ebcdic` の表の同梱単位（生成物の分割・モジュール境界・`exports` サブパス）
- `tools/gen-tables` の出力形式（分割して出す必要があれば）
- `packages/ebcdic/src/codec.ts` の `katakanaChar` の置き場所
- `packages/web-ui/src/components/ScreenGrid.vue:41` の import 先
- `packages/core` の後方互換（`@as400web/core` / `@as400web/core/codec` の既存 export）
- バンドルサイズの回帰を防ぐ検査（今回削った分が黙って戻らないようにする）

### 対象外

- **`katakanaChar` の振る舞いの変更**（同じバイトに同じ文字を返すこと）
- **サーバー側のバンドル/起動時間の最適化**（Node は表を全部持っていてよい）
- 対応 CCSID の増減、変換結果の変更
- backlog の切り出し候補 3（ホストサーバー）/ 4（TN5250 一式）
- npm publish

## 機能要件

- `katakanaChar` が、DBCS 変換表を引き込まずに使える経路を持つ
- web-ui がその経路を使い、本番バンドルに DBCS 表が入らない
- サーバー側（`packages/server`）と core 内部は従来どおり全 CCSID を扱える
- `@as400web/core` / `@as400web/core/codec` / `@as400web/core/browser` の既存 export は
  引き続き解決できる（`20260726-library-extraction-codec` で確立した後方互換を壊さない）
- `tools/gen-tables` を実行すると、分割後の形式で表が正しく再生成される

## 非機能要件 / 制約

- **半角カナ表示の見た目が 1 文字も変わらないこと**（`katakanaView` は実機 ACS の表示コード切替に
  対応する機能で、化ける位置がずれると利用者には不具合に見える）
- `@as400web/ebcdic` は引き続き**外部ランタイム依存ゼロ**
- ピュアロジック層（core / ebcdic / scs）の Node API 非依存を維持する
- 型検査・lint・テストが monorepo 全体で従来どおり通る
- 変換表の出典表記（ICU / Unicode License V3）を落とさない

## 完了条件 (受け入れ基準)

- [ ] web-ui の本番バンドルに `ibm-930_P120-1999` / `ibm-939_P120-1999` の
      **DBCS 表が含まれない**（バンドル内の識別子検索で確認）
- [ ] web-ui の本番バンドルが baseline **1,407,469 バイトから 400,000 バイト以上小さい**
      （実測値は結果として報告する）
- [ ] `katakanaChar` が全 256 バイトについて**変更前と同一の文字を返す**
      （変更前の出力を固定した回帰テストで確認）
- [ ] `npm run build`（`tsc -b`）が成功する
- [ ] `npm test`（全 workspace）が従来と同じ結果で成功する
      （`zip-writer.test.ts` の 4 件は `unzip` 不在による既知の環境要因）
- [ ] `npm run lint` が成功する
- [ ] `npm run build -w @as400web/web-ui`（`vue-tsc` 込み）が成功する
- [ ] `packages/server/src` の差分がゼロ（サーバー側は影響を受けない）
- [ ] `npm run gen:tables` を実行しても、生成物の**内容**が変化しない
      （分割するなら分割後の形で安定して再生成できること）
- [ ] `@as400web/core` / `@as400web/core/codec` / `@as400web/core/browser` から
      従来のシンボルが解決できる（既存の `codec-reexport.test.ts` が通る）
- [ ] 削減が黙って戻らないことの検査がある（バンドルへの表の再混入を検出する）

## 未確定事項 / 確認したいこと

spec 工程で決める（本作業は完全自律のため、**判断は `decisions.md` に根拠つきで記録し、PR をレビュー地点とする**）。

- **どの手を採るか**: backlog の (a) 遅延 import 化 / (b) サブパス export の分割 /
  (c) 生成物の形式変更。実測では「SBCS 部だけを別モジュールに切り出し（c）、
  narrow な入口を足す（b）」の組み合わせが本命に見えるが、spec で確定する
- `ibm290` / `ibm1027`（930 / 939 の SBCS 部を借りる日本語 SBCS）の組み立てを
  どう扱うか——ここも SBCS 部しか要らないので、同じ分割の恩恵を受けられる可能性がある
- web-ui の import 先を変えるか、`@as400web/core/codec` 側を痩せさせるか
  （前者は web-ui のソース変更を伴い、後者は後方互換の範囲に踏み込む）
- 生成物を分割する場合の `tools/gen-tables` の出力単位と、既存の
  `emit-sbcs.ts` / `emit-stateful.ts` の責務分担
