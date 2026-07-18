# 仕様: スプールファイルの一覧・取得

## 概要

既存スプールを **pull 型**で一覧・取得する。現状の `PrinterSession`（push 型）を
置き換えるのではなく、**別の入り口として補完**する。

- **一覧**: `QGYOLSPL`（コマンドサーバー経由）
- **中身**: ネットワーク印刷サーバー（`0xE003` / 8474・9474）

## 設計方針

### D1: SQL ではなくホストサーバー経由で通す（ユーザー判断）

research で **SQL 経路（`QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC` /
`SYSTOOLS.SPOOLED_FILE_DATA`）でも一覧・中身とも取得できることを実機で確認済み**。
新規コードがほぼゼロで済むため一度は主経路の候補だったが、**ホストサーバー経由で統一する**
方針を採る。

理由:
- SQL 経路はカタログビューに依存し、古い IBM i では使えない
- ネットワーク印刷サーバーは中身取得だけでなく**保留・解放・削除・移動、
  メッセージ取得・応答、ライター開始/終了**まで扱える。ここを実装しておくと
  後続の MSGW 作業がその上に載る

> **SQL でも同じことができる**という事実は README に残す（採用しないだけで、
> 環境によっては有用な代替手段であるため）。

### D2: 中身の正しさは SQL と突き合わせて確認する

採用しないが、**検証には使う**。同じスプールをネットワーク印刷サーバーと SQL の
両方で読み、内容が一致することを実機で確かめる。
「実装した経路が正しい」ことを、独立した経路で裏付ける。

### D3: 今回の範囲は「一覧」と「中身」に絞る

ネットワーク印刷サーバーは保留・解放・削除・メッセージ応答なども扱えるが、
**この作業では実装しない**。MSGW 作業（次の次）でまとめて扱うほうが、
権限の確認も含めて筋が通る。

操作コードの定義だけは置き、実装は段階的に足す。

### D4: 既存資産をそのまま使う

| 必要なもの | 使うもの |
|---|---|
| 認証（`0x7001`/`0x7002`） | 既存 `server-connect.ts`。**サーバー ID を渡すだけ** |
| 20 バイトヘッダー | 既存 `hostserver/datastream.ts` |
| プログラム呼び出し | 前作業の `CommandConnection.call()` |
| EBCDIC | 既存 `codec`（CCSID 37） |

ネットワーク印刷サーバーのデータストリームは
**20 バイトヘッダー ＋ 12 バイトテンプレート ＋ LL/CP**。既存の枠組みに収まる。

## 対象範囲

新規: `packages/core/src/hostserver/spool/`

| ファイル | 責務 |
|---|---|
| `spool-list.ts` | `QGYOLSPL` の呼び出しとレコード解析（一覧） |
| `netprint-datastream.ts` | ネットワーク印刷サーバーのヘッダー・テンプレート・操作コード |
| `netprint-connection.ts` | 接続と OPEN→READ→CLOSE（中身取得） |
| `spool-types.ts` | 一覧項目・識別子の型 |

変更: `index.ts`、`port-mapper.ts`（`print` サービスを追加）

**対象外**: 保留・解放・削除・移動、メッセージ応答、ライター操作（D3）、PDF 化、MCP、Web UI

## インターフェース / データ構造

```ts
/** スプールを一意に指す識別子。一覧の結果をそのまま中身取得へ渡せる */
export interface SpoolId {
  /** 例 "WEBEMU01" */
  jobName: string;
  jobUser: string;
  /** 例 "672961" */
  jobNumber: string;
  /** 例 "QPJOBLOG" */
  fileName: string;
  fileNumber: number;
}

export interface SpoolEntry extends SpoolId {
  outputQueue: string;
  outputQueueLibrary: string;
  status: string;
  totalPages: number;
  currentPage: number;
  copies: number;
  userData: string;
  formType: string;
  /** 例 "2026-07-18-16.46.05" */
  createdAt: string;
}

export interface SpoolListFilter {
  /** 既定は接続ユーザー。* は使わない（各配列に最低 1 件必要なため *ALL を入れる） */
  user?: string;
  outputQueue?: string;
  outputQueueLibrary?: string;
  status?: string;
}

/** 一覧（コマンドサーバー経由） */
export function listSpooledFiles(
  conn: CommandConnection, filter?: SpoolListFilter, opts?: { max?: number }
): Promise<SpoolEntry[]>;

/** 中身（ネットワーク印刷サーバー） */
export class NetPrintConnection {
  static connect(opts: NetPrintConnectOptions): Promise<NetPrintConnection>;
  /** 1 行 1 レコードのテキストとして読む */
  readSpooledFile(id: SpoolId): Promise<string[]>;
  close(): void;
}
```

## 振る舞いの詳細

### 一覧（QGYOLSPL）

research F2 で実機確認済みの手順。**推測しない**:

```
パラメータ 10 個。修飾ジョブ名は【空白】（*ALL は CPF3342 で弾かれる）
フィルタ OSPF0100 は【件数と配列が交互に並ぶ連続配置】。オフセット表ではない:
  ユーザー数(4) + [名前(10)+予約(2)]×n
  OUTQ 数(4)    + [名前(10)+ライブラリ(10)]×n
  用紙タイプ(10) / ユーザーデータ(10)
  状態数(4)     + [状態(10)+予約(2)]×n
  装置数(4)     + [装置(10)+予約(2)]×n
各配列は最低 1 件必要。絞り込まない場合は *ALL を入れる
```

リスト情報（80）: 総件数(0) / 返却件数(4) / ハンドル(8) / レコード長(12)。
レコード（OSPL0300・136）の配置は**原典を読んで確定させる**
（research F5 の反省。実機で確認できたのは先頭 36 バイトのみ）。

### 中身（ネットワーク印刷サーバー）

```
20 バイトヘッダー（サーバー ID 0xE003）
12 バイトテンプレート: 操作 ID(2) / フラグ(4) / 戻りコード(2) / EO(4)
LL/CP のコードポイント列

手順: OPEN(0x0002) → READ(0x0003) を繰り返す → CLOSE(0x0005)
```

## エラー処理 / 異常系

| 状況 | 扱い |
|---|---|
| 一覧の API 失敗 | 前作業の `CommandError`（メッセージ ID 付き） |
| 存在しないスプール | ネットワーク印刷サーバーの戻りコードを分類して返す |
| 権限不足 | 同上。**他人のスプールは見えない**のが正常 |
| 接続不可・証明書 | 既存の `CONNECT_FAILED` / `TLS_CERT_INVALID` |

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| QGY で一覧 | 実機（research で成功済み） |
| ネットワーク印刷サーバーで中身取得 | 実機 |
| **SQL の結果と一致** | 同じスプールを両方で読んで突き合わせ（D2） |
| 識別子が繋がる | 一覧の `SpoolId` をそのまま `readSpooledFile` へ |
| 解析の単体テスト | 実機の生バイト列を固定値にする |
| 資格情報が平文で出ない | トレース出力を検証 |
