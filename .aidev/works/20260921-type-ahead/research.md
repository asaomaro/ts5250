# 調査: 先打ち（施錠中・応答待ち中の打鍵）

## 調査の問い
- Q1: ACS は施錠中の打鍵をどう扱うか（溜めるか・いつ再生するか・何で捨てるか）
- Q2: ACS の GUI の打鍵は、その経路（`ECLPS.SendKeys`）を通るか
- Q3: 当 PJ はどこで捨てているか

## 判明した事実

### F1: 原典
- `ECLPS.SendKeys` は、施錠中（`locked`）・READ 待ち（`readPending`）・SysReq 中の打鍵を `keyBuffer` に溜め
  （`dataBuffered`）、解錠で再生する。キーによって扱いが分かれる:
  - **`[reset]` `[sysreq]` `[help]` `[attn]`: 溜めを空にしてから、そのキーはその場で処理する**
  - **`[altcsr]` `[insert]` `[altview]` `[dbcsinp]` `[dspsosi]`: 溜めずにその場で処理する**（表示・入力モードの切り替え）
  - それ以外: 溜める
- `ECLPS.reset`（Reset キー。`PS5250.processReset` から）は、挿入モードを解き、施錠中なら溜めを捨てる。
- 既定は先打ち有効（`beans/HOD/Session` の `DISABLE_SESSION_TYPE_AHEAD` 既定 false。台帳の記載）。
- **GUI の打鍵も同じ経路**: `beans/HOD/Screen`（`SendKeyListener`。キーボードの `DefaultKeyboardRemap` から受ける）
  → `Screen.sendKeys` が登録済みの `SendKeyListener` へ配る → `beans/HOD/Session.sendKeys(SendKeyEvent)`
  （`SendKeyListener` を実装）→ **`ECLPS.SendKeys`**。Session を Screen に登録する箇所（`HostTerminal`）は読んでいない。

### F2: 実機（`scripts/acs-probe/type-ahead.txt`。ECL の `SendKeys`）
施錠は `DLYJOB DLY(3)` の Enter で作った。**各場合の `lock-*` が inhibit=1 であることを確かめた**。

```
=== lock-1          inhibit=1   （施錠中に ABC を打つ。画面には出ない）
=== after-1         inhibit=0   20| ===> ABC            ← 解錠後にコマンド行へ入った
=== lock-2          inhibit=1   （施錠中に DSPLIBL[enter]）
=== after-2         inhibit=0   ライブラリー・リスト表示   ← 解錠後に送られた
=== lock-3-after-reset inhibit=1 （XYZ のあと Reset。**Reset でホストの施錠は解けない**）
=== after-3         inhibit=0   20| ===>                ← XYZ は捨てられた
=== lock-4          inhibit=1   （施錠中にもう一度 Enter）
=== after-4         inhibit=0   24| オプション番号またはコマンドを入力してください。 ← 2 回目の Enter が送られた
```

### F3: 当 PJ の現状
- `EmulatorPane.vue` `onKeydown`: `inputBlocked`（`busy` ∨ 予約中）なら Attn / SysReq 以外を `preventDefault` して捨てる。
- `ScreenGrid.vue` `onInputKeydown`: `inhibited`（`busy` ∨ `keyboardLocked`）なら捨てる。
- `EmulatorPane.vue` `onFkeyAid`: 施錠中は機能キーボタンを捨てる。
- 捨てるようにしたのは PR #388（「打てるのに Enter が効かない」を避けるため）。

## 未確認
- ACS が溜める上限。IME の変換中の打鍵。ペースト（ACS のペーストが `SendKeys` を通るか）。
- 施錠中の Help を ACS が送るか（溜めを捨てることは原典の分岐から）。
