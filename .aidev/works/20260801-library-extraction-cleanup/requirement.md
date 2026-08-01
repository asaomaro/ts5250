# 要件: ライブラリ切り出しの後始末（3c ＋ 3d）

## 背景 / 課題

`.aidev/backlog/library-extraction.md` の **3c** と **3d**。どちらも
`20260801-library-extraction-drop-core-reexport`（PR #235）が follow-up として起票したもので、
規模が小さく互いに独立しているため 1 つの作業として扱う。

### 3c: `packages/core` に型のみの依存が残っている

PR #235 で `core → hostserver` の**実行時**依存は消えた
（`dist/index.js` の `@as400web/hostserver` が 33 → 0）。しかし
`packages/core/src/browser.ts` が hostserver の型を `export type` で再輸出しており、
`packages/core/package.json` の `dependencies` に `@as400web/hostserver` が残っている。

**実測（2026-08-01）** — `browser.ts` が出している hostserver の型と、web-ui での利用:

| 型 | web-ui での利用箇所 |
|---|---|
| `UploadRejection` | `components/TransferPane.vue` |
| `IfsEntry` | `ifsApi.ts` / `composables/useIfsTree.ts` / `components/IfsPane.vue` |
| `IfsListResult` | `ifsApi.ts` |
| `DtaqAttributes` | `dtaqApi.ts` / `components/DtaqPane.vue` |
| `DtaqSearchOrder` | `dtaqApi.ts` |
| `DtaqEntry` | **0 件（誰も使っていない）** |
| `DtaqType` | **0 件（誰も使っていない）** |

利用しているのは **web-ui の 6 ファイル**だけ。`DtaqEntry` / `DtaqType` は
**再輸出しているが利用者がいない**。

### 3d: 旧名 `Tn5250Error` が広く残っている

`@as400web/base` の `errors.ts` は旧名について
「このリポジトリ内の**新しいコードでは `As400Error` を使うこと**（新旧の混在を意図していない）」
と書いているが、実際には混在している。

**実測（2026-08-01）— backlog の記述より広い**:

| 場所 | ファイル | 箇所 | 扱い |
|---|---|---|---|
| `tools/hostserver-check/src` | 8 | 17 | **改める**（backlog が挙げていた分） |
| `packages/hostserver/test` | 20 | 約 44 | **改める**（挙がっていなかった分） |
| `packages/core/test`（`buffer` / `gds` / `tls` / `transport`） | 4 | 11 | **改める** |
| `packages/base/src/errors.ts` / `index.ts` | 2 | 3 | **残す**（別名の定義そのもの） |
| `packages/core/src/index.ts` | 1 | 1 | **残す**（公開 API の後方互換） |
| `packages/core/test/errors-compat.test.ts` | 1 | 7 | **残す**（新旧の同一性を検査するテスト） |
| `packages/core/test/codec-reexport.test.ts` | 1 | 1 | **残す**（改名の経緯を述べたコメント） |

テストでの使われ方は `expect(() => …).toThrow(Tn5250Error)` と import の 2 種類だけで、
**同一クラスなので振る舞いは変わらない**（`errors-compat.test.ts` が同一性を固定している）。

backlog の 3d は tools だけを挙げていたが、**tools だけ直すと約 55 箇所が残り、
「新旧の混在を意図していない」という目的が達成されない**。テストも揃える。

## 目的 / ゴール

1. **3c**: `packages/core` の `dependencies` から `@as400web/hostserver` を外す。
   ホストサーバーの型は、使う側（web-ui）が実体から直接取る。
2. **3d**: リポジトリ内の新しいコードから旧名 `Tn5250Error` を無くす。
   残すのは「別名の定義」「公開 API の後方互換」「同一性を検査するテスト」だけにする。

## スコープ

### 対象

**3c**

- `packages/core/src/browser.ts` から hostserver 由来の `export type` 3 文を削除
- `packages/web-ui` の 6 ファイルが `@as400web/hostserver` から `import type` する形へ変更
- `packages/web-ui/package.json` に `@as400web/hostserver` を **`devDependencies`** として追加
  （型だけ＝実行時には使わないので `dependencies` ではない）
