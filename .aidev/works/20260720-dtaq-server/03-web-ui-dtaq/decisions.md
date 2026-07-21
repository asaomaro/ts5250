# 決定記録（03-web-ui-dtaq）

## D1: 一覧は `MESSAGE_DATA`(EBCDIC)＋HEX で見せる（UTF-8 列は使わない）

- 背景: `DATA_QUEUE_ENTRIES` には `MESSAGE_DATA`(CCSID273) / `MESSAGE_DATA_UTF8`(CCSID1208) /
  `MESSAGE_DATA_BINARY`(BLOB) がある。UTF-8 列が一番読みやすそうだが…
- 事実: **サーバーの SQL 結果デコーダは CCSID 1208 を扱えない**（実機で
  `INTERNAL_ERROR: unsupported CCSID 1208` を確認。対応は 37/273/930/… のみ）。
- 決定: 一覧は `CAST(MESSAGE_DATA AS VARCHAR)`（EBCDIC・best-effort）＋
  `HEX(CAST(MESSAGE_DATA_BINARY AS ... FOR BIT DATA))`（符号化非依存の真値）で返す。
  UI に「text は EBCDIC 解釈の best-effort、真値は hex か受信で確認」と注記。
- 影響: UTF-8/バイナリのエントリは一覧の text が化ける（IFS の CCSID 決定表未対応と同型の限界）。
  正確に見たいときは「受信（encoding 指定）」を使う。self-protocol の受信は生バイトを返すので化けない。

## D2: 一覧 SQL に埋める library/name は厳格に検証（インジェクション対策）

- 背景: 一覧だけは `/api/host/sql` に SQL 文字列を組んで投げる（design 判断 3）。library/name を
  文字列リテラルに埋めるので、`'` を含む名前でクエリを壊せる。
- 決定: `assertObjectName`（`/^[A-Za-z0-9$#@_.]{1,10}$/`）を **SQL を組む前に**必ず通す。
  通らなければ `fetch` せず `DtaqRequestError(400)`。送受信ルート（自前プロトコル）は
  固定長 EBCDIC フィールドなのでこの問題は無いが、UI の入力ガードとしても同じ検証を使う。

## D3: `onClear` は「取り直してから」成功メッセージを出す（E2E で踏んだ回帰）

- 背景: 一覧表示中にクリアすると、成功後に一覧を取り直す。だが `onList` は冒頭で `message` を
  リセットするので、先に「クリアしました」を立ててから `onList` を呼ぶと**メッセージが即座に消える**。
- 検出: **実ブラウザ E2E**（`p.note "クリアしました"` が出ない）。単体（mount）では最初見落とした。
- 決定: クリアと再一覧を 1 つの `run` にまとめ、**最後に** `message` を立てる。
  回帰を単体テスト（`dtaq-pane.test.ts` の「クリア」）で固定した。

## D4: E2E は web-ui の vite バンドルを明示ビルドしてから（stale bundle の罠）

- 背景: ルートの `npm run build`（`tsc -b`）は **web-ui の vite バンドルを作らない**。
  古い `dist` を配信し続け、E2E が「新パネルが無い」で失敗した（IFS の decisions と同型の罠）。
- 決定: E2E 前に `npm run build -w @as400web/web-ui`（`vue-tsc -b && vite build`）を必ず走らせる。
  system は server 設定から自動選択されるので、E2E は選択ステップ不要（機能カードが即出る）。
