# 仕様: ウィンドウ表示の見せ方

## 概要

`detectWindowRect()`（直前の作業）で得た窓の矩形の上に、**重ねるだけの装飾**を描く。
文字・桁・ホスト色には一切触れない。見せ方は画面設定「ウィンドウ設定」で選ぶ。

## 設計方針

### D1. 矩形は既存の検出をそのまま使う

拡張5250（`gui.windows`）と文字で描かれた窓（罫線検出）の**両方**を 1 つの関数が返すので、
装飾側は種類を意識しない。窓が無ければ `null` → 何も描かない。

### D2. 重ねるだけ（レイアウトに影響させない）

`.gui-window` と同じ流儀で**絶対配置**する（`position:absolute` ＋ `left: (col-1)ch` /
`top: (row-1)*1.25em`）。`pointer-events: none` を付け、**窓の中の入力・クリック・矩形選択を妨げない**。

### D3. スモークは「窓の外側」を 4 枚で覆う

全面に 1 枚かけて窓だけ切り抜く方法（`clip-path` 等）もあるが、窓の**上・下・左・右**の
4 つの矩形で覆う方が単純で、どのブラウザでも同じに出る。窓の中は一切覆わないので読みやすさが落ちない。

```
┌─────────────┐
│     上       │
├───┬─────┬───┤
│ 左 │ 窓  │ 右 │   ← 窓の中は覆わない
├───┴─────┴───┤
│     下       │
└─────────────┘
```

### D4. 用意するパターン

| 値 | ラベル | 見せ方 |
|---|---|---|
| `none` | 無効 | 何も描かない（既定・従来どおり） |
| `shadow` | 影 | 窓の外側に落ち影 |
| `smoke` | スモーク | 窓の外を暗くする |
| `smokeShadow` | 影＋スモーク | 上の 2 つ |
| `raised` | 浮き出し | 影＋窓の面をわずかに持ち上げる（地色を薄く敷く） |
| `outline` | 枠強調 | アクセント色の枠線を重ねる |

### D5. 設定は既存の流儀に合わせる

`VIEW_ITEMS` に `expandable: true` で追加する。これだけで
「開く／閉じる＋見本つきパレット」もキー設定の順送り（`view:windowView`）も自動で付く。

## インターフェース / データ構造

```ts
// stores/viewSettings.ts
export type WindowView = "none" | "shadow" | "smoke" | "smokeShadow" | "raised" | "outline";
export interface ViewSettings { …既存…; windowView: WindowView }  // 既定 "none"
```

`VIEW_ITEMS` に追加（ボタン設定の直後）:

```ts
{ key: "windowView", label: "ウィンドウ設定", expandable: true,
  opts: [none 無効 / shadow 影 / smoke スモーク / smokeShadow 影＋スモーク /
         raised 浮き出し / outline 枠強調] }
```

`ScreenGrid.vue`:
- `windowRect = computed(() => 設定が none なら null、それ以外は detectWindowRect(snapshot, displayChar))`
- 描画: 窓の枠 1 枚（`.win-deco`）＋ スモーク 4 枚（`.win-smoke`）。
- 意匠は `.pane[data-window="…"]` で出し分ける（他の設定と同じ流儀）。

## 振る舞いの詳細

- **窓が無い画面**: `detectWindowRect` が `null` → 要素を 1 つも描かない。
- **設定が `none`**: 検出も走らせない（無駄な計算をしない）。
- **座標**: `.gui-window` と同じ補正（`margin: 8px 0 0 10px`＝グリッドの padding 分）を使う。
  矩形は**閉区間**（`row1..row2` / `col1..col2`）なので、幅 = `col2-col1+1` 桁、高さ = `(row2-row1+1)*1.25em`。
- **重なり順**: 文字より上、カーソル・矩形選択より下（選択が見えなくならないように）。
- `pointer-events: none` で操作を透過させる。

## エラー処理 / 異常系

| 状況 | 扱い |
|---|---|
| 窓の検出が外れる（誤爆） | 装飾が変な位置に出るだけで、文字・操作は無傷。設定を無効にすれば元に戻る |
| 窓が画面いっぱい | スモークの 4 枚が幅 0 になる。0 のものは描かない |
| 拡張5250 と罫線の両方が該当 | `detectWindowRect` の既存の優先順（`gui.windows` が優先）に従う |

## 受け入れ基準との対応

| 完了条件 | 実現方法 |
|---|---|
| 既定では従来と同じ | `none` で検出も描画もしない。コンポーネントテスト |
| パターンで見せ方が変わる | `data-window` で出し分け。ビルド後 CSS のガード |
| 文字の窓でも効く | `detectWindowRect` の罫線経路。F1 ヘルプ相当の合成データでテスト＋実機 |
| 拡張5250 の窓でも効く | `gui.windows` 経路。合成データでテスト＋実機（EXTPGM） |
| 窓が無い画面で何も出ない | コンポーネントテスト |
| 桁がずれない | 絶対配置＋`pointer-events:none`。ON/OFF で行テキストが不変であることをテスト |
| 操作を妨げない | `pointer-events: none` をビルド後 CSS で固定 |
