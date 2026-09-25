# レビュー: `.vsix`パッケージング

## ラウンド1

`aidev coverage` は gaps=0（family全体で被覆済み。04-packagingの全タスクは`AC: なし`のため、
判定は`tasks.md`「テスト方針」の3項目——test-result.mdで確認済み）。

- [should] `scripts/prepare-server.mjs`（`server-stage/`を組み立てる側）と
  `src/extension.ts`の`resolveServerPaths`（Production分岐で`server-stage/`を読む側）が、
  同じ相対レイアウト（`packages/web-ui/dist`・`node_modules/@ts5250/server/dist/main.js`）を
  2か所で独立に決め打ちしていた。共有もテストによる対応関係の固定もされておらず、
  どちらか片方だけレイアウトを変えると、もう片方が気づかず壊れる
  （`electron/main.cjs`にも同種の決め打ちが独立にあり、本PJの配布物レイアウトでは
  この2重化自体は既存の作法だが、対応関係を固定する仕組みが無かった点が指摘対象）
  — 根拠: `vscode-extension/src/extension.ts:29-33`, `vscode-extension/scripts/prepare-server.mjs:96-106`
  [conv:paired-artifact-sync!]

## ラウンド1の対応

- ESM（`prepare-server.mjs`）とコンパイル済みCommonJS（`extension.ts`）をまたぐため、
  モジュールとして1か所に共有するのは`.vscodeignore`の除外境界（`scripts/`は配布物から除外）を
  越える複雑さを招くと判断し、見送った（`decisions.md` D1）。
- 代わりに`.aidev/conventions/paired-artifact-sync.md`「3. 共有できないときは、対応関係を
  機械で固定するテストを置く」に従い、`vscode-extension/test/serverStageLayout.test.ts`を追加した
  （`protocol-sync.test.ts`と同じ「文字列の対応を固定する」手法）。mutation検証済み
  （`web-ui` → `webui`に書き換えて実際にテストが落ちることを確認してから元に戻した）。
  タスクとして`tasks.md`にT4を追加し、taskcheck済み（`aidev taskcheck report T4 --findings 0`）。

対応後、`should`の残存指摘は無し。

## ラウンド2

再点検した範囲（ラウンド1のT4追加分 + coding→test再承認後の差分）:
- `test/serverStageLayout.test.ts`が実際に両ファイルの現物を読んで比較しており、
  ハードコードされた期待値の書き写しではないことを確認（本文をそのまま貼り付けた
  二重管理ではなく、都度ファイルを読む形——書き換えれば必ず追従する）。
- 68件（66+2）全テストが green。`tsc -b` / `tsc -b tsconfig.test.json` / `eslint` いずれも0エラー。

指摘なし。
