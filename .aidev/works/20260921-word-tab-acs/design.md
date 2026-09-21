# 設計

## 概要
- `nextWordStart` の left/right を、ACS の `is1stCharacter` 相当の `isHead` と、画面の全桁ぶんを端で巻き戻ってたどるループにする。`classifyKey` に Alt+←/→（単独）を `word-left`/`word-right` として足す。

## 対象範囲
- `useCursor.ts`・`useKeymap.ts`、テスト `use-cursor.test.ts`・`keymap.test.ts`・`pane-word-jump-input.test.ts`、`scripts/acs-probe/tabword.txt`。

## 依拠する既存の事実
- 桁アクセサ `charAt`（`" "`＝空白〔SO/SI 含む〕・`""`＝全角の後半・他＝文字）。`isFullWidth`（`@ts5250/base`）。

## インターフェース / データ構造
- `nextWordStart` のシグネチャは変えない。

## 振る舞いの詳細
- 直前の位置は行をまたぐ（行頭なら前の行の最終桁）。up/down は従来どおり。

## エラー処理 / 異常系
- 語が全く無ければ pos を返す。

## 受け入れ基準との対応
- AC1〜AC2: `use-cursor.test.ts`（実機のメニューの停止位置を近似したもの・端の巻き戻り・行頭・全角 1 字ごと）と `pane-word-jump-input.test.ts`。AC3: `keymap.test.ts`。mutation 9 通り。
