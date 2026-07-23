# タスク: IFS ペインの上位移動と、削除・リネーム

## 先に単独で入るもの

- [x] T1: web-ui の一覧に **「.. 上位フォルダへ」の行**を足す（ルートでは出さない・`openPath(親)` を呼ぶ・
      クリック / Enter / Space で動く・選択状態にはしない）。テストは「ルートで出ない」「押すと親へ移動」

## core（プロトコル・接続）

- [x] T2: `errors.ts` に `NOT_EMPTY` を足し、`fileFailure` の `rc=9` をそれに写像する
- [x] T3: `buildRenameRequest`（0x000F・テンプレート 16・元 CP 0x0003 / 先 CP 0x0004・置換フラグ）と
      `buildRemoveDirRequest`（0x000E・テンプレート **10**・フラグ 2 バイト・CP 0x0001）を足す。
      **`buildDeleteRequest` のコピーにしない**。バイト位置をテストで固定する
- [x] T4: `IfsConnection` に `rename(from, to, opts?)` と `removeDirectory(path)` を足す（依存: T2, T3）

## server（列挙・HTTP）

- [x] T5: `packages/server/src/ifs-delete.ts` を新規作成。`planDelete` が対象を**深い順**に列挙し、
      symlink を `file` として含め、上限（件数・ディレクトリ数）と `incomplete` を判定する
- [x] T6: `/api/host/ifs/rename` を追加（`newName` は名前のみ。`/` を含めば 400）（依存: T4）
- [x] T7: `/api/host/ifs/delete` を種別分岐＋`recursive` 対応にする（依存: T4, T5）。
      **上限超過・辿れない場合は 1 件も消さない**。途中失敗は消せた件数と失敗パスを返す。ログに件数を残す
- [x] T8: `/api/host/ifs/delete-plan` を追加（数えるだけ。確認ダイアログ用）（依存: T5）
- [x] T9: `host-api.ts` の `statusOf` で `NOT_EMPTY` → 409（依存: T2）
- [x] T13: `--ifs-delete-max-entries` / `--ifs-delete-max-dirs` を CLI 引数に足す（既定 1,000 / 500）（依存: T7）

## web-ui

- [x] T10: `ifsApi.ts` に `deletePlan` / `deletePath` / `renamePath` を足し、`NOT_EMPTY` / `TOO_MANY` の
      文言を `messageFor` と `KNOWN_ERROR_CODES` に足す（依存: T6, T7, T8）
- [x] T11: リネーム UI（現在の名前を初期値に入力・`/` を弾く・成功したら一覧とツリーと選択を追随）（依存: T10）
- [x] T12: 削除 UI（フォルダは `delete-plan` の件数を確認ダイアログに出す・上限超過や辿れない場合の案内・
      削除後に選択とプレビューを片づける・現在地を消したら親へ移動）（依存: T10）

## 検証

- [x] T14: `tools/hostserver-check` に rename / rmdir / 再帰削除を確かめるコマンドを足す（依存: T4）
- [ ] T15: 実機（PUB400）と Web UI で往復を確認する（依存: T1, T11, T12, T14）
