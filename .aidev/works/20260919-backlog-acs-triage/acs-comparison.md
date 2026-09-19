# ACS との突き合わせ表（未突き合わせだった 3 領域）

requirements の AC5 の実体。ACS のコア（`acshod2.jar`。CFR 0.152 でデコンパイル）と当 PJ（HEAD `65f88e64`）を、組ごとに並べる。

- **表の見方**
  - 行番号: ACS 側は CFR の出力の行、当 PJ 側は `file:line`。
  - 深さの記号: research の「検証の深さの表記」に同じ（◎ 実測 / ○ 主エージェントが両側を直読 / ◐ 片側を直読 / △ 委譲先の報告のみ）。
  - 差異の番号 P1〜P19 は `.aidev/backlog/acs-parity.md` に起票した項目、S1〜S3 は `.aidev/backlog/session-lifecycle.md` に起票した項目（対応は末尾の表）。
- **ACS のコードは引き写していない。** 書いてあるのは、クラス.メソッドの名前と振る舞いの要約だけ。

## 対象外とした領域

- **既に突き合わせ済みの領域**（再調査しない。結果を参照するだけ）
  - WTD のオーダー（`DS5250.processWriteToDisplay`）と `PS5250.addChar` → `20260915-acs-protocol-order-audit`
  - `Field5250` の文字種の検査 → `20260915-acs-field-validation-audit`
  - IC/MC の確定・SOH / CLEAR での破棄・WEC でのカーソル復元・窓の左端・CC2 の警報・flag2・Query Reply の画面能力 → PR #404
  - FCW（DBCS 4 値・自己点検 mod10/11） → PR #404
  - `ScreenText` の表示設定（カーソル・罫線・桁区切り）と配色 → PR #405
- **主題の外**
  - TN3270・VT。ACS の 5250 の代替という主題から外れる。
  - STARTTLS・SLP・WF・FASTPATH（HMC）・Kerberos。IBM i の 5250 では使わないか、企業の SSO に属する。
  - True Transparency Write（0xF4。HTML DDS）。Query Reply で申告していないので、ホストは送らない。

## 領域 1: DS5250 のコマンド（WTD のオーダー以外）

出典: 委譲先 C。主エージェントが確かめたものは深さの欄に記した。

