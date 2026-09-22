# 調査: ACS に同梱の jt400 のホストサーバー認証

## 判明した事実
- F1（原典。`acsbundle.jar` の `lib/jt400.jar` の `AS400ImplRemote`）: 認証の分岐はレベル < 2 で「数字（`Character.isDigit`）で始まれば頭に `Q`」→ 10 文字を超えれば例外 →
  `SignonConverter.upperCharsToByteArray` → DES（`encryptPassword`）。< 4 で空・`*` 始まりは例外、`trimUnicodeSpace`（末尾の U+0000・U+0020・U+3000）→ SHA-1。
  それ以外（4）は空・`*` 始まりは例外、**落とさずに** `generatePwdTokenForPasswordLevel4`（塩＝利用者名 10 文字＋末尾 4 文字の UTF-16BE の SHA-256、
  PBKDF2WithHmacSHA512・10022 回・512 ビット）→ `generateSha512Substitute`（SHA-512。64 バイト）。
- F2（原典）: 要求の暗号化種別は `SignonInfoReq` も `AS400StrSvrDS` も置換値の長さで決まる——8 は 1、20 は 3、それ以外は 7。
- F3（原典の比較）: レベル 4 の手順は ACS の `PasswordSubstitute`（telnet の自動サインオン。`packages/hostserver/src/bypass-signon.ts`）と同じ。
- F4（当 PJ）: `signon.ts` と `server-connect.ts` がそれぞれ「< 2 は DES、それ以外は SHA-1」「8 バイトなら 1、それ以外は 3」と書いていた。`Q` も末尾の除去も無い。
- F5（jt400 を Java から実行）: 固定のシードで各レベルの出力を採った（`test/hostserver-password-levels.test.ts` の期待値）。
