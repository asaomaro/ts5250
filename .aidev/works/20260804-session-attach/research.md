# 調査: 既存セッションへの attach

## 調査の問い

- Q1: 通知フックの単数枠は具体的に何が壊れるか
- Q2: 一覧の導線はどこに置けるか。既存の口は使えるか
- Q3: プリンターの前例（`20260801-printer-attach-by-ref`）から何を引き継ぐか
- Q4: 在席（`viewers`）は attach で正しく動くか

## 判明した事実

### F1: 単数枠は **2 つ目のタブが 1 つ目の通知を殺す**

`ws-handler.ts:418-425`:

```ts
entry.onPcCommandEvent = (event) => this.send(...);      // **上書き**
entry.onReservationChange = (r) => this.send(...);       // **上書き**
this.detachScreen = () => {
  entry.session.off("screen", onScreen);                 // EventEmitter なので複数可
  delete entry.onPcCommandEvent;                         // **他人の分も消す**
  delete entry.onReservationChange;
};
```

壊れ方は 2 つ:

1. **2 つ目のタブが繋いだ時点**で、1 つ目のタブは PC コマンドと予約の通知を受け取れなくなる
   （予約の通知が来ない＝**覆いが出ない／消えない**）
2. **どちらか 1 つが閉じた時点**で、残ったタブの通知も消える

`screen` は `EventEmitter` なので複数購読でき、**画面更新だけは両方に届く**。
つまり「画面は同期するのに、覆いは片方にしか出ない」という中途半端な壊れ方になる。

### F2: 一覧の口は既にある。ただし **admin 用で全件**

`/api/admin/sessions` → `listAll()`。`owner` を含む**全利用者のセッション**を返す。
画面は `AdminPane.vue`（「セッション管理」）で、いまは**切断だけ**。

一方 `SessionManager.list(user)` は**自分の分だけ**（admin には全件）。
**attach の一覧は `list(user)` を使うべき**——admin が既定で他人の画面を開く導線は作らない
（`20260803-hllapi-bridge` で `Connect("A")` の既定を自分に限定したのと同じ判断）。

### F3: プリンターの前例から引き継ぐもの

`session-manager.ts:728`:

```ts
if (opts.ref !== undefined) {
  const existing = [...this.printers.values()].find(
    (e) => e.ref === opts.ref && e.owner === opts.owner
  );
  if (existing) return existing;      // 開き直さず、これを返す
}
```

コメントに書かれている判断がそのまま効く:

- **一致は ref ＋ owner**——他人のものは掴めない
- **状態は変えない**——「利用者が止めたものを、開き直しただけで勝手に再開しない」
- **判定はサーバーに置く**——「画面側だけで見ると、リロード直後はまだ一覧が届いておらずすり抜ける」

表示セッションは設定 ref を持たずに開くこともあるので、**鍵は `sessionId` そのもの**になる。

### F4: 在席は attach でそのまま動く（数え方は正しい）

`addViewer` / `removeViewer` は `entry.viewers` の増減で、**上書きではない**。
2 タブなら 2、1 つ閉じれば 1。**F1 の単数枠とは別の仕組み**なので、こちらは直す必要が無い。

`20260803-mcp-session-exclusion` の予約判定（`hasViewer`）は attach 後もそのまま正しい
——**「疎通の有無で判断する」という選択がここで効く**。出どころで判断していたら、
attach を入れた時点で崩れていた。

## 影響範囲

- `ws-messages.ts` — `WsOpen` に `sessionId`
- `ws-handler.ts` — attach 経路、**フックを複数購読へ**
- `session-manager.ts` — 購読の登録／解除（フックの持ち方を変える）
- web-ui — 一覧と「開く」導線、`session-controller` の open 経路

## 実現性 / リスク

- **フックの作り替えが本丸**。`onPcCommandEvent` / `onReservationChange` を購読リストにする
- リスクは**解除の取りこぼし**（購読が残るとリークし、閉じたタブへ送ろうとする）
  → 検査で固定する
- attach 後に**予約の覆いが両方のタブに出る**ことを実機で見る

## spec への申し送り

- 一覧は **`list(user)`**（admin でも既定は自分の分）
- **状態を変えない**（プリンターの前例）
- フックは**購読リスト**にし、解除は自分の分だけ
- 在席は**触らない**（既に正しい）
