# 仕様: HLLAPI の 3270 のセッションの Tab・Backtab

## 概要
HLLAPI の `moveCursor` で、スナップショットがホーム位置を持たない（3270）ときは 3270 の規則の関数で行き先を決める。

## 設計方針
- `packages/server/src/hllapi-3270-tab.ts`（新規）に `tabPosition3270` / `backtabPosition3270` を置く（使うのは HLLAPI だけ）
- Tab は ACS `PS3270.processTabKey` を事実どおり書き起こす。Backtab は 5250 の `backtabPosition` に長さ 0 の欄を除いた欄を渡し、書式なしだけを足す（欄の途中なら欄頭・前の保護されていない欄・回り込みは 3270 と同じ。
  保護されていない欄が無いときの ACS は読み切れていないので、従来どおり動かさない）

## 対象範囲
- `packages/server/src/hllapi-3270-tab.ts`（新規）・`packages/server/src/hllapi.ts` の `moveCursor`

## 依拠する既存の事実
- ACS `PS3270.processTabKey`: 属性がある画面では、カーソルが保護されていない欄の属性の桁にいればその欄の先頭。そうでなければ次の保護されていない欄の属性（回り込み）から、次の桁も属性なら（長さ 0）さらに次へ。
  一巡したら 1 行 1 桁、保護されていない欄が無ければ今いる欄の属性の次の桁。属性が 1 つも無ければ 1 行 1 桁（scratchpad の `acs/x3270/out/.../PS3270.java`）
- ACS `PS3270.processBacktabKey`: 欄の 2 桁目以降（かつ欄の終わりより前）で保護されていなければ欄頭。そうでなければ前の保護されていない欄を探し、長さ 0 を飛ばす。属性が無ければ 1 行 1 桁
- 3270 のスナップショットの欄は属性ごとに 1 つで、長さ 0 の欄も入る。書式なしなら欄は空（`packages/tn3270/src/screen/snapshot.ts` の `buildFields`）
- 3270 のスナップショットは `home` を持たない（`packages/server/src/hllapi.ts` の Home の分岐の注記）
- 実機の ACS の 3270 のコア: メインメニュー（入力欄はコマンド行 1 つ）で保護域からの Tab・欄頭と欄の途中からの Backtab はどれもコマンド行の先頭。Clear はホストがすぐ描き直すので書式なしの画面は作れない（`scripts/acs-probe/hllapi-tab-3270.txt`）

## インターフェース / データ構造
- `tabPosition3270(snapshot, pos): number`・`backtabPosition3270(snapshot, pos): number | undefined`（1 起点の PS 位置）

## 振る舞いの詳細
- 欄の属性の位置は欄の先頭の 1 つ前（1 桁目なら画面の最後の桁）
- 「今いる欄」は、属性の位置がカーソル以前で最後のもの（無ければ最後の欄。回り込み）

## エラー処理 / 異常系
- なし（純関数）

## 受け入れ基準との対応
- AC1: 両関数の欄が空の分岐（単体）
- AC2: `tabPosition3270` の長さ 0・保護されていない欄が無い・どれも長さ 0 の分岐、`backtabPosition3270` の長さ 0 の除外（単体）
- AC3: 通常の画面の行き先（単体）と、実機のメインメニューで ACS と同じ（`scripts/verify-hllapi-tab-3270.mjs`）
