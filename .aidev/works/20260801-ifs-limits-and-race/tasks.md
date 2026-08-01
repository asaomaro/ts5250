# タスク: IFS の上限表示・プレビュー競合対策・先回り判定

- [x] T1: `packages/server/src/host-ifs.ts` の `TOO_MANY_DIRECTORIES` 応答（`:792-803`）に
      `maxDirectories` を足す。既定は `DEFAULT_MAX_DIRECTORIES` へ委譲（自前で `?? 5000` と書かない）
- [x] T2: `resolveIfsLimits(deps)` と `GET /api/host/ifs/limits` を追加。
      `readMaxBytes` / `zipMaxBytes` / `zipMaxFiles` / `zipMaxDirectories` /
      `deleteMaxEntries` / `deleteMaxDirectories` の 6 値。**`withIfs` を通さない**（接続不要）
- [x] T3: `packages/web-ui/src/ifsApi.ts` — `IfsError` に `maxDirectories`、
      `messageFor` が上限値を出す（spec D7。`TOO_LARGE` は複数系/単数系を `files` の有無で分ける。
      上限が欠けていたら上限部分を落とす）、`fetchLimits()` を追加（依存: T1・T2）
- [x] T4: `packages/web-ui/src/composables/usePreview.ts` — 世代トークンと**門番 4 か所**
      （テキスト代入 / blob 代入 / `catch` の error / `finally` の loading）。
      `createObjectURL` は `isStale()` の**後**に呼ぶ。`reload` の巻き戻しも守る（spec D3）
- [x] T5: `usePreview` にサイズ先回り。`sizeHint !== undefined && max !== undefined && sizeHint > max`
      のときだけ読まずに `tooLarge` を立てる。**`kind` は保つ**（依存: T3・T4）
- [x] T6: `usePreview` にヌルバイト判定。復号後の文字列に `U+0000` があれば `binaryContent: true`。
      `content: null` のときは判定しない（依存: T4）
- [x] T7: `packages/web-ui/src/components/IfsPane.vue` — `/limits` を引いて `usePreview` に渡す
      （失敗は握って先回り無しで続行・エラー表示なし）。`tooLarge` / `binaryContent` の案内を出す。
      配色は CSS 変数経由（依存: T5・T6）
- [x] T8: テスト（依存: T1〜T7）
      — 競合 5 本（門番 4 か所＋`reload` 巻き戻し）／先回り 4 本（超過・同値・sizeHint 無し・limits 無し）／
      ヌルバイト 3 本／上限文言 4 本（zip・read・dirs・欠損）／サーバー 4 本（`/limits` 200・接続不要・
      CLI 上書き・`maxDirectories`）
- [x] T9: 全体検証（依存: T8）
      — `npm test` ／ `npx eslint packages tools` ／ `npm run build -w @as400web/web-ui` ／
      バンドルサイズが基準線 358,354 バイトから大きく増えていないこと
