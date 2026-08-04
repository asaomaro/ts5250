# 仕様: MCP の操作を、見ている人が居るときだけ排他する

## 概要

MCP が画面を書くとき、**そのセッションをブラウザが見ていれば**自動的に予約する。
利用者には「MCP が自動操作中です」と出て入力が止まり、「解除して操作する」で取り戻せる。
見ている人が居なければ**何もしない**——誰も守る相手が居ないので儀式にしない。

## 設計方針

### D1: 判定は「ブラウザと疎通があるか」だけ

セッションの出どころ（MCP が開いたか）で判断しない。
いまブラウザは既存セッションへ後から繋げないので両者は一致するが、**それは偶然の性質**で、
attach を入れた瞬間に崩れる。**疎通の有無は不変。**

### D2: エージェントに囲わせない

`reserve_session` のようなツールは**作らない**。囲い忘れる余地を作らない。
道具の側が勝手に取り、勝手に手放す。

### D3: 期限は予約が持つ

`RESERVATION_TTL_MS`（2 分）は HLLAPI の既定として残し、**予約ごとに期限を持てる**ようにする。
MCP は短い期限で取り、呼び出しのたびに延ばす——連射は 1 回の「MCP が操作中」に見え、
終われば黙って消える。

### D4: 足し忘れをソース走査で固定する

書き込みの入口は 8 箇所あり、共通のラッパが無い（この repo の作法）。
**忘れると黙って効かなくなる**ので、`mcp-tools.ts` を走査して
「書き込みの検査を通す箇所は必ず予約も取る」ことを機械で検査する。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `session-manager.ts` | 在席カウント、期限の保持、`hasViewer` |
| `ws-handler.ts` | 在席の付け外し（`detachScreen` に相乗り） |
| `mcp-tools.ts` | 8 箇所で予約を取る、`list_sessions` に予約状態 |
| web-ui | **変更なし** |

## インターフェース / データ構造

```ts
// SessionEntry
/** このセッションを見ているブラウザの数。**通知フックの有無で代用しない** */
viewers: number;

// SessionReservation
/** この予約の期限の長さ。用途で違う（HLLAPI は長く、MCP は短く） */
ttlMs: number;

// SessionManager
/** ブラウザが見ているか（予約を取るかの判断に使う） */
hasViewer(id: string): boolean;
/** 在席の増減。ws-handler が呼ぶ */
addViewer(id: string): void;
removeViewer(id: string): void;
/** 期限を指定できるようにする（未指定は RESERVATION_TTL_MS） */
reserve(id, holder, label, user?, ttlMs?): SessionEntry;

// mcp-tools.ts
/** MCP 用の予約の期限。実測して決める（要件の未確定事項） */
const MCP_RESERVATION_TTL_MS: number;
/** **見ている人が居るときだけ**予約する。書き込みの直前に呼ぶ */
function claimForWrite(sessions, sessionId, user): void;
```

## 振る舞いの詳細

| 状況 | 予約 | 画面 |
|---|---|---|
| ブラウザが見ている＋MCP が書く | **取る** | 「MCP が自動操作中です」＋覆い |
| 他人のセッション（管理者） | 取る | 「kanri（MCP）が自動操作中です」 |
| 誰も見ていない | **取らない** | — |
| MCP が連射 | 期限が延びる | 出っぱなし（点滅しない） |
| MCP が終わる | 期限で解ける | 覆いが消える |
| HLLAPI が既に予約中 | **取れない** → `SESSION_RESERVED` | HLLAPI の表示のまま |

- 予約が取れなければ **`SESSION_RESERVED` を投げる**（書かずに断る）。
  他の自動化が動いている最中に割り込まない
- `list_sessions` に `reservedBy` を足す（予約中のみ）

## ドメイン固有の考慮

- **web-ui は触らない。** `label` が画面へ流れる仕掛けは `20260803-hllapi-bridge` で入っている
- 他人のセッションを触るときに操作者名を出す規則も同じ場所にある（`reservationLabel`）。
  MCP でも同じ形にする

## エラー処理 / 異常系

- 予約が取れない（他が持っている）→ `SESSION_RESERVED`。MCP は `errorResult` で返す
- セッションが消えている → 既存の `SESSION_NOT_FOUND`
- **在席カウントが漏れる**と、誰も見ていないのに予約が付く。
  `detachScreen` は切断・エラー・置き換えのすべてで呼ばれることを検査で固定する

## 受け入れ基準との対応

| 完了条件 | どう満たすか |
|---|---|
| 画面に「MCP が自動操作中です」 | `label = "MCP"` を渡す。表示は既存 |
| ブラウザから打てない | `assertWritable` の内側の検査（既存） |
| 連射で点滅しない | 短い期限＋`touchReservation` |
| 終われば自然に解ける | 期限切れ（既存の `reservationOf` が刈る） |
| 誰も見ていなければ予約しない | `hasViewer` で判断 |
| `list_sessions` で分かる | `reservedBy` を足す |
| 実機 E2E で目視 | `verify-hllapi-browser.mjs` を拡張 |