| ACS 側 | 当 PJ 側 | 結果 | 深さ |
|---|---|---|---|
| `processCommand` 0x40 → `processClearUnit`（1186/1431） | `wtd-applier.ts:169` → `buffer.ts:545 clearUnit` | 概ね一致（窓を閉じる・欄を捨てる・CA マスクを捨てる）。細部に差 → P17 | △ |
| 0x20 CLEAR UNIT ALTERNATE（1202） | `wtd-applier.ts:173` → `buffer.ts:474` | 差異あり・低（CA マスクの扱い。当 PJ は実機観察に基づき保持） → P17 | △ |
| 0x50 → `processClearFMT`（1225/1461） | `wtd-applier.ts:188` → `buffer.ts:707` | 差異あり・低（施錠・保留 READ・メッセージ行の初期化） → P17 | △ |
| 0x23 → `PS5250.processRoll`（2347） | `wtd-applier.ts:230` → `buffer.ts:588` | 方向は一致。空いた行・不正パラメータで差 → P17 | △ |
| 0x21/0x22 `processWriteErrorCode`（1511）・`PS5250.saveMsgLinePosition`・`keyDown` | `wtd-applier.ts:289/293`・`applyWriteErrorCode` | 差異あり（窓の中に描かない・エラー状態が無い） → P11 | ◐ |
| CC1 → `processWCC1`（2214）・`PS5250.clearNonbypassFields` | `wtd-applier.ts` の `applyCc`・`buffer.ts:1092` | 0xC0 で順序が逆 → P5。他のモードは一致 | ○ |
| CC2 → `preprocessWCC2` / `processWCC2` / `endOfRecord` | `applyCc2`・`session.ts:590-705` | MW の CC2 ビットを見ない → P12。READ の無いアンロック → P14 | ◐ |
| 0x72 / 0x83 → `sendAll`（1276/2368） | `wtd-applier.ts:267/277`・`read-response.ts` | 0x72 は一致。0x83 は低の差 → P17 | △ |
| 0x42 / 0x52 / 0x82 は保留するだけ（1286） → `sendAid` / `sendAll` | `wtd-applier.ts:304`・`session.ts:666`・`read-response.ts` | 骨格は一致（SBA・MDT・符号付き数値・継続欄・CA キー）。READ だけのレコードでカーソルを動かす → P6 | ○ |
| 0x62 / 0x66 `processReadScreen`（2855） | `save-screen.ts:111` | 応答の形式が違う（カーソルの前置・opcode・NUL） → P17 | △ |
| 0x64 / 0x68 `processReadScreenEA`（2889） | `save-screen.ts:176` | 形式は一致。打鍵文字を 0x40 にする → P17（P1 と同じ根） | △ |
| 0x6A / 0x6C（罫線つきの印刷用画面） | 0x62/0x64 と同じ形で返す | 差異あり・低・要実測 → P17 | △ |
| 0x02 `processSaveScreen`（2741）＋ `Save5250Net` | `wtd-applier.ts:193`・`save-screen.ts:24`・`buffer.ts:564` | **差異あり・高**（退避する状態が足りない） → P1 | ◎ |
| 0x12 `processRestoreScreen`（2827） | `wtd-applier.ts:204`・`buffer.ts:620` | **差異あり・高**（自分の積荷を WTD として再適用する） → P1 | ◎ |
| 0x03 部分退避（1358） | `wtd-applier.ts:207`・`save-screen.ts:90` | 矩形の指定を無視して全画面を退避（QSH は全 0 なので実害なし） | △ |
| 0x13（1367） | `wtd-applier.ts:218` | 自分の積荷とは整合している | △ |
| 0xF3 `processWSF`（2003） | `wtd-applier.ts:301/763` | D9/70 は一致。D9/72 は未対応 → P17 | △ |
| WDSF → `ENPTUI5250.processWSFOrder` | `wtd-applier.ts:636`・`wdsf-parser.ts:242` | 50/51/53/58/59/5B/5F/60/61 は対応済み。52/54/55 は未対応 → P17 | △ |
| WEA（0x12） → `PS5250.writeExtAttribute` | `wtd-applier.ts:555-575` | タイプ 5（DBCS の拡張 NLS）だけ差 → P17。色・桁区切りを WEA で受ける経路は ACS にも無い（acs-parity の DSPATR(CS) の判定） | ○ |
| 属性バイト → `PS5250.setAttributeToPlanes` | `screen/attributes.ts:61-76` | 一致（桁区切りは 0x30〜0x37・0x3F） | ○ |
| opcode の処理 `processPassthru`（923-1057） | `session.ts:590-660` | Cancel Invite は一致。opcode 6/7 だけの即時読み取りは未対応（低） | △ |
| 負応答（`tokenizeData` のセンスコード） | warn するだけ | 未対応・低 → P17 | △ |

## 領域 2: キー入力・入力欄の編集・AID・施錠

出典: 委譲先 D。ACS の既定のキー割り当ては `AcsMapFunctions.MAP_5250`。

