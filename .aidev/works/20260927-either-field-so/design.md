# 仕様: 空にした E 欄の全角・半角の状態

## 依拠する既存の事実
- research F2〜F4

## インターフェース / データ構造
- ScreenGrid の `edit` イベントに 4 つ目の引数 `{ eitherDbcsOn }`（E 欄だけ）
- `SessionState.eitherDbcsOn?: Map<number, boolean>`（`edits` と同じ寿命）
- `WsKeyField` の値の形に `eitherDbcsOn?: boolean`（真偽値でなければ無視）
- `Session5250.setField(target, value, opts?: { eitherDbcsOn?: boolean })`・`ScreenBuffer.setFieldValue(…, opts?)`

## 振る舞い
- `opts.eitherDbcsOn` があれば E 欄の状態はそれに決め（値からは推さない）、真で値が空白だけなら欄の先頭に SO の桁を置く
- 無ければ従来どおり値から推す（MCP・HLLAPI・マクロ）。ws は無いとき 2 引数で呼ぶ

## 受け入れ基準との対応
- AC1: 上の経路。実機（`scripts/verify-either-empty.mjs`）と ACS（F1）
- AC2: `opts` 無しの経路の単体
