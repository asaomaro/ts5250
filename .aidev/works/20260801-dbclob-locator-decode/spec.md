# 仕様: ロケーター経由の DBCLOB を直す

## 設計方針

### D1: 判定を `db-decode.ts` に集約する（2 か所に書かない）

欠陥の根は「同じ CCSID 判定が `db-decode.ts` と `query.ts` にあり、片方だけ正しい」こと。
**片方を直すのではなく、正しい側に寄せて重複を消す。**

- `isTwoByteCcsid(ccsid)` を新設（UTF-16 ∪ 純 DBCS）
- `decodeLobBytes(bytes, ccsid)` を新設（UTF-16 / 純 DBCS / 混在 の順に試し、
  未知はバイト列のまま）
- `query.ts` のローカル `decodeLob` は**削除**して `decodeLobBytes` を使う

### D2: 長さは CCSID が判明してから換算する

`lobDataLength`（総長）は `lobData`（CCSID を含む）**より先に**読まれるので、
申告値をそのまま `totalLength` に入れられない。`declaredTotal` に取っておき、
CCSID が分かった時点で `× perChar` する。

`perChar = isTwoByteCcsid(ccsid) ? 2 : 1`。本体の切り出しも同じ係数を掛ける。

### D3: 混在 CCSID の CLOB は触らない

実機で元から正しいと確認済み（research F3）。`perChar = 1` なので式に通しても値は変わらない。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/hostserver/src/db/db-decode.ts` | `isTwoByteCcsid` / `decodeLobBytes` を新設・公開 |
| `packages/hostserver/src/db/lob.ts` | 申告長を CCSID で換算 |
| `packages/hostserver/src/db/query.ts` | ローカル `decodeLob` を削除し共有版へ |
| `packages/hostserver/test/lob-ccsid-units.test.ts` | 新規（単位と復号） |
| `scripts/research-dbclob-locator.mjs` | 新規（実機の再現） |

## 受け入れ基準との対応

requirement の完了条件に一対一（結果は `test-result.md`）。
