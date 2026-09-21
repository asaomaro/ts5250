# 調査: ACS の自動サインオンの NEW-ENVIRON

## 判明した事実
- F1（原典）: `NVT5250.getHostDeviceOptions`: `ssoEnabled` と `ssoType`（`ssoBypassSignonClearText`＝3・`ssoBypassSignonEncrypted`＝4 ほか）で自動サインオン。
  利用者名は `trim().toUpperCase()`、パスワードは `PasswordCipher` で復号して末尾の空白を落とす。3・4 では IBMSUBSPW（21）と IBMRSEED（22）を申告の表に入れる。
- F2（原典）: `insertVariable` は `0x03＋名前＋0x01` を書いてから値を書く。IBMRSEED は平文（3）なら値を書かずに抜ける。暗号化（4）ならクライアントのシードを書く。
  値のバイトは 0xFF を二重にし、0x00〜0x03 の前に 0x02（ESC）を置く。IBMSUBSPW の平文は既定の文字コードで符号化したパスワード。
- F3（原典）: `AcsOnly.initBypassSignon` は ACS の製品の中で動き、パスワードの入力を求める設定（`acsPasswordPrompt` が `3_session` / `4_always`）なら
  `ssoType` を**暗号化**にする。ACS の既定の設定値は**未確認**（台帳へ）。
- F4（実機・ACS のワイヤ）: `scripts/acs-probe.mjs` に `PROBE_BYPASS_SIGNON=clear` を足し、`scripts/tap-proxy.mjs` を挟んで PUB400 に当てた（記録はパスワードを含むので、
  値を伏せて解析してから消した）: `IBMRSEED`（値なし）・`USER`（4 バイト・大文字）・`DEVNAME`（値なし）・`KBDTYPE "   "`・`CODEPAGE 37`・`CHARSET 697`・
  `IBMSUBSPW`（9 バイト）・`IBMRSEED`（値なし）・`IBMSENDCONFREC YES`。ACS のコアはこれでサインオンした（コマンド行 20,7）。
- F5（実機・当 PJ）: 変更後、`scripts/verify-autosignon.mjs PUB400` で通った。手元の実機は QRMTSIGN が `*FRCSIGNON`（自動サインオンを受けてもサインオン画面を出す）で、
  変更の前後とも同じくサインオン画面のまま（SQL `QSYS2.SYSTEM_VALUE_INFO` で確認。PUB400 は `*VERIFY`）。
