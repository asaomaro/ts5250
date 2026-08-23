# 検証結果: 実機の版数とパスワードレベル

実施 2026-08-01。**実機**。
資格情報は `.env`（`.gitignore:7` で除外・未追跡）にのみ置き、**本書には書かない**。
以下の出力はパスワードを含まない（そもそも表示されない）。

## 1. サインオン（`tools/hostserver-check/dist/main.js`）

```
host=192.0.2.1 tls=false user=USER
認証成功
  server version   : V7R3M0
  datastream level : 10
  password level   : 0
  job name         : 081654/QUSER/QZSOSIGN
  server CCSID     : 5035
```

- **`password level : 0`** で `認証成功`。`signon.ts:222-229` の
  `passwordLevel < MIN_SHA_PASSWORD_LEVEL` 分岐（DES 経路）が**実機のハンドシェイクを通った**
- **`V7R3M0`**。`formatVersion`（`signon.ts:275-283`）が上位 16 ビットを版数として読む実装で、
  JTOpen の `getVRM()` と同じ欄

## 2. backlog 指定の手順（コマンドサーバー経由）

backlog `hostserver.md` が書いていた検証手順そのものを通した
（`npm run cmd -w @as400web/hostserver-check -- …` と同じ入口）。
**副作用の無い読み取り専用コマンド**を選んだ。

```
host=192.0.2.1 tls=false V7R3M0 ccsid=5035 dsLevel=11

成功  rc=0x0  CHKOBJ OBJ(QSYS/QCMD) OBJTYPE(*PGM)
```

サインオン単体だけでなく、**コマンドサーバーの交換属性まで通っている**
（`dsLevel=11`。サインオンサーバーの 10 とは別のサーバー）。

## 3. 版数の裏取り（2 経路目・PTF グループ）

```sql
SELECT PTF_GROUP_NAME, PTF_GROUP_DESCRIPTION FROM QSYS2.GROUP_PTF_INFO
```

| PTF_GROUP_NAME | PTF_GROUP_DESCRIPTION |
|---|---|
| SF99703 | DB2 FOR IBM I |
| SF99727 | TECHNOLOGY REFRESH |
| SF99729 | GROUP HIPER |
| **SF99730** | **CUMULATIVE PTF PACKAGE C9116730** |
| **SF99730** | **CUMULATIVE PTF PACKAGE C3257730** |

累積 PTF パッケージ ID は `Cyyddd<rrr>` の形で、**末尾 3 桁が版数**＝ `730` ＝ **7.3.0**。
群番号 `SF99730` も 7.3 の累積群。他の群（`SF99703` / `SF99727` / `SF99729`）も 7.3 系で、
**7.5 系の群は 1 つも入っていない**。

→ **VRM と PTF の 2 経路が一致。実機は IBM i 7.3。**

## 4. 補強（3 経路目・否定的証拠）

```
SELECT OS_NAME, OS_VERSION, OS_RELEASE, HOST_NAME FROM QSYS2.ENV_SYS_INFO
→ SQL エラー: SQLCODE=-204 SQLSTATE=42704
```

`QSYS2.ENV_SYS_INFO` が**存在しない**。版数の確認には使えないので、
`scripts/README.md` にその旨を書いた（次の人が同じ空振りをしないように）。

## 5. リポジトリ側の検証

| 検証 | 結果 |
|---|---|
| `npm run build`（`tsc -b`） | 通過 |
| `npm run lint` | エラー 0 |
| `npm test` | **3,285 件通過 / 失敗 0** |
| `git diff` にパスワードが含まれないこと | **0 件**（機械的に走査。目視に頼らない） |
| `.env` が未追跡のままであること | 確認済み（`git status --porcelain .env` が空） |
| 訂正対象の面に誤った版数表記が残っていないこと | **0 件**（`grep -rn "実機.*IBM i 7\.5" packages/*/src packages/*/test`） |

### 訂正した箇所（ソースコメント 11 か所 / 10 ファイル）

最初は 1 ファイルしか直しておらず、**T7 の走査で 9 ファイルの取りこぼしを検出した**
（目視で拾ったつもりだったが、`--include` を絞った grep が別の書き方を落としていた）。

`packages/tn5250/src/screen/types.ts` / `packages/web-ui/src/composables/fkeyLegend.ts`（実装 2 件）と、
`field-ffw-bits` / `signed-num-transmit` / `window-prev-diff` / `window-write-extent` /
`real-help-window` / `opt-legend` / `ffw-behavior-bits`（テスト 8 件）。
いずれも**実測の出所として版数を書いている**コメントで、読んだ人が事実として受け取る。

## 未検証の穴

- **パスワードレベル 1 は確認していない**。当たれる機械が無い。
  0 と 1 は同じ DES 経路（`MIN_SHA_PASSWORD_LEVEL` 未満）なので確度は高いが、**測っていない**
- **TLS は確認していない**。実機へは平文で接続した。
  レベル 0 × TLS の組み合わせは未実測
- **DDM(DRDA) は試していない**。SECCHK が SHA 前提のため、レベル 0 の実機では
  断られるはずだが**実測していない**（backlog に残した）
- **7.3 と 7.5 で何が違うかは測っていない**。本 work が正したのは
  「どちらで測ったか」であって、「差分が何か」は別（backlog に新項目として起こした）
