# 仕様: 1399 の申告

## 設計方針
- `deviceEnvFor(1399)` を `{ kbdType: "JPE", codePage: 1027, charSet: 32000 }` にする。表は 5250・3270・VT で共有なので 3 つとも変わる（どれも実機で繋がることを確かめる）。

## 依拠する既存の事実
- `session.ts`（tn5250）・tn3270・vt の各セッションが `deviceEnvFor` を引いて NEW-ENVIRON に載せる。

## 受け入れ基準との対応
- AC1: `base/test/device-env.test.ts`（と tn5250 の写し）、ACS のワイヤ（research F3）。AC2: `scripts/verify-device-env.mjs`（両方の実機）・`verify-3270-devname.mjs`・VT の接続。
