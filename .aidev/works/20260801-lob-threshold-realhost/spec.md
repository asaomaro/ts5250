# 仕様: LOB フィールドしきい値を使えるようにする

`research.md` の実測を受けて決めた内容。

## 概要

しきい値を接続時に指定できるようにし、**しきい値以下で行データに載って届く LOB を復号する**。
**既定は 0（＝常にロケーター）のまま変えない。**

## 設計方針

### D1: 採る。ただし**既定は動かさない**

実測（F4）では、LOB セル 6 個で**往復 12 → 4**。実機では体感差が小さいが、
**PUB400 は 1 往復 4〜7 秒**なので 8 往復の差は 30 秒以上になる。使う価値がある。

一方、**中身が要らないときにも行がふくらむ**（982 → 5,078 バイト＝5.2 倍）。
過去の実測（DBCLOB(2M) 2 行で応答 8.4MB）はしきい値を上げた瞬間に再現する。
よって**既定は 0 のまま**、上げるのは呼び出し側が明示したときだけ。

### D2: オプションを足すなら**復号まで実装する**（半端なオプションを置かない）

`lobFieldThreshold` だけ足して復号を放置すると、
**指定した瞬間に `HOST_SERVER_UNSUPPORTED` で落ちるオプション**になる（F2）。
それは「使えない設定を公開面に置く」ことなので、本 work で復号まで入れる。

### D3: 値の形は `LobPlaceholder` のまま（利用側に分岐を増やさない）

同じ列が、接続時の設定次第で**ロケーター経由でもインラインでも届く**。
利用側（画面 / CSV / MCP）に「どちらで来たか」を意識させない。

- `value` … 中身（CLOB/DBCLOB は文字列・BLOB は `Uint8Array`）
- `byteLength` … バイト数
- `locator: 0` … **インラインなのでロケーターは無い**（取り直す先も無い）
- `unavailable` … 付かない（取れているため）

**採らなかった案**: CLOB を素の `string` で返す。`DbValue` は `Uint8Array` を許さないので
BLOB が表現できず、**型ごとに形が変わる**。JSON 化（`/api/host/sql` / `host_sql`）でも
`Uint8Array` は `{"0":1,…}` に化ける。

### D4: 長さの単位は型で分ける（実測どおり）

| 型 | 接頭辞 4 バイトの意味 | 本体の読み方 |
|---|---|---|
| `CLOB` (408) | **バイト数** | `decodeText(ccsid)` |
| `BLOB` (404) | **バイト数** | そのまま `Uint8Array` |
| `DBCLOB` (412) | **文字数** | `chars * 2` バイトを `decodeGraphic(ccsid)` |

DBCLOB を他と同じ「バイト数」で書いた最初の実装は、実機で `日本語` を `日` にした（F3）。
**SBCS だけで試すと通ってしまう**ので、テストは全角で固定する。

### D5: しきい値の丸めは「安全側へ倒す」

`clampLobThreshold`: 未指定・0 以下・**非有限**は **0**。上限は **15,728,640**。

`Infinity` を「上限いっぱい」と読まない——**上げる方へ倒すと静かにメモリを食う**。
意図しない値が来たら常にロケーター側へ落とす。上限は原典が自分で切り下げている値
（公表の 16,777,216 は通らない。`20260801-lob-batch-retrieval-research`）。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/hostserver/src/db/db-connection.ts` | `lobFieldThreshold` オプション・`MAX_LOB_FIELD_THRESHOLD`・`clampLobThreshold` |
| `packages/hostserver/src/db/db-types.ts` | `SUPPORTED` に `CLOB` / `DBCLOB` / `BLOB` を追加 |
| `packages/hostserver/src/db/db-decode.ts` | インライン LOB の復号（D4）＋ `inlineLob` |
| `packages/hostserver/test/db-decode-inline-lob.test.ts` | 新規（並びを固定） |
| `packages/hostserver/test/db-connection-lob-threshold.test.ts` | 新規（丸めを固定） |
| `packages/hostserver/test/db-types.test.ts` / `db-decode.test.ts` | 「LOB は対象外」を実態へ |
| `scripts/research-lob-threshold.mjs` | 新規（再現） |

**変更しない**: 既定のしきい値（0）／`/api/host/sql`・MCP の入口（呼び出し側が
しきい値を指定する経路は**今回作らない**。使い道が固まってから）。

## エラー処理 / 異常系

- 宣言幅を超える長さが来たら `PROTOCOL_ERROR` で落とす（`assertVarLength`）。
  **黙って隣の列を巻き込むより落ちる方が良い**
- 未知の CCSID の DBCLOB は `decodeGraphic` が `HOST_SERVER_UNSUPPORTED` を投げる（既存の挙動）

## 受け入れ基準との対応

requirement の完了条件に一対一で対応（`test-result.md` に結果）。
