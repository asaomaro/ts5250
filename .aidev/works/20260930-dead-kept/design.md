# 仕様: 死んだ桁を AID のあとも残す

## 概要
core に死んだ桁のセル（`{ type: "char", char: " ", charKind: "sbcs", dead: true }`）を持たせ、送信ではバイトとして NUL に見せ、snapshot に `dead` を出す。web-ui は `dead` を値の死んだ桁の印へ読み戻す。

## 設計方針
新しいセルの種類は作らず、char セルに省略可の `dead` を付ける。バイトとして見る読み口（`cellAt`・`dbcsRawCell`・`allNul`）だけ NUL に揃える。

## 対象範囲
- `packages/tn5250/src/screen/buffer.ts`・`types.ts`、`packages/web-ui/src/components/ScreenGrid.vue`

## 依拠する既存の事実
- 送信は `cellAt` が null のセルを NUL として扱う（`read-response.ts` の `sendValue`・`save-screen.ts`）
- 書き込み・消去はセルごと置き換える（`setChar` など。`buffer.ts`）ので、死んだ印は自然に消える
- web-ui の鎖は値の DEAD_MARK を死んだ桁として持つ（`oChainCells.ts`）

## インターフェース / データ構造
- `InternalCell` の char に `dead?: true`、snapshot の `Cell.dead?: true`

## 振る舞いの詳細
- 継続した O 欄の鎖の値の死んだ桁の印は、死んだ桁のセルとして置く（継続でない欄は従来どおり空のセル）
- `cellAt` は死んだ桁を null で返す。`dbcsRawCell` は undefined（NUL）

## エラー処理 / 異常系
- なし

## 受け入れ基準との対応
- AC1: `o-chain-send.test.ts`（死んだ桁のセル）
- AC2: 実機 `verify-browser-cont-o-dead-kept.mjs`・`o-chain-edit.test.ts`
