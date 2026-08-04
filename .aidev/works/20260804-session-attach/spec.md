# 仕様: 既存のセッションをブラウザから開く

## 概要

開いているセッション（MCP や HLLAPI が開いたものを含む）を**一覧から選んでブラウザで開ける**。
すでに見ている人が居ても**両方が同じ画面を見られる**。

## 設計方針

### D1: 通知は購読リストにする

いまは 1 枠で上書き（`entry.onPcCommandEvent = fn`）。2 つ目のタブが繋ぐと
**1 つ目の通知が止まり**、どちらかが閉じると**残った方の通知も消える**。

`screen` は `EventEmitter` なので画面更新だけは両方に届く——つまり
**「画面は同期するのに覆いは片方にしか出ない」**という中途半端な壊れ方をする。

`SessionManager` に購読の口を置き、**解除の関数を返す**。呼び出し側は自分の分だけ外す。

### D2: 一覧は `list(user)`（自分の分だけ）

`/api/admin/sessions` は `listAll()` で**全利用者**を返すが、attach の導線に使わない。
admin が既定で他人の画面を開く導線は作らない
（`20260803-hllapi-bridge` で `Connect("A")` の既定を自分に限定したのと同じ判断）。

### D3: 状態を変えない

繋ぎ直しただけで勝手に何かを再開しない（プリンターの前例
`20260801-printer-attach-by-ref` の判断をそのまま引き継ぐ）。

### D4: 判定はサーバーに置く

「そのセッションが存在し、自分のものか」は `sessions.get(id, user)` が決める。
画面側だけで見るとリロード直後に一覧が届いておらずすり抜ける（前例のコメント）。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `session-manager.ts` | 購読リスト、`subscribePcCommand` / `subscribeReservation` |
| `ws-messages.ts` | `WsOpen.sessionId`（attach） |
| `ws-handler.ts` | attach 経路、購読の登録／解除 |
| `session-routes.ts`（新規） | `GET /api/sessions`——**自分の開いているセッション** |
| web-ui | 一覧と「開く」導線 |

## インターフェース / データ構造

```ts
// SessionEntry（単数枠を置き換える）
/** PC コマンドの購読者。**複数のタブが同じセッションを見られる** */
pcCommandSubscribers?: Set<(e: PcCommandEvent) => void>;
/** 予約の購読者。同上 */
reservationSubscribers?: Set<(r: SessionReservation | undefined) => void>;

// SessionManager
/** 購読する。**返った関数を呼べば自分の分だけ外れる** */
subscribePcCommand(id: string, fn: (e: PcCommandEvent) => void): () => void;
subscribeReservation(id: string, fn: (r: SessionReservation | undefined) => void): () => void;

// WsOpen
/** **既存のセッションへ繋ぐ**（新規に開かない）。自分のものだけ */
sessionId?: string;

// GET /api/sessions
{ sessions: { sessionId, host, connectedAt, readOnly, name?, reservedBy?, viewers }[] }
```

## 振る舞いの詳細

| 状況 | 結果 |
|---|---|
| `{ type: "open", sessionId }` — 自分のもの | **繋ぐ**（新規に開かない）。`opened` を返す |
| 同 — 他人のもの | `FORBIDDEN`（`get` の所有者検査） |
| 同 — 存在しない | `SESSION_NOT_FOUND` |
| 2 つのタブが同じセッション | **両方に画面・予約・PC コマンドが届く** |
| 片方が閉じる | **もう片方は生きたまま**。在席は 2 → 1 |
| 全部閉じる | 在席 0。**セッションは閉じない**（MCP が使っているかもしれない） |

- attach では `sessions.open()` を呼ばない——**新しい接続を作らない**
- `readOnly` は**そのセッションの性質**に従う（attach 時に指定できない）

## ドメイン固有の考慮

- **在席（`viewers`）は触らない。** 増減方式なので attach でそのまま正しい
  （`20260803-mcp-session-exclusion`）。**「疎通の有無で判断する」選択がここで効く**
- 予約の覆いは**両方のタブに出る**（購読リストにするので）

## エラー処理 / 異常系

- **購読の取りこぼし**＝リーク。閉じたタブへ送ろうとする。
  `dispose` で必ず外れることを検査で固定する
- attach 中にセッションが閉じられたら、既存の `closed` が両方へ届く

## 受け入れ基準との対応

| 完了条件 | どう満たすか |
|---|---|
| 一覧から選んで開ける | `GET /api/sessions` ＋ web-ui の導線 |
| 2 つのタブが同じ画面 | 購読リスト（D1） |
| 片方を閉じても生きている | 解除は自分の分だけ |
| 他人のは開けない | `get(id, user)` |
| 在席が正しい | 既存の増減方式（変更なし） |
| MCP の予約が働く | `hasViewer` がそのまま正しい |
