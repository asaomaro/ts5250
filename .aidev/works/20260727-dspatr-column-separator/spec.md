# 仕様: DSPATR(CS)（桁区切り）を画面に表示する

## 設計方針

### D1. 既存の属性クラスと同じ仕組みに乗せる
`underline` / `reverse` / `blink` と同様に `columnSeparator` → `a-colsep` を付けるだけ。
**新しい描画経路を作らない**——桁区切りはセル単位の見た目であって、別レイヤーではない。

### D2. `cellClass()` と `attrByteClass()` の両方に入れる
`attrByteClass()` は埋め込み属性のオーバーレイが使う。**片方だけ落とすと入力欄の中だけ
桁区切りが消える**という分かりにくい差になるので揃える。

### D3. 線は `border-left` ＋ `currentColor`
5250 の桁区切りは「**その桁の左側に縦線**」。文字色に追従させるため `currentColor` を使う
（反転中は `.a-reverse` が `color` を CRT 地色にするので、線もそれに従う）。

```css
.a-colsep { border-left: 1px solid currentColor; }
```

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| `a-colsep` が付く | D1 |
| 無い画面には出ない | 条件付きで push するだけ |
| 他属性と併用 | 既存のクラス配列に足すので自然に併用される |
| `attrByteClass` でも同じ | D2 |
