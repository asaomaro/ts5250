# 仕様: ヘッダーの高さをタブ帯に揃える

## 同じ変数を見せる

CSS には「別の要素と同じ高さ」を書く手段が無いので、**両方が 1 つの値を見る**形にする。

```css
:root { --chrome-row-h: 28px; }        /* styles.css */
.topbar { height: var(--chrome-row-h); box-sizing: border-box; padding: 0 14px; }
.tabs   { min-height: var(--chrome-row-h); box-sizing: border-box; }
```

片方に数字を書くと、もう片方を直したときにずれる——**揃えろという要求は、
「いま同じ数字にする」ではなく「これからも同じであること」**なので、値を 1 つにする。

## ヘッダーの縦余白を落とす

`padding: 8px 14px` → `0 14px`。中身は `align-items: center` で中央に置く。
ボタン（`.theme-btn`）は 28px → 22px にして行に収める。

**縦余白を持たせない**のは、`20260802-screen-margins` と同じ理由——
削ったぶんは画面に回る。
