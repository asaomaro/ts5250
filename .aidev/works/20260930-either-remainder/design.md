# 仕様: E 欄の残り

## 概要
web-ui の 3 か所を ACS に合わせる。core は変えない（送信は既に SO/SI・NUL・0x1C を正しく運ぶ）。

## 設計方針
差は編集モデルの側にあったので、`ScreenGrid.vue` と `fieldEdit.ts` だけを直す。

## 対象範囲
- `ScreenGrid.vue`・`fieldEdit.ts`

## 依拠する既存の事実
- 送信の SO/SI・NUL・Dup 文字の運び方は `read-response.ts` の既存の道（実機で W1〜W8 と J/E の 23 通りで一致済み）
- E の形（full・compact・open）は `jeShapeOf` が決める（`ScreenGrid.vue`）。挿入の余地は `absorbDbcs` が末尾の空白を削って数える

## インターフェース / データ構造
- `isDbcsEdit(f)`: DBCS を申告した欄なら伏せ字でも真
- `insertBudget(f, chars)`: E の全角の状態で full でなければ欄長 − 1、それ以外は欄長
- `dupFill(state, dupChar, bytesOf?)`: カーソル以降のバイトぶん埋める（既定は 1 字 1 バイト）

## 振る舞いの詳細
- 伏せ字の DBCS 欄: 列ビューで編集し、入力欄には桁ぶんの空白を出す。IME は許す。中身が入って届いた欄は編集が空から始まる
- Dup: 全角 2 バイト・半角 1 バイトで数える
- 挿入: 打鍵・貼り付けとも `insertBudget` で数える。選択の置き換えは対象外（消した跡を埋めるだけ）

## エラー処理 / 異常系
- 余地なしは従来どおり 0012（MSG_NO_ROOM）で値を変えない

## 受け入れ基準との対応
- AC1: `isDbcsEdit`・`syncDbcs`・`onCompositionStart` と `either-remainder.test.ts`
- AC2: `dupFill` と `either-remainder.test.ts`
- AC3: `insertBudget` と `either-remainder.test.ts`
- AC4: `scripts/verify-browser-either-remainder.mjs`（実機）
