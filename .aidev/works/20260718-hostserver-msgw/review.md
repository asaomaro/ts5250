# レビュー記録

## ラウンド 1（2026-07-18T23:39:06Z）

自己レビュー。差分は既存 `netprint-*` への追加のみ（新規ファイルなし）。

- [should] `answerMessage` の応答文字列を `length: reply.length` で送っている。
  他の属性は**固定長で空白詰め**が必要だったのに、ここだけ可変長。
  MSGREPLY が固定長を要求する場合、スプール ID のときと同じ
  「隣の値を巻き込む」問題が起きうる。**未検証なので断定できない**が、
  他の属性と扱いが違うことは記録しておくべき。
  / 対応: コメントで明示（未検証のため実装は変えない。変えると別の推測になる）

- [nit] `retrieveMessage` が `SpoolMessage.handle` を optional にしている。
  ハンドルが無ければ応答できないので、型で分けたほうが厳密。
  ただし取得できない場合が実在するため optional が妥当。
  / 対応: 許容（`answerMessage` 側で `CONFIG_ERROR` にしている）

- [nit] 未検証の警告が JSDoc のみ。README にも書くべき。
  / 対応: deliver 時に README へ追記

must 0 件・should 1 件・nit 2 件。
