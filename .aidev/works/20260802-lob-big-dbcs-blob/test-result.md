# テスト結果: 純 DBCS と BLOB の 64KB 超を実測で閉じる

## 自動テスト

| 対象 | 結果 |
|---|---|
| `npm run build`（`tsc -b` ＋ `vue-tsc`） | PASS |
| `npm run lint`（eslint） | PASS |
| `npm test`（全パッケージ） | **3,582 passed / 0 failed** |

hostserver は 696 → **702**（+6）。他パッケージは変化なし。

### 追加したテスト（6 件）

| ファイル | 何を固定したか |
|---|---|
| `lob-ccsid-units.test.ts` | `isTwoByteCcsid(65535)` が false / `isBinaryCcsid` が 0 と 65535 を拾い、文字コードを持つもの（37 / 1200 / 5035 / 300）を拾わない / **`decodeLobBytes(_, 65535)` がバイト列のまま返す** |
| `lob-multi-segment.test.ts` | 純 DBCS（300）が **UTF-16 と同じく文字で進む** / **BLOB（65535）はバイトで進む**（2 バイト扱いにしない） |

### 循環を避けた

偽ホストの `perChar` を**引数で渡す**形に変えた（`charCountingHostFor`）。
`isTwoByteCcsid`（こちら側の判定）から導くと**自分の判定で自分を試す**ことになり、
判定が間違っていても通ってしまう。ホストの振る舞いは**実機で測った値をそのまま書く**。

既存の呼び出しは `charCountingHost`（1200 なら 2、それ以外 1）で従来どおり。

## 実機検証（実機 / IBM i 7.3）

### 事実の採取

`scripts/research-lob-big-dbcs-blob.mjs`（`research.md` に全文）。

- **F1**: CCSID 300 は**倍々に伸ばせる**（種だけ 1200 経由の二段キャスト、
  連結は同じ CCSID どうしなので変換不要）。15 回で 524,288 バイト。
- **F2**: 純 DBCS は UTF-16 と**同じ往復**（`want` を文字で頼み `offset` を文字で進める）。
- **F3**: **BLOB は CCSID `0` ではなく `65535` で来る**（新しい事実）。

### 直ったことの確認

`scripts/verify-lob-big-dbcs-blob.mjs` — **18 passed / 0 failed**。

```
フィクスチャ: TESTLIB.LOBBIGV
  P (DBCLOB CCSID 300): 524288 バイト / 262144 文字（バイト = 文字 × 2）
  B (BLOB)            : 262144 バイト
  PASS 純 DBCS を 64KB 超で作れる（524288 バイト）
  PASS BLOB を 64KB 超で作れる（262144 バイト）

### 1. DBCLOB(CCSID 300) を上限 200000 バイトで取る（分割 2 周）
  PASS **先頭から連続している（中抜けが無い）**
  PASS 上限ちょうど（200000）/ 全体長はバイトで申告（524288）/ 打ち切りの印が立つ

### 2. BLOB を上限 200000 バイトで取る（分割 4 周）
  PASS **バイト列のまま返る（文字列に化けない）**
  先頭16: 01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef
  PASS **先頭から連続している** / 上限ちょうど（200000）/ 全体長が一致（262144）

### 3. 上限 40,000 バイトで打ち切る
  PASS 純 DBCS が上限ちょうど（40000）——**2 倍に膨らまない**
  PASS BLOB が上限ちょうど（40000）/ 両方とも先頭から連続

### 4. 小さい LOB は完全に取れる
  PASS 純 DBCS が完全一致（"あいうえおかきく"）
  PASS BLOB が完全一致（01 23 45 67 89 ab cd ef）/ 打ち切りの印が立たない

OK — 18 passed, 0 failed
```

後片付け: `finally` で `DROP TABLE`。表は自分のライブラリー（`AS400_LIB`、既定 `TESTLIB`）。
内部 IP はスクリプトに書いていない。

## 受け入れ基準

| 完了条件 | 結果 | 根拠 |
|---|---|---|
| 純 DBCS の 64KB 超を実機に作れた | PASS | research F1（524,288 バイト） |
| 純 DBCS が先頭から連続 | PASS | 実機 1 |
| BLOB がバイト単位で一致・文字列に化けない | PASS | 実機 2（`isBinaryCcsid`） |
| 上限ちょうど・`too-large` | PASS | 実機 1〜3 |
| 差異を直し、実機なしの回帰を足す | PASS | `isBinaryCcsid` ＋ 単体 6 件 |
| `scripts/README.md` に載る | PASS | research・verify の 2 本＋注意書き 2 点 |
| backlog を実測で閉じる | PASS | deliver で該当行を `[x]` |

## 未検証の穴

- **CCSID 16684 は測れていない**（変更なし）。`20260801-pure-dbcs-dbclob` で
  **この実機に変換表が無い**ことを実測済み（1200 経由でも `-332`）。
  **作れないものは測れない**——別の実機が要る。
- **PR #289 で直した分割経路そのもの**は今回も 200,000 バイトまで。
  `MAX_LOB_BYTES` いっぱいでの実測はしていない（往復数が増えるだけで単位の扱いは同じ）。
