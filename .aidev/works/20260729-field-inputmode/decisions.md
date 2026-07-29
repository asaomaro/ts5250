# 決定記録

## D1: `numeric` 全体ではなく digits-only にだけ絞る（backlog の記述から変更）

- 背景: backlog は「`f.numeric` の欄に `inputmode="numeric"` を付ければ…」と書いていた。
- **実装前に `field-validate.ts` を読んで分かったこと**: 許容集合は shift で違う。

  | shift | 許容集合 |
  |---|---|
  | **digits-only**（0x0600） | **`/^[0-9]*$/`** |
  | numeric-only / signed-numeric | `/^[0-9.,+-]*$/` |

- 決定: **digits-only にだけ `inputmode="numeric"` を付ける。** 他の数値欄には付けない。
- 理由: `numeric` 全体に付けると、`.` `,` `+` `-` を許容する欄でそれらのキーが消え、
  **打てるはずの文字が打てなくなる**（AGENTS.md「環境の検出結果で選択肢を塞がない」）。
  digits-only なら絞っても利用者が打てる文字は 1 つも減らない＝**塞がない**ことが保証できる。
  backlog の「推測を一切含まずホストの申告だけで決まる」という性質も、この形でこそ成り立つ。
- 影響: `Field` に `digitsOnly?: boolean` を追加（`signedNumeric` と対称）。
  numeric-only / signed-numeric はフルキーボードのまま＝**今日と変わらない**。
