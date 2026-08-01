# 要件: ホストサーバー層のパッケージ分割

## 背景 / 課題

`.aidev/backlog/library-extraction.md` の切り出し候補 **3. ホストサーバー**
（`hostserver/` ＋ `hostserver/db/` ＋ `transport/host-connection.ts`）を実施する。

backlog はこの項目に 2 つの前提条件を課していた。**2026-08-01 に確認したところ、両方とも満たされている**。

- 「SQL 実行が完了していること」→ `20260718-hostserver-sql` で完了
- 「**アップロードが載ってから**のほうが切り出しの価値は高い（API が固まる）」→
  `20260719-hostserver-upload-ddm` で DDM 経由のアップロードが着地済み。
  `hostserver/ddm/`（1,287 行）と `hostserver/db/upload-prepare.ts` / `insert.ts` /
  `marker-encode.ts` / `marker-format.ts` が実在する

### 依存関係の実測（2026-08-01）

backlog の「規模: 認証 878 行 ＋ SQL 約 1,200 行」は 2026-07-18 時点の値で、その後
IFS・DDM・DTAQ・スプール・リストが載って**大きく増えている**。現状は以下。

| 対象 | ファイル数 | 行数 |
|---|---|---|
| `packages/core/src/hostserver/`（`db` / `ifs` / `ddm` / `dtaq` / `spool` / `list` / `command` 含む） | 46 | 10,290 |
| `packages/core/src/transport/host-connection.ts` | 1 | 316 |
| `packages/core/src/transport/ddm-transport.ts` | 1 | 137 |
| **合計** | **48** | **10,743** |

**切り出し面は薄い。** `hostserver/` 配下 46 ファイルが自分の木の外へ張っている import は、
実測で**次の 5 ファイルに限られる**（`../` `../../` の相対 import を全件集計した結果）。

| 依存先 | import 箇所 | 備考 |
|---|---|---|
| `src/errors.ts`（182 行） | 28 | `As400Error` / `ErrorCode` / `withSocketHint` |
| `src/log.ts`（76 行） | 10 | `20260719-core-debt-payoff` で `setLogSink` 注入・既定 no-op 化済み |
| `src/transport/host-connection.ts` | 10 | **hostserver 専用**（後述） |
| `src/transport/ddm-transport.ts` | 1 | **hostserver 専用**（後述） |
| `src/identifier.ts`（33 行） | 2 | `ddm/column-meta.ts` から |

外部ランタイム依存は `@as400web/ebcdic`（16 箇所）と `@as400web/scs`（1 箇所）の 2 つだけで、
どちらも既に独立パッケージ（`20260726-library-extraction-codec` / PR #169）。

**`transport/` は既に半分に割れている**（backlog が `host-connection.ts` だけを挙げていたのは
片手落ちで、実測すると `ddm-transport.ts` も同じ側にある）:

- `host-connection.ts` / `ddm-transport.ts` → **利用者は hostserver 配下 10 ファイルのみ**
  （`ddm-transport.ts` 自身が `host-connection.ts` の `HostTlsOptions` を使う）
- `tcp.ts`（130 行）/ `types.ts`（14 行）→ **利用者は TN5250 側のみ**
  （`session/session.ts` / `session/printer-session.ts` / `telnet/telnet.ts` / `trace/replay.ts` / `index.ts`）

### 共有層の偏り（この作業の本題）

上表の `errors.ts` / `log.ts` / `identifier.ts` は「core と hostserver の共有物」だが、
**実際の利用は hostserver 側に大きく偏っている**。

| ファイル | hostserver からの利用 | TN5250 側からの利用 |
|---|---|---|
| `errors.ts` | 34 ファイル | 11 ファイル（`transport` 3 / `protocol` 3 / `session` 2 / `screen` 2 / `csv-parse` 1） |
| `log.ts` | 13 ファイル | 2 ファイル（`index.ts` / `browser.ts` の re-export のみ） |
| `identifier.ts` | 1 ファイル | 2 ファイル（`index.ts` / `browser.ts` の re-export のみ） |

つまり「どちらに寄せるか」が自明でない共有物は実質 `errors.ts` だけで、
`log.ts` は事実上ホストサーバーの持ち物になっている。この 3 ファイル（計 291 行）の置き場所が、
本作業で決めるべき最大の設計判断になる。

