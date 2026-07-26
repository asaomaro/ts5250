# タスク: EBCDIC コーデックと SCS デコーダのパッケージ分割

進行の目安: **T1・T2 は緑 → T3〜T5 は赤（ビルドが通らない）→ T6 で緑に戻る**。
中断するなら T6 の後にする。

## 器を作る（ビルドは緑のまま）

- [x] **T1**: `packages/ebcdic/` の骨格を作る（依存: なし）
  - `package.json`（name `@as400web/ebcdic` / `type: module` / license Apache-2.0 /
    exports `.` と `./catalog` / `files: ["dist"]` / **`dependencies` を置かない**）
  - `tsconfig.json`（`../../tsconfig.base.json` 継承 / `composite: true` / `rootDir: src` /
    `outDir: dist` / `types: ["node"]`＝`TextDecoder` の型に必要）
  - `vitest.config.ts`（core と同じ `include: ["test/**/*.test.ts"]`）
  - root `tsconfig.json` の `references` に `packages/ebcdic` を追加
  - `npm install`（workspace のリンクを張る。R6）

- [x] **T2**: `packages/scs/` の骨格を作る（依存: なし）
  - `package.json`（name `@as400web/scs` / exports `.` / `dependencies: { "@as400web/ebcdic": "0.1.0" }`）
  - `tsconfig.json`（`references: [{ "path": "../ebcdic" }]`）
  - `vitest.config.ts`
  - root `tsconfig.json` の `references` に `packages/scs` を追加

## 実体を移す（ここから赤）

- [x] **T3**: codec 一式を `@as400web/ebcdic` へ移設する（依存: T1）
  - `git mv` で 6 ファイル → `packages/ebcdic/src/`
    （`codec.ts` / `pure-dbcs.ts` / `ccsid300.ts` / `ccsid-catalog.ts` / `ccsid-text.ts` / `table-types.ts`）
  - `git mv` で 5 表 → `packages/ebcdic/src/tables/`
    （**`table-types.ts` と `tables/` の親子関係を保つ**＝生成物の `../table-types.js` を壊さない。spec D6）
  - `src/index.ts` を作る（`.` の公開面。spec「インターフェース」の表のとおり明示列挙）
  - `src/catalog.ts` を作る（`./catalog` の公開面。**`ccsid-catalog.ts` 以外を import しない**）
  - 移設したファイルの中身は import パス以外変更しない。
    **原典参照コメント（ACS/jt400 の CCSID 300 差分・research F4・ICU 出典と Unicode License）を落とさない**

- [x] **T4**: `scs.ts` を `@as400web/scs` へ移設する（依存: T2, T3）
  - `git mv packages/core/src/protocol/scs.ts packages/scs/src/scs.ts`
  - 先頭の import を `@as400web/ebcdic` に変更（`codecForCcsid` / `SO` / `SI` / `Codec`）
  - `src/index.ts` を作る（`ScsDecoder` / `LogicalPage`）
  - **tn5250 `lib5250/scs.c` の参照コメントと、0xFD＝DBCS(IGC) 制御の実測メモを落とさない**

- [x] **T5**: core を新パッケージへ向ける（内部）（依存: T3, T4）
  - `packages/core/package.json` に `dependencies`（`@as400web/ebcdic` / `@as400web/scs`、いずれも `"0.1.0"`）
  - `packages/core/tsconfig.json` に両者への `references`
  - core 内部 **22 ファイル**の codec import を `@as400web/ebcdic` に付け替える
    （`hostserver/` 15・`protocol/` 3・`screen/` 1・`session/` 2・`telnet/` 1）
  - `session/printer-session.ts` と `hostserver/spool/netprint-connection.ts` の
    scs import を `@as400web/scs` に付け替える

