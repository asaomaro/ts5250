# 要件: EBCDIC コーデックと SCS デコーダのパッケージ分割

## 背景 / 課題

`.aidev/backlog/library-extraction.md` の切り出し候補 **1. EBCDIC コーデック** と
**2. SCS デコーダ**（どちらも推奨順の先頭・強調項目）を実施する。

backlog では「codec は依存ゼロ／scs は codec のみ依存」と 2026-07-18 に実測されている。
**2026-07-26 に再測したところ、この前提は今も成立している**（下表）。

| 対象 | 規模 | 依存 |
|---|---|---|
| `packages/core/src/codec/` （6 ファイル） | 680 行 | **codec 内部のみ**（`errors` / `log` / `transport` へ一切依存しない） |
| `packages/core/src/codec/tables/` （5 テーブル） | 約 1.17 MB | なし（生成物） |
| `packages/core/src/protocol/scs.ts` | 250 行 | `codec/codec.js` のみ（`codecForCcsid` / `SO` / `SI` / `Codec`） |

一方、両者は現在 `@as400web/core`（TN5250 プロトコル一式）に同居しており、
**「IBM i のスプールや EBCDIC を扱いたいが TN5250 一式は要らない」利用者に対して、
プロトコル本体ごと引き渡すことになっている**。切り出しの独自価値は backlog に記載のとおり:

- npm の EBCDIC 系は SBCS 止まりが多いが、本実装は SBCS(37/273) と DBCS(930/939/1399)、
  SO/SI 制御、純 DBCS(300) まで対応している
- SCS デコーダは「スプールのバイト列 → 論理ページ」に責務が閉じており、
  `server/src/pdf.ts` が 66 行で済んでいるのが分離の効いている証拠

**影響範囲の実測（2026-07-26）**:

- core 内部の codec 利用: 約 25 ファイル（`protocol` / `screen` / `session` / `telnet` /
  `hostserver`（`db` / `spool` / `command` / `list` / `ddm` / `dtaq`））
- core 内部の scs 利用: `session/printer-session.ts`, `hostserver/spool/netprint-connection.ts`,
  `index.ts` の re-export、`test/scs.test.ts`
- **core 外部からの利用は 5 ファイル**:
  - `packages/server/src/host-dtaq.ts` — `codecForCcsid`（`@as400web/core/codec` サブパス経由）
  - `packages/server/src/pdf.ts`, `host-spools.ts` — `LogicalPage` 型（`@as400web/core` 経由）
  - `packages/web-ui/src/components/ScreenGrid.vue` — `katakanaChar`（`@as400web/core/codec` サブパス経由）
  - `packages/web-ui/src/components/IfsPane.vue` — `TEXT_CCSIDS` / `ccsidLabel`
    （`@as400web/core/browser` 経由の**値** import。表を引き込まない入口が実際に効いている箇所）
  - ※ backlog の「web-ui が `@as400web/core/codec` から import しているのは `katakanaChar` の
    1 関数だけ」という記述は**今も正しい**。実測の結果、web-ui の本番バンドル
    （1,407 kB）に ibm-930 / 939 の表が入っていることを確認した（`decisions.md` D1）
- テーブル生成器 `tools/gen-tables` は `.ts` を **core の src へ直接書き出している**ため、
  分割に伴い出力先の付け替えが要る

## 目的 / ゴール

EBCDIC コーデックと SCS デコーダを、monorepo 内で `@as400web/core` から独立した
パッケージとして成立させる。**外部公開（npm publish）の判断を後回しにできる状態**にすることが
このスコープのゴールで、公開そのものは行わない。

## スコープ

### 対象

- `packages/core/src/codec/`（`codec.ts` / `pure-dbcs.ts` / `ccsid300.ts` / `ccsid-text.ts` /
  `ccsid-catalog.ts` / `table-types.ts` ＋ `tables/` 5 テーブル）の独立パッケージ化
- `packages/core/src/protocol/scs.ts` の独立パッケージ化（codec とセットで出す）
- 上記に対応する既存テスト（`codec.test.ts` / `dbcs-codec.test.ts` / `ccsid-text.test.ts` /
  `scs.test.ts` ほか該当分）の移設
- core 内 約 25 ファイルの import 付け替え
- `@as400web/core` からの **re-export による後方互換の維持**
  （`@as400web/core` / `@as400web/core/codec` / `@as400web/core/browser` の
  既存 export が壊れないこと）