| ACS 側 | 当 PJ 側 | 結果 | 深さ |
|---|---|---|---|
| `PS5250.processCharKeyStroke`（上書き） | `ScreenGrid.vue` の打鍵・`advanceIfFull` | 無指定の欄は一致。RB/RZ 欄は差 → P16 | △ |
| `insertChar`・`reserveRoomForInsert` | `fieldEdit.ts:29-43` `typeChar` | **差異あり**（あふれた文字を捨てる） → P2 | ○ |
| Insert キー・`DS5250.initKeyboard` の `resetInsertMode` | `EmulatorPane.vue:95` `insertMode` | 差異あり（画面をまたいで残る） → P8 | ○ |
| `processBackspace` | `ScreenGrid.vue:2636-2672` | 欄の中は一致。欄の先頭で差（低） → P16 | △ |
| `processDeleteChar` | `fieldEdit.del` | 一致 | △ |
| `processEraseEOF` / `eraseToEOF_Work` | `eraseEofKey` | 単独の欄は一致。継続欄で差 → P16 | △ |
| `processEraseInput` → `clearNonbypassFields(true)` | `ScreenGrid.vue:2372` `eraseInputKey` | **差異あり**（全欄を消す） → P7 | ○ |
| `processFieldPlusMinusAndExit` | `fieldExitKey`・`fieldEdit.fieldExit` | 流れは一致。事前の検査と継続欄で差 → P16 | △ |
| 同上（Field+ / Field−） | `fieldSignKey`・`signKeyHack` | 符号付き数値欄は一致。非数値欄・数値専用欄で差 → P16 | △ |
| `performRightAdjustFill` | `fieldEdit.ts` の `rightAdjust` / `applyAdjust` | 通常は一致。符号付き＋RZ と空白の扱いで差 → P16 | △ |
| `processDupFM`（Dup） | `dupKey`・`dupFill` | DUP_ENABLE の判定は一致。FER 欄・継続欄で差 → P16 | △ |
| `processDupFM`（Field Mark） | なし | 未対応 → P16 | △ |
| `processHome` | `ScreenGrid.vue:2682`・`onLocal` の home | 差異あり（行き先が違う）・要判断 → P16 | △ |
| `processEndField`・`Field5250.getEndPosition` | `fieldEdit.end` | 欄の中はほぼ一致。欄の外で差 → P16 | △ |
| `processNewline` と `MAP_5250` の `S10=[newline]` | なし（`useKeymap.ts:72-73` で Enter の AID） | **差異あり**（Shift+Enter で送信する） → P9 | ○ |
| `processTab`・`FFT5250.nextNonByPassInputFieldPos` | `focusByOffset`・`tabStops` | 一致（ボタンにも止まるのは意図的） | △ |
| `processBacktab`・`previousNonByPassInputFieldPos` | `focusByOffset(-1)` | 差異あり → P16 | △ |
| `processCursorMove`・`ECLPS.moveCursor` | `moveCell`・欄の中の ←/→ | 保護域への移動・画面端のラップは一致。欄を出るときの検査が無い → P16 | △ |
| `Field5250.isFieldExitRequired` | `buffer.ts:1225` | 差異あり（RB/RZ） → P16 | △ |
| FER を越えた打鍵で 0018 | 黙って入らない | 意図的な差異（`20260729-ffw-behavior-bits` D5） | △ |
| `processAIDCode` の 0020 の検査 | なし | 差異あり・要判断 → P16 | △ |
| ME/MF/自己点検（`processAIDCode`・`FFT5250.checkMandatoryFieldCheck`） | `session-controller.ts`・`mandatoryCheck.ts` | 差異あり（意味とタイミング）・要判断。Enter のときだけにしたのは意図的（D1） → P16 | △ |
| MONOCASE（`inputChar`・`CodePage.toUpper`） | `ScreenGrid.vue:218` | ASCII は一致。930/5026 で全欄を大文字化するのは ACS で裏付けが取れた。ASCII 以外で差 → P16 | △ |
| Bypass（`checkSBCSField`） | 保護欄として扱う | 一致 | △ |
| Enter・F キー・Roll の送信（`DS5250.sendAll`） | `buildReadMdtResponse` | 一致（MDT の欄だけ・画面の順） | △ |
| CA キー（`isSOH_PF`） | `sendsDataForAid` | 一致 | △ |
| Clear / Help / Print / PA / Record Backspace（`DS5250.sendAid`） | `read-response.ts:108-121` | 差異あり（欄データを送る）・低 → P16 | △ |
| Attn / SysReq（`sendAid`・`processSysreq`） | `session.ts:331-396` | 一致（施錠中も通す・応答を待たない） | ○ |
| 操作員エラー（`setErrorCode` → HLP 0x01 の送信 → WEC） | `opMessages.ts` のローカル文言 | 意図的な差異。コメントの番号が違う → P16 | △ |
| 先打ち（`ECLPS.SendKeys` の `keyBuffer`・`DS5250.checkPendingAid`） | `ScreenGrid.vue` の `onInputKeydown`・`EmulatorPane.vue:851` | **差異あり**（捨てる）・要判断 → P3 | ◐ |
| 施錠中に通すキー（Reset・SysReq・Insert・Attn） | `isEscapeAidEvent`（Attn / SysReq） | ほぼ一致（Insert だけ違う） | △ |
| 既定のキー割り当て（`MAP_5250`） | `keybindings.ts` / `useKeymap.ts` | 差異あり → P9・P16 | ○（Shift+Enter） / △（その他） |

