# 決定記録

## D1: `server-stage/`レイアウトの対応関係は、共有モジュール化ではなくテストで固定する

- 背景: review round1で、`scripts/prepare-server.mjs`（レイアウトの組み立て側）と
  `src/extension.ts`の`resolveServerPaths`（レイアウトの読み取り側）が同じ相対パス
  （`packages/web-ui/dist`・`node_modules/@ts5250/server/dist/main.js`）を独立に決め打ちしている
  ことが判明した（`.aidev/conventions/paired-artifact-sync.md`該当。詳細は`review.md`ラウンド1）。
- 決定: 両者を1つの共有モジュールに統合するのではなく、`test/serverStageLayout.test.ts`で
  「レイアウトが食い違ったら落ちるテスト」を追加して対応関係を固定した（T4）。
- 理由 / 代替案:
  - 検討した代替案: 相対パスのセグメントをJSON等の共有データファイルへ切り出し、両側から読む。
  - 退けた理由: `prepare-server.mjs`はESMスクリプト（ビルド時のみ実行・配布物には含まれない）、
    `extension.ts`はCommonJSへコンパイルされ`.vsix`に同梱される実行時コード——モジュール形式が
    またがる。共有データファイルを`scripts/`配下に置くと`.vscodeignore`が`scripts/**`を除外して
    いるため実行時に読めず、`scripts/`の外に置くと「ビルド専用スクリプトが読むデータがビルドの
    外にある」という不自然な配置になる。さらに`electron/main.cjs`も同じ`@ts5250/server/dist/main.js`
    という決め打ちを独立に持っており（本PJの配布物レイアウトの既定の作法）、今回だけ抽象化すると
    一貫性がかえって崩れる。
  - 採用理由: `protocol-sync.test.ts`（`protocol.ts`と`embed-protocol.ts`の同期固定）で既に
    同じ課題に同じ手法（ソースを読んで文字列の対応を比較するテスト）を採っており、本PJの
    確立した作法と整合する。実際にmutationで検証済み（web-ui→webuiに書き換えてテストが
    落ちることを確認）。
- 影響: `tasks.md`にT4を追加。`review.md`ラウンド1の指摘はこの対応で解消。
