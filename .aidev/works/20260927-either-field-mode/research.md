# 調査: E 欄の半角・全角

## 判明した事実
- F1（原典 `PS5250.checkDBCSField`）: DBCS オンの E 欄で半角を打つと、カーソルが SO の直後なら欄を半角で埋め直して DBCS オフにし（`setEitherFieldDBCSOn(false)`）、それ以外は 0x80000060。
  DBCS オフの E 欄で全角を打つと、カーソルが欄の先頭なら SO を置いて DBCS オンにし、それ以外は 0x80000061。呼び出し側（`processCharKeyStroke`）は負の値を `setErrorCode((short)n)`＝0060・0061。
- F2（実測。2026-09-27・社内機・930。`scripts/acs-probe/either-field-mode.txt`・DSM の DBCSFE の E 欄 9,10）:
  A `X`→`あ`: 拒否（inhibit=5・値は `X`）/ B 空の欄の 9,13 に `あ`: 拒否 / C `あい` の後 9,11（SO の直後）に `X`: 入り、欄は `X` だけ / D `あい` の後 9,13 に `X`: 拒否。
- F4（実測。同じ日・同じ画面を呼び直して。独立点検で「原典を読んだだけ」と指摘された 2 つ）:
  E `AB` の後、欄の先頭（9,10）に `あ`: 入り、欄は `あ` だけ（全角へ切り替えると欄を空にする） / F E の続きを SO の直後から Erase EOF で空にした後、9,15 に `う`: 入る（消しても全角のまま）、
  同じ位置に `X`: 拒否（inhibit=5・「入力として DBCS が必要」）。原典（`Field5250.EitherFieldDBCSOn`・`PS5250.eraseField_Work` が全角の欄の SO/SI を残す）と一致。
- F5（原典）: 状態が立つのは切り替えと、ホストが欄の先頭に SO/SI を書いたとき（`PS5250` の表示データの書き込み）。欄の生成時は下りている。
- F3（当 PJ）: E 欄の打鍵は `rejectReason` を通るだけで、混ぜられる（`packages/web-ui/src/composables/fieldValidate.ts` の「open/either は SBCS/DBCS 両方許可」）。

## 実装アンカー
- A1: `ScreenGrid.vue` の DBCS の打鍵（`dbcsType` の手前）と IME の確定（`commitInto`）
