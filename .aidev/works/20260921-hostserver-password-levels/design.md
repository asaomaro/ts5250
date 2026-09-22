# 仕様: ホストサーバーの認証の置換値

## 設計方針
- `password.ts` に `passwordSubstituteSha512`（レベル 4）と `encryptionTypeOf`（長さ → 1/3/7）を置き、telnet の `bypass-signon.ts` もレベル 4 はこれを呼ぶ（手順を 2 か所に書かない）。
- `credentials.ts` の `hostServerPasswordSubstitute(level, user, password, clientSeed, serverSeed)` に jt400 の前処理ごと寄せ、`signon.ts` と `server-connect.ts` の
  2 か所の三項分岐を置き換える（対になる資産を複製しない。`paired-artifact-sync`）。

## 依拠する既存の事実
- research F1〜F5。レベル 0/1 の DES・2/3 の SHA-1 の本体は既存の `passwordSubstituteDes` / `passwordSubstituteSha`（jtopenlite との差分テストで固定済み）。

## 受け入れ基準との対応
- AC1: `test/hostserver-password-levels.test.ts`（レベル 4 の 3 例・開始要求とサインオン要求の種別 7）
- AC2: 同（レベル 0 の Q・2/3 の末尾・4 の末尾・空と `*`）
- AC3: 実機（PUB400 レベル 3・社内機 レベル 0 でサインオンと DB サーバーの開始）・mutation
