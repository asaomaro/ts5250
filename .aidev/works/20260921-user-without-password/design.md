# 仕様: USER の条件

## 設計方針
- `telnet.ts` の IS で、USER を書く条件にパスワードがあることを足す。

## 依拠する既存の事実
- `handleSubnegotiation` の自動サインオンの変数（`20260921-encrypted-autosignon` の `finish`）。

## 受け入れ基準との対応
- AC1: `telnet.test.ts`「password 未指定（user のみ）なら USER も…送らない」
- AC2: mutation
