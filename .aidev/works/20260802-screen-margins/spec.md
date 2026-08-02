# 仕様: エミュレータ画面の余白を ACS 相当に詰める

## 測ってから削る

まず実機で測った（viewport 1125×707）:

```
grid padding 8px 10px / wrap 589 / grid 586 / font 19px
```

縦の余白は 4 か所に散っていた:

| 場所 | 前 | 後 | 縦の節約 |
|---|---|---|---|
| `.group`（ペインの外） | `4px` | `0` | 8px |
| `.tabs`（タブ帯の上） | `4px 4px 0` | `1px 2px 0` | 6px |
| `.grid`（文字と枠の間） | `8px 10px` | `1px 2px` | 14px |
| `.statusbar` ＋ `.fk` | `5px 10px` / `3px 8px` | `1px 8px` / `2px 8px` | 8px |

結果、画面に使える高さが **573 → 598px**（+25px・4.4%）。

## 同じ数字が 3 か所にあった

余白を変えたら**字が大きくならず、クリック位置もずれた**。原因は同じ数字の重複:

- CSS `padding: 8px 10px`
- フィット計算 `clientWidth - 20` / `clientHeight - 16`
- クリックの桁逆算 `ev.clientX - rect.left - 10` / `- 8`

`fitFont.ts` に `GRID_PAD_X` / `GRID_PAD_Y` を置き、**CSS も TS もそこから引く**
（CSS 変数は `:style` で流し込む）。テストの座標計算も同じ定数を使う。

## ACS 相当とは

ACS は画面の文字が枠のすぐ内側から始まる。0 にしないのは**字が枠に触れると読みにくい**ため、
`1px 2px` を残す。
