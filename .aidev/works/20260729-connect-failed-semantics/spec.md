# 仕様: `CONNECT_FAILED` の意味を取り戻す

## 概要

server が接続以外の意味で投げている `CONNECT_FAILED` 12 箇所を、実際の意味に合ったコードへ移す。
「セッション上限」だけは合うコードが無いので `SESSION_LIMIT` を足す。あわせて
**腐りの原因（意味が書かれていない・判定がコードの列挙）を塞ぐ**。

## 設計方針

### 方針1: 移す先は 2 つだけ。**新設は 1 つに絞る**

| 移す先 | 対象 | HTTP |
|---|---|---|
| `CONFIG_ERROR`（既存） | 設定ファイルが読めない・スキーマ違反・古い書式・環境変数未設定・資格情報が無い・**指定不足** | 400（**現状と同じ**） |
| `SESSION_LIMIT`（新設） | セッション上限に達した（表示・プリンター） | **409** |

コードを増やすほど呼び出し側の分岐が増える。**利用者の対処が同じものは同じコードにする**——
「設定ファイルを直す」「指定を足す」はどちらも*こちらの設定を直す*で、
`CONFIG_ERROR` の 400 で案内が変わらない。

**「指定不足」に専用コードを作らない理由**: `host or profile required` は
「接続先の設定が決まっていない」であって、`CONFIG_ERROR` の範囲。
新コードを作ると `statusOf` も 400 で同じになり、**区別できても誰も使わない区別**になる。

### 方針2: `SESSION_LIMIT` は 409（「今の状態と衝突している」の棚）

`statusOf` は既に **409 の棚**を持っている——`ALREADY_EXISTS` / `RESOURCE_BUSY` / `NOT_EMPTY`。
共通しているのは「**時間や対象を変えれば通りうる**ので 502（ホストが落ちている）に落とさない」。
セッション上限も**どれか閉じれば通る**ので同じ棚が正しい。

400（現状）だと「要求が間違っている」に見えるが、要求は正しい。戻り型は広げない（409 は既にある）。

### 方針3: `fatal` はコードの列挙をやめ、**状態**で決める

```ts
// 変更前: const fatal = code === "SESSION_CLOSED" || code === "CONNECT_FAILED";
// 変更後: この接続にセッションが無い / 失われた
const fatal = code === "SESSION_CLOSED" || this.sessionId === undefined;
```

コードの列挙で意味を持たせると、**改名のたびに黙って意味が変わる**（この作業そのものがその実例）。
`fatal` を読んでいるクライアントは無い（research F5）ので、今が直す機会。

### 方針4: `ErrorCode` の全種に用途の JSDoc を書く

腐りの原因の半分は「前半 16 種にコメントが無い」こと（research F7。実測 25 種 → 追加後 26 種）。
**近そうなものを選ばせない**ために、各コードに「どういうときに使うか」と、
似ているコードとの**使い分け**を書く（既存の後半 9 種と同じ書き方に揃える）。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/core/src/errors.ts` | `SESSION_LIMIT` を追加。**全 26 種に JSDoc** |
| `packages/server/src/session-manager.ts` | 上限 2 箇所 → `SESSION_LIMIT` |
| `packages/server/src/auth.ts` | 2 箇所 → `CONFIG_ERROR` |
| `packages/server/src/config-store.ts` | 3 箇所 → `CONFIG_ERROR` |
| `packages/server/src/config-resolver.ts` | 2 箇所 → `CONFIG_ERROR` |
| `packages/server/src/mcp-tools.ts` | 2 箇所 → `CONFIG_ERROR` |
| `packages/server/src/ws-handler.ts` | 1 箇所 → `CONFIG_ERROR`、`fatal` を状態判定へ |
| `packages/server/src/host-api.ts` | `statusOf` に `SESSION_LIMIT` → 409 |
| `packages/server/test/session-manager.test.ts` | 上限テストを新コードへ |
| `.aidev/backlog/library-extraction.md` | 当該項目にチェックと結論 |

## インターフェース / データ構造

```ts
/**
 * 同時に開けるセッションの上限に達した（`--max-sessions`。既定 8）。
 *
 * **`CONNECT_FAILED` と分けている理由**: あちらは「IBM i へ繋げなかった」。こちらは
 * **繋ぎに行く前に自分側で断っている**ので、ホストの状態とは無関係。混ぜると
 * 「ホストが落ちている」と「席が空いていない」を受け取った側が区別できない。
 *
 * **`RESOURCE_BUSY` と分けている理由**: あちらはホスト上の対象（IFS のファイル等）が
 * 他に掴まれている状態で、UI が「他の処理が対象を使用中です」と案内する。こちらは
 * **こちらのサーバーの席**の話で、対処は「使っていないセッションを閉じる」。
 */
