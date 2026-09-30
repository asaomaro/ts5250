# レビュー: 交渉の前のテキスト

## ラウンド 1（独立の読み）
- 書き出しの照合: `nvt-text.ts` を ACS の `NVT_process_outbound` の状態機械と 1 分岐ずつ突き合わせた（LF の 7 状態は SBA・空白 80 字・SBA の 3 かたまりに畳んだ。バイト列が一致することを偽のサーバーの 9 通りで確認）。ENQ の「空白を 1 つ書いてから境目まで」は do-while で同じ
- 規約: ACS のコード・コメントは写していない（表の 95 バイトは事実。手順は自分の言葉）。`console.*`・`node:*` の import なし（telnet 層は純ロジック）
- 共有層: `TelnetLayer.feed` は全 5250 セッションの入口。IBM i は交渉の前に通常データを送らない（tap の記録）ので nvtBuf は空のまま。交渉を省いたレコードを流す既存の試験は EOR 終わりをレコードにして通した。分割した受信の 1 件だけ試験を直した
- 再接続: 新しい `TelnetLayer` は BINARY・EOR の状態が初期に戻る。`Session5250.nvt.pos` も `establish` で 0 に戻す

指摘:
- [nit][conv:-] NVT の入力（キーを交渉前の相手へ送る）と 3270 の NVT は未対応 / 対応: スコープ外に明記（requirements）