- [x] **T6**: core の互換面を作る（依存: T5）→ **完了時点で `npm run build` が通ること**
  - `packages/core/src/codec/codec.ts` を**再作成**（`@as400web/ebcdic` からの明示 re-export のみ。
    `export *` は使わない。spec D4）。これで `exports["./codec"]` のマッピングを変えずに済む
  - `packages/core/src/index.ts` の 4 箇所を差し替え
    （codec / `table-types` / `pure-dbcs` / `ccsid-text` → `@as400web/ebcdic`、scs → `@as400web/scs`）
  - `packages/core/src/browser.ts` の catalog を `@as400web/ebcdic/catalog` から re-export
    （**`.` ではない**——表を引き込まないため。R3）
  - `npm run build` で緑を確認する

## 追従と検証資産

- [x] **T7**: テストを移設する（依存: T6）
  - `git mv` で `codec` / `dbcs-codec` / `pure-dbcs` / `ccsid-text` の 4 テスト → `packages/ebcdic/test/`
  - `git mv` で `scs` テスト → `packages/scs/test/`
  - import を各パッケージの `../src/...` に合わせる
  - `dbcs-session.test.ts` は **core に残す**（session のトレース再生テストであって codec のテストではない）
  - 3 パッケージそれぞれで vitest を実行し、**合計が baseline 871 を下回らない**ことを確認

- [x] **T8**: eslint の Node 非依存ガードを新パッケージへ広げる（依存: T6）
  - `files: ["packages/core/src/**"]` に `packages/ebcdic/src/**` と `packages/scs/src/**` を追加
    （`no-restricted-imports` の `node:*` と `no-restricted-globals` の `Buffer`/`process`/… が対象）
  - `ignores` の `packages/core/src/codec/tables/**` を `packages/ebcdic/src/tables/**` に付け替える
  - **違反コードを一時的に書いて lint が実際に落ちることを確認**してから消す
    （`20260719-core-debt-payoff` と同じ検証手順。ルールを足しただけで効いていない事態を防ぐ）

- [x] **T9**: `tools/gen-tables` の出力先を付け替える（依存: T6）
  - `tools/gen-tables/src/main.ts:11` の `outDir` を `packages/ebcdic/src/tables` に
  - `npm run gen:tables` を実行し、**`git diff --exit-code` が差分なし**であることを確認（R5）

- [x] **T10**: 互換テストを追加する（依存: T7）
  - `packages/core/test/codec-reexport.test.ts`（`errors-compat.test.ts` の先例に倣う）
  - `@as400web/core`（root）から `codecForCcsid` / `SbcsCodec` / `DbcsCodec` / `katakanaChar` /
    `SO` / `SI` / `PureDbcsCodec` / `decodeCcsidText` / `ScsDecoder` が取得でき、動作すること
  - `@as400web/core/codec` から `codecForCcsid` が取得でき、`codecForCcsid(37).decode(...)` が
    期待どおりの文字列を返すこと（`server/src/host-dtaq.ts` の利用形と同じ）
  - `@as400web/core/browser` から `TEXT_CCSIDS` / `ccsidLabel` が取得できること

- [x] **T11**: `./catalog` が表を引き込まないことを検査する（依存: T7）
  - `packages/ebcdic/test/` に、`catalog` の入口から到達可能なモジュールに `tables/` が
    含まれないことを確認するテストを置く（R3。ビルドもテストも通ってしまう種類の回帰なので、
    専用の検査が要る）

## 受け入れ基準の一次確認

- [x] **T12**: リポジトリ全体で通しを確認する（依存: T8, T9, T10, T11）
  - `npm run build`（`tsc -b`）
  - `npm test`（`--workspaces`）
  - `npm run lint`
  - `npm run build -w @as400web/web-ui`（`vue-tsc -b && vite build`。R8・AGENTS.md 規約）
  - `git diff --stat -- packages/server/src packages/web-ui/src` が**空**であること
    （後方互換の機械的な証明）
  - web-ui の `dist/assets/index-*.js` が **baseline 1,407,469 バイトから増えていない**こと
    （R3。`ScreenGrid.vue` が `@as400web/core/codec` から `katakanaChar` を引くため、
    現状すでに ibm-930/939 の表がバンドルに入っている。**減らすのは backlog の別項目**で、
    ここでは悪化させないことだけを確認する。`decisions.md` D1）
