# 調査: ACS の USER

## 判明した事実
- F1（原典）: `NVT5250` は VAR の要求に `insertUser` で USER を書くが、`ssoType` が 3・4（パスワード付きの自動サインオン）のときだけ。
  利用者名・パスワードのどちらかが空なら `ssoType` を 0 にする（`20260921-telnet-signon-vars` の続き）。
- F2（当 PJ）: 画面・MCP の経路はパスワードが無ければ利用者名も渡さない（`config-resolver.ts` の `resolvePassword`）。利用者名だけが telnet まで届くのは WS の直接指定だけ。
- F3（実機・PUB400）: 利用者名だけを送っても送らなくても、サインオン画面になり、利用者名の欄は空だった。
