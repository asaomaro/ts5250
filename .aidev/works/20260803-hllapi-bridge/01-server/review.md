# レビュー記録: 01-server

## ラウンド 1（2026-08-03）

差分: `hllapi-types.ts` / `hllapi-ps.ts` / `hllapi-keys.ts` / `hllapi.ts` / `hllapi-routes.ts` の追加、
`app.ts` に登録 1 行、テスト 3 本（69 件）。

### 指摘

- **[must]** `hllapi.ts` `writeIntoField` — **読み取り専用のセッションへ HLLAPI から書き込めた。**
  `user` を引数に受けながら使っておらず（lint が「未使用」で拾った）、
  `assertWritable` を通していなかった。画面や MCP で塞いでいる境界を**横から破る**形。
  **対応: 修正済み。** `deps.sessions.assertWritable(entry.id, user)` を先に通し、
  失敗なら `rc=5`。MCP の `send_key` が欄を書くときと同じ扱いにした。回帰テストを追加。

- **[should]** `Send Key` で写せないニーモニックが混ざったとき、**一部だけ送らない**ようにした。
  当初は先頭から順に処理して途中で止める形だったが、それだと画面が半端な状態で残り、
  呼び出し側からは「どこまで進んだか」が分からない。
  **対応: 解析の結果に 1 つでも `unsupported` があれば、何も送らずに `rc=20`。**

- **[nit]** `Start Host Notification` の機能番号を `HF` に**入れなかった**。
  一次資料の目次が `32` と書いているが `Find Field Length` と衝突しており、正しい値を
  確かめられていない（research F2）。**推測で置くより空けておくほうが安全**——
  対象外の機能なので実害は無く、実装するときに一次資料へ戻れる。**現状維持**。

- **[nit]** `moveCursor` の `eraseEof` / `delete` / `backspace` / `newline` / `reset` は
  **位置を動かさないだけ**で、画面の書き換えを伴わない。
  `Send Key` で送っても「何も起きない」ように見える。
  **対応: `02-bridge` の `docs/HLLAPI.md` に明記する**（黙って未対応にしない）。

### 規約の確認

| 観点 | 結果 |
|---|---|
| **ロジックが TypeScript にある** | 機能番号・PS 走査・`rc` の決定はすべてここ。Rust 側には何も置かない設計 |
| 純関数を分けた | `hllapi-ps.ts` / `hllapi-keys.ts` はセッションに触らない。実機なしでテストできる |
| **未実装が黙って成功しない** | 分岐の既定が `rc=10`。テストで固定 |
| **秘密を出さない** | `hllapi-routes.ts` のログは `function` と `rc` だけ。`data` の中身を出さない |
| ログは stderr のみ | `childLog` 経由。`console.*` なし |
| 一次資料に基づく | 機能番号・戻り値・ニーモニックの出所を各ファイルの冒頭に明記 |
| 既存の非退行 | 登録 1 行のみ。3,832 件緑 |
| 上限を設けた | `data` は 8,192 文字まで、Wait / Pause は 30 秒まで（**無限に待たない**） |

### 判定

**must 1 件・should 1 件を修正**、nit 2 件は理由を添えて現状維持／後段送り。**通過**。