| "SESSION_LIMIT"
```

`statusOf`:

```ts
case "ALREADY_EXISTS":
case "RESOURCE_BUSY":
case "NOT_EMPTY":
// セッションの席が埋まっている。**どれか閉じれば通る**ので、要求の誤り（400）でも
// ホストの障害（502）でもない
case "SESSION_LIMIT":
  return 409;
```

## 振る舞いの詳細

### 移動表（全 12 箇所）

| 箇所 | 変更後 | HTTP の変化 |
|---|---|---|
| `session-manager.ts:383`（表示の上限） | `SESSION_LIMIT` | 400 → **409** |
| `session-manager.ts:554`（プリンターの上限） | `SESSION_LIMIT` | 400 → **409** |
| `auth.ts:88`（users 読めない） | `CONFIG_ERROR` | 変化なし（起動時。HTTP に出ない） |
| `auth.ts:92`（users スキーマ違反） | `CONFIG_ERROR` | 同 |
| `config-store.ts:391`（設定読めない） | `CONFIG_ERROR` | 変化なし（400 → 400） |
| `config-store.ts:398`（スキーマ違反） | `CONFIG_ERROR` | 同 |
| `config-store.ts:413`（平文パスワード廃止） | `CONFIG_ERROR` | 同 |
| `config-resolver.ts:83`（指定不足） | `CONFIG_ERROR` | 同 |
| `config-resolver.ts:208`（passwordEnv 未設定） | `CONFIG_ERROR` | 同 |
| `mcp-tools.ts:316`（資格情報が無い） | `CONFIG_ERROR` | 同（MCP は本文のみ） |
| `mcp-tools.ts:1065`（指定不足） | `CONFIG_ERROR` | 同 |
| `ws-handler.ts:415`（指定不足） | `CONFIG_ERROR` | 同（WS は `code` を本文に載せるだけ） |

**メッセージ本文は変えない。** 変えると利用者が読む文言まで動き、この作業の範囲がぼやける。

### `fatal` の判定

| 場面 | 変更前 | 変更後 | 妥当性 |
|---|---|---|---|
| `open` が接続失敗（`CONNECT_FAILED`） | true | true | セッションが無い |
| `open` が指定不足（`CONFIG_ERROR`） | true | true | セッションが無い（**コードが変わっても保たれる**） |
| `open` が上限（`SESSION_LIMIT`） | true | true | 同 |
| セッション中に `SESSION_CLOSED` | true | true | 失われた |
| セッション中の `FIELD_TYPE` 等 | false | false | セッションは生きている |
| `open` 前の `key`（`SESSION_NOT_FOUND`） | false | **true** | セッションが無いのは事実 |

最後の 1 行だけ分類が変わる。読んでいるクライアントは無い（research F5）ため実害はなく、
**「セッションが無い」という事実としては変更後のほうが正しい**。

## ドメイン固有の考慮

- **502 は「上流（IBM i）との通信に失敗した」意味に限る**（`host-api.ts` の既存方針）。
  今回の移動はどれも 502 を増やさない
- `describeSocketError()` は `CONNECT_FAILED` に紐づく仕組み（OS のソケットエラーを日本語に）。
  接続以外を `CONNECT_FAILED` にしていると、**この説明が付く余地のない場面に付きうる**。
  移動でその混線も消える
- `As400Error` は npm 公開候補の型。**既存コードは消さない**（足すだけ）

## エラー処理 / 異常系

- 新コードを `statusOf` に足し忘れると **502（ホストの障害）に落ちる**。
  写像表のテストで固定する（`host-ifs.test.ts:123` の形式に倣う）
- `ErrorCode` は union 型なので、綴り違いはコンパイルで落ちる

## 受け入れ基準との対応

| requirement の完了条件 | 満たし方 |
|---|---|
| 接続以外の `CONNECT_FAILED` が残っていない | 12 箇所の移動＋`grep` で確認するテスト |
| 上限が専用コードで、ステータスが対処に合っている | `SESSION_LIMIT` → 409 |
| 設定系が設定系コードになっている | 10 箇所 → `CONFIG_ERROR` |
| `statusOf` が説明つきで整っている | 409 の棚にコメント付きで追加 |
| `fatal` が状態で決まる | `this.sessionId === undefined` |
| 全コードに用途の JSDoc | `errors.ts` 全 26 種 |
| 既存テストが新しい意味で通る | core 2 件はそのまま／server 1 件を書き換え／写像表 1 件は据え置き |
| backlog にチェック | 当該項目に結論を書く |