## 領域 3: telnet の交渉・接続確立・プリンター

出典: 委譲先 E。

| ACS 側 | 当 PJ 側 | 結果 | 深さ |
|---|---|---|---|
| `Telnet.negotiate` / `reset` の optstate | `telnet.ts:56-62, 202-210` | 差異あり・実害なし（IBM i は要求を送り直さない） | △ |
| `Telnet.receive`（IAC/SB の解析） | `telnet.ts:130-199` | 一致 | △ |
| TIMING-MARK | 対応オプション外なので WONT | 一致 | △ |
| `Telnet.Process_SB_TERMINAL_TYPE_SEND` | `telnet.ts:214-216` | 一致（申告する名前は P18） | △ |
| `DS5250.initializeTelnet` / `DS5250P.initializeTelnet` | `terminal-type.ts:23-26, 44-47` | 差異あり → P18（表示）・P4（プリンター） | ◐ |
| `DS5250.processWSF` の Query Reply | `query-reply.ts:57-87` | 画面能力は一致（PR #404）。DBCS 24x80 の型式が違う → P18 | △ |
| `NVT5250.getHostDeviceOptions`・`CodePage` | `packages/base/src/device-env.ts:32-47` | 37/273/930/939 は一致。1399 だけ差 → P18 | △ |
| `NVT5250.Process_SB_NEW_ENVIRONMENT_SEND` | `telnet.ts:217-257` | 応答の方式が違う・実害なし | △ |
| `insertVariable` の DEVNAME・`AutoDeviceName5250` | `telnet.ts:220-222`・`session-manager.ts:136-144, 856-873` | 差異あり（置換記号・大文字化・再試行の理由） → P18 | △ |
| `insertVariable` の IBMRSEED / IBMSUBSPW | `telnet.ts:246-255` | 差異あり（書式） → P18 | ◐ |
| 暗号化パスワード・IBMAF（MFA）・Kerberos | なし | 未対応（意図的。将来拡張） | △ |
| IBMASSOCPRT | なし | 未対応 → P18 | △ |
| `DS5250.processPassthru`・`NVT5250.process_outbound` | `session.ts:547-576`・`startup-record.ts:423-440` | 見分け方と復号が違う（低） → P18 | △ |
| `DS5250.processStartUpConfirmation` | `startup-record.ts:364-414` | **差異あり**（2703/2777/8936/8937 が無い） → P10 | ○ |
| ステータスバーの拒否理由（`KEY_5250_CONNECTION_ERR_*`） | `session.ts:561-568`（英文） | 差異あり・低 → P18 | △ |
| `ECLConnection` の autoReconnect | `session-manager.ts:746-752`・`:1003-1013` | 差異あり・要判断 → P15 | △ |
| `Transport.setKeepAlive`（既定 off） | `tcp.ts:15-39`（60 秒で on） | 意図的な差異（改善。`tcp.ts` に理由） | △ |
| `NVT.NVT_process_outbound`（交渉前のテキスト） | なし | 未対応・低 → P18 | △ |
| バックアップホスト・`startTimeoutChecker` | `session.ts:213-217`（15 秒） | 差異あり・低 → P18 | △ |
| `DS5250P.processPassthru`（起動応答） | `printer-session.ts:177-207` | 一致 | △ |
| `DS5250P.processScs`（ジョブ終了の判定） | `printer-session.ts:69-70, 186-189` | 差異あり（byte7 と長さ 17） → P19 | △ |
| `DS5250P.processClear` / `endOfRecord` | `printer-session.ts:184` | 差異あり（CLEAR に応答しない） → P13 | ◐ |
| `PSNVT5250P.sendPrintData` / `processPrinterError`・`PrintHostData.write` | `printer-session.ts:185` | 差異あり（受信した瞬間に完了を返す） → P13 | ◐ |
| 印刷完了応答の定数 | `printer-session.ts:68` | バイト 4-5 が違う・低 → P19 | △ |
| プリンターの既定値（HPT・IBMFONT=11 ほか） | `printer-session.ts:122-135` | 意図的な差異（既定を SCS にした理由は README） | △ |
| `PrintSCS5250` の 1 バイトの制御 | `scs.ts:183-237` | 差異あり → P19 | △ |
| `PrintSCS5250` の 0x2B オーダー | `scs.ts:249-308` | 差異あり（消費長・打ち切り） → P19 | △ |
| `processPresentationPosition`、NL / CR / FF ほか | `scs.ts:184-222` | 一致 | △ |
| `PrintSCS5250DB` の SO / SI / SPCC | `scs.ts:126-129`・`spool-html.ts:141-146` | 意図的な差異だが ACS と逆（0 桁と 1 桁）・要実測 → P19 | △ |
| 2BD2 系の書式オーダー | 読み飛ばし | 差異あり・低 → P19 | △ |

