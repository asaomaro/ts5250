# 決定記録

autonomous モードのため、人間ゲートを置かずに判断した事項を記録する。

## D1. 3c は web-ui の `devDependencies` に寄せる（spec 工程・2026-08-01）

`browser.ts` の hostserver 型再輸出をやめ、web-ui が実体から `import type` する。
hostserver は web-ui の **`devDependencies`**（`dependencies` ではない）。

`import type` は TypeScript が実行時コードを一切出さないので、バンドルにも本番インストールにも
入らない。「ブラウザ向けパッケージが Node 専用パッケージを参照する」違和感は残るが、
**参照しているのはデータの形だけ**で `node:net` を含むモジュールには到達しない。
バンドルサイズ据え置きと `node:net` 0 件で機械的に裏を取る。

退けた案:

- **5 つの型を `@as400web/base` へ移す** — `IfsEntry` / `DtaqAttributes` はホストサーバー固有の
  データ形。base は「複製すると壊れるもの」の置き場であってドメイン型の物置ではない
- **web-ui 側で同じ形を定義し直す** — 型が二重管理になり、サーバーの応答形が変わったときに
  **ずれても気づけない**。型を共有している理由そのものを捨てる

## D2. `DtaqEntry` / `DtaqType` は移さない（spec 工程・2026-08-01）

`browser.ts` が再輸出していたが、**web-ui での利用は実測 0 件**。
移設先が無いので、そのまま消す（必要になれば web-ui が hostserver から取ればよい）。

## D3. 3d を backlog の記述より広く取る（spec 工程・2026-08-01）

backlog の 3d は `tools/hostserver-check` の 7 ファイルだけを挙げていたが、実測すると
**`packages/core/test` と `packages/hostserver/test` の 24 ファイル・約 55 箇所**にも
旧名が残っていた。tools だけ直しても「新旧の混在を意図していない」という
`errors.ts` の JSDoc の意図は達成されない。

テストでの使われ方は `import` と `expect(…).toThrow(Tn5250Error)` の 2 種類だけで、
**同一クラスなので振る舞いは変わらない**（`errors-compat.test.ts` が同一性を固定している）。

**残すのは 4 箇所**——別名の定義（`base/src/errors.ts` / `index.ts`）、
公開 API の後方互換（`core/src/index.ts`）、同一性を検査するテスト（`errors-compat.test.ts`）、
経緯を述べたコメント（`codec-reexport.test.ts`）。

## D4. `ifs-ops.ts` の重複 import は畳む（spec 工程・2026-08-01）

`tools/hostserver-check/src/ifs-ops.ts:18` が `Tn5250Error` と `As400Error` を**両方**取っている。
素直に置換すると `import { As400Error, As400Error }` になり構文エラーになるので、
このファイルだけ重複を畳む。45 行目と 117 行目はどちらも同一クラスへの `instanceof` なので、
統合しても意味は変わらない。

## D5. root の `tsc -b` は web-ui を見ていない（coding 工程・2026-08-01）

`browser.ts` の再輸出を消したあと **root の `npm run build`（`tsc -b`）は緑のまま**だったが、
`npm run build -w @as400web/web-ui`（`vue-tsc`）が
`test/use-ifs-tree.test.ts` の `IfsListResult` を型エラーで落とした。

**web-ui は root の project references に入っておらず**、`vue-tsc` で別に型検査される。
さらに web-ui は `tsconfig.test.json` を持ち **test も型検査の対象**なので、
`src` だけ直しても足りない。core / hostserver 側の慣習（`include: ["src"]` で test は
型検査されない）と違うので取り違えやすい。

**web-ui に影響する変更では、root の `tsc -b` が緑でも安心しないこと。**

## D6. `dist` を読む検査はコメントを剥がす必要がある（coding 工程・2026-08-01）

`hostserver-not-reexported.test.ts` の `dist/browser.js` 検査が落ちた。原因は
**`tsc` が JSDoc を出力にそのまま残す**ことで、`browser.ts` に書いた
「hostserver をここへ戻すな」という注意書き自体が `@as400web/hostserver` の文字列として
引っかかっていた。

見たいのは**実行時に解決されるモジュール指定子**であってコメントの文字列ではないので、
`readDist()` でコメントを剥がしてから検査するようにした。
**注意書きを書いたことでガードが誤検知する**という、自分で自分の足を踏む形だった。
