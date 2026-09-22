# 調査: ACS の DBCS の端末タイプ

## 判明した事実
- F1（実機・ACS のワイヤ）: `scripts/acs-probe.mjs` を `scripts/tap-proxy.mjs` 越しに PUB400 へ当て、TERMINAL-TYPE IS を採った:
  930 24x80・930 27x132・1399 24x80 → どれも `IBM-5555-C01`。**このとき 3 回ともサインオンに失敗した**（930 はプローブがパスワードを大文字にし、
  大文字小文字を区別する PUB400 では通らない。1399 は `PROBE_CODEPAGE_KEY` 無しで通らなかった）——端末タイプの交渉はサインオンより前なので採れている。
  QMAXSIGN を数えるので、直後に 37 で正しくサインオンして回数を戻した。
- F2（当 PJ・旧い判断）: `terminal-type.ts` と `docs/PROTOCOL.md` §2.1 は、PUB400 の総当たりで「C01 は STRSEU が 27x132 で来る」ので 24x80 に G02 を採った。
  その後 `query-reply.ts` が画面サイズに合わせて t[50] を 0x11（24x80）/ 0x31（27x132）に分けた（ACS のタップの実測）。
- F3（実機・当 PJ）: 一時的に C01 にして、G02 と同じ手順を両方の実機（AS400 930・PUB400 1399）で流した: サインオン・WRKACTJOB・DSPLIBL・WRKSPLF・DSPMSG・F1 の
  画面サイズと色の種類は G02 と 1 つも変わらない（24x80、blue/green/red/white）。**STRSEU（*DS4 を持つ）も C01 で 24x80**（G02 と同じ）。
