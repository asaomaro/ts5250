# レビュー: ホストサーバーの keepAlive

## タスク点検ログ
- 差分は表示・プリンター（#460〜#462）と同じ形をホストサーバーの 2 トランスポートと 6 接続クラスに写したもの。点検で見た点: 各接続クラスの受け渡しは signon と開く関数をモックして 6 種とも「指定すると届く・指定しなければ載らない」を固定（変異で検出）・
  `hostAuthFrom` の転記・解決が種別を問わない（変異で検出）・signon の短い接続は対象外。独立点検の指摘は無し（`taskcheck` は同一セッションでの確認）

## ラウンド 1
- 指摘なし（must 0 / should 0 / nit 0）。要件適合: AC1 は `hostserver/test/keepalive.test.ts`（14 件）、AC2 は `server/test/host-keepalive.test.ts`・`ws-lifetime.test.ts`。変異 8 通り検出。
  規約適合: 原則 1（ACS 同梱の `jt400` の `SocketProperties` は既定で入れない）。実機で DB・IFS の接続が通ることを確認。**副作用は README に明記**: 途中の機器が無通信の接続を落とす環境の常駐監視は `keepAlive: true` が要る（落ちたことに気づけない）
