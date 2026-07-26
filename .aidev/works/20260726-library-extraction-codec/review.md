# レビュー記録

## ラウンド 1（2026-07-26T23:24:07Z）

差分 48 ファイル（テーブル 5 表・`package-lock.json`・`.aidev` を除く）。
要件適合・正確性・規約適合（AGENTS.md）・保守性の 4 観点で点検した。

### 要件適合・正確性

受け入れ基準 11 項目は test 工程で検証済み。加えてレビューで次を確認した（いずれも問題なし）。

- `git diff -M main` の rename 検出で、移設 10 ファイルが**変更行 0**。
  `ebcdic/src/codec.ts` は core 側に同名ファサードが残るため rename 対から外れるので個別に照合し、
  main の `core/src/codec/codec.ts` と**バイト一致**を確認した
- 原典参照コメントの生存を機械確認（tn5250 `lib5250/scs.c` / `0xFD は DBCS` /
  `ACS / jt400` / `ICU (unicode-org/icu-data)` / `Unicode License` / `research F4`）
- `decisions.md D2` 形式の参照は既存の慣習（`telnet.ts:25` の `decisions.md D3` 等）に一致
- `codec-reexport.test.ts` の `not.toMatch(/from "@as400web\/ebcdic"/)` は
  `@as400web/ebcdic/codec` を誤検出しない（`ebcdic` の直後が `/` で閉じ引用符ではない）
- `tools/hostserver-check` は codec / scs を参照しない＝付け替え漏れなし
- web-ui は `@as400web/ebcdic` を直接 import しないので、`package.json` への依存追加は不要
  （core が正しく宣言しており、解決は workspace のホイストで通る）

### 指摘

- [should] `packages/scs/tsconfig.json` — **`types: ["node"]` が不要**。
  `scs.ts` は `Uint8Array` / `String.fromCodePoint` しか使わず Node の型を要さない
  （実測: この設定を外しても `tsc -b` は成功する）。
  問題は「余分」であることより**根拠と実際がずれている**こと——`ebcdic/tsconfig.json` には
  「`TextDecoder` / `TextEncoder` の型のためだけに要る」と理由を書いたのに、
  その理由が当てはまらない scs に同じ設定がコピーされている。
  Node API を書ける余地を理由なく残すのは、この 2 パッケージの売り（依存ゼロ・ブラウザで動く）に対して
  弱い方に倒す判断になる。/ 対応: 差し戻し

- [should] `packages/ebcdic/test/catalog-no-tables.test.ts` — **到達可能性の検査に取りこぼしがある**。
  `RELATIVE_IMPORT = /from\s+"(\.[^"]*)"/g` は `from "..."` の形しか拾わないので、
  束縛なしの副作用 import（`import "./tables/ibm1399.js";`）と動的 import（`await import("./codec.js")`）を
  見逃す。JSDoc は「**src の import グラフを実際にたどる**」と宣言しており、
  拾えない形があると**ガードが黙って素通しする**——このテストの価値は
  「壊れたら必ず落ちる」ことだけなので、宣言と実装を一致させる。
  なお `import type ... from` を数えてしまう側の過剰計上は、安全側（表を見逃さない方向）なので許容する。
  / 対応: 差し戻し

- [nit] `eslint.config.js` — `no-restricted-imports` / `no-restricted-globals` の**メッセージ文言が
  「core のピュアロジック層では…」のまま**。ルールの適用範囲を
  `packages/ebcdic/src/**` / `packages/scs/src/**` へ広げたので、
  ebcdic や scs で違反したときに "core" と言われて出所が分からない。
  / 対応: 差し戻し（should と同じラウンドで直せるため）

## ラウンド 2（2026-07-26T23:26:42Z）

ラウンド 1 の指摘 3 件の対応を確認した。

### 対応の確認

- [should] `packages/scs/tsconfig.json` の `types` → **`types: []` に変更**。
  実際に Node API を書いたプローブで `TS2591: Cannot find name 'node:fs' / 'Buffer'` が出ることを確認した。
  eslint より**手前の型検査**で弾けるようになった（多層防御）／ **修正済**
- [should] `catalog-no-tables.test.ts` の正規表現 → `from "…"` に加えて
  **束縛なしの副作用 import と動的 import** を拾う形に変更。
  `import "./tables/ibm1399.js";` と `await import("./codec.js")` を実際に仕込み、
  どちらでもテストが落ちること・戻せば通ることを確認した／ **修正済**
- [nit] eslint のメッセージ文言 → 「ピュアロジック層（core/ebcdic/scs）では…」に統一／ **修正済**

### ラウンド 2 の指摘

- [nit] `eslint.config.js` のブロックコメントが、ラウンド 1 の修正で**自分自身が古くなっていた**
  （「両パッケージには `types: ["node"]` が入っており」と書いてあるが、scs は `types: []` になった）。
  規約（AGENTS.md「コメントは why を書く」）に照らすと、誤った根拠が残るのが一番まずい。
  ebcdic だけが型の防壁を持てない理由と、scs は型でも弾ける旨に書き直した／ **本ラウンドで修正済**

### 再検証

修正後に受け入れ基準を通し直し、すべて維持されていることを確認した。

- `npm run build`（クリーンから）／ `npx eslint packages tools`：成功
- `npm test`：2,362 passed / 4 failed（`zip-writer.test.ts` の環境要因のみ。`main` でも同一）
- web-ui：`vue-tsc` 込みでビルド成功、バンドルは `index-CG8HnPjB.js` / 1,407,469 バイトで**ハッシュまで一致**
- `npm run gen:tables`：差分なし
- `packages/server/src`・`packages/web-ui/src`：差分ゼロ

**判定: must 0 / should 0 / nit 1（本ラウンドで修正済）。review 通過。**