- `tools/gen-tables` の出力先を新パッケージへ付け替え
- ビルド構成の更新（root `tsconfig.json` の project references、workspaces、`tsc -b`）

### 対象外

- **npm への publish**（`package.json` の整備は分割に必要な範囲に留め、公開作業は行わない）
- **別リポジトリへの分離**
- **CCSID テーブルの同梱単位／tree-shaking の見直し**
  （backlog の別項目。バンドルサイズを実測しながら進める独立作業とされている。
  本作業ではテーブルは**現状の形式のまま移設**する）
- backlog 切り出し候補 **3. ホストサーバー** / **4. TN5250 クライアント一式**
- `ErrorCode` / `CONNECT_FAILED` の意味の整理（backlog の別項目）
- 公開 API の設計変更・関数の改名・シグネチャ変更

## 機能要件

- EBCDIC コーデック（SBCS 37/273、DBCS 930/939/1399、純 DBCS 300、SO/SI 制御、
  CCSID カタログとテキスト変換）が、`@as400web/core` を介さず単体で import できる
- SCS デコーダ（バイト列 → `LogicalPage[]`）が、TN5250 プロトコル本体を引き込まずに import できる
- 既存の利用側（core 内部・`packages/server`）が、機能・挙動を変えずに新パッケージを利用する
- `@as400web/core` の既存 export 経路（`.` / `./codec` / `./browser`）は従来どおり解決でき、
  既存の import 文を書き換えなくても動く
- `tools/gen-tables` を実行すると、テーブルが新パッケージ側の正しい場所に生成される

## 非機能要件 / 制約

- **新パッケージは外部ランタイム依存ゼロを保つ**（backlog の指摘どおり、
  「依存ゼロ」がこのコーデックの売りであり、`pino` 等のロガーを持ち込むと価値が半減する。
  ロガーは既に `setLogSink` による注入・既定 no-op 化が済んでいる＝`20260719-core-debt-payoff`）
- Node とブラウザの双方で動作する（現状 codec は Node 固有 API に依存していない）
- 既存の公開 API に破壊的変更を入れない（後方互換は re-export で担保する）
- 型検査・lint・テストが monorepo 全体で従来どおり通る（`tsc -b` / `eslint .` / `vitest`）
- ライセンスは既存に合わせる（Apache-2.0）

## 完了条件 (受け入れ基準)

- [ ] codec 一式と `scs.ts` が `packages/core` の外に移り、core の `src/codec/` と
      `src/protocol/scs.ts` が実体として存在しない（re-export のみ、または完全撤去）
- [ ] 新パッケージの `package.json` が外部 `dependencies` を持たない
- [ ] `npm run build`（`tsc -b`）がリポジトリ全体で成功する
- [ ] `npm test`（全 workspace）が従来と同じ結果で成功する
- [ ] `npm run lint` が成功する
- [ ] `packages/server/src/host-dtaq.ts` の `@as400web/core/codec` からの import が
      無変更のまま解決する（後方互換の実証）
- [ ] `packages/server/src/pdf.ts` の `LogicalPage`（`@as400web/core` 経由）が
      無変更のまま解決する
- [ ] `packages/web-ui/src/components/ScreenGrid.vue` の `katakanaChar`
      （`@as400web/core/codec` 経由）が無変更のまま解決し、`vue-tsc -b && vite build` が通る
- [ ] web-ui の本番バンドルサイズが分割前（**1,407,469 バイト**）から**増えていない**
- [ ] `npm run gen:tables` を実行してもテーブルの内容が変化しない
      （出力先だけが変わり、生成結果は同一）
- [ ] 移設したテストが新パッケージ側で実行され、テスト総数が減っていない

## 未確定事項 / 確認したいこと

いずれも spec 工程で決める（本作業は `humanGates: [spec]` の部分自律なので、spec 承認時に人が確認する）。

- **パッケージの粒度**: codec と scs を 1 パッケージにまとめるか、2 パッケージに分けるか
  （backlog は「1 と同じ切り出しで一緒に出せる」としており同梱を示唆するが、
  「EBCDIC だけ欲しい」利用者には分けたほうが素直）
- **パッケージ名**とサブパス export の構成
- **後方互換の実現方式**: core を re-export の薄いファサードにするか、
  `exports` のマッピングで新パッケージへ転送するか
- `tools/gen-tables` の出力先と、生成物を新パッケージのどこに置くか
  （src 直書き出しを維持するか）
