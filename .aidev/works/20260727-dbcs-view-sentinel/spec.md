# 仕様: DBCS 欄にフォーカスしても制御コードを見せず、SO/SI マークの桁をずらさない

## 設計方針

### D1. 「DBCS で全角とみなすか」の判定を 1 箇所に集約する

```ts
export function isWideForDbcs(ch: string): boolean {
  return !isRawSentinel(ch) && isFullWidth(ch);
}
export function viewChar(ch: string): string {
  return isRawSentinel(ch) ? " " : ch;
}
```

`isFullWidth` が私用領域を外字＝全角として含むことに起因する取り違えは、
**これで 3 度目**（`displayCols` / `dbcsByteLength` / 列ビュー）。
その都度その場で直すのをやめ、**罠を 1 箇所に閉じ込める**。

適用先: `columnView` / `dbcsViewLayout` / `columnViewLayout`（`columnsBefore` / `viewAtColumn`）/
`dbcsByteLength`。

### D2. 列ビューにはセンチネルを出さず、空白 1 桁にする

センチネルは「1 バイト・1 桁・表示は空白」。列ビューは**表示用**なので、
ここで空白へ潰す（`viewChar`）。**論理値・送信値はセンチネルを保つ**ので
PR #173/#174 の round-trip は壊れない。

### D3. フォーカス中の `el.value` 代入も `stripSentinels` を通す

休止時はテンプレートが `displayText(stripSentinels(...))` を通すが、
フォーカス中は同期処理が直接代入していた。**同じ境界を通す**ようにする
（D2 で列ビュー側も潰しているので二重の守り）。

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| 制御コードが見えない | D2（列ビューで空白）＋ D3（代入時にも潰す） |
| SO マークの桁が休止時と同じ | D1（センチネルを全角扱いしない＝SO を前に入れない） |
| 休止 ⇔ フォーカスで桁が動かない | D1（桁数計算も同じ判定を使う） |
| 送信値はセンチネルを保つ | 論理値には触らない。潰すのは列ビュー＝表示だけ |
