# 要件: `@as400web/core` を `@as400web/tn5250` に改め、中身を TN5250 一式に絞る

## 背景 / 課題

`.aidev/backlog/library-extraction.md` の切り出し候補 **4. TN5250 クライアント一式**。
これで項目 1〜4 が揃う。

### 前 3 回と性質が違う —— 「core から出す」のではなく「core そのもの」が対象

項目 1・2・3 は core から何かを取り出す作業だった。項目 4 の対象は core の中身そのもので、
**出したあとに core に何が残るか**を先に決めないと形が決まらない。

**実測（2026-08-01）— TN5250 側は驚くほど独立している**:

| ディレクトリ | 行数 |
|---|---|
| `protocol/` | 1,912 |
| `screen/` | 1,556 |
| `session/` | 892 |
| `telnet/` | 393 |
| `trace/` | 147 |
| `transport/` | 144 |
| **小計** | **5,044** |

この 6 ディレクトリが外へ張っている依存は **`session → util/emitter.ts`（28 行）の 1 本だけ**。
`protocol ⇄ screen` は backlog の記述どおり相互依存（7 と 4）で分割不可。

**残る 1,197 行の行き先が問題**:

| モジュール | 行 | 性質 | core 外の利用者 |
|---|---|---|---|
| `html/screen-html.ts` | 557 | 画面 → HTML。**`screen` / `protocol` に依存** | server / web-ui |
| `html/spool-html.ts` | 217 | スプール → HTML。**`@as400web/scs` の `LogicalPage`** | server ×3 / web-ui |
| `sql/split-statements.ts` | 158 | SQL 文分割。**純粋** | web-ui |
| `csv-parse.ts` | 128 | CSV 解析。**純粋**（`As400Error` のみ） | server / web-ui |
| `text/east-asian-width.ts` | 109 | 全角判定。**純粋** | `screen/` ・両 html ・web-ui ×2 |
| `util/emitter.ts` | 28 | イベント。**`session` 専用** | なし |
| `codec/codec.ts` | 34 | `@as400web/core/codec` 互換ファサード | server ×1（＋script 1） |

`html/` が `screen` / `protocol` に依存しているため、**6 ディレクトリだけ出すと
残った core が新パッケージに依存し返す**——3b / 3c で消したばかりの形に逆戻りする。

### 「core」という名前が問題の一部だった

`@as400web/core` は**何が入っているのかを名前が語らない**。実際この袋には
TN5250・ホストサーバー・EBCDIC・SCS・CSV 解析・SQL 文分割が同居し、
利用側は「とりあえず core から取る」形になっていた（3b で 61 文を割り直した）。
**名が体を表す名前にすれば、次に何かを足すとき「これは tn5250 か？」と問える。**

## 目的 / ゴール

1. `packages/core` を **`packages/tn5250` / `@as400web/tn5250`** に改める。
   中身は **TN5250 の端末プロトコル一式だけ**にする。
2. TN5250 に属さない純粋ユーティリティを、実体のふさわしい場所へ移す。
3. 依存の向きを**一方通行**に保つ（再輸出ファサードを新たに作らない。3b / 3c の方針）。

## スコープ

### 対象

**A. パッケージの改名**

- `packages/core` → `packages/tn5250`（`git mv`）
- パッケージ名 `@as400web/core` → `@as400web/tn5250`
- 入口 `@as400web/core` → `@as400web/tn5250`、`@as400web/core/browser` → `@as400web/tn5250/browser`
- **`@as400web/core/codec` サブパスは廃止**（下記 C）
- 利用側の書き換え: **追跡 190 ファイル**
  （`packages/web-ui/test` 56 / `scripts` 46 / `packages/server/src` 20 /
  `packages/server/test` 19 / `packages/web-ui/src` 21 / その他）
- 各 `package.json` の `dependencies` と `tsconfig.json` の `references`、root `tsconfig.json`

**B. 中身の整理**

| 移動 | 移動先 | 理由 |
|---|---|---|
| `html/spool-html.ts`（217 行） | **`@as400web/scs`** | スプールの論理ページ → HTML。TN5250 とは無関係で、scs の「バイト列 → 論理ページ」の自然な続き |
| `csv-parse.ts`（128 行） | **`@as400web/base`** | 純粋なテキスト処理。TN5250 にもホストサーバーにも属さない |
| `sql/split-statements.ts`（158 行） | **`@as400web/base`** | 同上 |
| `text/east-asian-width.ts`（109 行） | **`@as400web/base`** | **`screen/`（tn5250）と `spool-html`（scs）の両方が使う**ので、どちらにも置けない |
| `util/emitter.ts`（28 行） | tn5250 内へ（`session/` 配下） | `session` 専用。トップに置く理由がない |
| `html/screen-html.ts`（557 行） | tn5250 に残す | `screen` / `protocol` に依存しており分離できない |

