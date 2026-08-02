# 調査: 純 DBCS（CCSID 300）と BLOB の 64KB 超（実機 / IBM i 7.3）

再現: `scripts/research-lob-big-dbcs-blob.mjs`

## F1: CCSID 300 の値は倍々に伸ばせる

種は**1200 を経由した二段キャスト**（直接の変換は `-332/57017`。`20260801-pure-dbcs-dbclob`）。
そこから先の連結は**同じ CCSID どうしなので変換が要らない**:

```sql
INSERT … CAST(CAST('あいうえおかきく' AS DBCLOB(1M) CCSID 1200) AS DBCLOB(1M) CCSID 300)
UPDATE … SET P = P || P    -- 15 回
→ P: 524,288 バイト / 262,144 文字
```

**「作れないから測れない」ではなかった。** `20260801-pure-dbcs-dbclob` は小さな値しか
作っていなかったので、大きな値の作り方が分からないままだった。

## F2: 純 DBCS は UTF-16 と同じ道を通る（実測）

```
want=65535 offset=0     → ccsid=300 lenField=65535 body=131070B declared=262144
want=34465 offset=65535 → ccsid=300 lenField=34465 body=68930B  declared=262144
→ 100,000 文字 = 200,000 バイト・先頭から連続・too-large
```

**PR #289 の「同じ枝だから同じはず」は正しかった**——が、それは今回測って初めて事実になった。
往復の形は UTF-16（1200）と完全に同じ（`want` を文字で頼み、`offset` を文字で進める）。

## F3: **BLOB は CCSID `0` ではなく `65535` で来る**（新しい事実）

```
want=65535 offset=0      → ccsid=65535 lenField=65535 body=65535B
want=65535 offset=65535  → ccsid=65535 …
want=65535 offset=131070 → ccsid=65535 …
want=3395  offset=196605 → ccsid=3395B
→ 200,000 バイト・バイト列のまま・先頭から連続・too-large
```

`65535`（0xFFFF）は IBM の「**変換しない**」。`0`（未設定）ではない。

### これが埋まっていた穴

同じ「バイナリか」の判定が **3 か所**にあり、**1 か所だけ欠けていた**:

| 場所 | 判定 |
|---|---|
| `db-reply.ts:108` | `ccsid === 0 \|\| ccsid === 65535` ✅ |
| `marker-encode.ts:233` | `ccsid === 0 \|\| ccsid === 65535` ✅ |
| `db-decode.ts` `decodeLobBytes` | **`ccsid === 0` のみ** ❌ |

BLOB がバイト列で返っていたのは、`codecForCcsid(65535)` が投げて
**`catch`（「未知の CCSID はバイト列で返す」）に落ちていた**から。
**偶然正しかっただけで、65535 に codec を足した瞬間に BLOB が黙って文字列へ化ける**。

doc も嘘だった（`@param ccsid 0 なら BLOB` — 実機は 0 を送ってこない）。

`20260801-dbclob-locator-decode` が「**根は判定の重複。同じ CCSID を扱えていたのに
別実装があって片方だけ正しかった**」と書いて集約したのと、**まったく同じ形**。

## 直し方

`isBinaryCcsid(ccsid)` を `db-decode.ts` に置き、**3 か所すべてをそこに寄せる**。
`decodeLobBytes` は `catch` 頼みをやめて明示的に返す。doc の `0 なら BLOB` を直す。

## 副産物

- **BLOB の分割は 4 周**（65,535 バイト × 3 ＋ 3,395）。`perChar=1` なので
  `want` がバイトと一致し、混在 CLOB と同じ刻み。
- 打ち切り（上限 40,000）は純 DBCS・BLOB とも**上限ちょうど**。
  PR #289 の切り詰めが 2 バイト系（300）でも効いている。
