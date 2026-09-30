# レビュー: E 欄の残り

## ラウンド 1（独立の読み）
- 手順の照合: `insertBudget` の `--n3` は ACS `insertChar` の `--n3`（`isDBCSOnlyField || isDBCSEitherField && isEitherFieldDBCSOn`）に当たる。J は full なので変わらない（`jeShapeOf` が "only" を full に返す）。実機 I1 が一致
- 伏せ字: 実値を DOM に出さないことを `el.value.trim() === ""` で固定。IME の経路は el.value が桁ぶんの空白＋合成中の字なので `commitInto` が読む差分は変わらない
- 共有層: core は無変更。Dup の埋め方は SBCS の欄で従来と同じ（既定の重みが 1）

指摘:
- [nit][conv:-] `insertInto` の状態は貼り付け前の `base` で見ており、貼り付けの途中で E が半角から全角へ切り替わる場合は近似 / 対応: 先頭での切り替えは欄を空にしてから入れる経路で、空なら余地は欄長に等しく実害なし。記録のみ
