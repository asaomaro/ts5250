# 仕様: ライブラリ切り出しの後始末（3c ＋ 3d）

## 0. 着手前ベースライン（2026-08-01 実測）

| 項目 | 値 |
|---|---|
| テスト | **269 files / 3,266 tests**（skip は `zip-writer` の 4 件） |
| web-ui 本番バンドル JS | **359,853 バイト**（CSS 89,097） |
| `packages/core/dist/index.js` の `@as400web/hostserver` | **0 箇所**（PR #235 で達成済み） |
| `packages/core/package.json` の `dependencies` | base / ebcdic / **hostserver** / scs |

## 1. 3c —— 型のみの依存を web-ui へ移す

### 1.1 決定: web-ui が `@as400web/hostserver` を `devDependencies` に持つ

**採る案**: `browser.ts` の再輸出をやめ、web-ui が実体から `import type` する。
hostserver は web-ui の **`devDependencies`**（`dependencies` ではない）。

**根拠**: `import type` は TypeScript が実行時コードを一切出さないので、
バンドルにも `node_modules` の本番インストールにも入らない。
「ブラウザ向けパッケージが Node 専用パッケージを参照する」違和感は残るが、
**参照しているのはデータの形だけ**で、`node:net` を含むモジュールには到達しない。
受け入れ基準（バンドルサイズ据え置き・`node:net` 0 件）で機械的に裏を取る。

**退けた案**:

| 案 | 退ける理由 |
|---|---|
| 5 つの型を `@as400web/base` へ移す | `IfsEntry` / `DtaqAttributes` は**ホストサーバー固有のデータ形**。base は「複製すると壊れるもの」の置き場で、ドメイン型の物置ではない（レイヤリングが崩れる） |
| web-ui 側で同じ形を定義し直す | 型が二重管理になり、サーバーの応答形が変わったときに**ずれても気づけない**。いま型を共有している理由そのものを捨てる |
| 現状維持（core の `dependencies` に残す） | 3c が解こうとしている問題そのもの |

### 1.2 変更するファイル

| ファイル | 変更 |
|---|---|
| `packages/core/src/browser.ts` | hostserver 由来の `export type` **3 文を削除**（`UploadRejection` / `IfsEntry`・`IfsListResult` / dtaq 型群） |
| `packages/core/package.json` | `dependencies` から `@as400web/hostserver` を削除 |
| `packages/core/tsconfig.json` | `references` から `../hostserver` を削除 |
| `packages/web-ui/package.json` | `devDependencies` に `@as400web/hostserver` を追加 |
| `packages/web-ui/src/ifsApi.ts` | `IfsEntry` / `IfsListResult` を hostserver から。`LineEnding` は `@as400web/core/browser` のまま（ebcdic 由来）＝ **import を 2 文に割る** |
| `packages/web-ui/src/dtaqApi.ts` | `DtaqAttributes` / `DtaqSearchOrder` を hostserver から |
| `packages/web-ui/src/composables/useIfsTree.ts` | `IfsEntry` を hostserver から |
| `packages/web-ui/src/components/IfsPane.vue` | 同上 |
| `packages/web-ui/src/components/TransferPane.vue` | `UploadRejection` を hostserver から |
| `packages/web-ui/src/components/DtaqPane.vue` | `DtaqAttributes` を hostserver から |

**`DtaqEntry` / `DtaqType` は移さない**——実測で web-ui の利用が **0 件**。
`browser.ts` が再輸出していただけで、誰も使っていなかった（decisions.md D2）。

### 1.3 ガードを厳しくする

`packages/core/test/hostserver-not-reexported.test.ts` は現在
「`src` の hostserver 参照は `browser.ts` の `export type` だけ許す」という**例外つき**。
3c でその例外が要らなくなるので、**例外を消して「0 件」に強化する**。

併せて次の 2 つを足す:

- `packages/core/package.json` の `dependencies` に `@as400web/hostserver` が**無い**
- `packages/core/tsconfig.json` の `references` に `../hostserver` が**無い**

宣言が残っていると「実行時に引かないだけで依存はしている」状態に戻れてしまうので、
宣言そのものを固定する。

## 2. 3d —— 旧名 `Tn5250Error` を新しいコードから消す

### 2.1 置換する範囲（実測）

| 場所 | ファイル | 箇所 |
|---|---|---|
| `tools/hostserver-check/src` | 8 | 17 |
| `packages/hostserver/test` | 20 | 約 44 |
| `packages/core/test`（`buffer` / `gds` / `tls` / `transport`） | 4 | 11 |

使われ方は 2 種類だけ——`import { Tn5250Error } from "@as400web/base";` と
`expect(() => …).toThrow(Tn5250Error)`。**同一クラスなので振る舞いは変わらない**。

### 2.2 残す 4 箇所（意図的）

| 場所 | 残す理由 |
|---|---|
| `packages/base/src/errors.ts` / `index.ts` | **別名の定義そのもの**。外部利用者のための互換シム |
| `packages/core/src/index.ts` | 公開 API の後方互換（`@as400web/core` から旧名が取れる） |
| `packages/core/test/errors-compat.test.ts` | **新旧の同一性を検査するのが役目**。ここから旧名を消すと検査が成立しない |
| `packages/core/test/codec-reexport.test.ts` | 改名の経緯を述べた**コメント**（識別子ではない） |

### 2.3 重複 import になる 1 ファイル

`tools/hostserver-check/src/ifs-ops.ts:18` が
`import { Tn5250Error, As400Error } from "@as400web/base";` と**両方**取っている。
素直に置換すると `import { As400Error, As400Error }` になり構文エラー。
**この 1 ファイルだけ重複を畳む**（45 行目の `As400Error` 判定と 117 行目の
`Tn5250Error` 判定は同一クラスへの `instanceof` なので、統合しても意味は変わらない）。

## 3. 受け入れ基準

**3c**

- [ ] `packages/core/package.json` の `dependencies` に `@as400web/hostserver` が無い
- [ ] `packages/core/tsconfig.json` の `references` に `../hostserver` が無い
- [ ] `packages/core/src` の `@as400web/hostserver` 参照が **0 件**（コメントを除く）
- [ ] `packages/web-ui/package.json` の **`devDependencies`** に `@as400web/hostserver` がある
      （`dependencies` には無い）
- [ ] web-ui 本番バンドル JS が **359,853 バイト以下**
- [ ] web-ui 本番バンドルに `node:net` / `node:tls` が **0 件**
- [ ] `hostserver-not-reexported.test.ts` から `browser.ts` の例外が消えている

**3d**

- [ ] `tools/hostserver-check/src` と `packages/*/test` の `Tn5250Error` が
      `errors-compat.test.ts` と `codec-reexport.test.ts` のコメントを除いて **0 件**
- [ ] `errors-compat.test.ts` が緑（旧名が引き続き取れる）

**共通**

- [ ] `npm run build` 成功
- [ ] `npm test` が **269 files / 3,266 tests 以上**、失敗 0
- [ ] `npx eslint packages tools` 成功

## 4. plan で判定する

- subtask には割らない見込み（2 項目とも小さく、機械的）。
- 3c と 3d は**互いに独立**なので、段としては 3c → 検証 → 3d → 検証 と刻める
  （前作業と違い、途中で緑にできる）。
