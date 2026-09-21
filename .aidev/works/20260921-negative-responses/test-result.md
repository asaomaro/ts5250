# テスト結果: 否定応答

## 実行したもの
- tn5250 全量 — 808 passed / 0 failed（`wtd-applier.test.ts` の 3 件を足し、未知のコマンドの旧い振る舞いを固定していた 1 件と WSF の 0x80 の 1 件を ACS の振る舞いに直した）。
- 実機（社内機）: DSM の試験プログラム `NEGTST`（`WSF72X`・`BADCMD`・`ROLLBAD`）を ACS のコアと当 PJ で走らせ、ホストの戻りを比べた（research F3）。測った後に消した。
- mutation 7 通りすべて検出（`scratchpad/mut-neg.py`）。
- 全量は次の節目でまとめて回す。

## 受け入れ基準ごとの判定
- AC1: pass — 4 条件のセンス・コードと、否定応答のバイト列（`000e12a0000004800000` ＋ センス）。
- AC2: pass — 未知のコマンドの後ろの WTD が届く。
- AC3: pass — 実機で ACS と同じ戻り（0x80 は CPFA304、他は rc=0）。mutation。

## 失敗の証跡

```
$ DSCMD_PGM=NEGTST node ... scripts/diag-5250-commands.mjs WSF72X   # 修正前
  受信   18B  04 f3 00 06 d9 72 80 00
As400Error: keyboard is locked (state=locked)
```
修正前はホストが待ち続けた（ACS では `QsnPutInpCmd` が CPFA304 で戻る）。

```
$ npx vitest run   # 変更の直後（tn5250）
 × 未知コマンドは警告してレコードの残りを打ち切る（例外にしない）
 × フラグ 0x80 は返さない（ACS は否定応答。当 PJ は持たない）・長さが 6 でなければ返さない（ACS と同じ）
```
旧い振る舞いを固定していたテスト。ACS の振る舞いに直した。

## 起動確認（smoke）
```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- ACS が返す他のセンス・コード（D2）。ESC が無い・CLEAR UNIT ALTERNATE の引数は実機で出させていない（DSM は ESC を付けて出すので作れない）。
