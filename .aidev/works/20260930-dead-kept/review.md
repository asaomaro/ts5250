# レビュー: 死んだ桁を AID のあとも残す

## ラウンド 1（独立の読み）
- 原典との照合: 実機の測定（E1・E2）を実装へ移した。死んだ桁は継続した O 欄の鎖だけ
- 共有層: `cellAt` が死んだ桁を null で返すので、送信・SAVE SCREEN は従来どおり NUL として読む。snapshot の `Cell.dead` は省略可の追加のみ
- 規約: ACS のコード・コメントは写していない

指摘:
- [nit][conv:-] 死んだ桁を読む直接の `this.cells` が数か所ある（`allNul`・`dbcsRawCell`）/ 対応: 両方 NUL に揃えた。テスト（`raw-dead` 変異）で固定