## 領域の外で見つかったもの（当 PJ の欠陥）

| 内容 | 根拠 | 深さ | 台帳 |
|---|---|---|---|
| リロード・タブを閉じた後、90 秒は同じ装置名で開けない（ACS はウィンドウを閉じると接続を閉じる） | 実機で `8902` を実測・`session-manager.ts:692` / `:885-889` | ◎ | S1 |
| ping の見張りが最初の ping まで張られない | 実機・実ブラウザで実測（130 秒検出せず）・`ws-client.ts:199-200` | ◎ | S2 |
| プリンターの「＋新規」で古い口がリークする／`detachReport` | 委譲先 A の一時テスト・コード読み | △ | S3 |

## 台帳の項目との対応

| # | `.aidev/backlog/acs-parity.md` の見出し（要旨） |
|---|---|
| P1 | RESTORE SCREEN で自分の退避イメージを再適用し、打鍵と MDT が消える |
| P2 | 挿入モードで、あふれた末尾を捨てる |
| P3 | 施錠中・応答待ち中の先打ちを捨てる |
| P4 | DBCS プリンターの申告内容 |
| P5 | CC1=0xC0 で欄を消さない |
| P6 | READ だけのレコードでカーソルを動かす |
| P7 | Erase Input の範囲 |
| P8 | 挿入モードが画面をまたいで残る |
| P9 | Shift+Enter で送信する |
| P10 | 起動応答コードが足りない |
| P11 | WEC を窓の中に描かない／エラー状態 |
| P12 | MW を出さない |
| P13 | プリンターの完了応答と CLEAR |
| P14 | READ の無いアンロック（#401） |
| P15 | 自動再接続 |
| P16 | 【まとめ】キー編集の細部 |
| P17 | 【まとめ】DS5250 のその他 |
| P18 | 【まとめ】telnet・自動サインオン・装置名 |
| P19 | 【まとめ】SCS |

| # | `.aidev/backlog/session-lifecycle.md` の見出し（要旨） |
|---|---|
| S1 | リロード後、90 秒は同じ装置名で開けない |
| S2 | ping の見張りが最初の ping まで張られない |
| S3 | プリンターの「＋新規」の古い口 |
