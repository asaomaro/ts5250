# 仕様: 重ねる要素の余白補正を定数に従わせる

## 概要

`ScreenGrid.vue` の scoped CSS にある `margin: 8px 0 0 10px` を、
`.grid` がインラインで流し込んでいるカスタムプロパティに置き換える。

```css
margin: var(--grid-pad-y) 0 0 var(--grid-pad-x);
```

`--grid-pad-x/y` は `.grid` 要素の `:style` で `GRID_PAD_X/Y` から与えている（既存）。
カスタムプロパティは継承するので、`.grid` の子孫であるオーバーレイはそのまま読める。

## 設計方針

**なぜ margin なのか（そのまま残す理由）**——絶対配置の基準は祖先の padding box なので、
`left: 0` は padding の外側の縁になる。桁 1 に合わせるには padding と同じ量だけ内側へ寄せる必要がある。
`.opmsg` は `left/right/bottom` を直接使っており（#270〜#272 で導入）、既に var を読んでいる。
残りは `left`/`top` を桁・行から計算して渡す形なので、補正は margin で足すのが最小の変更になる。

**`.opmsg` に合わせて left/top へ寄せない**——オーバーレイの `left`/`top` は
`(col-1)+"ch"` / `(row-1)*1.25+"em"` を JS 側が組み立てている。`calc()` へ移すと
12 か所の style バインドを全部書き換えることになり、変更量に見合わない。

## 対象範囲

- `packages/web-ui/src/components/ScreenGrid.vue`（scoped CSS のみ。12 か所）
  - `.cursor` / `.rect-sel` / `.grid-line` / `.win-frame` / `.opt-btn` / `.opt-hints`
  - `.gui-window-border` / `.win-smoke, .win-deco` / `.gui-window` / `.win-title`
  - `.gui-selection` / `.gui-scrollbar`
- `packages/web-ui/test/grid-overlay-offset.test.ts`（新規。回帰の番人）

## インターフェース / データ構造

変更なし。`GRID_PAD_X` / `GRID_PAD_Y`（`composables/fitFont.ts`）が唯一の定義であることは維持する。

## 振る舞いの詳細

- 余白 `GRID_PAD_X=2` / `GRID_PAD_Y=1` のとき、補正は `1px 0 0 2px` になる。
  従来（8px / 10px）に対し、重ねるものが**左へ 8px・上へ 7px 戻る**＝文字と一致する。
- 余白の定数を変えると、CSS・フィット計算・クリックの桁逆算・オーバーレイが同時に追従する。

## ドメイン固有の考慮

- ACS はほぼ余白を持たない。余白の値自体はこの作業で触らない（#274 の判断を維持）。

## エラー処理 / 異常系

- `--grid-pad-x/y` が未定義の環境（`.grid` の外にオーバーレイを出す将来の変更）では
  `margin` が無効値になり 0 として扱われる。**フォールバック値は書かない**——
  数字を書けば「唯一の定義」が崩れ、今回と同じ食い違いの種になる。
  代わりに、オーバーレイが `.grid` の子であることをテストで固定する。

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| px 直書きが残っていない | 12 か所を var に置換。`grid-overlay-offset.test.ts` が style ブロックの `margin:` を走査し、`0` か `var(--grid-pad-` 以外を落とす |
| カーソルがセルに一致 | `scripts/verify-cursor-align.mjs` で実ブラウザ計測（`.cursor` の矩形 vs 桁・行から求めたセル矩形） |
| 直書きが復活したら落ちる | 同テスト（jsdom は scoped CSS を計算しないため、ソースを見る形にする） |
