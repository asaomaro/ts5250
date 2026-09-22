# 調査: ACS の暗号化した自動サインオン

## 判明した事実
- F1（原典）: 製品の ACS（`AcsOnly.initBypassSignon`）は自動サインオンを使うとき常に `ssoBypassSignonEncrypted`（パスワードを都度入れる設定 `3_session` / `4_always`）。
  平文の自動サインオンの設定は無い。QPWDLVL はサインオン・サーバーに聞く（`SignonServer.getPasswordLevel`）。`NVT5250` は取れなければ 0。
- F2（原典）: `NVT5250` はホストの SEND の `USERVAR IBMRSEED` の直後の 8 バイトをサーバーのシードとして読み、自分のシードを乱数で作る。
  IS の IBMRSEED に自分のシード、IBMSUBSPW に `PasswordSubstitute.getPasswordSubstitute(利用者名, パスワード（末尾の空白を落とす）, 自分のシード, サーバーのシード, QPWDLVL)`。
  値の 0x00〜0x03 は ESC、0xFF は二重。~~計算が例外なら IBMSUBSPW を書かない~~ → 原典と違った（節目の独立点検の指摘）:
  `NVT5250.insertVariable` は変数の頭（`03 名前 01`）を switch の前に書くので、例外でも IBMRSEED は自分のシードで、IBMSUBSPW は値の無いまま送る。
- F3（原典）: `PasswordSubstitute`: 0/1 は DES（パスワードは大文字、数字で始まれば頭に Q、10 文字まで、`SignonConverter` の表の文字だけ）、
  2/3 は SHA-1（利用者名は 10 文字の空白詰めを UTF-16BE、パスワードは末尾の U+0000・U+0020・U+3000 を落として UTF-16BE、`*` で始まれば例外）、
  4 は PBKDF2-HMAC-SHA512（塩＝SHA-256(利用者名 10 文字＋パスワードの末尾 4 文字)、10022 回、512 ビット）→ SHA-512(鍵‖サーバー‖クライアント‖利用者名‖1)。
- F4（実機・ACS のコア・タップ・PUB400・QPWDLVL 3）: SEND は `USERVAR IBMRSEED <8 バイト> VAR USERVAR`。ACS の IS は IBMRSEED（自分のシード）・USER・…・IBMSUBSPW（20 バイト）・IBMRSEED（再掲）。
  サインオン画面を飛ばしてメニューへ。
- F5（実機）: QPWDLVL は PUB400 が 3、社内機が 0（`querySignonInfo` に当たる交換属性で）。社内機は QRMTSIGN が `*FRCSIGNON` で自動サインオンそのものを受けない。
- F6（当 PJ）: `@ts5250/hostserver` の `password.ts` に DES・SHA-1 の代替パスワード（ホストサーバーのサインオン用）。レベル 4 と、数字で始まるパスワードの Q は無い。