- `packages/core/package.json` から `@as400web/hostserver` を削除
- `packages/core/tsconfig.json` の `references` から `../hostserver` を削除
- `packages/core/test/hostserver-not-reexported.test.ts` の更新
  （「browser.ts の `export type` だけは許す」という例外が不要になる＝**より厳しくできる**）
- 誰も使っていない `DtaqEntry` / `DtaqType` の再輸出は復活させない

**3d**

- `tools/hostserver-check/src` 8 ファイルと、`packages/*/test` 24 ファイルの
  `Tn5250Error` を `As400Error` に置換（import と `toThrow` の引数）

### 対象外

- `@as400web/base` の `Tn5250Error` 別名そのものの削除（**外部利用者のための互換シム**。
  `errors.ts` の JSDoc が明記している）
- `@as400web/core` の `Tn5250Error` 再輸出の削除（同上）
- `errors-compat.test.ts` の書き換え（新旧の同一性を検査するのが役目）
- `@as400web/core` が `ebcdic` / `scs` から再輸出している分
- backlog 項目 **4. TN5250 クライアント一式**の切り出し
- 振る舞いの変更・公開 API の設計変更

## 機能要件

- `@as400web/core` を install してもホストサーバーのパッケージが付いてこない
- `packages/web-ui` が hostserver の型を使い続けられる（UI の型付けが落ちない）
- **web-ui の本番バンドルに hostserver の実体が入らない**（`import type` なので実行時に消える）
- `Tn5250Error` は外部利用者のために引き続き `@as400web/base` と `@as400web/core` から取れる
- 振る舞いは一切変わらない

## 非機能要件 / 制約

- 型検査・lint・テストが monorepo 全体で従来どおり通る
- web-ui の本番バンドルサイズを増やさない（基準線 **359,853 バイト**）
- `packages/server` と `tools` の**振る舞い**を変えない（3d は識別子の置換のみ）
- ライセンスは既存に合わせる（Apache-2.0）

## 完了条件 (受け入れ基準)

**3c**

- [ ] `packages/core/package.json` の `dependencies` に `@as400web/hostserver` が**無い**
- [ ] `packages/core/tsconfig.json` の `references` に `../hostserver` が**無い**
- [ ] `packages/core/src` 全体に `@as400web/hostserver` の参照が**0 件**（コメントを除く）
- [ ] `packages/web-ui/package.json` の `devDependencies` に `@as400web/hostserver` がある
      （`dependencies` ではない）
- [ ] web-ui の本番バンドル JS が **359,853 バイト以下**
- [ ] web-ui の本番バンドルに `node:net` / `node:tls` が現れない
- [ ] `hostserver-not-reexported.test.ts` が「例外なし」に強化されている

**3d**

- [ ] `tools/hostserver-check/src` と `packages/*/test` に `Tn5250Error` が**残っていない**
      （`errors-compat.test.ts` と `codec-reexport.test.ts` のコメントを除く）
- [ ] `@as400web/base` と `@as400web/core` からは引き続き `Tn5250Error` が取れる
      （`errors-compat.test.ts` が緑）

**共通**

- [ ] `npm run build`（`tsc -b`）が成功
- [ ] `npm test` が **269 files / 3,266 tests 以上**、失敗 0（skip は `zip-writer` の 4 件のみ）
- [ ] `npx eslint packages tools` が成功

## 未確定事項 / 確認したいこと

spec で決める（`mode: autonomous` のため自律判断し、根拠は `decisions.md` に残す）。

- **web-ui が Node 専用パッケージを `devDependencies` に持つことの是非**。
  型だけなら実行時にもバンドルにも入らないが、ブラウザ向けパッケージの依存として
  違和感が残る。代替（型を `@as400web/base` へ移す／web-ui 側で構造的に定義し直す）と
  比べて妥当か判断する
- **`DtaqEntry` / `DtaqType` を web-ui 側に足すか**（現状 0 件なので足さない見込み）
- **3d の置換で `As400Error` が既に import 済みのファイルがあるか**（重複 import になる）
