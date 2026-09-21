# テスト結果: DBCS の端末タイプ

## 実行したもの
- tn5250 の端末タイプ・Query Reply に触れるテスト（`grep -l "5555\|terminalType"`）— 64 passed。型検査（`tsc --noEmit`）
- 実機（当 PJ。一時的に C01 にして G02 と比べた）: AS400 930・PUB400 1399 で、サインオン・WRKACTJOB・DSPLIBL・WRKSPLF・DSPMSG・F1・STRSEU（OPTION(5)）の
  画面サイズと色の種類。G02 と C01 で差なし（すべて 24x80）。
- 実機（ACS のワイヤ）: research F1。
- 全量・lint・build は節目でまとめて回す。

## 受け入れ基準ごとの判定
- AC1: pass — 単体（1399・930 の 24x80 と 1399 の 27x132 が C01）と ACS のワイヤ。
- AC2: pass — 上の実機。STRSEU（*DS4）も 24x80。

## 失敗の証跡

```
$ PUB400_HOST=127.0.0.1 PROBE_PORT=2424 PROBE_CODEPAGE=930 PROBE_SCREEN=24x80 node … scripts/acs-probe.mjs cp1399.txt PUB400
== 930 24x80 exit=3
TERMINAL-TYPE IBM-5555-C01
```
ACS のコアのサインオンが通らなかった（930 はパスワードを大文字にする。research F1）。端末タイプは採れている。直後に 37 で正しくサインオンして QMAXSIGN の回数を戻した。

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 46657)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- 装置の型番を見て動きを変えるホストのプログラムでは試していない。27x132 の DBCS は以前から C01（変更なし）。
