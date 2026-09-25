# 決定記録

## D1: `packages/server`への最小限の変更（design.mdの「変更なし」からの逸脱）

- **背景**: 親work（`20260924-vscode-extension`）の`design.md`「対象範囲」は
  `packages/server`を「変更なし」としていた。test工程で、ビルド済みサーバーへ実際に
  `curl`した際（`.aidev/works/20260924-vscode-extension/01-embed-ui`のtest工程・
  AGENTS.md「実機で確定できることは、必ず実機で確定する」に沿った検証）、
  `/embed.html?app=emulator`へのリクエストが`embed.html`ではなく`index.html`の中身を
  返すことが判明した。原因は`packages/server/src/app.ts`のSPAフォールバック
  （`app.get("*", serveStatic({path:"index.html", root}))`）——`favicon.ico`等と
  同じ理由（dist直下の固定名ファイルは`/assets/*`の対象外で、個別配信を書き漏らすと
  フォールバックに吸われる）で`embed.html`も吸われていた。同じ欠陥の既存の回帰テスト
  （`test/web-static-icons.test.ts`の「favicon.svg の中身が index.html にすり替わらない」）
  が既にこの種のバグへの警戒として存在していたが、`embed.html`の追加時に同じ対応を
  取っていなかった。
- **決定**: `packages/server/src/app.ts`に`app.use("/embed.html", serveStatic({root}))`を
  1行追加し、既存の`web-static-icons.test.ts`と同じパターンで回帰テストを追加した。
  修正無しでテストが落ちることを確認してから（mutation確認）修正を適用した。
- **理由・代替案**: 代替案は「拡張機能側（`vscode-extension`）で`embed.html`の中身を
  自前配信する」ことだったが、既存サーバーの静的配信の仕組み（`--web-root`）を
  そのまま使う設計（design.md「対象範囲」の前提）を崩すことになり、02-extension-core側の
  実装が複雑化する。1行の追加で直る既存の欠陥を放置してまで守る理由が無いため、
  最小限の`packages/server`変更を選んだ。
- **影響**: design.mdの「対象範囲」の記述（`packages/server`変更なし）は不正確だったと
  訂正する。実際には「新規ルート追加はしない・既存のCLI引数もそのまま使う」という
  意図であり、静的配信の書き漏らしという既存の欠陥クラスの修正はこの意図に反しない。
  親work統合時、design.mdの当該記述を修正する（取り消し線で残す）。
