# 仕様: 暗号化した自動サインオン

## 設計方針
- hostserver に `bypassSignonSubstitute(level, user, password, clientSeed, serverSeed)`（ACS の `getPasswordSubstitute` の手順。DES・SHA-1 は既存の `password.ts` を使う）と、
  認証しない `querySignonInfo`（交換属性だけ）。
- tn5250 の telnet は `passwordSubstitute(serverSeed)` を受け取り、SEND のシードで代替パスワードを作って送る。**IS を送るまで後続の受信を溜める**（順序を平文と同じに）。
  tn5250 はホストサーバーに依存しないので、関数はサーバーが組んで渡す。
- サーバーの `bypassSubstituteFor` が作成時に QPWDLVL を聞き始め（接続の前）、表示・プリンターの接続に渡す。

## 依拠する既存の事実
- `password.ts` の `passwordSubstituteDes` / `passwordSubstituteSha`（ホストサーバーのサインオンで実機に通っている）。
- telnet の IS は `handleSubnegotiation` で組む（`20260921-telnet-signon-vars` の正規化・長さの条件）。

## 受け入れ基準との対応
- AC1: `hostserver/test/bypass-signon.test.ts`（ACS を Java から呼んだ出力と突き合わせ）
- AC2: `tn5250/test/telnet.test.ts`「暗号化した自動サインオン」
- AC3: `server/test/bypass-substitute.test.ts`、実機 `scripts/verify-autosignon.mjs PUB400`
- AC4: mutation
