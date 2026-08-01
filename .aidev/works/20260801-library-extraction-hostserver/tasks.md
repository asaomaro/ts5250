# タスク

`plan.md` の 3 段（base → hostserver → ガード／検証）に対応する。

## 第1段: `@as400web/base` の切り出し

- [x] **T1** `packages/base/` の骨組みを作る
  - `package.json`（`@as400web/base` / `type: module` / `exports` は `.` のみ / `files: ["dist"]` /
    `build: tsc -b` / `test: vitest run --passWithNoTests` / **`dependencies` なし**）
  - `tsconfig.json`（`extends: ../../tsconfig.base.json` / `composite` / `rootDir: src` /
    `outDir: dist` / **`types: []`**＝Node API を型検査の段階で塞ぐ）
  - `vitest.config.ts`（`include: ["test/**/*.test.ts"]`）
  - root `tsconfig.json` の `references` の**先頭**に `packages/base` を追加
- [x] **T2** `errors.ts` / `log.ts` / `identifier.ts` を `git mv` で `packages/base/src/` へ移す
  - `packages/base/src/index.ts` を作り、3 モジュールを**列挙で** re-export（`export *` は使わない）
  - `identifier.ts` 内の `./errors.js` 参照は相対のまま（同一パッケージ内）
- [x] **T3** `packages/core` 側の参照を `@as400web/base` へ付け替える
  - 対象: `index.ts` / `browser.ts` / `transport/`(2) / `protocol/`(3) / `screen/`(2) /
    `session/`(2) / `csv-parse.ts` / `identifier` 利用箇所
  - `hostserver/` 配下 34 ファイルの `../errors.js` `../../errors.js` `../log.js` `../../log.js`
    `../../identifier.js` も同時に付け替える（この時点ではまだ core 内）
  - `packages/core/package.json` の `dependencies` に `@as400web/base` を追加
  - `packages/core/tsconfig.json` の `references` に `../base` を追加
  - `packages/core/test/` の `../src/errors.js` 参照も付け替える
- [x] **T4** 第1段の検証
  - `npm run build` が緑
  - `npm test` がベースライン（265 files / 3,248 tests・既知の 4 失敗のみ）と一致

## 第2段: `@as400web/hostserver` の切り出し

- [x] **T5** `packages/hostserver/` の骨組みを作る
  - `package.json`（`@as400web/hostserver` / `exports` は `.` のみ /
    `dependencies`: `@as400web/base` `@as400web/ebcdic` `@as400web/scs` の 3 つだけ）
  - `tsconfig.json`（`types: ["node"]`＝`node:net`/`node:tls` を使うため。
    `references`: `../base` `../ebcdic` `../scs`）
  - `vitest.config.ts`
  - root `tsconfig.json` の `references` に `packages/hostserver` を **`core` より前**に追加
- [x] **T6** ソースを `git mv` で移す
  - `packages/core/src/hostserver/**`（46 ファイル）→ `packages/hostserver/src/**`（木構造を維持）
  - `packages/core/src/transport/host-connection.ts` → `packages/hostserver/src/transport/`
  - `packages/core/src/transport/ddm-transport.ts` → `packages/hostserver/src/transport/`
- [x] **T7** `packages/hostserver/src/index.ts` を書く
  - `packages/core/src/index.ts` の hostserver 由来 35 行を土台に、**列挙で** export する
  - `browser.ts` が型で使う `UploadRejection` / `IfsEntry` / `IfsListResult` / dtaq 型群も含める
- [x] **T8** `packages/hostserver/src` 内の import を直す
  - `../../transport/host-connection.js` → 新しい相対位置へ
  - 移動で階層が変わった相対パスを解消（`tsc -b` の型エラーが 0 になるまで）
- [x] **T9** `packages/core` の re-export を新パッケージ向けに書き換える
  - `src/index.ts`: hostserver 由来 35 行の参照先を `@as400web/hostserver` へ。**列挙の中身は変えない**
  - `src/browser.ts`: hostserver 由来 3 箇所を `@as400web/hostserver` へ。**`export type` を維持**
  - `packages/core/package.json` の `dependencies` に `@as400web/hostserver` を追加
  - `packages/core/tsconfig.json` の `references` に `../hostserver` を追加
  - `packages/core/src/hostserver` と移動した `transport/` 2 ファイルが**残っていない**ことを確認
- [x] **T10** テスト 43 本を移す
  - `packages/core/test/` の該当 43 本を `git mv` で `packages/hostserver/test/` へ
  - import 付け替え: `../src/errors.js` → `@as400web/base`（22 箇所）/
    `../src/codec/codec.js` → `@as400web/ebcdic/codec`（3 箇所）/
    `../src/hostserver/X.js` → `../src/X.js`
  - **`errors-compat.test.ts` は core に残す**（core の re-export 面の番人。T11 で拡張する）
  - `npm run build` と `npm test` が緑・件数がベースラインと一致

## 第3段: ガードと全体検証

- [x] **T10.5** `eslint.config.js` のピュアロジック層ガードを新レイアウトへ追随させる
  - 現状 `files: ["packages/core/src/**", …]` / `ignores: ["packages/core/src/transport/**",
    "packages/core/src/log.ts"]` で `node:*` import と `Buffer`/`process` 等を禁止している。
    **hostserver/** はこの glob の下にあり、既に禁止が効いていた**（実測: hostserver 配下に
    `node:*` の import は 0 件。I/O は `transport/` に隔離されている）
  - 移動するとこの glob から外れ、**ガードが静かに消える**——設定ファイル自身の
    コメントが警告している失敗様式そのもの
  - `files` に `packages/base/src/**` と `packages/hostserver/src/**` を追加し、
    `ignores` を `packages/core/src/transport/**` と `packages/hostserver/src/transport/**` にする
  - `packages/core/src/log.ts` の除外は**移動により消える**（base の `log.ts` は Node API を
    使わないので除外不要。除外を残すと存在しないパスが設定に残る）
- [x] **T11** 不変条件をテストで固定する（4 本）
  - `packages/hostserver/test/no-core-dependency.test.ts` — `src` 全体を**走査**して
    `@as400web/core` および `protocol`/`screen`/`session`/`telnet`/`trace` への参照が 0 件
    （列挙にすると新しいファイルが素通りする）
  - `packages/core/test/hostserver-reexport.test.ts` — `@as400web/core` の hostserver 由来 export が
    **実行時に到達可能**（列挙漏れの検出）
  - `packages/core/test/errors-compat.test.ts`（既存を拡張）— `SqlError`（hostserver）が
    `As400Error`（base）の `instanceof` を通る＝**パッケージ跨ぎの単一インスタンス**の実証
  - `packages/core/test/log-sink-single-instance.test.ts` — `setLogSink` が
    hostserver 側の `childLog` にも効く（D-A の根拠を実行時に固定）
  - **各テストがわざと壊したときに落ちることを確認**してから戻す（効いていないテストを足さない）
- [x] **T12** 全体検証
  - `npm run build` / `npm test` / `npm run lint` が緑
  - web-ui 本番バンドル JS が **359,853 バイト以下**
  - `grep -c 'node:net\|node:tls' packages/web-ui/dist/assets/index-*.js` が 0
  - `git diff --stat -- packages/server/src packages/web-ui tools/hostserver-check` が**空**
  - `tools/hostserver-check` がビルドできる
