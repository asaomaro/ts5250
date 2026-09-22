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

## 節目 9 の対応（ラウンド 2 の指摘を直した回）

### 実行したもの
- `npm test`（全量）— 6,474 passed / 0 failed / 41 skipped
- `npm run lint` — exit 0 / `npm run build`（web-ui の `vue-tsc` を含む）— exit 0（1 回目は `ScreenGrid` の `ccsid` の prop 型で落ち、`number | undefined` に直した）
- mutation（`scratchpad/mut-m9.py` 25 通り＋`mut-m9b.py` 4 通り）— 生き残った 3 通り（DBCS の打鍵・ペースト・IME の MDT）にテストを足して全部 KILLED

### 起動確認（smoke）

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 46429)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

### 受け入れ基準の再確認
- AC1〜AC3: pass（全量）。オペコードごとの読み方・否定応答の順・否定応答の後ろを読まない（ROLL・CUA・WSF 0x80）を `negative-response-order.test.ts`（15 件）で固定
- 実機（社内機・2026-09-22）: DSM（`WSF72X`→CPFA304・`ROLLBAD`→rc=0・`BADCMD`→rc=0）が以前と同じ。通常の画面（DSPJOB・DSPLIBL・WRKSPLF・DSPMSG・WRKOBJ・プロンプト・GO MAIN・QCMD）を
  社内機（930）と PUB400（37）で一巡させて、否定応答・読み違いの警告 0 件。試験プログラムは片付けた（DLTPGM・CHKOBJ で無いこと・IFS も削除）

### 失敗の証跡
点検役の再現（直す前の HEAD。`scratchpad/rv5/tn/neg.test.ts`）:

```
[order] sent: ["NEG 10050121","0000880044d97080"]
[op2-lead] sent: ["NEG 10050121"]
[noop-data] sent: ["NEG 10050121"]
```

直した後、既存のテストが Query・D9/72 をオペコード NOOP で送っていたので落ちた（ACS は NOOP のデータを読まない）。実機は Query を PUT/GET（0x03）で送る
（`fixtures/pub400-autosignon-menu.jsonl` の `001112a000000400000304f30005d97000`）ので、テストを PUT/GET に直した:

```
     × 24x80 → 画面能力 0x11 4ms
     × 27x132 → 画面能力 0x31 1ms
     × **フラグ 0x40・次が 0 → Unicode の CCSID を申告**（ACS のコアと同じ 15 バイト） 4ms
     × **それ以外 → `D9 72 80 00 03 01 04`**（ACS のコアと同じ 12 バイト） 2ms
     × **フラグ 0x80 は否定応答 0x10050112**（ACS と同じ。`20260921-negative-responses`）・長さが 6 でなければ返さない 2ms
AssertionError: Query Reply を返している: expected undefined to be defined
AssertionError: expected [] to deeply equal [ '000088000cd972c00034b044b004b0' ]
 Test Files  1 failed | 2 passed (3)
      Tests  5 failed | 47 passed (52)
```

## 節目 10 の対応（ラウンド 4 の指摘を直した回）

### 実行したもの
- `npm test`（全量）— 6,619 passed / 0 failed / 41 skipped（10 ワークスペース）
- `npm run lint` — exit 0 / `npm run build`（web-ui の `vue-tsc` を含む）— exit 0（途中の 1 回は `field-exit-checks-wiring.test.ts` の型で落ち、`NonNullable<Field["dbcsType"]>` に直した）
- mutation（`scratchpad/partA-mut.py` を直した後のコードへ当て直し）— 32 通りが落ち、生き残り 0。1 通り（W1: WSF だけの早期 return）は、直した後にコードが無くなった
- mutation（`scratchpad/mut-a10b.py`。応答連鎖の分岐）— 9 通り。初回に 3 通り生き残ったのでテストを 2 件足し、9 通りとも落ちた

### 受け入れ基準の再確認
- AC1〜AC3: pass（全量）。応答連鎖（WSF ＋ READ 系の全組み合わせ・応答だけのレコードの画面イベント）を `negative-response-order.test.ts` で固定

### 失敗の証跡
点検役の再現（直す前の HEAD。`scratchpad/rv10/partA-order.test.ts`）:

```
[WSF Query][READ SCREEN]       HEAD: ["Query 応答"]                     ACS: Query 応答 → 画面応答
[READ SCREEN][WSF Query]       HEAD: ["Query 応答"]                     ACS: 画面応答 → Query 応答
[WSF Query][READ IMMEDIATE]    HEAD: ["Query 応答"]                     ACS: Query 応答 → 即時読み応答
[READ SCREEN][READ IMMEDIATE]  HEAD: ["READ IMMEDIATE の応答だけ"]        ACS: 両方
```

直した後の mutation の 1 回目（`scratchpad/mut-a10b.py`。3 ファイルの集合）で生き残ったもの。tn5250 の全量に当てても 2 通りが残った:

```
SURVIVED A-S1 READ SCREEN EXTENDED の応答を送らない :: 53 passed (53)
SURVIVED A-S1 READ MDT IMMEDIATE ALT の応答を送らない :: 53 passed (53)
SURVIVED A-S1 READ IMMEDIATE で responded を立てない :: 53 passed (53)
（tn5250 全量: READ SCREEN EXTENDED は 1 failed | 862 passed で落ち、残る 2 通りは 863 passed (863) のまま）
```
足したテスト: 「READ MDT IMMEDIATE ALT・READ SCREEN EXTENDED も WSF の応答と一緒に返す」「READ 系だけのレコードは応答を 1 本返し、画面イベントを出さない」。

### 起動確認（smoke）

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45959)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

### 未検証の穴
- コマンド順で応答を送る作りにしていない（固定順）。混ざるレコードを実機で出せるかは未確認（DSM は 1 コマンドずつ）
- `processPassthru` のオペコード 1・3・6・7・9 の固有の動作は未実装（台帳）
