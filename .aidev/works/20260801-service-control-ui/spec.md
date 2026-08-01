# 仕様: サービスの操作を画面から行う

## 概要

サーバー側は揃っている。**画面をサーバーの語彙に合わせる**だけ——`ServiceState`
（`stopped` / `listening` / `reconnecting` / `error`）を描き、開始/停止を送る。

新しい概念は作らない。**プリンターと監視で同じ言葉・同じ並び**にする
（利用者が「これはプリンターも待ち行列も同じです」と言った通り）。

## 設計方針

### 1. printer 設定を編集者に返す（**先に直す**）

いまの `GET /api/sessions-config` は printer の中身を返さない（`hasOutput` フラグのみ）。
更新は**オブジェクトごと置き換え**なので、**名前を直して保存しただけで `autoPdfDir` が消える**。

`サービス` ✅ を同じ `printer` ブロックに足すと、**この欠陥に乗る**——
✅ を入れて保存した瞬間に PDF 保存先が消える。順序として**先に直す**。

**直し方は `pcCommand` の前例をそのまま踏む**（`config-store.ts` の
「値を返さないと保存のたびに消える」）:

- `publicSession(s, { includeTrusted })` が `pub.printer` を返す
- 返す相手は `canEditServer`（認証オフ or admin かつ永続化可）**だけ**
- フラグ（`service` / `hasOutput`）は**従来どおり誰にでも返す**——
  定義の一覧（#256）はこれを使うので、そこは変えない

**なぜ安全か**: 値を受け取れるのは、その値を**書ける**相手と同じ集合。
非編集者には従来どおりフラグだけで、パスもプリンター名も出ない。

### 2. `サービス` ✅ の置き場所は信頼設定欄

`service` は printer スキーマ＝**サーバー設定にしか無い**（`config-types.ts`）。
すでにある `canEditPrinter`（サーバー設定 かつ 編集権限 かつ printer）と条件が**完全に一致**する
ので、既存の「サーバー側の出力（信頼設定）」欄にそのまま置く。**新しい認可条件を作らない**
——散らすと食い違う。

### 3. `自動で待ち受け開始` ✅ は普通の欄

`autoStart` は `sessionBase`＝**個人設定も持てる**（信頼設定ではない）。
だから信頼設定欄ではなく通常のフォームに置き、`printer` / `dtaqwatch` のときだけ出す
（`display` は画面なので常に開く）。

**既定は ✅（`autoStart !== false`）。** いまある定義の挙動を変えない（#253 design D3）。

### 4. 状態表示は監視の見た目に寄せる

`WatchPane.vue` が既に `listening` / `reconnecting` / `stopped` / `error` を色分けして出している。
**プリンターも同じ言葉・同じ色**にする。ラベルだけ用途に合わせる:

| `ServiceState` | 監視 | プリンター |
|---|---|---|
| `listening` | 監視中 | 待ち受け中 |
| `reconnecting` | 再接続中 | 再接続中 |
| `stopped` | 停止中 | 停止中 |
| `error` | エラー | エラー |

**共通化はしない。** 2 コンポーネントで語が 1 つずつ違うだけなので、
共有部品にすると引数で分岐する層が増えて読みにくくなる。

### 5. 監視は「停止」と「再開」を出し分ける

いまは常に `停止` が出ていて、押すと消える（#254 前は行ごと消えていた）。
`stopped` の行には **`開始`** を出し、`watch-resume` を送る。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/server/src/config-types.ts` | `PublicSession.printer?`（編集者にだけ返る） |
| `packages/server/src/config-store.ts` | `publicSession` が `includeTrusted` で `printer` を返す |
| `packages/web-ui/src/stores/systems.ts` | `SessionConfigForm.autoStart` / `printer.service` |
| `packages/web-ui/src/stores/sessions.ts` | `SessionState.state` / `serviceError` |
| `packages/web-ui/src/session-controller.ts` | `printer-state` の反映、`startPrinter` / `stopPrinter` |
| `packages/web-ui/src/stores/watches.ts` | `resume(id)` |
| `packages/web-ui/src/components/ConfigCard.vue` | ✅ 2 つ、printer 設定の読み込み、詳細行 |
| `packages/web-ui/src/components/PrinterPane.vue` | 開始/停止ボタン、状態表示 |
| `packages/web-ui/src/components/WatchPane.vue` | 停止/開始の出し分け |

## インターフェース / データ構造

```ts
// config-types.ts — 信頼設定なので編集できる相手にだけ返る（pcCommand と同じ）
export interface PublicSession {
  // …
  /** `printer` のみ。**編集できる相手にだけ返す**（`includeTrusted`）。
   *  返さないと編集フォームが空から始まり、保存のたびに出力設定が消える */
  printer?: PrinterConfig;
}

