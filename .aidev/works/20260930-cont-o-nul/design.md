# 仕様: 継続した O 欄の空きと空白

## 概要
鎖の値の文字として U+0000 を「空き（NUL）」に使う。空白（U+0020）は中身。core はそれを空のセル・生バイト 0x40 のセルに写す。

## 設計方針
鎖だけに持たせる（継続でない O 欄・J・E は従来どおり。値の表し方を全欄に広げると影響が大きい）。運ぶ道具は既存の値の文字列（U+0000 は他で使っていない）。

## 対象範囲
- web-ui: `oFieldCells.ts`・`oChainCells.ts`・`ScreenGrid.vue`・`fieldValidate.ts`
- core: `buffer.ts`

## 依拠する既存の事実
- 鎖の詰め直しは末尾の空きだけを余地に数える（`oChainCells.ts` の `isFree`）。空きの表し方が空白だったので、空白も余地に数えていた
- 送信は空のセルを見分ける（`read-response.ts`。READ MDT は途中を 0x40・ALT は 00・末尾は落とす）
- snapshot のセルは、ホストが書いた空白に生バイト 0x40 を持ち、空のセルは持たない（`wtd-applier.ts`）

## インターフェース / データ構造
- `OCell.nul?`（空き）、`nulCell()`、`toCells(chars, length, padNul)`、`eraseToEnd(cells, c, fill)`
- 値: U+0000＝空き、U+0020＝空白、DEAD_MARK＝死んだ桁（従来）
- core: `setFieldCells`・`setFieldValue` は U+0000 を空のセルにする。鎖の空白は生バイト 0x40 のセルにし、末尾でも落とさない

## 振る舞いの詳細
- 詰め直し・Delete・Erase EOF・続く区間の消去・詰め物は空き（NUL）
- 初期値: snapshot のセルが「空白で生バイトが無い」なら空き、生バイト 0x40 なら中身の空白
- 末尾の空きだけを値から落とす（`trimPad`）。列ビューでは空きは空白 1 桁（`viewChar`）

## エラー処理 / 異常系
- 空白で満杯の鎖への挿入は 0012（ACS の余地の数え方どおり）

## 受け入れ基準との対応
- AC1: `oChainCells.ts` の `isFree`・`reflow` と `o-chain-cells.test.ts`
- AC2: 実機のブラウザ `scripts/verify-browser-cont-o.mjs`（C09・C10 の末尾まで）
- AC3: `buffer.ts`・`o-chain-send.test.ts`
- AC4: `scripts/verify-browser-cont-o-paste.mjs`（P1〜P8）
