# 検証結果: host_call_program の正常系

実施 2026-08-01。実機 **実機（IBM i 7.3）**。**`packages/` は無変更。**

## 実機（11 項目すべて PASS）

```
### QUSROBJD（オブジェクト記述）
  rc=0x0 success=true
  PASS メッセージが出ない（MCH0802 のような不一致が無い）
  PASS 出力パラメータが 1 番目に返る（要求順の前提）
  bytesReturned=90 bytesAvailable=90
  object=QCMD library=QSYS type=*PGM
  PASS 受け取り変数に中身がある（90 バイト）
  PASS オブジェクト名が QCMD
  PASS ライブラリが QSYS
  PASS 種別が *PGM

### QSYRUSRI（ユーザー情報）
  rc=0x0
  PASS メッセージが出ない
  user=USER
  PASS ユーザー名が USER

### 出力の位置合わせ
  outputs = [<100B>, null, null, null, null, null]
  PASS 要求したパラメータ数だけ返る（6）
  PASS 出力パラメータの位置に中身がある
  PASS 入力パラメータの位置は null

OK — 11 passed, 0 failed
```

## 受け入れ基準ごと

| 基準 | 結果 |
|---|---|
| `MCH0802` 等のメッセージ無しに成功 | 合格 |
| **返った中身が期待どおり** | 合格（名前・ライブラリ・種別・ユーザー名） |
| 出力が要求順・入力位置は null | 合格 |
| 書式の違う API を 2 つ以上 | 合格（`OBJD0100` / `USRI0100`） |
| 再現スクリプト | `scripts/research-call-program.mjs` |
| build / lint / test | 合格（**3,318 件通過・失敗 0**） |

## 結論

**実装は正しかった。** 足りなかったのは成功例だけで、コード変更は不要。
MCP ツールの説明「出力パラメータは要求した順で返る前提で位置合わせしている」も
**実機で裏づいた**。

## 未検証の穴

- **入出力（`inout`）パラメータを試していない**。`ProgramParameter` は
  `inout` を持つが、今回使った API は `in` と `out` だけ
- **`null` パラメータ**（省略可能な引数）も試していない
- **受け取り変数が足りない場合**（`bytesAvailable > bytesReturned`）の挙動は
  今回は起きなかった（90/90）。**切り詰められたときに気づけるか**は未確認
- **MCP 経由では通していない**。ツール登録は同じ `conn.call` を呼ぶだけだが、
  Base64 の往復（`toProgramParams` / 出力の base64 化）は経路として未確認
- **書き込み系の API は試していない**（副作用を避けた）
- PUB400（7.5）では未確認
