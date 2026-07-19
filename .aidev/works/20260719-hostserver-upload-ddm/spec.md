# 仕様: DDM レコードレベル書き込み

## D1. レコードの列レイアウトは SQL から得る（DDM の record format reader を実装しない）★

原典は `DDMRecordFormatReader`（135 行）＋ **`DDMField`（1,220 行）** で列情報を扱うが、
**このプロジェクトには既に動作実績のある SQL がある**（`20260718-hostserver-sql`）。

`QSYS2.SYSCOLUMNS` から列の順序・型・長さ・精度・位取り・NULL 可否が取れるので、
そこからレコードバッファのオフセットを計算する。

**根拠**:

1. **移植量が桁で違う**。`DDMField` 1,220 行の書き起こしを丸ごと回避できる
2. **既に検証済みの経路を使う**。SQL は実機で全型の取得を確認済み
3. **検証が別経路になる**——DDM で書いて **SQL で読み返す**ので、
   レイアウトの計算が間違っていれば読み返しで露見する（同じ経路で確認しない）

**この案が抱えるリスクと対処**: SQL のメタデータから物理レコードの配置を導けるかは
**仮説**である。固定長型が宣言順に連続配置される前提に立っており、
可変長・日付時刻・DBCS では崩れうる。

→ **対応する型を絞り、対応外は書き込み前に明示的に失敗させる**（D2）。
   そして**実機の往復で仮説を検証する**。**崩れたら DDM の record format 経路に切り替える**
   のではなく、まず**実測して事実を記録**する（推測で直さない）。

## D2. 対応する型を絞る

| SQL の型 | 物理表現 | 対応 |
|---|---|---|
| `CHAR` | 固定長 EBCDIC・右空白詰め | ✅ |
| `NUMERIC` | ゾーン 10 進 | ✅ |
| `DECIMAL` | パック 10 進 | ✅ |
| `SMALLINT` / `INTEGER` / `BIGINT` | 2 / 4 / 8 バイト ビッグエンディアン | ✅ |
| 上記以外（`VARCHAR` / `DATE` / `TIME` / `TIMESTAMP` / `GRAPHIC` / 浮動小数 …） | — | ❌ **明示的にエラー** |

**黙って壊れた値を書かない。** 対応外の型を含むファイルは、書き込み前に
`HOST_SERVER_UNSUPPORTED` で失敗させる（型名を添える）。

> `VARCHAR` を落とすのは、2 バイトの長さ接頭辞を持つため配置計算が変わり、
> **実機で確かめずに実装すると壊れたデータを書く**リスクがあるため。
> 対応するなら実測してからにする（backlog へ）。

## D3. スコープは「追記」だけ

- 対象: **既存の物理ファイルにレコードを追記**（`S38PUTM` + `S38BUF`）
- 対象外: 読み取り・キー付きアクセス・更新・削除・ファイル作成
  （読み取りは SQL がある。ファイル作成は `host_command` の CL で足りる）

## D4. 既存の transport を共有しない

DDM のフレームは **6 バイトヘッダー**（LL / GDS ID / フォーマット ID / 相関 ID）で、
`transport/host-connection.ts` の 20 バイト前提と違う（research F1）。

**無理に共通化しない。** 共有するのはソケットを開く層（`openHostConnection` の下の TCP/TLS）
までとし、フレームの読み書きは DDM 専用に持つ。
前作業で「早すぎる共通化で両者を結びつけない」と判断したのと同じ理由。

ただし **signon（passwordLevel の取得）とパスワード置換値の生成は既存を再利用する**——
原典自身が `// Copied from HostServerConnection.` と書いており、同一であることが確認できている。

## 2. ファイル構成

```
packages/core/src/hostserver/ddm/
  ddm-connection.ts   接続（EXCSAT/ACCSEC/SECCHK）・open・write・close
  ddm-datastream.ts   DDM のフレーム組み立てと解析（6 バイトヘッダー・LL/CP）
  record-layout.ts    SQL のメタデータ → レコードバッファの配置（純関数）
  encode.ts           値 → バイト列（ゾーン/パック 10 進・文字・整数。純関数）
```

**`record-layout.ts` と `encode.ts` を純関数に切り出す**のが要点——
ここが「真の難所」（SQL 実装 retro）であり、実機なしで単体テストできる形にしておく。

## 3. API

```ts
export interface DdmConnectOptions {
  host: string; user: string; password: string;
  port?: number; tls?: boolean | HostTlsOptions; resolvePort?: boolean; timeoutMs?: number;
}

export class DdmConnection {
  static connect(opts: DdmConnectOptions): Promise<DdmConnection>;
  /** 書き込み用に開く。レコード長・間隔・NULL マップ位置を得る */
  open(library: string, file: string, opts?: { member?: string; recordFormat?: string }): Promise<DdmFile>;
  /** レコードを 1 件追記する */
  write(file: DdmFile, values: readonly DbValue[]): Promise<void>;
  close(file: DdmFile): Promise<HostMessage[]>;
  disconnect(): void;
}

/** SQL のメタデータからレコード配置を作る（純関数） */
export function buildRecordLayout(columns: readonly ColumnLayoutInput[]): RecordLayout;
```

`values` は列の宣言順。**列数が合わなければエラー**（黙って詰めない）。

## 4. 受け入れ基準

- [ ] DDM に接続・認証できる（実機）
- [ ] 既存物理ファイルを書き込みで開き、レコード長・間隔を取得できる
- [ ] レコードを追記でき、**SQL の SELECT で読み返して一致する**（別経路の確認）
- [ ] 対応外の型を含むファイルは書き込み前に `HOST_SERVER_UNSUPPORTED`
- [ ] 列数不一致・値の桁あふれが明示的なエラーになる
- [ ] `record-layout.ts` / `encode.ts` に単体テスト
- [ ] `tsc -b` / lint / 既存テスト緑
- [ ] 参照コメントに原典のクラス／メソッド名
- [ ] 実機に作ったテスト用ファイルを**後片付け**する

## 5. 失敗時の安全性（requirement 要検討 2）

**コミット制御は使わない**（原典の `commitmentControl` は false 固定）。
つまり**書いたレコードは即座に確定し、途中で失敗しても巻き戻らない**。

これは DDM の追記としては通常の挙動だが、**利用者に対して保証を偽らない**——
API の JSDoc に「途中で失敗した場合、それまでに書いたレコードは残る」と明記する。
複数レコードの原子性が要るなら、それは呼び出し側が SQL のトランザクションや
`host_command` の CL で扱う話であり、この層では扱わない。

検証は **MYLIB に作った使い捨てファイル**に対してのみ行い、終わったら消す。
