# タスク

`plan.md`「3. 段取り」に対応。**T2〜T5 の合否は `tsc -b` ではなく分類走査の残件数**で見る
（再輸出が残っている間は移し残しがあっても型検査が通るため）。

- [x] **T1** 移設対象を機械的に確定する
  - `@as400web/core` からの import を base / hostserver / ebcdic / scs / core に振り分ける走査を用意
  - 名前の出どころは各パッケージの `index.ts` から読む（手で表を持たない）
  - **ブロックコメントを剥がす**——`base/src/index.ts` は `Tn5250Error` の直前に `/** … */` を
    置いており、行コメントだけ剥がす実装だと名前の抽出に失敗する（実際に踏んだ）
  - 対象 **58 ファイル / 61 文**が再現できることを確認

- [x] **T2** `packages/server/src`（31 ファイル）の import を割る
  - 1 文を宛先ごとに 2〜3 文へ。**識別子・別名・`type` 修飾は変えない**
  - 項目に付いている JSDoc コメントを巻き込まない
  - 完了条件: 走査で `packages/server/src` の残り **0 件**

- [x] **T3** `packages/server/test`（16 ファイル）の import を割る
  - 完了条件: 走査で残り 0 件 ＋ `npm test -w @as400web/server` が緑

- [x] **T4** `tools/hostserver-check/src`（11 ファイル）の import を割る
  - `Tn5250Error` は**改名せず**取得元だけ `@as400web/base` に変える（decisions.md D4）
  - 完了条件: 走査で残り 0 件

- [x] **T5** マニフェストを更新する
  - `packages/server/package.json` の `dependencies` に
    `@as400web/base` / `@as400web/hostserver` / `@as400web/ebcdic` / `@as400web/scs`
  - `packages/server/tsconfig.json` の `references` に対応する 4 つ
  - `tools/hostserver-check/package.json` / `tsconfig.json` も同様（使う分だけ）
  - `npm install` → `npm run build` が緑

- [x] **T6** `packages/core/src/index.ts` の hostserver 再輸出 **39 行**を撤去する
  - 節ごとの見出しコメントも、hostserver 専用のものは一緒に消す
  - `browser.ts` の `export type` 3 箇所は**残す**（decisions.md D2）
  - `packages/core/package.json` の `@as400web/hostserver` は**残す**が、
    **型のみである旨をコメントで書く**（decisions.md D5）
  - 完了条件: `tsc -b` が緑（ここで落ちたら T2〜T4 に移し残しがある）

- [x] **T7** ガードテストを作り直す
  - `git mv packages/core/test/hostserver-reexport.test.ts` →
    `packages/core/test/hostserver-not-reexported.test.ts`（意味が反転するので名前も変える）
  - 検査 4 つ:
    1. `import * as core` に hostserver の実行時 export 名が 1 つも無い
    2. `packages/core/src` の `@as400web/hostserver` 参照は `browser.ts` の `export type` のみ
    3. `packages/core/dist/index.js` に `@as400web/hostserver` が 0 件
    4. `packages/core/dist/browser.js` に `@as400web/hostserver` が 0 件
  - **`dist` が無ければ落とす**（skip にすると「ビルドしていないから緑」になる）
  - 併せて `packages/server/test` に「利用側が `@as400web/core` から
    base / hostserver の名前を取っていないこと」の走査テストを置く
    （T2〜T4 のゲートを恒久化する。次に書く人が `@as400web/core` に戻すのを塞ぐ）
  - **わざと戻して落ちることを確認**してから元に戻す

- [x] **T8** 全体検証
  - `packages/core/dist/index.js` の `@as400web/hostserver` が **33 → 0**
  - `npm run build` / `npm test` / `npx eslint packages tools` が緑
  - テストが **268 files / 3,263 tests 以上**、失敗 0（skip は `zip-writer` の 4 件のみ）
  - `git diff --stat -- packages/web-ui` が**空**
  - web-ui 本番バンドル JS が **359,853 バイト以下**
