# タスク: CSV を IBM i の物理ファイルへ取り込む

各タスクは「1 タスク = 1 つの検証可能な変更」。単体テストは各タスクに含める
（別タスクに切り出さない＝テストのない状態を正常と見なさないため）。

## core — 型と符号化

- [x] T1: `ColumnLayoutInput` と `FieldLayout` に `ccsid?: number` を追加し、
      `length` のコメントを「CHAR は**バイト数**（research F8）」に訂正する
- [x] T2: `buildRecordLayout` が `ccsid` を `FieldLayout` へ運ぶ（依存: T1）。
      単体テスト: 混在 CCSID の列で `size` が `LENGTH` どおりのバイト数になること
- [x] T3: `buildDdmRecord` がフィールドごとに `codecForCcsid(field.ccsid)` で符号化する（依存: T2）。
      CCSID 37 の直書きを除去。単体テスト: 273 と 5035 の列が別々に符号化されること

## core — 事前検査（本作業のロジックの中心）

- [x] T4: `upload-prepare.ts` を新規作成（依存: T3）。`UploadRejection` 判別可能ユニオンと
      `prepareUpload()` を実装。**全行を符号化してから返す**（DD2）。
      単体テスト: 列不足/余剰・対応外の型・未対応 CCSID・65535・長さ超過・表現できない文字・
      数値でない値・**複数拒否がまとめて返ること**・`row` が 1 始まりであること・件数上限で打ち切ること

## core — 列メタデータ

- [x] T5: `column-meta.ts` を新規作成（依存: T2）。`CCSID` を選択列に加え、
      `ORDER BY ORDINAL_POSITION` を維持し、**ライブラリ名・表名を文字列連結しない**
      （`^[A-Z0-9_$#@]{1,10}$` で検証）。
      `tools/hostserver-check/src/ddm.ts` の重複クエリを**これに置き換える**

## core — バッチ書き込み

- [x] T6: `open()` に `blockingFactor?: number`（既定 100）を追加し UFCB に載せる（依存: T3）。
      S38OPNFB 受領後に `effectiveBatchSize = max(1, min(要求, 32767, floor(65525/recordIncrement)))`
      を計算して `DdmFile` に持たせる。単体テスト: 丸めの境界値
- [x] T7: `writeAll()` を新規追加（依存: T6）。`buildS38Buf(records)` を括り出し、
      `write()` はそれへの薄い委譲にする（DD3）。`WriteAllResult`（`committedRows` /
      `uncertainRange`）を返す。単体テスト: バッチ分割数・境界・`uncertainRange` の算出
- [x] **T8: 実機確認（ゲート）** — `MYLIB.TESTPF` へバッチで複数件書き、SQL で読み返して一致を確認。
      **往復回数が件数でなくバッチ数になっていること**を計測で示す（依存: T7）。
      ⚠ **ここを通るまで T11 以降に進まない**。崩れたら spec へ差し戻す

## core — CSV 解析

- [x] T9: `csv-parse.ts` を新規作成（依存: なし。T1〜T8 と並行可）。RFC 4180 準拠。
      単体テスト: 引用符・埋め込み改行・二重引用符・BOM・CRLF/LF・末尾改行・空行・
      ヘッダーのみ・列数不一致

## server

- [ ] T10: `host-api.ts` の `statusOf` で `HOST_SERVER_UNSUPPORTED` を **400** に写像（依存: なし）。
      **既存 SQL 経路のテストへの影響を先に確認**してから変更する
- [ ] T11: `host-upload.ts` に `uploadRows()` を実装（依存: T4, T5, T7, T9）。
      メタ取得 → 検査 → 接続 → 送信 → 後始末の順序のみを持つ。
      **`layout.recordLength` と S38OPNFB の照合を実行時ガードとして入れる**
- [ ] T12: `POST /api/host/upload` を追加し `app.ts` に登録（依存: T11）。
      zod は `.strict()`・`sourceSchema` 始まり。**行数上限を受理段階で検査**（DD2）。
      テスト: 認証オフ / admin / 一般ユーザーの 3 パターン、上限超過、拒否時 400
- [ ] T13: MCP ツール `host_upload_table` を追加（依存: T11）。`csv` が来たら
      **core の `parseCsv` で解析**してから `uploadRows` に渡す（入口を分けても実行経路は 1 つ）
- [ ] T14: `host-sql.ts` 冒頭の「構造的に読み取り専用」コメントを**範囲を狭めて訂正**する（依存: T12）。
      削除せず、`/api/host/upload` が書き込みを行う旨を追記して繋ぐ（DD6）

## web-ui

> **D1 で変更**: 取り込み専用の `UploadPane` をやめ、**取得 ⇄ 取り込みを持つ「データ転送」ペイン**
> （`TransferPane.vue` / `transfer:data`）にした。SQL ペインは Run SQL Scripts の位置づけで据え置く。
> core / server は影響なし（`decisions.md` D1）。

- [ ] T15: `TransferPane.vue` の骨格と**方向切替**（取得 ⇄ 取り込み）を作る（依存: T12）。
      `transfer:data` タブ ID で開く。`paneLabels.ts` とペイン振り分け（`WorkspaceNode.vue`）に登録。
      列見出し固定の規約（`docs/UI-DESIGN.md`）に従う
- [ ] T16: 取り込み側を実装（依存: T15）。design の状態遷移
      （待機 / 解析中 / 解析失敗 / プレビュー / 送信中 / 拒否 / 完了 / **部分完了**）。
      **列の突き合わせ表に CCSID を出す**・**想定往復数をステータスバーに出す**・
      **部分完了は確定範囲と不明範囲を分けて出す**（モックで合意済み）。
      コンポーネントテスト: 状態遷移、拒否理由の表示（行番号・列名が出ること）、
      部分完了が完了と別表示になること
- [ ] T17: 取得側を実装（依存: T15）。表と絞り込み条件だけを受け、既存 `POST /api/host/sql` に
      `SELECT * FROM <lib>.<file> WHERE …` を組み立てて投げ、既存 `csv.ts` で CSV 保存。
      **SQL エディタは出さない**。**識別子の検証は取り込み側と同じ関数を使う**（規則を二重化しない）。
      コンポーネントテスト: 組み立てた SQL、識別子が不正なときに送信しないこと
- [ ] T18: ファイル D&D の棲み分け（依存: T16）。`WorkspaceNode.vue` と `PaneTabs.vue` の
      各ハンドラ先頭で `dataTransfer.types` に `Files` があれば何もせず戻る（DD5）。
      コンポーネントテスト: `Files` ドラッグで分割・タブ移動が発火しないこと（回帰資産化）

## 仕上げ

- [ ] T19: **実機通し確認**（依存: T18）。
      (a) `MYLIB.TESTPF` へ CSV から投入 → SQL で読み返して一致
      (b) `MYLIB.CSVUPJP` へ日本語を投入 → 読み返して一致（**基準行 ID=2 と突き合わせ**）
      (c) CCSID 273 の列に日本語を含む CSV → **1 行も書かずに**拒否されること
      (d) 100 行の性能（往復回数と実時間を記録し、1 行 1 往復との差を示す）
      (e) 取得側で表を CSV に落とし、日本語が壊れないこと
- [ ] T20: `npm run build`（`vue-tsc` 込み）・全パッケージのテスト・lint を通す。
      web-ui のテストは**パッケージ dir から実行**する（AGENTS.md）
