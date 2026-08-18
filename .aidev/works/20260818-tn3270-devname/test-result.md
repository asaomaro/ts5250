# 試験結果

## 実機（SR-OSAKA）— **5 PASS / 0 FAIL**

`scripts/verify-3270-devname-osaka.mjs`

```
### 1. 指定しないとき（従来どおり）
  PASS 繋がる（IBM i と判定=true）
  PASS ホストが割り当てた名前: QPADEV000D
### 2. 装置名を指定したとき（AS3270A）
  PASS **繋がる（交渉も切断も起きない）**
  PASS 名前は使われず、ホストが採番する: QPADEV000D
  PASS **画面が届いている**（DEVNAME を送っていた頃は 0 文字だった）
5 PASS / 0 FAIL
```

## 途中の実測（結論の根拠）

| 渡し方 | 結果 |
|---|---|
| 端末タイプに `@名前` | **交渉が 15 秒で時間切れ** |
| NEW-ENVIRON の `DEVNAME` | 交渉は通るが **Query Reply の直後に CLOSE**。画面 0 文字 |
| `DEVNAME` を止める（他は同じ） | **ready・画面 166 文字** |

`DEVNAME` は名前を 4 通り（`AS3270A` / `TST3270X` / `QPADEV0099` / `D3270TST`）試して全て同じ。
**1 行を止めるだけで通った**ので、引き金はこれで確定。

ホスト側も見た——`QSYS2.OBJECT_STATISTICS('QSYS','DEVD')` で装置記述の種別を数えたところ、
**3270 の装置記述は 0 件**で、表示装置は全て `DSPVRT`（IBM i が自動で作る仮想表示装置）。

## 自動テスト

| 対象 | 件数 |
|---|---|
| `tn3270`（`ibmi-keys` に 5 件追加、既存の `telnet` 1 件を書き換え） | **250 passed / 37 skipped** |
| `server` | **1,206 passed** |
| `web-ui` | **1,681 passed** |
| その他 | 617 passed |
| 合計 | **4,743 passed / 37 skipped** |

`npm run build`（`vue-tsc` 込み）・`npm run lint` ともに緑。

`tab-visibility` の時間切れは前工程からの持ち越し（別プロセスの負荷。単独では通る）。
