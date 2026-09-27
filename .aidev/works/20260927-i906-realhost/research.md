# 調査: I906 を実機で出させる

## 判明した事実
- F1（実測。2026-09-27・社内機。QRMTSIGN *FRCSIGNON・QPWDLVL 0）: ACS のコアの自動サインオン（`scripts/acs-probe/startup-i906.txt`）を
  平文（`PROBE_BYPASS_SIGNON=clear`）・暗号化（`PROBE_BYPASS_SIGNON=encrypted`・`PROBE_PASSWORD_LEVEL=0`）の両方で試し、どちらも **I902**＋サインオン画面（`20260927-startup-code-others` research F5 と同じ）。
- F2: PUB400 は QRMTSIGN *VERIFY（自動サインオンが通る）。I906 を出させるには QRMTSIGN の変更か、許されない条件（誤った資格情報など）が要り、共有の実機ではどちらも行わない。

## design への申し送り
- 台帳は「実機で出させる手段が無い」として閉じ、`20260927-startup-code-others` D1（装置名を採る＝暫定）は据え置く。
