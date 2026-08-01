# レビュー記録

## ラウンド 1（2026-08-01T04:20:22Z）

差分 9 ファイル（+675 / −30）。サーバー 1・API 層 1・composable 1・画面 1・テスト 5。

競合対策は「4 か所の門番のうち 1 つでも漏れると症状が残る」形なので、
**`show()` の制御フローを分岐ごとに追う**ことをレビューの中心に置いた。

### 指摘

- **[must]** `packages/web-ui/src/composables/usePreview.ts:157-186` —
  **`loading` が `true` のまま戻らなくなる経路がある。**

  `binary` の早期 return（`:160-166`）と `tooLarge` の早期 return（`:169-186`）は
  `loading` に触れずに抜ける。従来はそれで問題なかった——先行する要求の `finally` が
  無条件に `loading = false` を実行していたため。今回そこに門番を入れた（`:238-241`）ので、
  次の順序で**ローディングが二度と消えない**:

  ```
  show(A.txt)  → loading = true、応答待ち（token 1）
  show(B.bin)  → token 2。binary 分岐で return（loading は true のまま）
  A の応答到着 → isStale() が真 → finally が loading を落とさない
  → loading は true に張り付く
  ```

  `tooLarge` でも同じ（大きいファイルを選んだ瞬間に固まる）。
  **この変更が作り込んだ退行**で、門番を入れる前には存在しなかった。

  現状 `IfsPane` はこの `loading` を描画に使っていない（`useDelayedLoading` の `busy` を見ている）
  ので**今すぐ画面が壊れるわけではない**が、`loading` は composable が返す公開 API で、
  次に使う人が踏む。早期 return も「その時点で最新の要求の終着点」なので落とすのが正しい。
  ／ 対応: 差し戻し

- **[should]** `packages/server/src/host-ifs.ts:840` — **既定値が 2 箇所になっている。**

  `deps.zipMaxDirectories ?? DEFAULT_MAX_DIRECTORIES` が `resolveIfsLimits`（`:305`）と
  `TOO_MANY_DIRECTORIES` の応答（`:840`）に重複している。

  `resolveIfsLimits` の JSDoc は
  **「既定値をここで書き直さない——`?? 5000` のような式を足すと既定が 2 箇所になり、
  片方だけ変えたときに『UI が言う上限』と『実際に弾かれる上限』がずれる」**
  と書いている。**同じ変更の中でその規律を破っている。**

  しかも今回は「UI が言う上限（`/limits`）」と「弾かれたときに返す上限（413 の本文）」という、
  まさに food-poisoning を起こす 2 者。`resolveIfsLimits(deps)` を使えば 1 箇所に戻る
  ／ 対応: 差し戻し

- **[nit]** `ifsApi.ts:99-100` の `TOO_MANY` は `${b.entries ?? "?"}` / `${b.max ?? "?"}` で、
  今回導入した `limitOf`（欠けたら断片ごと省く）と方針が不揃い。
  ただし**既存コードで、サーバーは必ず両方を送る**ので実害は無い。
  今回の変更で触っていない行を書き換えると差分が膨らむ／ 対応: 許容

- **[nit]** `packages/web-ui/test/ifs-pane.test.ts` の 27 個のモックに同じ 2 行を挿入した。
  重複だが、各テストが `globalThis.fetch` を丸ごと差し替える既存様式なので、
  共通化するにはテストの書き方自体を変えることになる。**今回のスコープではない**／ 対応: 許容

### 確認して**問題なかった**もの

| 論点 | 確認内容 | 結果 |
|---|---|---|
| `reload` のトークン先読み（`latest + 1`） | `show` が同期的に `++latest` するので値が一致する。間に別の呼び出しは入らない（単一スレッド） | ✅ |
| `reload` で `tooLarge` が誤発火しないか | 渡すのは `current.bytes`＝一度読めた実測値なので上限以下 | ✅ |
| 早期 return 分岐の `isStale()` 判定漏れ | `binary` / `tooLarge` は `await` を挟まないので常に `token === latest` | ✅ |
| blob の解放漏れ | `createObjectURL` が `isStale()` の**後**。捨てる側は URL を作らない＝解放対象が存在しない | ✅（テストで created 数を固定） |
| `PreviewState.maxBytes` と `IfsError.maxBytes` の混同 | 別の型・別の経路。名前が同じだけ | ✅ |
| `/limits` の認可 | `app.ts:99` の `app.use("*", createAuthMiddleware(...))` が全ルートに掛かる | ✅ |
| `/limits` が接続を張らないこと | `withIfs` を通らない。テストで `example.invalid` でも 200 を確認 | ✅ |
| `body` computed で空の編集欄・`src=""` が出ないこと | `tooLarge` のとき `body` が `undefined` になり、textarea / iframe / img すべて描画されない | ✅ |
| 先回りの境界 | 同値は読む（サーバーも `>`）。`sizeHint` / `limits` が未知なら読む | ✅（テスト 4 本） |
| `/limits` 失敗時 | `IfsPane` が握って続行。エラー表示なし。先回りが効かないだけ | ✅ |

### 規約適合

- **UI 規約（`AGENTS.md`）**: 追加した表示は既存の `.note` クラスに乗せた。生色なし・新しい
  スクロール領域なし ✅
- **エラー文言は `messageFor` に集約**: コンポーネント側で組み立てていない。
  `IfsPane` の `mbOf` は `tooLarge`（サーバー由来のエラーではない状態）専用 ✅
- **プレビュー失敗で操作を消さない**: `tooLarge` / `binaryContent` は `error` ではなく `state` に
  入れたので、ダウンロード・削除・リネームは引き続き使える ✅
- **`packages/core` に触れていない** ✅

**判定: must 1 / should 1 / nit 2 → coding へ差し戻し。**

---

## ラウンド 2（2026-08-01T04:26:00Z）

ラウンド 1 の must 1 / should 1 の対応を確認した。

### 対応の確認

- **[must]** `loading` の張り付き → **修正済**。`binary` / `tooLarge` の早期 return で
  `loading.value = false` を落とすようにした。
  **回帰テストを 2 本追加**（「binary を選んでもローディングが残らない」
  「tooLarge でもローディングが残らない」）——どちらも
  「先行する遅い要求がある状態で早期 return の分岐に入る」という、
  ラウンド 1 で指摘した順序をそのまま再現している
- **[should]** 既定値の二重化 → **修正済**。`TOO_MANY_DIRECTORIES` の応答が
  `resolveIfsLimits(deps).zipMaxDirectories` を使うようにし、`?? DEFAULT_MAX_DIRECTORIES` の
  重複を消した。`DEFAULT_MAX_DIRECTORIES` の直接参照は `resolveIfsLimits` の 1 箇所だけになった
- **[nit]** `TOO_MANY` の `?? "?"` → 既存コードのため**維持**（許容）
- **[nit]** テストモックへの同一 2 行の挿入 → 既存様式のため**維持**（許容）

### 再検証

- `npm test`: **3,243 passed / 4 failed**（`zip-writer` の環境要因のみ。テストは +2 本）
- `npx eslint packages tools`: クリーン
- `npm run build -w @as400web/web-ui`: 成功。**359,954 バイト**（基準線 358,354 から +1,600）
- `grep -c 'DEFAULT_MAX_DIRECTORIES' packages/server/src/host-ifs.ts` が
  import 1 ＋ 使用 1 の **2 件**（修正前は 3 件）

**判定: must 0 / should 0 / nit 2（いずれも許容）。review 通過。**
