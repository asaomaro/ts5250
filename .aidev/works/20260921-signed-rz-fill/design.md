# 設計

## 概要
- `applyAdjust` を、RZ・RB を先に見て埋め字を決める形にする。符号付き数値なら `keepLastPosition`（符号桁を動かさない）を付ける。RZ・RB が無く符号付きなら従来の空白右寄せ。

## 対象範囲
- `packages/web-ui/src/composables/fieldEdit.ts`、`test/field-adjust.test.ts`・`test/field-sign-dup.test.ts`。

## 依拠する既存の事実
- `rightAdjust(state, fill, { keepLastPosition })`（同ファイル）。`AdjustSpec`（`adjust`・`signedNumeric`）。

## インターフェース / データ構造
- 変更なし（`applyAdjust` の結果だけ変わる）。

## 振る舞いの詳細
- 符号付き＋RZ: `'0'` 埋め・符号桁を動かさない。符号付き＋RB: 空白・符号桁を動かさない。符号付きで指定が無い・MF だけ: 空白・符号桁を動かさない。符号付きでない: RZ `'0'`・RB 空白・それ以外は動かさない。

## エラー処理 / 異常系
- なし。

## 受け入れ基準との対応
- AC1: 符号付き＋RZ/RB の Field Exit・Field−・Field+ のテスト。
- AC2: 無指定・MF の符号付きのテスト（既存＋追加）。
- AC3: mutation 6 通り。decisions D1 に破棄の証拠。