### 後方互換の面（実測）

- `src/index.ts` が hostserver 配下から **35 行にわたって re-export** している
  （`DbConnection` / `query` / `openQuery` / `SqlError` / `listSpooledFiles` /
  `IfsConnection` / `DtaqConnection` / `DdmConnection` / `listObjects` / `listUsers` / `listJobs` ほか）
- `src/browser.ts` が hostserver の**型だけ**を 3 箇所 re-export している
  （`UploadRejection` / `IfsEntry`・`IfsListResult` / dtaq 型群）。
  いずれも `export type` なのでブラウザ向けバンドルには実体が入らない
- 利用側: `packages/server/src` の **37 ファイル**、`packages/web-ui/src` の **22 ファイル**、
  `tools/hostserver-check` が `@as400web/core` を import している
- テスト: `packages/core/test` の全 89 本のうち **43 本**が
  `src/hostserver/` または `src/transport/host-connection` を**相対パスで直接** import している
  （バレル経由は 1 本のみ）。移設に伴い相対パスの付け替えが要る

## 目的 / ゴール

ホストサーバー層（IBM i のホストサーバーポート群と話す実装）を、monorepo 内で
`@as400web/core`（TN5250 プロトコル一式）から独立したパッケージとして成立させる。

**「IBM i に SQL を投げたい／IFS を読み書きしたいが、TN5250 の画面エミュレーションは要らない」**
利用者が、5250 データストリームのパーサや画面モデルを引き取らずに済む状態にする。

項目 1・2（`@as400web/ebcdic` / `@as400web/scs`）と同じく、**外部公開（npm publish）の判断を
後回しにできる状態**にすることがゴールで、公開そのものは行わない。

## スコープ

### 対象

- `packages/core/src/hostserver/` 46 ファイル（10,290 行）の独立パッケージ化
- `packages/core/src/transport/host-connection.ts` / `ddm-transport.ts` の移設
  （実測で hostserver 専用と確認済み）
- 共有層 `errors.ts` / `log.ts` / `identifier.ts` の置き場所の決定と、それに伴う移動・分割
- 該当テスト 43 本の移設と相対 import の付け替え
- `@as400web/core` からの **re-export による後方互換の維持**
  （`@as400web/core` の 35 行の hostserver re-export と、`@as400web/core/browser` の
  型 re-export 3 箇所が、利用側を書き換えずに解決し続けること）
- ビルド構成の更新（root `tsconfig.json` の project references、`tsc -b` の順序）
- `tools/hostserver-check` が新構成で動くこと

### 対象外

- **npm への publish**（`package.json` の整備は分割に必要な範囲に留める）
- **別リポジトリへの分離**
- **`packages/core/src/sql/split-statements.ts`**（158 行）。
  名前から hostserver 側に見えるが、**実測すると hostserver から一切参照されていない**。
  `browser.ts` からのみ export される web-ui 向けの SQL 文字列ユーティリティで、
  ホストサーバー通信とは無関係。本作業では動かさない
- **`transport/tcp.ts` / `transport/types.ts`**（TN5250 側の持ち物）
- backlog 切り出し候補 **4. TN5250 クライアント一式**
- 公開 API の設計変更・関数の改名・シグネチャ変更・エラーコードの意味の見直し
- `packages/server` / `packages/web-ui` 側のリファクタ
  （import 元が変わらないなら、これらのファイルは触らないのが正しい着地）

## 機能要件

- ホストサーバー層（signon 認証・DB/SQL・IFS・DDM・DTAQ・スプール・オブジェクト/ユーザー/ジョブ一覧・
  リモートコマンド実行）が、`@as400web/core` を介さず単体で import できる
- 新パッケージが 5250 データストリームのパーサ・画面モデル・telnet ネゴシエーションを引き込まない
- 既存の利用側（`packages/server` 37 ファイル・`packages/web-ui` 22 ファイル・
  `tools/hostserver-check`）が、機能・挙動を変えずに動く
- `@as400web/core` および `@as400web/core/browser` の既存 export 経路は従来どおり解決でき、
  既存の import 文を書き換えなくても動く
