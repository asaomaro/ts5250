# @ts5250/hostserver

IBM i の**ホストサーバー群**（signon / database / command / network print / file / data queue / DDM）
を相手にするクライアント。**TN5250 の端末プロトコルは含まない**——「IBM i に SQL を投げたい／
IFS を読み書きしたいが、画面エミュレーションは要らない」利用者のために `@ts5250/tn5250` から
切り出したパッケージである。

> **逆向きの依存（ここから `@ts5250/tn5250` を import すること）は作らない。** 切り出しの意味が
> 消えるため、`test/no-core-dependency.test.ts` が src 全体を走査して検査している。

装置名（デバイス）もセッションも要らず、**単発で叩ける**のが 5250 経由との違い。画面レイアウトの
変化に壊されない。

## できること

| 相手のサーバー | 提供するもの |
|---|---|
| **signon** | 認証（パスワードレベル 0 の DES 経路にも対応）、ポートマッパー、戻りコードの分類 |
| **database** | SQL（SELECT / DML / DDL・手続き・関数・`CALL`）、列メタデータ、LOB（ロケーター／しきい値）、上限つき取得、**実行計画**（自ジョブの DB モニターで採取・索引の助言つき） |
| **command** | CL コマンドの実行、**コマンド定義の取得とテンプレートからの組み立て**（実機の F4 相当）、プログラム / サービスプログラムの呼び出し（型付き引数）、**PCML** からの呼び出し |
| **network print** | スプールの一覧（コマンドサーバー）と中身の取得 |
| **file** | IFS の読み書き |
| **data queue** | 送受信・peek・作成・クリア・削除・属性 |
| **DDM** | レコードレベルの書き込み |
| — | メッセージ待ち行列（一覧・送信・**照会への応答**・削除）、各種一覧（QGY オープンリスト）、CSV → 表の取り込み |

## 使い方

```ts
import { signon, DbConnection, queryLimited } from "@ts5250/hostserver";

const creds = { host: "pub400.com", user: "MYUSER", password: "…" };

await signon(creds);                       // 認証だけ確かめる
const db = await DbConnection.connect(creds);
const res = await queryLimited(db, "SELECT * FROM QIWS.QCUSTCDT", { limit: 200 });
console.error(res.rows.length, res.truncated);
```

**`export *` は使わない**（`index.ts` に公開面を列挙する）。何が外に出ているかを目視できる形に保つため。

## 検証

- ユニット: `npm test -w @ts5250/hostserver`
- 実機の手動チェック: `tools/hostserver-check`（SQL / CL / DDM / IFS / DTAQ）。
  実行規約は [`scripts/README.md`](../../scripts/README.md)。
