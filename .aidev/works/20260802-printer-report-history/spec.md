# 仕様: 常駐プリンターが受け取った帳票を画面から読めるようにする

## 概要

サーバーは既に `printer-opened` でバッファ済みの帳票を送っている。**受け手が捨てている**
だけなので、直しの芯は 3 点しかない。

1. **捨てない**——`session-controller.ts` が `msg.reports` / `msg.receivedTotal` を使う。
2. **時刻を運ぶ**——受信時刻をサーバーで刻み、電文に載せる。
3. **辿れる**——サービス一覧の行からそのプリンターを開ける。

## 調査で判明した前提

| 事実 | 出所 |
|---|---|
| `printer-opened` は `reports` / `receivedTotal` / `outputStatuses` / `outputWarnings` を送る | `ws-handler.ts:493` |
| web-ui は `reports: []` と書いて `msg.reports` を無視する | `session-controller.ts` `case "printer-opened"` |
| `SpoolReport` は時刻を持たない | `packages/tn5250/src/session/printer-session.ts:16` |
| 受信時刻はクライアントが押している | `stores/sessions.ts` `addReport` の `Date.now()` |
| `PrinterEntry.reports` は 50 件で頭打ち・`receivedTotal` は落ちた分も数える | `session-manager.ts` `REPORT_LIMIT` / `deliverReport` |
| `systemsStore.sessions` は**全システムの**セッション設定を持つ | `stores/systems.ts:142`（`currentSessions` だけが絞る） |
| ランチャーの「接続」は `openedSession`（開いていればタブへ）と `deviceNameInUse`（装置の二重掴み）を見る | `LauncherPane.vue` `connect()` |

## 設計方針

### 1. 受信時刻はサーバーで刻む（`SessionManager` の 1 か所）

`deliverReport` は「push でも救出でも同じ道を通す」ための唯一の funnel なので、
**ここで刻めば漏れない**。クロックは `this.now()`——テストで固定できる既存の注入口を使う。

`SpoolReport`（`@as400web/tn5250`）は**触らない**。あれはプロトコル層の「届いた 1 スプール」で、
サーバーがいつ受け取ったかは上位の関心事。サーバー側だけの派生型を置く:

```ts
/** サーバーが受け取った帳票。**受信時刻はここで刻む**（プロトコル層は時計を持たない） */
export type StoredReport = SpoolReport & { receivedAt: number };
```

`PrinterEntry.reports: StoredReport[]` にし、`onReport` も `StoredReport` を渡す
——**live の push も同じ時刻を運ぶ**。ここを分けると「開き直すと時刻が出るのに、
今届いたものには無い」という説明しにくい差が生まれる。

`waitSpool`（MCP）と `handleReport`（自動出力）は上位型のまま受けられる（構造的部分型）。

### 2. 電文は後方互換で足す（`receivedAt?`）

```ts
// WsPrinterOpened.reports[] と WsReport.report の両方
{ id: string; pages: LogicalPageMsg[]; receivedAt?: number }
```

**任意にする**——Electron 同梱版のように web-ui とサーバーの版がずれる経路がある。
受け手は `receivedAt` が無ければ従来どおりクライアントで押す
（`addReport` の `??=` が既にその形なので、**渡すだけで自動的にそうなる**）。

### 3. 受け取り側（`session-controller.ts`）

```ts
case "printer-opened": {
  …
  reports: msg.reports.map(toView),      // ← 捨てない
  receivedTotal: msg.receivedTotal,      // ← 累計（落ちた分含む）
  selectedReportId: msg.reports[0]?.id,  // ← 開いた直後に空の viewer を出さない
  …
}
```

**未読は 0 のまま**。`addReport` を回すと `unread` が件数ぶん上がるが、
受け取るのは「閉じている間に届いた既存分」で、**いま開いて見ているもの**。
タブのバッジを 50 件ぶん光らせるのは嘘に近い。だから `addReport` は使わず直接入れる。

選択は**先頭（最も古い）**にする。live の `addReport` と同じ規則で、一覧の `#1` と一致する。
「最新を選ぶ」に変えると、live と restore で規則が 2 つになる。

`case "report"`（live）は `receivedAt` を素通しし、`receivedTotal` を 1 増やす。
**サーバー値から始めて増やす**ので、落ちた分を含む累計であり続ける。

### 4. 件数の見せ方

```
受信 12 件            … 累計 === 保持
受信 62 件（保持 50）  … 累計 > 保持（古いものが落ちている）
```

`ServicesPane` の既存表記 `帳票 12 件（保持 10）` と**同じ形**にする。
**普段は括弧を出さない**——50 件を超えるまで起きない状態のために、常時 2 つ並べない。

`receivedTotal` が無い（古いサーバー）ときは `reports.length` にフォールバックする。

### 5. サービス一覧からの導線

`ServicesPane` のプリンター行の操作セルに **`開く`** を足す。

- **ボタンにする**（行クリックにしない）。同じ行に開始/停止があり、行全体が押せると
  「押すと何が起きるか」が曖昧になる。いまの行は押せないので、**押せるようになったことに
  気づけない**という問題も付く。
