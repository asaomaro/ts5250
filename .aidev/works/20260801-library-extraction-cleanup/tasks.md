# タスク

`plan.md`「3.」に対応。**3c（T1〜T4）→ 3d（T5）→ 全体（T6）** の順。

## 3c: 型のみの依存を web-ui へ移す

- [x] **T1** 再輸出をやめ、web-ui を直参照へ
  - `packages/core/src/browser.ts` から hostserver 由来の `export type` 3 文を削除
  - web-ui 6 ファイル（`ifsApi.ts` / `dtaqApi.ts` / `composables/useIfsTree.ts` /
    `components/IfsPane.vue` / `components/DtaqPane.vue` / `components/TransferPane.vue`）を
    `import type … from "@as400web/hostserver"` へ
  - `ifsApi.ts` は `LineEnding`（ebcdic 由来）が混ざっているので **import を 2 文に割る**
  - `DtaqEntry` / `DtaqType` は移さない（利用 0 件。decisions.md D2）
- [x] **T2** マニフェストを更新
  - `packages/core/package.json` の `dependencies` から `@as400web/hostserver` を削除
  - `packages/core/tsconfig.json` の `references` から `../hostserver` を削除
  - `packages/web-ui/package.json` の **`devDependencies`** に `@as400web/hostserver` を追加
  - `npm install` → `npm run build` が緑
- [x] **T3** ガードを強化
  - `hostserver-not-reexported.test.ts` の「`browser.ts` の `export type` は許す」例外を**削除**し、
    `packages/core/src` の hostserver 参照を **0 件**に固定
  - `packages/core/package.json` の `dependencies` と `tsconfig.json` の `references` に
    hostserver が**無い**ことを検査（宣言が残ると元に戻れてしまう）
  - web-ui 側は `devDependencies` にあり `dependencies` には無いことを検査
  - **わざと戻して落ちることを確認**
- [x] **T4** 3c の検証
  - web-ui 本番バンドル JS が **359,853 バイト以下**
  - バンドルに `node:net` / `node:tls` が 0 件

## 3d: 旧名の置換

- [x] **T5** `Tn5250Error` → `As400Error`（32 ファイル・約 72 箇所）
  - 対象: `tools/hostserver-check/src`（8）/ `packages/hostserver/test`（20）/
    `packages/core/test` の `buffer` `gds` `tls` `transport`（4）
  - **除外**: `packages/base/src/errors.ts` / `index.ts` / `packages/core/src/index.ts` /
    `packages/core/test/errors-compat.test.ts` / `packages/core/test/codec-reexport.test.ts`
  - `tools/hostserver-check/src/ifs-ops.ts` は**先に重複 import を畳む**（decisions.md D4）
  - 置換後に残存箇所を走査して、除外した 4 箇所以外が 0 件であることを確認

## 全体

- [x] **T6** 全体検証
  - `npm run build` / `npm test` / `npx eslint packages tools` が緑
  - **269 files / 3,266 tests 以上**、失敗 0（skip は `zip-writer` の 4 件のみ）
  - `errors-compat.test.ts` が緑（旧名が引き続き取れる）