- `@as400web/core/browser` 経由の hostserver 型 re-export が、
  ブラウザ向けバンドルに `node:net` / `node:tls` を引き込まない（型のみであり続ける）

## 非機能要件 / 制約

- **新パッケージの外部ランタイム依存は `@as400web/ebcdic` と `@as400web/scs` のみに保つ**
  （`pino` 等のロガーを持ち込まない。ロガー注入は `setLogSink` で既に済んでいる）
- 新パッケージは **Node 専用**でよい（`host-connection.ts` が `node:net` / `node:tls` を使う。
  `@as400web/ebcdic` のような universal ではない）
- 既存の公開 API に破壊的変更を入れない（後方互換は re-export で担保する）
- 型検査・lint・テストが monorepo 全体で従来どおり通る（`tsc -b` / `eslint .` / `vitest`）
- ライセンスは既存に合わせる（Apache-2.0）
- **循環参照を作らない**。`@as400web/core` が新パッケージに依存する形（後方互換の re-export）に
  するなら、新パッケージ側は `@as400web/core` を参照してはならない

## 完了条件 (受け入れ基準)

- [ ] `hostserver/` 46 ファイルと `transport/host-connection.ts` / `ddm-transport.ts` が
      `packages/core/src` の外に移り、core 側に実体が存在しない（re-export のみ、または完全撤去）
- [ ] 新パッケージの `package.json` の `dependencies` が `@as400web/ebcdic` と
      `@as400web/scs` のみである（それ以外の外部依存が無い）
- [ ] 新パッケージから `@as400web/core` への import が **0 件**である（循環参照が無いことの実証）
- [ ] 新パッケージが `src/protocol/` `src/screen/` `src/session/` `src/telnet/` `src/trace/` を
      参照していない（TN5250 本体を引き込んでいないことの実証）
- [ ] `npm run build`（`tsc -b`）がリポジトリ全体で成功する
- [ ] `npm test`（全 workspace）が成功し、**テスト総数が分割前から減っていない**
- [ ] `npm run lint` が成功する
- [ ] `packages/server/src` の 37 ファイルと `tools/hostserver-check` を**無変更のまま**
      型検査・テストが通る（後方互換の実証）
- [ ] `packages/web-ui` を**無変更のまま** `vue-tsc -b && vite build` が通る
- [ ] web-ui の本番バンドルサイズが分割前（**要計測。直近の記録値は 358,354 バイト**）から
      増えていない
- [ ] web-ui の本番バンドルに `node:net` / `node:tls` 由来のコードが入っていない
- [ ] `tools/hostserver-check` が新構成でビルド・実行できる

## 未確定事項 / 確認したいこと

いずれも spec 工程で決める（本作業は `mode: autonomous` のため自律判断し、
決定と根拠は `decisions.md` に残す）。

- **共有層 `errors.ts` / `log.ts` / `identifier.ts`（計 291 行）の置き場所** — 最大の判断。
  取りうる案:
  - (a) 新しい共有基盤パッケージ（例 `@as400web/base`）を作り、core と hostserver の両方が依存する
  - (b) hostserver パッケージ側に移し、`@as400web/core` が hostserver に依存する
    （利用の偏りには合うが、TN5250 だけ欲しい利用者にホストサーバーが付いてくる）
  - (c) `errors.ts` は core に残し hostserver が core に依存する
    （**切り出しの目的を損なうため退ける想定**）
  - (d) `log.ts` / `identifier.ts` は hostserver へ、`errors.ts` だけ共有基盤へ、と割る
- **パッケージ名**（`@as400web/hostserver` が素直だが、内容は「IBM i のホストサーバー群の
  クライアント」なので `@as400web/ibmi-client` 等も候補）
- **サブパス export の構成**（`./db` / `./ifs` / `./ddm` 等に割るか、単一入口にするか）
- **後方互換の実現方式**（core を薄い re-export ファサードにするか、
  `package.json` の `exports` マッピングで転送するか）
- **移設テストの置き場所**（新パッケージの `test/` へ全部移すか、
  core 横断の結合テストだけ core に残すか）
- **1 PR に収まるか**（48 ファイル移動 ＋ 43 テスト付け替え ＋ 共有層の再配置。
  plan 工程で subtask 分割の要否を判定する）
