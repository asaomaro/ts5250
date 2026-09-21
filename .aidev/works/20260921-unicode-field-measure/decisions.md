# 決定記録

## D1: Unicode の欄は実装しない（Unicode を申告しない限り届かない）
- 背景: R11 の調査（原典の読み）は、Unicode の欄は FCW 0x90xx〜0x93xx と WDSF 0x54 の CCSID 版で届くと読み、届く条件は「DDS の CCSID キーワード付きの欄」と「クライアントの Unicode データストリームの申告（既定 OFF）」だと読んだ。申告しないクライアントにも送るかは未確認だった。
- 決定（実機の測定）: 社内機で、G 型・`CCSID(13488)` / `CCSID(1200)` の欄を持つ画面を、Unicode を申告しない当 PJ と ACS のコア（既定）で受けた。**どちらにも、ホストは EBCDIC 混在の DBCS open の欄（FCW 0x8280）として送った**（データはジョブの CCSID の SO/SI つき。FCW 0x90xx も WDSF 0x54 も来ない）。当 PJ の画面は `AB あい` と正しく出て、ACS のコアも同じ。
- 影響: 実装は要らない。申告するときだけ設計案（R11）が要る。台帳の「余地がある」の推測は取り消し線で直した。

## D2: 試験画面は C のレコード入出力で作る（CL の DCLF は使えない）
- 背景: CL の `DCLF` は、Unicode の欄を含む表示装置ファイルで `CRTBNDCL` が CPF0820 で落ちた（理由は listing 側で未確認）。
- 決定: ILE C の `_Ropen`・`_Rwriterd` で画面を出し、戻った入力の生バイトを IFS のログへ残す。`SYSIFCOPT(*IFSIO)` を付ける（付けないと `fopen` が IFS を開けない）。
