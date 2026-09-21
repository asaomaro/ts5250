# テスト結果: WSF D9/72 への応答

## 実行したもの
- tn5250: `alarm-and-query-size-session.test.ts`（新規 3 件）・`query-reply.test.ts` — 14 passed / 0 failed。
- 実機（社内機）: `scripts/build-dscmd.mjs` で試験プログラム（`WSFTST`）を作り、ACS のコア（`scripts/acs-probe.mjs`）と当 PJ（`scripts/diag-5250-commands.mjs WSF72 WSF72N`）で
  それぞれ出させた。ホストが読んだ生バイトは両方とも 0x40 → `000088000cd972c00034b044b004b0`、0x00 → `0000880009d9728000030104`。当 PJ の修正前は応答せず施錠のまま。
  測った後に試験プログラムと IFS のソース・ログを消した（`CHKOBJ` で無いことを確認）。
- mutation 4 通り検出（1 通りは最初、置き換えで構文が壊れて落ちていたので、振る舞いだけを変える形で当て直した）。
- 全量は次の節目でまとめて回す。

## 受け入れ基準ごとの判定
- AC1: pass — 単体と実機で ACS と同じバイト列。
- AC2: pass — 0x80・長さ 7 で返さない。
- AC3: pass — 上の mutation。

## 失敗の証跡

```
$ DSCMD_PGM=WSFTST node ... scripts/diag-5250-commands.mjs WSF72   # 修正前
  ⚠ **応答待ちで時間切れ**（ホストが待っている＝こちらが返していない）
  受信   18B  04 f3 00 06 d9 72 40 00
As400Error: keyboard is locked (state=locked)
```
当 PJ が応答しないことの確認（修正の前提）。

## 起動確認（smoke）
```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- この WSF を送ってくる実際の画面・アプリは見つけていない（DSM で出させた）。応答で Unicode を申告した後にホストが何を送ってくるかは未確認（D1）。

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
- AC1〜AC3: pass（全量）。SF 2 つ・WSF 2 つ（Query と D9/72）・D9/72＋READ・短い WSF・Query のフラグを `negative-response-order.test.ts` で固定
- 実機（社内機・2026-09-22）: DSM の `WSF72` / `WSF72N` でホストが読んだ応答が `000088000cd972c00034b044b004b0` / `0000880009d9728000030104`（ACS のコアと同じ。以前と同じ）

### 失敗の証跡
点検役の再現（直す前の HEAD。`scratchpad/rv5/tn/neg.test.ts`）:

```
[2sf-b] sent: ["NEG 10050112"]
[70+72] sent: ["0000880044d97080"]
[d972+read] sent: ["000088000cd972c00034b044b004b0"] state: locked locked: true
```
