# 要件: DSPATR(CS)（桁区切り）を画面に表示する

## 背景 / 課題

**他の実機環境**からの調査報告（Dspf 1-2.pdf / Dspf 2-2.pdf）を受領。
「DDS(DSPF) で描いているはずの罫線（枠線・区切り線）が Web UI 上で表示されない」。

報告書は罫線の描き方を 3 系統に切り分けている。

| 系統 | 5250 上の実体 | 報告書の判定 |
|---|---|---|
| (1) `DSPATR(CS)` 桁区切り | フィールド属性 | 原因判明・報告元では対応済み |
| (2) `GRDATR` / `GRDLIN` | WDSF 0x60 / 0x61 | 未実装・**保留（判断待ち）** |
| (3) `WDWBORDER` | CREATE WINDOW の minor 0x01 | 未実装・**保留（判断待ち）** |

**本作業は (1) のみを対象とする。**

## 現リポジトリでの実態（確認済み）

報告書は (1) を「対応済み」とするが、それは**報告元環境のローカル修正**であり、
受領した差分 PDF（command-datastream 系）には含まれていない。実際に確認したところ:

- core（`screen/attributes.ts`）は属性バイト 0x30–0x33 等から
  `columnSeparator` を**正しく解析してセルに保持している**
- しかし `packages/web-ui/src` 全体で `columnSeparator` の参照は **0 件**。
  `cellClass()` は `underline` / `reverse` / `blink` だけを CSS クラス化しており、
  `columnSeparator` を**完全に素通し**していた
- `a-colsep` クラスも styles.css に存在しない

つまり「core は持っているのに描画側が捨てている」という報告書の指摘は**そのまま当てはまる**。

## スコープ

### 対象
- `packages/web-ui/src/components/ScreenGrid.vue` の `cellClass()` / `attrByteClass()`
- `packages/web-ui/src/styles.css` の `.a-colsep`
- 回帰テスト

### 対象外
- **(2) GRDATR / GRDLIN**、**(3) WDWBORDER**——報告書自身が「保留（別途判断待ち）」とし、
  「ウィンドウ/スクロールバーと同様の**新規 GUI 要素の追加**規模」と見積もっている。
  パーサ拡張・ScreenBuffer への状態保持・オーバーレイ描画・テストが必要で、
  **別作業として起票すべき規模**
- core の属性解析（既に正しい）

## 完了条件

- [ ] `columnSeparator` を持つセルに `a-colsep` クラスが付く
- [ ] 桁区切りが無い画面には `a-colsep` が出ない
- [ ] 他の属性（下線・反転・色）と併用できる
- [ ] `attrByteClass()`（埋め込み属性の色バンド）でも同じ扱いになる
- [ ] 修正前に落ちる回帰テストがある
- [ ] build / test / lint / vue-tsc ビルドが通る
