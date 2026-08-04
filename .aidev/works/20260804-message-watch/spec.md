# 仕様: メッセージ待ち行列の待ち受け

## 概要

既存の**監視**（`WatchRegistry` / `WatchPane` / `sessionType: "dtaqwatch"`）に、
**2 つ目の種類**としてメッセージ待ち行列を足す。届いたら WS で push する。

**新しい箱は作らない。** 寿命・状態・バックオフ・所有・履歴・転送は
`20260723-dtaq-watch-notify` 以降で作り込んだ規則をそのまま使う。

## 設計方針

### 方針1: `WatchRegistry` を「待ち方」だけ差し替えられる形にする

いまの `WatchRegistry` は骨格（寿命・再接続・履歴・購読）と
中身（`openDtaq` / `DtaqConnection.read`）が固く結び付いている。

**骨格は全部共通で、違うのは「開く」と「1 件待つ」だけ**なので、そこだけを

```ts
interface WatchSource { open(): Promise<WatchLink>; }
interface WatchLink { next(): Promise<WatchItem | undefined>; close(): void; }
```

に切り出す。`loop()` / `push()` / `setState()` / バックオフは**一切変えない**。

**代替案（退けた）**: 別レジストリ `MessageWatchRegistry` を作る。
→ 寿命の規則・状態語彙・購読・所有判定が**丸ごと二重化**する。規則が 2 か所に
分かれた瞬間に片方だけ直る事故が起きる（`ServiceState` を共有語彙にした理由と同じ）。

### 方針2: **消さない**（`*SAME`）

データ待ち行列の監視は**消費する**（本番のコンシューマの取り分を奪うので警告を出している）。
メッセージ待ち行列は `QMHRCVM` のメッセージ動作に `*SAME` を渡せば**状態を変えない**。

**これは重要な違い**なので、`MSG_WATCH_CONSUMES` の警告は
**メッセージ待ち行列には出さない**——出すと嘘になる。

### 方針3: カーソルは「最後に見たキー」

`*NEXT` ＋ 直前のキーで次の 1 件を待つ（実機で確認）。

**始めた時点より前のものは流さない**。`QSYSOPR` には 365 件溜まっていることがあり、
始めた瞬間に 365 件が push されると通知として使い物にならない。

- 始めるとき、`*LAST` を待ち 0 で 1 回引いて**いまの末尾のキー**を取る
- 空なら `*FIRST` で待つ（最初の 1 件が来たら、そこからカーソルが始まる）
- 「既にあるぶんも欲しい」場合のために `includeExisting` を用意する（既定 false）

## 対象範囲

| ファイル | 変更 |
| --- | --- |
| `packages/hostserver/src/command/command-connection.ts` | `call()` に**この 1 往復だけの read タイムアウト**を足す |
| `packages/hostserver/src/command/message-receive.ts` | **新規**。`QMHRCVM` の組み立てと `RCVM0200` の読み取り |
| `packages/server/src/watch-source.ts` | **新規**。`WatchSource` / `WatchLink` と dtaq 版 |
| `packages/server/src/host-msgwatch.ts` | **新規**。メッセージ待ち行列版の `WatchSource` |
| `packages/server/src/watch-registry.ts` | 骨格を種類非依存にする |
| `packages/server/src/config-types.ts` | `sessionType: "msgwatch"` と `msgWatch` |
| `config-store.ts` / `boot-autostart.ts` / `service-reconcile.ts` / `host-printers.ts` | 種類の追加ぶん |
| `packages/web-ui/src/components/{ConfigCard,WatchPane}.vue` ほか | 表示 |

## インターフェース / データ構造

### `QMHRCVM` の呼び出し（実機で確定済み。research F2）

```
0 メッセージ情報   char(512) out
1 その長さ         bin(4)    in
2 形式名           char(8)   in   "RCVM0200"（**`0100` は置換データしか返さない**）
3 修飾名           char(20)  in   待ち行列(10)＋ライブラリー(10)
4 メッセージ種別   char(10)  in   *LAST / *FIRST / *NEXT
5 メッセージキー   char(4)   in   **使わないときは空白（0x40）。0 埋めは CPF2551**
6 待ち時間         bin(4)    in   秒。**無限にはしない**（下記）
7 メッセージ動作   char(10)  in   "*SAME"（**消さない**）
8 エラーコード     char(8)   inout
```

