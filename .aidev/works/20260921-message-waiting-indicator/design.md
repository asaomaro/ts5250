# 仕様: メッセージ待ち表示（MW）を出さない

## 概要
**達成したい状態**: メッセージが届いたことが画面から分かる。
3 層をつなぐ——CC2 の解析 → セッションの状態 → スナップショット → ステータスバー。

## 設計方針
- **既存の `messageWaiting`（オペコードで更新）を単一の状態として使う**。CC2 も同じ状態を更新する。
- `ApplyResult.messageWaiting` は**触れなかったら `undefined`**——ビットの無い WTD で消さないため。
- スナップショットへは `Session5250.snapshot()` で重ねる（画面バッファではなくセッションの状態なので）。
- 表示は既存の `🔒 応答待ち` に倣う（日本語ラベル・定義済みの配色変数）。

## 対象範囲
| ファイル | 変更内容 |
|---|---|
| `packages/tn5250/src/screen/types.ts` | `ScreenSnapshot.messageWaiting?` |
| `packages/tn5250/src/protocol/wtd-applier.ts` | `ApplyResult.messageWaiting?` と `applyCc2` |
| `packages/tn5250/src/session/session.ts` | 反映と `snapshot()` への重ね |
| `packages/web-ui/src/components/StatusBar.vue` | 表示灯 |

## 依拠する既存の事実
- `messageWaiting` はオペコードで既に更新されている（`session.ts:607-608`）。
- `ScreenSnapshot` は共有型（`types.ts`）。**web-ui は test/ も型検査する**ので web-ui 側も通す（`AGENTS.md`）。
- 定義済みの配色変数に `--t-cyan` は**無い**（`--t-turquoise` を使う）。

## インターフェース / データ構造
- `ScreenSnapshot.messageWaiting?: boolean`（点灯時だけ付与）
- `ApplyResult.messageWaiting?: boolean`（触れなかったら undefined）

## 振る舞いの詳細
CC2 0x02→消灯、0x01→点灯（この順。両方なら点灯）。ビット無しなら状態を保つ。

## エラー処理 / 異常系
変更なし。

## 要件との対応
- AC1: `applyCc2`。AC2: `session.ts`。AC3: `StatusBar.vue`。AC4: mutation 4 通り。
