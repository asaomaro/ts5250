# 調査: プリンターセッションの申告と応答（ACS との突き合わせ）

## 判明した事実
- F1（原典）: `DS5250P.initializeTelnet` は端末タイプを `DBCSsession && !hostPrintTransform ? "IBM-5553-B01" : "IBM-3812-1"` とする。
  `NVT5250.getHostDeviceOptions` はプリンターで `startupResponse = false`（IBMSENDCONFREC を送らない）、KBDTYPE / CODEPAGE / CHARSET は
  表示セッションの枝でしか決めない。変数の組は `userVarPRTSB = {DEVNAME, IBMMSGQNAME, IBMMSGQLIB, IBMFONT, IBMFORMFEED, IBMBUFFERSIZE, IBMTRANSFORM}`・
  `userVarPRTDB = {DEVNAME, IBMMSGQNAME, IBMMSGQLIB, IBMFORMFEED, IBMIGCFEAT, IBMTRANSFORM}`・HPT は
  `{DEVNAME, IBMMSGQNAME, IBMMSGQLIB, IBMFONT, IBMBUFFERSIZE, IBMTRANSFORM, IBMMFRTYPMDL, IBMPPRSRC1, IBMPPRSRC2, IBMENVELOPE, [SB のみ IBMASCII899], IBMWSCSTNAME, IBMWSCSTLIB}`。
  値: IBMMSGQNAME=QSYSOPR・IBMMSGQLIB=*LIBL・IBMFONT=11（`HODDefaults`）、IBMFORMFEED は値なし、IBMBUFFERSIZE=768 固定、
  IBMIGCFEAT は日本 2424J0（韓 2424K0・中 2424S0・台 2424C0）、IBMTRANSFORM は 0/1、IBMMFRTYPMDL は機種名を `_` の手前まで、
  用紙入れ・封筒は既定 "00" を ESC＋0x00、IBMASCII899=0、IBMWSCSTNAME=*NONE、IBMWSCSTLIB はカスタマイズ・オブジェクトを使うときだけ。
  ACS の 5250 プリンターの既定は HPT あり（`HostPrintIcon5250` が `hostPrintTransform=true`）。
- F2（実機・日本語機。`scripts/diag-printer-declare.mjs`）: この機は新しい装置名の自動構成を許さない（8940）。CRTDEVPRT で事前に作った
  装置（仮想制御装置に付けないと 8903）に繋いで比べた。
  - ACS の DBCS 申告 → I902。事前に 3812 で作った装置でも **5553/B01 に作り変えられ**、IGC 属性の帳票（OVRPRTF IGCDTA(*YES)＋DSPLIBL）は
    CPA3394（用紙）・CPA4044（位置合わせ）に I で答えると**最後まで届いた**（SO 計 7・待ち行列から消えた）。
  - 当 PJ の申告 → I902 だが、事前に 5553 で作った装置でも **3812/1 に作り変えられ**、CPA3303（エラーコード 5）で 0 レコード。
  - ACS の HPT（DBCS）申告 → I902・3812/1 のまま、IGC の帳票が変換済みデータで最後まで届いた。
  - ACS の SBCS 申告 → I902・3812/1。この機の DSPLIBL は IGC 付きなので CPA3303（ACS を SBCS で設定したときと同じ）。
- F3（PUB400・自動構成あり）: ACS の DBCS 申告 → **I902**（資格情報あり・なし）。当 PJ の変数を 5553 に載せる → **8925**。
  ACS の SBCS・HPT（DBCS/SBCS）・当 PJ の HPT → I902。**`docs/HOST-PRINT-TRANSFORM.md` §2 の「5553-B01 は 8925」は、当 PJ の変数の組が原因だった。**
- F4（実機のレコード）: DBCS（5553）ではジョブの終わりが **16 バイト**（フラグ 0x08・本体なし）で届き、その後に **CLEAR（opcode 2）**が来た。
  HPT では 17 バイト（本体 0x00 が 1 バイト）。当 PJ は長さ 17 だけを終わりとみなすので、5553 では帳票が確定しない。
- F5（原典）: `DS5250P.processScs` はフラグ 1 が 8 で本体が空か 0x00 だけならジョブの終わり（`sendEOJ`）。`processClear` は応答を
  CLEAR_PROCESSED にして `sendEOJ`（受けかけのジョブを閉じる）。`endOfRecord` は `response_string` が NO_ERROR か CLEAR_PROCESSED のとき
  それを送る。`response_string` は**消されない**ので、一度決まると以後のレコードにも同じ応答が返る。データを書くと NO_ERROR に戻る。
  NO_ERROR は `00 0A 12 A0 01 02 04 00 00 01`、CLEAR_PROCESSED は `… 00 00 02`（予約が 0x0102。当 PJ は 0x0012）。
  opcode 1・2 以外は何もしない（当 PJ は本体を SCS として足していた）。

## 実装アンカー
- A1: 申告（`packages/tn5250/src/session/printer-session.ts` の `connect`・`terminal-type.ts` `printerTerminalTypeFor`・`telnet.ts` の NEW-ENVIRON の組み立て）
- A2: 受信（`printer-session.ts` `handleRecord` `finishJob`・定数 `PRINT_COMPLETE` `JOB_COMPLETE_LEN`）
- A3: 文書（`README.md` のプリンターの節と既知の制約・`docs/HOST-PRINT-TRANSFORM.md` §2・§7）
