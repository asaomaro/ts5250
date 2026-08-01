# 調査: MSGW をどう誘発するか（実機）

## F1. プリンターの自動構成が使えない

`PrinterSession.connect` が **`8940: Automatic configuration failed or not allowed`** で断られた。
`QAUTOVRT=200` / `QAUTOCFG=1` にもかかわらず（表示セッションは自動採番で繋がる）。

## F2. 自分で装置を作る道も塞がった

`*IOSYSCFG` があるので `CRTDEVPRT DEVD(...) DEVCLS(*VRT) TYPE(3812) MODEL(1) FONT(011)` は
**通った**（`CPC2622`）。だが

- `VRYCFG ... STATUS(*ON)` が **`CPD2609` / `CPF2640`** で失敗（コントローラー指定が要る）
- プリンターセッションは **`8903: Device not valid for session`**

TN5250E のプリンターセッションが繋がる装置は、telnet サーバーが作る種類のものに限られる。
**作った装置は削除して実機に残していない。**

## F3. 既存の仮想プリンター装置がある

`QSYS2.OBJECT_STATISTICS('QSYS','DEVD')` で `OBJATTRIBUTE='PRTVRT'` を引くと 10 台以上:
`PRT_TEST` / `PRTASD` / `PRTNAGA` / `PASANOQ` / `PHAYAQ` / `PRT01` / `PRT21` / `SZKP1` ほか。

**ライターは 1 台も動いていない**（`QSYS2.OUTPUT_QUEUE_INFO` で `WRITER_JOB_NAME IS NOT NULL` が 0 行）。
利用者の指定により `PRT_TEST` を借りた（**作らない・消さない**。ライターだけ起動して必ず止める）。

## F4. MSGW の作り方

1. `VRYCFG CFGOBJ(PRT_TEST) CFGTYPE(*DEV) STATUS(*ON)`
2. `PrinterSession.connect(deviceName: "PRT_TEST")` → `I902`（ホストがライターを起動する）
3. `CHGJOB OUTQ(PRT_TEST)` でコマンドサーバーのジョブの出力待ち行列を移す
4. **`OVRPRTF FILE(QPRTLIBL) FORMTYPE(AIDEVMSGW)`** で用紙タイプをずらす
5. `DSPLIBL OUTPUT(*PRINT)` → スプールが `MESSAGE_WAIT` になる

**踏んだ穴**: 最初 `OVRPRTF FILE(QPDSPLIB)` と書いていた。`DSPLIBL OUTPUT(*PRINT)` が作る
スプールは **`QPRTLIBL`** なので上書きが効かず、用紙タイプが揃ったままライターが
そのまま印刷してしまい、MSGW にならなかった（OUTQ が空になって気づいた）。

## F5. 一覧の状態名は `MESSAGE_WAIT`

`listSpooledFiles` が返す `status` は **`MESSAGE_WAIT`**。画面表記の `MSGW` ではない。

## F6. **メッセージ本文が化けていた**（この検証で見つけた欠陥）

`retrieveMessage` は ID（`CPA3394`）とハンドル（24 バイト）を正しく返したが、**本文が化けた**:

```
text=(G B I H R C)çqãðPRT_TESTå¸àgáºàýäPä]äBäÝäwPRT_TEST...
```

原因は `decodeNpString` が **CCSID 37 決め打ち**だったこと
（`netprint-connection.ts` の `const MESSAGE_CCSID = 37`）。
実機のサーバー CCSID は **5035** で、メッセージはジョブの文字コードで来る。

**ID は英数字なのでどの CCSID でも読めてしまい、本文だけが壊れる**——
だから「メッセージが無い」経路の確認では気づけなかった。

サインオンは `serverCcsid` を返している（`signon.ts:261`）ので、それを使えば直る。
