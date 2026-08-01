# タスク

`plan.md`「3.」に対応。**A（中身の整理）→ B（改名）→ C（ガード）** の順。
各段で `npm run build` と **`npm run build -w @as400web/web-ui` の両方**を回す。

## A: 中身の整理（改名の前に済ませる）

- [x] **T1** 純粋ユーティリティ 3 本を `@as400web/base` へ
  - `csv-parse.ts`(128) / `sql/split-statements.ts`(158) / `text/east-asian-width.ts`(109) を
    `git mv` で `packages/base/src/` へ（**ディレクトリは平坦化**）
  - `base/src/index.ts` に**列挙で**追加（`export *` は使わない）
  - 該当テストを `packages/base/test/` へ移し、import を付け替え
  - 利用側（core 内・server・web-ui）の import を `@as400web/base` へ
- [x] **T2** `html/spool-html.ts`(217) を `@as400web/scs` へ
  - `packages/scs/src/spool-html.ts` へ `git mv`、`scs/src/index.ts` に追加
  - `scs/package.json` の `dependencies` に `@as400web/base`、`tsconfig.json` の
    `references` に `../base` を追加。**`types: []` は保つ**
  - 利用側（server ×3・web-ui）の import を `@as400web/scs` へ
- [x] **T3** tn5250 内の整理と codec ファサードの廃止
  - `src/util/emitter.ts` → `src/session/emitter.ts`（`util/` を消す）
  - `src/html/screen-html.ts` → `src/screen-html.ts`（`html/` を畳む）
  - `src/codec/codec.ts` を**削除**し、`package.json` の `exports["./codec"]` も削除
  - `packages/server/src/host-dtaq.ts` を `@as400web/ebcdic/codec` 直参照へ
  - `codec-reexport.test.ts` から `/codec` サブパスの検査を削除
- [x] **T4** A の検証
  - `npm run build` ＋ `npm run build -w @as400web/web-ui` が緑
  - テストがベースライン（269 files / 3,268 tests）と一致
  - web-ui バンドルが 359,853 バイト以下

## B: パッケージの改名

- [x] **T5** `packages/core` → `packages/tn5250`
  - `git mv packages/core packages/tn5250`
  - `package.json` の `name` を `@as400web/tn5250` に
  - 追跡 190 ファイルの `@as400web/core` → `@as400web/tn5250`
    （**`from "…"` と `import("…")` の両方**を対象にする）
  - 各 `package.json` の `dependencies`、各 `tsconfig.json` の `references`、
    root `tsconfig.json`、`AGENTS.md`、`README` 類
  - **未追跡の `scripts/*.mjs` 6 本も作業ディレクトリでは直す**（コミットはしない）
  - `npm install` → `npm run build` ＋ web-ui ビルドが緑

## C: ガード

- [x] **T6** ガードの更新と新設
  - `hostserver-not-reexported.test.ts` のパスを追随
  - `import-from-owner.test.ts` の指定子を追随（base の名前が増える）
  - **新設** `packages/tn5250/test/dependency-direction.test.ts`
    —— 層の順序（`base < ebcdic < scs < hostserver < tn5250`）を 1 か所で宣言し、
    各 `src` を走査して**上位への import が 0 件**であることを検査。
    パッケージが増えても表に足すだけで全組み合わせが効く
  - **わざと逆向きの辺を作って落ちることを確認**してから戻す
- [x] **T7** 全体検証
  - 追跡ファイルの `@as400web/core` が 0 件（履歴の記述を除く）
  - `packages/tn5250/package.json` の `dependencies` が **base / ebcdic の 2 つだけ**
  - `npm run build` / `npm test` / `npx eslint packages tools` が緑
  - **269 files / 3,268 tests 以上**、失敗 0
  - web-ui バンドル 359,853 バイト以下
  - `tools/hostserver-check` と `tools/gen-tables` がビルドできる