**返りが 8 バイト以下＝何も無い**（見出しだけ）。

### `RCVM0200` の並び（実機で確定）

```
0-3  返ったバイト数   4-7  利用可能なバイト数   8-11 重大度
12-18 メッセージ ID（空白 7 個＝即時メッセージ）
19-20 種別（"05" が照会）   21-24 キー
152/160/168 置換データ・本文・二次レベルの長さ（返った/使える の対）
176-        置換データ → 本文 → 二次レベル
```

本文の位置は**長さ項目から求める**（決め打ちしない）。
**即時メッセージは置換データの側に本文が入る**（本文の長さが 0 になる）。

### 設定

```ts
export const msgWatchSchema = z.object({
  library: z.string().min(1).max(10),   // QSYS
  name: z.string().min(1).max(10),      // QSYSOPR
  onlyInquiry: z.boolean().optional(),  // 照会だけ拾う
  includeExisting: z.boolean().optional() // 既にあるぶんも流す（既定 false）
}).strict();
```

### 待ち受け 1 本（`WatchView`）

`kind` を `"dtaq" | "msgq"` に広げる。**他の項目は変えない。**

受信 1 件（`WatchEntryView`）には `message` を足す（メッセージ待ち行列のときだけ）:

```ts
message?: { key: string; id?: string; type: string; severity: number; inquiry: boolean };
```

## 振る舞いの詳細

- **待ち方**: 1 回 30 秒待って、時間切れなら掛け直す。ソケットの read タイムアウトは
  **この往復だけ**延ばす（既定 20 秒のままでは待ち切れない）。
  **無限に待たない**理由は research F8——ホスト側のジョブが待ち行列を掴んだままになり、
  `DLTMSGQ` が永久に通らなくなる。通知の速さは変わらず、何も来ないときに 1 分 2 往復するだけ
- **絞り込み**: `onlyInquiry` は**受け取ってから種別で捨てる**。
  `*INQ` と `*NEXT` は排他（どちらもメッセージ種別の欄）なので、ホスト側では絞れない。
  **捨てたぶんもカーソルは進める**（進めないと同じものを永久に読み続ける）
- **消さない**: 待ち受けたメッセージは一覧に残り、照会には後から応答できる
- **重複しない**: カーソルが単調に進むので、同じキーは 2 度出ない

## エラー処理 / 異常系

| 事象 | 扱い |
| --- | --- |
| 待ち行列が無い / 権限が無い | `error`（**張り直さない**。既存の `FATAL_CODES`） |
| `CPF2451`（割り振り不可）等 | `reconnecting` でバックオフ |
| 返りが 8 バイト以下 | 何も無い。**読み直す**（`continue`。dtaq と同じ扱い） |
| カーソルのキーが消された | `*NEXT` が `CPF2551` を返しうる → **`*LAST` で取り直す**（欠測は記録に残す） |

## ドメイン固有の考慮

- **`QSYSOPR` は共有資源**。`*SAME` なので他人のメッセージに触れない（実機で確認する）
- 名前は既存の `assertName`（`host-message.ts`）で検査する——CL 文字列に流れる経路と同じ規則
- **本文をログに出さない**（メッセージ本文に業務データが載る）

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
| --- | --- |
| 待ち受けられる | `sessionType: "msgwatch"` の定義から `WatchRegistry` が起動 |
| 届いたら push | 既存の `WatchEvent.entry` に相乗り（WS の経路は変更なし） |
| 照会だけに絞れる | `onlyInquiry` |
| 消えない | `*SAME`。実機で件数が変わらないことを確認 |
| 二度出ない | `*NEXT` カーソル。実機で連番を確認 |
| 実機で確認 | `scripts/verify-message-watch.mjs` |
