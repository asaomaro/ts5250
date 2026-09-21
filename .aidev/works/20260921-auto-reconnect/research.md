# 調査: ホストに切られたら自動で繋ぎ直す（ACS の自動再接続）

## 判明した事実

### F1: 原典（台帳の調査結果 2026-09-21 と、本 work での追加）
- `ECLConnection.SetCommStatus`: 通信状態が **2（通常の切断）**のときだけ再接続スレッドを起こす。
  **1 回目は即座、以後 20 秒おき、回数の上限なし**（`run()` は `Thread.sleep(20000)` して `StartCommunication`）。
  利用者が自分で切ったときは起こさない。
- 自動サインオンの失敗・拒否（8936→状態 33 / 8937→状態 34）は再接続の条件（状態 2）を満たさない
  → **パスワード拒否で試し続けて QMAXSIGN でプロファイルが無効化される輪にはならない**。
- 既定: ECL のコアは `SESSION_AUTORECONNECT = false`、HOD の bean（`HODDefaults`）は `autoReconnect = true`。
- **本 work で追加**: ACS 製品側（`com/ibm/eNetwork/HOD/acs` の 222 クラス）を走査したが、自動再接続の既定を
  上書きする箇所は無い（該当は `PlaybackUI`＝マクロ再生の画面だけ）。HOD の既定（true）がそのまま効く。
- ACS は通信が準備できていない間の打鍵を捨てる（`ECLPS.SendKeys` の冒頭: ACS の包みで `IsCommReady` が偽なら return）。

### F2: 実機（ACS。台帳の調査結果）
`SIGNOFF ENDCNN(*YES)` の直後に `commStatus=2` となり、3 秒以内に新しいサインオン画面（新しい装置）が出た。

### F3: 実機（当 PJ。本 work の実装を当てた）
コア単体（`scripts/verify-auto-reconnect.mjs`）:

| # | 条件 | 結果 |
|---|---|---|
| 1 | `SIGNOFF ENDCNN(*YES)`・装置名はホスト採番 | 切られた直後に 1 回目の繋ぎ直し → **約 0.05 秒で新しいサインオン画面**（QPADEV0001） |
| 2 | 同上（2 回目） | 同じく即座に繋ぎ直した |
| 3 | 同上・**装置名 WEBSF0 に固定** | 同じ名前で即座に繋ぎ直した |
| 対照 | `SIGNOFF`（ENDCNN(*NO)） | ホストは接続を切らずサインオン画面へ戻す → **繋ぎ直しは起きない**（正しい） |
| 対照 | `DSCJOB` | 同上 |

サーバー経由（`scripts/verify-ws-auto-reconnect.mjs`。ブラウザと同じ /ws）:
`key-done` → `host-reconnecting attempt=1` → 施錠した `screen` → 新しいサインオン画面の `screen` →
`host-reconnected` → `jobinfo job=QPADEV0001`。`closed` にはならなかった。

### F4: 当 PJ の現状（変更前）
- 表示セッションは `closed` を受けると破棄（`session-manager.ts` の `session.on("closed")`）。ホストへ繋ぎ直すのは常駐プリンターだけ。
- ブラウザ ↔ サーバーの瞬断からの復帰（`link`）はあるが、サーバー ↔ ホストの繋ぎ直しは無い。

## 未確認
- 再接続のあと ACS が自動サインオンを送り直すか（送り直して拒否されても状態 33/34 で止まるので輪にはならない）。
