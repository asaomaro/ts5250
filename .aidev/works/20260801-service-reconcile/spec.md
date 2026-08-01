# 仕様: 定義の変更をサービスに反映する

## 設計方針

### 1. 反映は CRUD の「後始末」として別に置く

`config-routes.ts` に `SessionManager` を持ち込まない。CRUD の役目は**設定を保存すること**で、
動いているものを触るのは別の関心事。コールバック 1 本（`onSessionChanged`）だけ受け取り、
中身は `app.ts` が `reconcileService` に繋ぐ。

**待たない**——保存の応答をホストへの接続で遅らせない。

### 2. 動いているものは落とさない

動いているプリンターを落とすと、その瞬間に流れている帳票の受け取りが切れる。
**名前の打ち間違いを直しただけで業務が止まる**のは割に合わない。

代わりに:

- **開き直しの材料だけ差し替える**（`updatePrinterOptions` / `WatchRegistry.update`）
- **`stale` を立てて画面に出す**（「要再起動」）——止めどきは利用者が決める
- 開始し直すと `stale` は消える（材料は既に新しい）

**`stale` が要るのは、材料の差し替えだけでは「直したのに効いていない」が黙るから。**
逆に、差し替えずに `stale` だけ立てると、開始し直しても古い設定で繋がる（両方要る）。

### 3. 消えた定義は解決しに行かない

`removed` は**解決が必ず失敗する**（もう無い）。解決してから分岐する形にすると、
削除のたびに例外経路を通ることになる。`removed` は実体だけを見る。

### 4. 何をどう扱うか

| 変更 | プリンター | 待ち行列 |
|---|---|---|
| 足された・自動 ✅ | 立ち上げる（サービス ✅ のときだけ） | 立ち上げる（種別がサービス型なので `service` を見ない） |
| 足された・自動 ☐ | **登録だけ**（開始ボタンを待つ） | 何もしない |
| 直された・動いている | 材料を差し替え、`stale` | 同左 |
| 直された・止まっている | 材料を差し替えるだけ | 同左 |
| サービス ☐ になった | **止めて捨てる** | （`service` を持たない） |
| 消された | **止めて捨てる** | 止めて消す（**先に stop**） |
| 個人設定 | 扱わない | 扱わない |

### 5. 失敗を保存の失敗にしない

`reconcileService` は**決して投げない**。ホストが落ちていて立ち上げに失敗しても、
設定は保存できている——そこで 500 を返すと「保存できたのか分からない」になる。
失敗は `skipped` に理由として残り、ログに出る。

## インターフェース

```ts
export type SessionChange = "saved" | "removed";
export interface ReconcileResult {
  started?: boolean; stopped?: boolean; stale?: boolean; skipped?: string;
}
export function reconcileService(deps, ref: string, change: SessionChange): Promise<ReconcileResult>;

// SessionManager
updatePrinterOptions(id: string, opts: OpenPrinterOptions): boolean; // 戻り＝いま接続を持っているか
// WatchRegistry
update(id: string, opts: { label; spec; connect }): boolean;
remove(id: string): void;
```

`WatchEvent` に `{ type: "list" }` を足す——**行が増減する変化は `state` では伝わらない**。

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| 4 つの変更が再起動なしで効く | 方針 1・4 |
| 保存で待ち受けが切れない | 方針 2 |
| 「要再起動」が出て開始で消える | 方針 2（`stale`） |
| 失敗が保存を巻き添えにしない | 方針 5 |
