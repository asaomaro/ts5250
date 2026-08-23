# 調査: メッセージ待ち行列

**実機（IBM i 7.3）で 4 つの操作すべてを通してから書いている。**

## 調査の問い

- Q1: 読む手段は。SQL サービスは使えるか
- Q2: 送信・応答・削除の手段は
- Q3: 既存の層（CL 実行 / SQL / プログラム呼び出し）のどれに載るか

## 判明した事実

### F1: 読むのは **`QSYS2.MESSAGE_QUEUE_INFO`**（SQL）が最良

7.3 で使える。列は 17 個:

```
MESSAGE_QUEUE_LIBRARY / MESSAGE_QUEUE_NAME / MESSAGE_ID / MESSAGE_TYPE /
MESSAGE_SUBTYPE / MESSAGE_TEXT / SEVERITY / MESSAGE_TIMESTAMP /
MESSAGE_KEY / ASSOCIATED_MESSAGE_KEY / FROM_USER / FROM_JOB / FROM_PROGRAM /
MESSAGE_FILE_LIBRARY / MESSAGE_FILE_NAME / MESSAGE_TOKENS / MESSAGE_SECOND_LEVEL_TEXT
```

`MESSAGE_TYPE` に `INQUIRY` / `REPLY` / `INFORMATIONAL` / `SENDER` が入るので、
**応答すべきものが見分けられる**。

**⚠ `SELECT *` は通らない。** `MESSAGE_KEY` が BINARY 型で、
DB 層が `unsupported type BINARY (912)` で断る。**`HEX(MESSAGE_KEY)` で取る**。

**⚠ 本文は VARGRAPHIC。** `CAST(... AS VARCHAR(n) CCSID 5026)` を通さないと読めない。

### F2: 送信は `SNDMSG`（CL）で足りる

```
SNDMSG MSG('…') TOUSR(USER)
SNDMSG MSG('…') TOMSGQ(lib/msgq) MSGTYPE(*INQ) RPYMSGQ(lib/msgq)
```

**`SNDUSRMSG` は使えない**（`CPD0031`）——対話ジョブで応答を待つ前提の命令。

照会を送ると**2 件**入る（`SENDER` と `INQUIRY`）。一覧に出るのは両方。

### F3: 応答は `SNDRPY`（CL）＋ **キーを 16 進で渡す**

```
SNDRPY MSGKEY(X'00000220') MSGQ(lib/msgq) RPY('YES')
```

実機で `INQUIRY` が `REPLY` に変わることを確認した。
**キーは `HEX(MESSAGE_KEY)` の値をそのまま `X'…'` に入れればよい。**

### F4: 削除は **`RMVMSG` が使えない**。`CLRMSGQ` と `QMHRMVM` を使う

```
RMVMSG … → CPD0031「Command RMVMSG not allowed in this setting.」
```

**`RMVMSG` は CL プログラム内でしか使えない**（コマンド行から呼べない）。

| やりたいこと | 手段 | 実機 |
|---|---|---|
| 全消し | `CLRMSGQ MSGQ(lib/msgq)`（CL） | OK |
| **キー指定** | **`QSYS/QMHRMVM` をプログラム呼び出し** | OK |

`QMHRMVM` の引数:

```
0 修飾名      char(20)  待ち行列名(10) ＋ ライブラリー(10)   ← **20 バイト。10 だと CPF2403**
1 メッセージキー char(4)
2 削除の範囲   char(10)  *BYKEY / *ALL / *KEEPUNANS / *OLD / *NEW
3 エラーコード char(8)
```

**`20260804-program-call` で作ったプログラム呼び出しがここで効いた**
——それが無ければキー指定の削除は実現できなかった。

### F5: 載せる層

| 操作 | 使う層 | 既存の入口 |
|---|---|---|
| 一覧 | SQL | `openDb` ＋ `openQuery` |
| 送信・応答・全消し | CL | `openCommand` ＋ `run` |
| キー指定の削除 | プログラム呼び出し | `openCommand` ＋ `call` |

**3 つとも既にある。** 新しい配管は要らない。

## 影響範囲

- `packages/server/src/host-message.ts`（新規）— REST
- `packages/server/src/host-server-tools.ts` — MCP ツール
- web-ui — 導線（入れるかは spec で決める）

## 実現性 / リスク

- **低リスク。** 既存の 3 層に載せるだけ
- リスクは**実機を荒らすこと**——`QSYSOPR` は共有。**検証は自分の待ち行列で行う**
  （この調査でも `TESTLIB/TSTMSGQ` を作って使い、最後に消した）
- 本文の CCSID 変換を間違えると読めない（F1）

## spec への申し送り

- キーは**16 進文字列**でやり取りする（`HEX()` の出力そのまま）
- **消すのは明示的な操作**にする。一覧を読んだだけで消えないこと
- 検証用の待ち行列を作る／消すスクリプトを用意する（`QSYSOPR` を使わない）
