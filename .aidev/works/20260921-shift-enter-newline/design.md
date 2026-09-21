# 仕様: Shift+Enter で画面を送信する

## 概要
ACS `PS5250.processNewline` に合わせる。

## 設計方針
- 原典の事実に合わせる: 次の行の先頭を起点に nextNonByPassInputFieldPos で次の入力欄へ。ホストへは送らない。

## 対象範囲
- `packages/web-ui/src/composables/useKeymap.ts`

## 依拠する既存の事実
- ACS `PS5250.processNewline`（`javap -c -constants` で確認）。

## インターフェース / データ構造
変更なし（振る舞いのみ）。

## 振る舞いの詳細
次の行の先頭を起点に nextNonByPassInputFieldPos で次の入力欄へ。ホストへは送らない。

## エラー処理 / 異常系
変更なし。

## 要件との対応
- AC1: テストで固定。
- AC2: mutation で確認。
