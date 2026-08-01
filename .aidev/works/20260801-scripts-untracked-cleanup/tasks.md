# タスク: 未追跡の実機診断スクリプト 29 本を追跡下に入れる

- [x] T1: ホスト指定を `process.env.AS400_HOST` へ寄せる（既定値なし・未設定なら `exit(1)`）。
      `check-html-determinism.mjs:22` / `probe-ccsid.mjs:29` / `shot-testlib-screens.mjs:21` /
      `shot-signedon.mjs:41,84` / `shot-signon.mjs:27,48`。
      **84 / 48 行は出力メタの文字列**——直し忘れると成果物に社内 IP が焼かれる
- [x] T2: 未使用変数 6 件を解消する。1 行のヘルパー 5 件（`has` × 4・`constant`）は**削除**、
      `shot-fkey.mjs:42` の `probe`（44 行）は **`_probe` に改名して残す**＋理由コメント（spec D2）
- [x] T3: `scripts/README.md` に 29 本の族の節を追記する（`shot-*` 15 / `build-*` 3 /
      `probe-*` 3 / `check-*` 3 / `diff-*` 2 / 単発 3。既存「その他」節と同じ族でまとめる書き方。spec D3）
- [x] T4: 静的検査——`node --check` を 29 本に回す / `npx eslint scripts/` エラー 0 /
      `git grep "172\.21\.10\.51" -- scripts/` が 0 件（依存: T1,T2）
- [x] T5: `npm run lint`（**リポジトリ全体でエラー 0**）/ `npm run build` / `npm test`（依存: T1〜T4）