**C. `@as400web/core/codec` ファサードの廃止**

`packages/core/src/codec/codec.ts`（34 行）は `@as400web/ebcdic/codec` への転送のみ。
実利用者は `packages/server/src/host-dtaq.ts` の 1 箇所だけで、
**3b で確立した「使うものは在り処から取る」に従えば `@as400web/ebcdic/codec` を直接使うべき**。
ファサードごと削除する。

### 対象外

- **npm publish**（項目 1〜3 と同じく「公開の判断を後回しにできる状態」までがゴール）
- 別リポジトリへの分離
- `protocol` / `screen` の相互依存の解消（backlog どおり分割不可）
- 公開 API の設計変更・関数の改名・シグネチャ変更・振る舞いの変更
- **未追跡の `scripts/*.mjs`**（作業ディレクトリにある調査用スクリプト）。
  ただし 6 本が `@as400web/core` を参照しており改名で壊れるため、
  **コミットはしないが作業ディレクトリでは直す**（下記「未確定事項」）

## 機能要件

- `@as400web/tn5250` が TN5250 の端末プロトコル（telnet ネゴシエーション・5250 データストリーム・
  画面モデル・セッション・トレース再生）を提供する
- `@as400web/tn5250` が**ホストサーバーにも SCS にも CSV 解析にも依存しない**
- `@as400web/scs` が `renderSpoolHtml` を提供する
- `@as400web/base` が CSV 解析・SQL 文分割・全角判定を提供する
- `@as400web/tn5250/browser` がブラウザ向けの入口を提供し続ける（web-ui が使う）
- 振る舞いは一切変わらない（移動と import の付け替えのみ）
- **依存が一方通行**である（`tn5250 → base`、`scs → base, ebcdic`、
  `hostserver → base, ebcdic, scs`。逆向きの辺が 1 本も無い）

## 非機能要件 / 制約

- 型検査・lint・テストが monorepo 全体で従来どおり通る
- web-ui の本番バンドルサイズを増やさない（基準線 **359,853 バイト**）
- **`@as400web/base` は外部ランタイム依存ゼロを保つ**（移す 3 ファイルとも純粋）
- **`@as400web/scs` の `types: []` を保つ**（`spool-html.ts` は Node API を使わない。
  生成する HTML 文字列の中に `document.*` が現れるが、それは**出力される文字列**であって
  TypeScript のコードではない）
- 循環参照を作らない
- ライセンスは既存に合わせる（Apache-2.0）

## 完了条件 (受け入れ基準)

- [ ] `packages/core` が存在せず、`packages/tn5250` に移っている
- [ ] `packages/tn5250/package.json` の `name` が `@as400web/tn5250`
- [ ] 追跡ファイルに `@as400web/core` の参照が **0 件**
- [ ] `packages/tn5250/src` に `csv-parse.ts` / `sql/` / `text/` / `codec/` / `html/spool-html.ts`
      が**存在しない**
- [ ] `@as400web/base` から `parseCsv` / `splitSqlStatements` / `isFullWidth` が取れる
- [ ] `@as400web/scs` から `renderSpoolHtml` が取れる
- [ ] `packages/base/package.json` に外部 `dependencies` が無い
- [ ] `packages/scs/tsconfig.json` の `types` が `[]` のまま
- [ ] **逆向きの依存が 0 本**（`base → *` / `ebcdic → *` / `scs → tn5250|hostserver` /
      `tn5250 → hostserver|scs` が無い）
- [ ] `npm run build`（`tsc -b`）が成功
- [ ] `npm run build -w @as400web/web-ui`（`vue-tsc` ＋ `vite build`）が成功
- [ ] `npm test` が **269 files / 3,268 tests 以上**、失敗 0（skip は `zip-writer` の 4 件のみ）
- [ ] `npx eslint packages tools` が成功
- [ ] web-ui 本番バンドル JS が **359,853 バイト以下**
- [ ] `tools/hostserver-check` と `tools/gen-tables` がビルドできる

## 未確定事項 / 確認したいこと

spec で決める（`mode: autonomous` のため自律判断し、根拠は `decisions.md` に残す）。

- **`@as400web/base` の役割をどう定義し直すか。** 現在の AGENTS.md は
  「base に置くのは**複製すると壊れるもの**だけ」と書いているが、
  `east-asian-width` / `csv-parse` / `split-statements` は複製しても壊れない
  （純粋関数で可変状態も `instanceof` も無い）。**「複数のパッケージが要るが、
  どれにも属さないもの」**という第 2 の基準を明記するか、別パッケージを立てるか
- **`util/emitter.ts` を `session/` 配下のどこに置くか**
- **未追跡の `scripts/*.mjs` 6 本**の扱い（コミット対象外だが改名で壊れる）
- **`@as400web/core/codec` の廃止で `codec-reexport.test.ts` をどう作り直すか**
  （`/codec` サブパスの検査が成立しなくなる）
