# 調査: 操作員エラーの状態（ACS の error_mode）

## 判明した事実

### F1: エラー状態に入る（原典）
`PS5250.setErrorCode(short)` が `error_code` を置き、**`error_mode = true`** にする。
操作員エラー（型違反・符号桁・満杯の挿入など）はここを通る。実機では `ECLOIA.InputInhibited() == 5`。

### F2: エラー状態を抜ける経路（原典）
`PS5250.clearErrorMode()` の呼び出し元は 4 つ:
- `processReset()` —— **Reset キー**（あわせて `clearSysreqMode` / `clearErrorDuringSysreqMode`）
- `keyDown(int, boolean)` —— 内部キーコード **1004〜1007** の分岐。`setErrorHelpMode(false)`・
  `restoreMsgLinePosition(false)`・`ECLOIA.clearDoNotEnter()` を呼ぶ（メッセージ行を戻す）
- `processAIDCode(short)` —— **AID キー**
- `canClearErrorModeViaMouseClick(int, int)` —— **マウスのクリック**

**1004〜1007 がどのキーかは定数から取れなかった**（`ECLConstants` に無い）→ F3 で実機に聞いた。

### F3: 実機での観測（`scripts/acs-probe/error-mode-exit-keys.txt`）
単独欄 TOUSR を満杯にして挿入し、エラー状態（`inhibit=5`）を作ってから各キーを押した。
**各試行の前がすべて `inhibit=5` であることを確かめた**（1 回目は作れておらず無効だった。F4）。

```
=== err-before-right  cursor=12,40 inhibit=5
=== after-right       cursor=12,41 inhibit=0   ← 右矢印で抜ける・カーソルも動く
=== err-before-down   cursor=12,40 inhibit=5
=== after-down        cursor=13,40 inhibit=0   ← 下矢印で抜ける・カーソルも動く
=== err-before-reset  cursor=12,40 inhibit=5
=== after-reset       cursor=12,40 inhibit=0   ← Reset で抜ける・カーソルは動かない
=== err-before-char   cursor=12,40 inhibit=5
=== after-char-in-error cursor=12,40 inhibit=5 ← 文字キーは拒否。入力されずエラーのまま
```

→ **1004〜1007 は矢印（カーソル移動）**と見てよい（右・下で抜けた）。
**ACS の「施錠」は Reset だけで解く硬い錠ではない**——矢印・AID・クリックでも抜けられる。

### F4: ~~エラーを抜けると挿入モードも解ける（実機）~~ → F6 で訂正
1 回目の測定では、1) で右矢印でエラーを抜けたあと、2)〜4) の X が**上書きで入った**
（カーソルが 41 へ進み、エラーにならなかった）。~~**抜けたときに挿入モードが解けていた**。~~
**解けていたのは確かだが、いつ解けたかはこの測定では分からない**（dump に挿入モードが無かった）。
各試行の前に `[insert]` を押し直して取り直した。

⚠ **1 回目の 2)〜4) は無効**だった——エラー状態を作れておらず（`inhibit=0`）、
その後の結果から何も言えない。**そのまま読めば「Reset でも抜けない」「文字キーも入る」という
誤った結論になっていた**。「前がエラー状態か」を先に確かめる形にして防いだ。

### F5: 残りの編集・移動キー（実機。`scripts/acs-probe/error-mode-other-keys.txt`）
F3 と同じ作り方。**各試行の前が `inhibit=5` であることを確かめた**。

```
=== err-before-tab       cursor=12,40 inhibit=5
=== after-tab            cursor=5,37  inhibit=0   ← Tab で抜ける・カーソルも次の欄へ
=== err-before-backspace cursor=12,40 inhibit=5
=== after-backspace      cursor=12,40 inhibit=5   ← Backspace は拒否。エラーのまま
=== err-before-home      cursor=12,40 inhibit=5
=== after-home           cursor=5,37  inhibit=0   ← Home で抜ける・カーソルも動く
=== err-before-delete    cursor=12,40 inhibit=5
=== after-delete         cursor=12,40 inhibit=5   ← Delete は拒否。エラーのまま
```

→ F3 と合わせた規則: **カーソルを動かすキーは抜ける（そのキーの働きもする）／欄を書き換えるキーは拒否**。

### F6: 挿入モードは**エラーに入った時点で**解ける／Reset は**エラーでなくても**解く（実機 2 経路・原典）
dump に `insert=`（`ECLOIA.IsInsertMode()`）を足して取り直した。

満杯の挿入（`scripts/acs-probe/error-mode-insert-timing.txt`）:
```
=== ins-before-error     cursor=12,40 inhibit=0 insert=true
=== err-entered          cursor=12,40 inhibit=5 insert=false   ← 入った時点で解けている
=== after-right-exit     cursor=12,41 inhibit=0 insert=false
=== ins-no-error         cursor=12,40 inhibit=0 insert=true
=== after-reset-no-error cursor=12,40 inhibit=0 insert=false   ← エラーでなくても Reset で解ける
```
保護領域への入力（別種のエラー。`error-mode-insert-timing-2.txt`）:
```
=== prot-ins-before    cursor=1,5  inhibit=0 insert=true
=== prot-err-entered   cursor=1,5  inhibit=5 insert=false      ← こちらも入った時点で解ける
=== field-ins-no-error cursor=5,37 inhibit=0 insert=true
=== field-after-reset  cursor=5,37 inhibit=0 insert=false      ← 別の位置でも Reset で解ける
```
原典: `PS5250.processReset` は `ECLPS.reset()` を呼び、`ECLPS.reset` は**挿入モードを無条件に解く**。
続けて**施錠中なら先打ちの溜め（`keyBuffer`）を捨てて解錠する**（`dataBuffered` / `unlockKeyboard`）
——先打ち（③）の Reset の働きはここ。`clearErrorMode` 自体は挿入モードに触れない。

### 未確認
- Field Exit・Erase EOF・Dup・Field+/−・IME の打鍵（`Process`）・Ctrl+C / Ctrl+V。
  実装では「欄を書き換える」と確かめた 3 種（文字・Backspace・Delete）以外は**抜ける側**に倒した
  （`decisions.md` D2）。

## 当 PJ の現状
- 操作員エラーは `emit("notice", …)` で通知を出すだけで、**次の打鍵で消える**
  （`EmulatorPane.vue` の `onKeydownCapture`）。**エラー状態を持たない**。
- **Reset キーは未実装**（台帳の【まとめ】キー編集の細部「未対応の機能」）。
- 通知には操作員エラー（`MSG_NO_ROOM`・`MSG_BY_REASON`・`MSG_PROTECTED`・`MSG_DUP_DISALLOWED`）と
  **情報の通知**（表示設定の順送り等）が混ざっている——**施錠するのは操作員エラーだけ**。
