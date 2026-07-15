# レビュー記録（05-field-edit-keyboard）

## ラウンド 1（2026-07-15）

subtask 05 の単独レビュー（web フィールド編集・キーボード）。

- [should] `ScreenGrid.vue` `onCompositionEnd` の IME 確定取り込みが値を二重化しうる / 対応: 修正
  - **内容**: composition 確定時に `beginEdit`（inputValue=旧値で init）→ 再度 `initEdit(inputValue, edit.cursor)`
    → `el.value`（＝確定後の**全文**）を 1 文字ずつ `typeChar` で流し込む、という手順になっており、
    旧フィールド値の上にネイティブ入力の全文を重ねて打ち込む。日本語 IME で DBCS フィールドに入力した際に
    値が壊れる/二重化する恐れ。
  - **修正**: composition 確定時は **ネイティブ input の現在値を field 値の真とみなして**取り込む
    （長さクランプ・型フィルタ・カーソルは selectionStart）。旧値からの再打ち込みをやめる。

- [note] 検証項目:
  - fieldEdit: 上書き既定・Insert トグル・5250 流バックスペース/Delete・カーソル・満杯ブロック・paste 切り詰めを確認。
  - keydown 制御: 印字文字の上書き、編集キーの 5250 挙動、AID/移動キーのペイン委譲（preventDefault しない）を確認。
    composition 中は自前制御を無効化（`if (composing.value) return`）。
  - fieldValidate: 数値/A(SBCS)/J(pure=全角のみ) の受理判定を確認。
  - keybindings: カスタムコンボが既定より優先。localStorage 永続。
  - katakana: rawByte は **非 nonDisplay の SBCS のみ**露出（パスワードは rawByte を出さない＝漏洩なし）を確認。
  - ブラウザ安全性: web-ui が core root を runtime import すると pino/node 依存を巻き込む → `@as400web/core/codec`
    サブパスで回避。Playwright で実ブラウザ動作を確認済み。

判定: should 1 件 → coding へ差し戻し。

## ラウンド 2（2026-07-15・差し戻し後の再レビュー）

- [should] IME 確定の二重化 → **修正済み**。`onCompositionEnd` を「native input の現在値を長さクランプ・型
  フィルタして field 値として取り込む」方式に変更（旧値からの再打ち込みを廃止）。ユニット追加
  （compositionstart→value="ABC"→compositionend で "ABC" が二重化せず取り込まれる）。全 193 テスト合格、
  Playwright E2E 維持。
- must/should なし。

判定: 指摘解消。review 通過。

