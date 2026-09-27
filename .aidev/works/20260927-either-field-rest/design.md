# 仕様: E 欄の残り

## 依拠する既存の事実
- 打鍵・IME の E 欄の規則は `eitherModeSwitch`（`ScreenGrid.vue`）。状態は `eitherDbcsOn`（値の先頭の字 → `eitherSwitched` → `Field.eitherDbcsOn`）

## インターフェース / データ構造
- `eitherPasteStep(f, mode, cursor, ch)`: 貼り付けの途中の状態（`mode.dbcsOn`）を持ち回って 1 字ずつ判定する（切り替えたら `mode` を書き換える）

## 受け入れ基準との対応
- AC1: `overwriteInto` と DBCS の経路で、混ぜる字は桁を消費（詰め物は今の状態の空白）・切り替えは空にしてから
- AC2: `firstRejection` が E 欄の混ぜる字で `either-dbcs` / `either-sbcs` を返し、呼び出し側が 0060 / 0061 を出す。`insertInto` は切り替えで空にする
- AC3: `scripts/acs-probe/either-empty.txt` と台帳
