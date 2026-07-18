# レビュー記録

## ラウンド 1（2026-07-18T13:56:50Z）

自己レビュー（主エージェントが差分を直読）。

- [must] `hostserver/signon.ts:71` — ピュア層で Node のグローバル `Buffer` を使っている。
  lint の `no-restricted-imports` は **import しか見ない**ためグローバル参照は素通りしていた。
  既存のピュア層（codec / protocol / screen）は `Buffer` を一切使っておらず、この 1 箇所だけが例外。
  D1 で「Node API を使わずブラウザでも動く形に保つ」と決めた方針にも反する。
  / 対応: 修正済（16進変換を自前のヘルパに置換）

- [must] `hostserver/signon.ts:57-61` — `traceFrame` がフレーム長を検査せずオフセット 16 を読む。
  `host-connection` は長さ 4 以上のフレームを通すため、4〜19 バイトの不正フレームが来ると
  `parseReply` の `PROTOCOL_ERROR` ではなく **`RangeError` が投げられる**（debug ログ有効時のみ）。
  トレースという副次機能が、エラーの型を壊してしまう。
  / 対応: 修正済（長さ不足なら要約のみ出して抜ける）

- [should] `hostserver/signon.ts:245-248` — `Object.assign` で `rc`/`kind`/`retryable` を後付けしている。
  「呼び出し側が文言ではなく値で分岐できる」と謳いながら、**TypeScript の型からは見えない**。
  実機テストで手動確認したが、利用側は `as any` 相当を強いられる。
  / 対応: 修正済（`SignonError` クラスを定義して公開）

- [nit] `hostserver/signon.ts:151` — 明示指定された `port` を範囲検査していない。
  ポートマッパー経由の値は検査しているのに非対称。
  / 対応: 修正済

- [nit] `hostserver/signon.ts:80-86` — 定数 (`CLIENT_CCSID` 等) が `traceFrame` の後ろに置かれ、
  ファイル冒頭の定数群と分断されている。
  / 対応: 修正済（冒頭にまとめた）

- [nit] `transport/host-connection.ts` — `setTimeout` はアイドルタイムアウトのため接続後も
  張り続ける。本作業は認証後すぐ閉じるので実害なし。長寿命接続を持つ段階（SQL）で見直す。
  / 対応: 許容（backlog の hostserver.md に含意される範囲。今回は変更しない）

must 2 件・should 1 件・nit 3 件。must/should はすべて修正した。
