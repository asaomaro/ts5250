# 調査: telnet の残り

## 判明した事実
- F1: ACS `NVT5250` は SEND の項目を順に読み、`VAR`（名前なし・`USER`）は自動サインオンなら `USER`、`USERVAR`（名前なし）は表の全部、`USERVAR 名前` は表にあればその変数・無ければ名前だけを返す。
  表は表示が `DEVNAME KBDTYPE CODEPAGE CHARSET`、プリンターが `DEVNAME` と `IBMMSGQNAME…`（`userVarDSP*` / `userVarPRT*`）、自動サインオンで `IBMSUBSPW IBMRSEED`、確認レコードで `IBMSENDCONFREC`、関連付けで `IBMASSOCPRT`。
  DEVNAME は名前が無くても `03 DEVNAME 01` と書く（`insertVariable` の case 0）。空の SEND には何も書かない
- F2: ACS は名前を当てた後もその名前とシードのバイトを 1 バイトずつ読み続ける（シードの 0x00・0x03 を新しい項目と読む）
- F3: IBM i の SEND（PUB400・tap）: `USERVAR IBMRSEED <シード 8 バイト> VAR USERVAR`
- F4: 直す前の当 PJ: 固定の順（DEVNAME・KBDTYPE…・IBMSENDCONFREC・USER・IBMRSEED・IBMSUBSPW）、名前の無い DEVNAME を書かない、IBMRSEED を返さない
- F5: ACS `NVT.NVT_process_outbound`: バイナリ・EOR を交渉する前に届いたデータを NVT の文字として画面に書く（BS・CR・LF などを処理）。IBM i はこの形で送らない（tap の記録はどれも交渉から始まる）

## 実装アンカー
- A1: `packages/tn5250/src/telnet/telnet.ts` の `handleSubnegotiation`（NEW-ENVIRON）