- **`editable` で隠さない**。読むだけの操作で、開始/停止（admin のみ）とは条件が違う。
- **定義が引けないときは出さない**。`/api/printers` と `/api/sessions-config` は
  どちらも `ConfigResolver` 由来で `ref` は同じ名前空間だが、認可の絞り方が同じとは
  限らない。引けない相手に押しても始まらないボタンを出さない。

### 6. 開く処理は 1 か所にまとめる（`composables/openConfigured.ts`）

ランチャーの `connect()` は「開いていればタブへ戻す」「装置名の二重掴みを断る」
「printer と display で入口が違う」を持っている。**同じ判断を `ServicesPane` に
書き写すと 2 か所になる**ので、composable に出して両方から呼ぶ。

```ts
export function useOpenConfigured(): {
  connecting: Ref<string>;
  error: Ref<string>;
  /** セッション設定 ref を開く。開いていればそのタブへ移る */
  open(ref: string, opts?: { force?: boolean }): Promise<void>;
};
```

**`meta.host` はそのセッション自身のシステムから引く**（`def.system` → `systemsStore.systems`）。
ランチャーは「選択中システムの host」を使っているが、`ServicesPane` は
**別システムのプリンターも並べる**ので、選択中システムを見ると別の機械の名前が付く。
ランチャー側では `def.system === menuSystem` なので**挙動は変わらない**。

`dtaqwatch` の分岐もそのまま移す（ランチャーの唯一の呼び出し口を割らない）。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/server/src/session-manager.ts` | `StoredReport`・`deliverReport` で `this.now()` を刻む・`onReport` の型 |
| `packages/server/src/ws-messages.ts` | `printer-opened.reports[]` と `report.report` に `receivedAt?` |
| `packages/server/src/ws-handler.ts` | 両電文に `receivedAt` を載せる |
| `packages/web-ui/src/session-controller.ts` | `msg.reports` / `receivedTotal` を使う・`report` の素通し |
| `packages/web-ui/src/stores/sessions.ts` | `SessionState.receivedTotal` |
| `packages/web-ui/src/composables/openConfigured.ts`（新規） | 開く処理の唯一の経路 |
| `packages/web-ui/src/components/LauncherPane.vue` | `connect()` を composable へ委譲 |
| `packages/web-ui/src/components/ServicesPane.vue` | `開く` ボタン |
| `packages/web-ui/src/components/PrinterPane.vue` | 件数表示（累計・保持） |

## インターフェース / データ構造

```ts
// server
export type StoredReport = SpoolReport & { receivedAt: number };
interface PrinterEntry { reports: StoredReport[]; onReport?: (r: StoredReport) => void; … }

// ws-messages（**任意**にして後方互換）
reports: { id: string; pages: LogicalPageMsg[]; receivedAt?: number }[];
report:  { id: string; pages: LogicalPageMsg[]; receivedAt?: number };

// web-ui
interface SessionState {
  /** 累計受信数（**サーバー側で落ちた分も含む**）。`reports.length` との差が落ちた数 */
  receivedTotal?: number;
}
```

## 振る舞いの詳細

- **開き直し**: `printer-opened.reports` が n 件 → 一覧に n 件、先頭が選択済み、未読 0。
- **live**: `report` が来る → 末尾に足す・未読 +1・`receivedTotal` +1（従来どおり）。
- **時刻**: サーバー値があればそれ。無ければクライアントの `Date.now()`（従来の見え方）。
- **落ちた分**: `receivedTotal` 62 / `reports` 50 → `受信 62 件（保持 50）`。
- **サービス一覧の `開く`**: 既に開いていれば**そのタブへ移る**（2 本目を開かない）。
  開くと `addSession` がそのタブを活性にする＝押した結果が見える。
- **装置名の二重掴み**: 別タブが同じ装置名で繋いでいれば断る（ランチャーと同じ文面）。

## エラー処理 / 異常系

- `msg.reports` が空配列 → 従来どおり「スプール待ち受け中…」。
- 定義が引けない `ref` → `開く` を出さない（押せないボタンを置かない）。
- 開く途中の失敗 → `ServicesPane` の既存 `error` 行に出す（新しい通知先を作らない）。
- 古いサーバー（`receivedAt` / `receivedTotal` 無し）→ 時刻はクライアント押し、
  件数は `reports.length`。**壊れない**。

## ドメイン固有の考慮

- 実機は**共用の本番機**。既存 `PRT_TEST` を借り、装置は作らない・消さない。
  `finally` で `ENDWTR`、作ったスプールは消す、他人の OUTQ に触らない。
- 検証スクリプトに内部 IP を書かない（`process.env.AS400_HOST`、既定値なし）。

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| 閉じている間の帳票が一覧に出る | 方針 3 |
| 受信時刻が実際に届いた時刻 | 方針 1・2 |
| 累計と保持の両方が読める | 方針 4 |
| サービス一覧から開いて読める | 方針 5・6 |
| 既存分で未読バッジが光らない | 方針 3（`addReport` を通さない） |
| 古いサーバーでも壊れない | 方針 2（`receivedAt?` と `??=`） |
| 実機で通す | `scripts/verify-printer-report-history.mjs`（新規） |
