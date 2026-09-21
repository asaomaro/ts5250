# テスト結果: 数値専用の欄の Field−

## 実行したもの
- web-ui: 数値の欄・Field± に関わる 15 ファイル — 394 passed / 0 failed（新規 2 件、旧い振る舞いを固定していた 1 件の期待値を直した）。`vue-tsc` 通過。
- tn5250: `numeric-only-zone-d.test.ts`（送信のバイト列 `f1f2404040d0`）。
- 実機（社内機・ACS のコア）: `scripts/acs-probe/field-minus-numeric-only.txt`（research F2）。
- mutation 4 通りすべて検出（`scratchpad/mut-zd.py`）。
- 全量は次の節目でまとめて回す。

## 受け入れ基準ごとの判定
- AC1: pass — 空の最終桁は 0xD0、数字 5 は 0xD5、Field+ は変えない。
- AC2: pass — READ MDT の応答が `F1 F2 40 40 40 D0`。
- AC3: pass — 上の mutation。

## 失敗の証跡

```
$ npx vitest run test/numpad-field-sign.test.ts   # 変更の直後
 × **キャレットから始めた矩形選択の最中でもテンキーの − は Field−**（文字 `-` を入れない）
Expected: "12"
Received: "12   �"
```
数値専用の欄で Field− の後に値が変わらないことを固定していた（旧い振る舞い）。テストの狙い（文字の `-` が入らない）は保ったまま、ゾーン D を期待する形に直した。

## 起動確認（smoke）
```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- ホストが受け取った値（負の数として読むか）は実機で見ていない（シフト M の欄を写すプログラムが無い）。送るバイトは ACS と同じ。
- 送る前の表示（D2）。

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
- AC1〜AC3: pass（全量）。ゾーン D の桁の表示を `zone-digit.test.ts`（変換表との一致・入力欄の表示）で固定

### 失敗の証跡
このラウンドでは失敗が発生していない（表示の指摘は読んで確かめたもの）。
