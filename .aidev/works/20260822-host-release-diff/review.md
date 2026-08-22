# 結果

## 差分表（2026-08-22 実測）

`node --env-file=.env scripts/compare-hosts-osaka-pub400.mjs`

| 項目 | SR-OSAKA（7.3） | pub400（7.5） | 何の差か |
|---|---|---|---|
| 版数 | IBM i V7R3 | IBM i V7R5 | — |
| 累積 PTF | SF99703 レベル 33 | 引けず（`SQLCODE=-443` 権限） | **権限** |
| QCCSID | 65535 | 273 | 構成 |
| QCHRID | 1172 / 290 | 697 / 273 | 構成（日本語機 / 英語機） |
| QLANGID | JPN | ENU | 構成 |
| QPWDLVL | 0 | 3 | 構成 |
| QMAXSIGN | 3 | 5 | 構成 |
| QAUTOVRT | 200 | 32767 | 構成 |
| QSYS2 の表 | 230 件 | 286 件 | **版数** |
| 20 行取得 | 42ms | 1074ms | 経路（LAN / インターネット） |
| SQL 非クエリ・往復・`-518/07003`・CREATE の SQLCODE | 同じ | 同じ | — |
| CL 実行 | rc=0 CPC2101 | rc=0 CPC2101 | — |
| コマンド定義の取得 | 6 パラメータ / 3460B | 6 パラメータ / 3460B | — |
| IFS 書き読み | ccsid=1208 長さ=6 | ccsid=1208 長さ=6 | — |
| スプール一覧 | 20 件 | 20 件 | — |
| DTAQ 読み取り | 取れた（5B） | 取れた（5B） | — |

**当方の機能で挙動が割れたものは無い。**

## 版数の差は 1 つだけで、当方には当たらない

唯一の版数由来は **QSYS2 のサービス数（230 → 286）**。これが効くのは「7.5 にしか無い
サービスを使っていた場合」なので、**当方が参照する 10 個を両機で照会した**:

```
DATA_QUEUE_ENTRIES / DUMP_PLAN_CACHE_TOPN / MESSAGE_QUEUE_INFO / PROCESS_DETAILED_MONITOR
QCMDEXC / SYSCOLUMNS / SYSROUTINES / SYSTABLES / SYSTOOLS.SPOOLED_FILE_DATA
  → **両機とも在る**
QSYS2.QQQ3000 → 両機とも無い（**注釈の中だけ**。コードは使っていない）
```

**7.3 で欠けるものは使っていない。**

## 見つけた不具合（直した）

### `QCDRCMDD` の失敗理由を握り潰していた

pub400 で `CRTLIB` の定義だけが引けなかった。文言は
`QCDRCMDD returned no data for CRTLIB`——**これでは利用者が何をすればよいか分からない**。

呼び出しの戻りを見たら、**理由は載っていた**:

```
CRTLIB → rc=1281(0x501) 出力=0  CPF9802 Not authorized to object CRTLIB in QSYS.
SNDMSG → rc=0           出力=2  （成功）
```

**版数の差ではなく権限の差だった**——pub400 は公開の共有機なのでライブラリ作成を落としている。
同じ `CRTLIB` が SR-OSAKA では 8 パラメータで引ける。

`result.messages` を捨てていたのを直し、CPF に応じたコードで投げるようにした。実機で確認:

```
AS400  CRTLIB: OK 8 パラメータ
PUB400 CRTLIB: ACCESS_DENIED — *LIBL/CRTLIB: CPF9802 Not authorized to object CRTLIB in QSYS.
```

CPF → コードの写しは **dtaq に既にあった**ので、3 つ目の複製を作らず `cpf-errors.ts` に出して
両方から使う。知らない CPF は `HOST_SERVER_UNSUPPORTED` のまま——**推測で丸めない**。

### 比較スクリプト側の誤り

`QSNDDTAQ` の長さ引数は **PACKED(5,0)**。`X'00000005'` と 2 進で渡して両機とも
`CPF24B4 パラメーター・リストのアドレス指定中に重大エラー` になっていた。`X'00005F'` に直して両機で通った。

## 残る限界

- **測ったのは当方が使う経路だけ**。DDM と MSGW は片側でしか起こせていない
  （pub400 では MSGW を作れず、DDM は経路が無い）。**両版で並べたとは言えない**
- pub400 の PTF 水準は**引けない**（権限）。「7.5 のどの水準か」までは押さえていない
- 所要時間の差（42ms / 1074ms）は**経路の差**で、版数の比較には使えない