// stores/sessions.ts — サーバーの語彙をそのまま持つ
interface SessionState {
  // …
  /** 待ち受けの状態（printer のみ）。未設定は listening 相当（直接接続の従来経路） */
  state?: ServiceState;
  /** `state === "error"` の理由 */
  serviceError?: string;
}

// session-controller.ts
export function startPrinter(sessionId: string): void; // → { type: "printer-start", sessionId }
export function stopPrinter(sessionId: string): void;  // → { type: "printer-stop",  sessionId }

// stores/watches.ts
resume(id: string): void; // → { type: "watch-resume", watchId: id }
```

## 振る舞いの詳細

### プリンターのツールバー

```
[«] [プリンター] [● 待ち受け中] 起動: I902  受信 3 件      … [停止] [自動出力: ON] …
[«] [プリンター] [○ 停止中]              受信 3 件      … [開始] …
[«] [プリンター] [✕ エラー: 装置が使用中]  受信 0 件      … [開始] …
```

- **停止中でも受信済みの帳票は消えない**（サーバーがそう作ってある）。一覧はそのまま出す。
- 一覧が空のときの案内文（`スプール待ち受け中…`）は、**待ち受けているときだけ**出す
  ——停止中に「待ち受け中…」と出すのは嘘。
- 開始は非同期で失敗しうる（装置使用中など）。**失敗はサーバーが `printer-state` の
  `error` で返す**ので、画面は送るだけでよい。

### 監視の行

```
キュー         受信  未読  状態     操作
MYLIB/ORDERQ    12    3   監視中   [停止]
MYLIB/LOGQ       0    -   停止中   [開始]
```

### エッジケース

| 状況 | 振る舞い |
|---|---|
| 停止中に閉じる | サービス（`service ✅`）ならサーバーに残る。そうでなければ従来どおり消える |
| `error` から開始 | 送れる（サーバーが `stopped` / `error` からのみ開始する） |
| 二重クリック | サーバー側が冪等（#254）。画面でも押している間は無効にする |
| 直接接続（定義なし）のプリンター | `state` は届く。開始/停止も効く（`openOpts` を持っているため） |

## ドメイン固有の考慮

- **信頼境界**（AGENTS.md 5 層目）: `printer` の値を返す相手を `canEditServer` に限る。
  個人設定は printer スキーマを持たない（`.strict()` で弾かれる）ので、そもそも出ない。
- **押しても 403 になるボタンを出さない**: `サービス` ✅ は `canEditPrinter` の欄に置く。
- **`vue-tsc` を必ず走らせる**: `tsc -b` は SFC のテンプレートを型検査しない
  （`20260801-source-comment-sweep` で踏んだ）。

## エラー処理 / 異常系

- 開始の失敗（装置使用中・ホスト不達）→ `printer-state` の `error` ＋ 理由。ツールバーに出す。
- 監視の再開の失敗 → `watch-state` の `error`（既存経路）。
- 設定保存の失敗 → 既存の `error` 表示。

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| ✅ 2 つを保存・再読込できる | `publicSession` が返し、`loadSession` が読む |
| 保存で printer 設定が消えない | 方針 1（返す→読む→送り返す） |
| `自動で待ち受け開始 ☐` で開くと停止中 | サーバー既存（#254）。画面は `printer-opened.state` を持つだけ |
| 停止で受信済みが残る | サーバー既存（#254）。画面は一覧を消さない |
| 監視の停止→再開 | `watch-resume`（#254）を画面から送る |
| ビルドと全テスト | `npm run build` / `vue-tsc` / `npm test` |
