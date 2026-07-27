# 要件: DBCS 欄にフォーカスしても制御コードを見せず、SO/SI マークの桁をずらさない

## 背景 / 課題

PR #173 / #174 で **DBCS 欄の論理値にセンチネル（U+E000–E0FF）が載るようになった**副作用。
利用者から実機のスクリーンショット付きで報告を受けた。

| 状態 | 表示 | 正誤 |
|---|---|---|
| 休止（フォーカス外） | `AX {設計}CD` | **正しい**（属性は空白 1 桁、`{` は SO の位置） |
| フォーカス中 | `AX{□設計}CD` | **誤り**（属性が豆腐で見え、`{` が属性より前に出る） |

データは `C1 E7 28 0E 45E2 45C9 0F C3 C4`＝`A X [属性0x28] SO 設計 SI C D`。

## 原因

フォーカス中の DBCS 欄は `dbcsRestLayout` の非休止側を通り、
**論理値（センチネル入り）から列ビューを再構成**する:

```ts
return dbcsViewLayout(padDbcs(f, [...logicalValue(f)]).join(""), soMark(), siMark());
```

ここで 2 つ壊れる。

1. **`dbcsViewLayout` がセンチネルを全角とみなす。**
   SO/SI の挿入判定に `isFullWidth` を使っており、**私用領域（U+E000–F8FF）を
   外字＝全角として含む**ため、センチネルの前に SO が入る
   → `{` が属性より前に出る
2. **フォーカス中の `el.value` 設定がセンチネルを潰していない。**
   休止時はテンプレートが `displayText(stripSentinels(...))` を通すが、
   フォーカス中は同期処理が `dbcsSliceText(lay, sl)` を**そのまま**代入している
   → センチネルが私用面の文字として描画され豆腐になる

`isFullWidth` が私用領域を含むことに起因する不具合は**これで 3 度目**
（`displayCols` / `dbcsByteLength` / 今回）。

## スコープ

### 対象
- `packages/web-ui/src/composables/fieldValidate.ts` の列ビュー構築
  （`columnView` / `dbcsViewLayout` / `columnViewLayout`）でセンチネルを SBCS 扱いにする
- `packages/web-ui/src/components/ScreenGrid.vue` のフォーカス中 `el.value` 設定で
  センチネルを空白に潰す

### 対象外
- core の値の作り方（PR #173 / #174 のとおりセンチネルを載せる方針は変えない）
- SO/SI の再構成規則そのもの・入力検証
- 休止時の表示（正しく動いている）

## 完了条件

- [ ] フォーカスしても**制御コードが見えない**（空白 1 桁として描かれる）
- [ ] フォーカス中の SO マーク `{` の桁が休止時と**同じ**
- [ ] 休止 ⇔ フォーカスで**桁が動かない**（全角・SO/SI・属性の位置が一致）
- [ ] 送信値（論理値）はセンチネルを保ったまま（PR #173/#174 の round-trip を壊さない）
- [ ] 修正前に落ちる回帰テストがある
- [ ] build / test / lint / vue-tsc ビルドが通る
