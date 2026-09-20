# 調査: SAVE/RESTORE SCREEN と画面イメージ応答を ACS に合わせる

## 調査の問い

- Q1: ホストが RESTORE SCREEN で返す積荷を、どう避ければよいか。レコードの残りを捨ててよいか。
- Q2: 打鍵した文字はどこに在るか（サーバーの `ScreenBuffer` か、ブラウザか）。MDT はどこが持つか。
- Q3: 保留中の READ・施錠・メッセージ行・CA マスクは、当 PJ のどこが持つか。退避する仕組みはあるか。
- Q4: ACS は退避に何を入れ、どう戻すか（一次資料）。
- Q5: 画面イメージ応答（`0x62` / `0x66` / `0x6A`）は実機に到達するか。ACS の応答形式は。
- Q6: 既存のテスト資産のうち、手当てと衝突するものはどれか。

## 調べ方（F0）

- **F0-1 ACS の一次資料（主エージェントが直読）**: `IBMiAccess_v1r1/acsbundle.jar` → `plugins/emulator/acshod2.jar` を
  CFR 0.152 でデコンパイルしたもの（scratchpad。リポジトリには入れない）。読んだのは
  `com.ibm.eNetwork.ECL.tn5250` の `DS5250` / `PS5250` / `Save5250` / `Save5250Net`。
  `protocol.md`「2.6」のとおり、一次資料との照合は委譲していない。
- **F0-2 ACS のコアを実機に当てる**: `scripts/acs-probe.mjs scripts/acs-probe/attn-restore.txt`（HACL/ECL）。
- **F0-3 当 PJ の生レコード採取**: scratchpad に書いた採取スクリプト（`@ts5250/tn5250` の `Session5250` に
  透過の中継を挟み、IAC EOR（`FF EF`）でレコードへ割って 16 進で出す）。実機へ表示セッションを 1 本、
  既存の装置名（`.env.verify` の枠内）で張るだけで、オブジェクトは作らない。
- **F0-4 当 PJ 側のコード調査**: 別コンテキストへ委譲（一次資料を要しない範囲）。結論は下記に取り込み、
  **手当ての根拠になる箇所は主エージェントが `file:line` を開き直して確かめた**。

## 判明した事実

### ACS 側（一次資料）

- **F1: ACS の退避は「状態一式」で、積荷そのものである**（`Save5250Net`。`DS5250.processSaveScreen`）。
  退避されるのは次のとおり（`Save5250Net.saveInformation()`）:
  - プレーン: `HostPlane`（文字コード）・`TextPlane`（表示文字）・`UnicodePlane`・
    （DBCS セッションのみ）`NLSPlane` / `DBCSPlane`・`GridPlane`・`PushButtonGridPlane`
  - フォーマットテーブル `FFT5250`（＝欄の定義。**MDT を含む**）
  - カーソル位置・カーソルの可視・ホーム位置
  - **挿入モード**・**施錠状態**（`isWCC2UnlockPending()` なら false に倒す）
  - **保留中の AID**（`pending_aid`）・**保留中の READ**（`pending_read`）
  - **メッセージ行番号**（`SOH_msgline_num`）・`WTD_IC_addr`
  - **SOH の 5・6・7 バイト目**（`SaveSOH_Byte5/6/7`）＝**CA マスク**
    （`DS5250` が AID キーごとにビットを見る箇所が 2998〜3026 行にある）
  - 拡張（ENPTUI）と PMB イベント一覧
- **F2: ACS は自分の積荷を読んで復元する。** `DS5250.processSaveScreen` は `Save5250Net` を
  **Java のオブジェクト直列化 → Deflater で圧縮**し、`ESC 0x12` に続けてホストへ送る。
  復元時は `readNetSavedScreen` が **Inflater → ObjectInputStream** で読み戻す。
  **ホストにとっては不透明な保管物**で、ACS 自身にとっては退避の実体そのもの。
  - **`ESC 0x12`（RESTORE SCREEN）はレコードの残り全部を積荷として消費する**
    （`processRestoreScreen(sArray, n5, n2 - 2)`。`n2` はレコードの終端、先頭の `ESC 12` の 2 バイトを引いた長さ）。
  - **`ESC 0x13`（RESTORE PARTIAL）は 2 バイトの長さを読み、その分だけ消費する**（`case 19`）。
    ACS の SAVE PARTIAL 応答が `ESC 13 ＋ 長さ 2 バイト ＋ 積荷` の形で出しているため。
  - `ESC 0x12` の直後が `00 00 04 13` のときだけ 2 バイト読み飛ばして続ける（入れ子の SAVE PARTIAL 用）。
  - **SAVE PARTIAL の応答はその場では送らない**——`saveddata` に貯め、レコードを処理し終えた後で送る
    （`DS5250` 1405-1409 行）。
- **F3: ACS の READ SCREEN 応答は前置なし・opcode は受信の写し**（`DS5250.processReadScreen`）。
  - ヘッダは `00 00 12 A0 00 00 04 00 80` ＋ **`WorkHeader.Opcode`**（＝受け取ったレコードの opcode）。
  - **カーソル位置の 2 バイトを前置しない。**
  - 本体は `ps.getBuffer()`（＝`HostPlane` を `short` に写したもの）を画面サイズぶん 1 バイトずつ。
    `0x62` のときだけ、上位バイトが立っているセルを 8 ビット右へ送り、`0x11→0x13` / `0x10→0x12` / `0x07→0x08` に写す。
    `0x66` ではこの加工をしない。
  - 未書き込み桁は `HostPlane` の値のまま（0x40 へ置き換えない）。
- **F4: ACS では打鍵した文字も `HostPlane` に入る**（`PS5250.putSBChar` が `TextPlane` と `HostPlane` の
  両方を書く）。したがって **ACS の READ SCREEN 応答には打鍵した文字が載る**。

### 当 PJ 側

- **F5: RESTORE SCREEN の後、レコードの残りは「次のコマンド」として解析される。**
  解析ループは `packages/tn5250/src/protocol/wtd-applier.ts:161` の `while (r.remaining > 0)` で、
  毎周 `ESC` ＋ コマンドを読む。`case COMMAND.RESTORE_SCREEN`（同 204-206）と
  `case COMMAND.RESTORE_PARTIAL_SCREEN`（同 218-229）は **`r` から 1 バイトも読まない**。
  レコードの境界は telnet の IAC EOR（`packages/tn5250/src/telnet/telnet.ts:176-181`）で、
  1 レコード＝1 回の `applyDataStream`（`packages/tn5250/src/session/session.ts:594`）。
- **F6: 打鍵した文字はブラウザだけが持ち、AID を送る瞬間にだけサーバーへ渡る。**
  - ブラウザの編集差分は `SessionState.edits: Map<fieldIndex, string>`
    （書き込みは `packages/web-ui/src/components/EmulatorPane.vue:119`）。
  - AID 送信時に `key` メッセージへまとめて載せ（`packages/web-ui/src/session-controller.ts:1161`）、
    サーバーが `session.setField()` を呼ぶ（`packages/server/src/ws-handler.ts:1036-1043` →
    `packages/tn5250/src/session/session.ts:280-295` → `packages/tn5250/src/screen/buffer.ts:910-950`）。
  - **打鍵ごとにサーバーの `ScreenBuffer` は更新されない。**
  - **ホスト発の画面が来ると、ブラウザは編集差分を無条件に捨てる**——
    `packages/web-ui/src/stores/sessions.ts:481` の `s.edits.clear()`（`updateScreen()` の末尾）。
    `screen` と `key-done` の両方から呼ばれる（`session-controller.ts:578-601`）。マージはしない。
  - **`pending.restored` は編集差分の扱いに関与していない**。web-ui での消費先は窓判定だけ
    （`packages/web-ui/src/composables/fkeyLegend.ts:220-225`）。
- **F7: MDT は `ScreenBuffer` が持ち、退避で往復する。** `InternalField.mdt`（`buffer.ts:85`）。
  立つのは FFW の MDT ビット（`buffer.ts:813`）と `setFieldValue` の末尾（`buffer.ts:942-949`）。
  `savedStack` は `fields` を複製するので（`buffer.ts:569`・`626`）**MDT は退避・復元される**。
- **F8: 退避されていない状態がある**（`buffer.ts:514-530` の `savedStack` の型が持つのは
  rows / cols / cells / fields / cursorAddr / retainedEnds / GUI 4 種だけ）。
  - **CA マスク `aidNoDataMask`**（`buffer.ts:654`。SOH から `buffer.ts:660-666` が作る。
    参照は `sendsDataForAid()` `buffer.ts:692-700` だけ）— **退避されない**。
  - **メッセージ行 `systemMessage`**（`buffer.ts:147`）— 退避されないどころか、
    **SAVE SCREEN / SAVE PARTIAL が能動的に消す**（`wtd-applier.ts:201`・`214`。
    テスト `packages/tn5250/test/system-message-lifetime.test.ts:79-90` が固定している）。
  - **メッセージ行番号 `msgLineRow`**（`buffer.ts:664-666`）— 退避されない。
  - **セッション層の状態**（`state` / `readCommand` / `pendingAid`。`session.ts:135`・`161`・`162`）
    — 退避の仕組みが無い。ただし当 PJ は READ SCREEN 系・SAVE 系を**その場で応答して `return`** する
    （`session.ts:609-651`）ので、保留として残る READ はホストの READ コマンド（0x42/0x52/0x82）だけ。
  - 施錠は `ScreenBuffer` の外（`session.ts:271-273` の `keyboardLocked` は `state !== "ready"` の導出）。

### 実測

- **F9: 実機の RESTORE SCREEN レコードは、積荷で終わる**（2026-09-20・F0-3 で採取）。
  メインメニューのコマンド欄に `WRKACTJOB` を入れ（`setField`。送らない）、Attn → F12 と送ったときの受信:

  | 操作 | レコード | 中身 |
  |---|---|---|
  | Attn | 12B | `… 04 02`（SAVE SCREEN 単独） |
  | Attn | 312B | `04 11 …`（WTD）＋ オフセット 298 に `04 52 00 00`（READ MDT） |
  | F12 | 26B | `04 40`（CLEAR UNIT）＋ `04 11 …`（WTD） |
  | F12 | **805B** | **`04 12` ＋ `04 11 …`（＝こちらが送った積荷）。末尾は WTD のデータで終わる** |
  | F12 | 14B | `04 52 00 00`（READ MDT） |

  - この往復では、`ESC 12` のレコードは積荷で終わっており、READ MDT は**別のレコード**で来た。
  - **⚠ この 1 例から「残りを捨ててよい」と決めるのは誤りだった。F9b を見ること。**

- **F9b: 同じ `ESC 12` でも、積荷の後ろにホストの READ が続くことがある**（2026-09-20・QSH 経路で追加採取）。
  `measurement-sanity`（実測を記録する前に、同じ条件でもう一度取る・計測器が結果を作っていないかを疑う）に
  従って別経路でも採ったところ、**F9 と食い違う形が出た**。

  | 操作 | レコード | コマンドの並び（本体先頭からのオフセット） |
  |---|---|---|
  | QSH 起動 | 17B ×2 | `@0:0403`（SAVE PARTIAL。パラメータは `00 00 00 00 00`） |
  | QSH 終了（F3） | **809B** | **`@0:0412` `@2:0411` `@795:0452`** |

  - 末尾 16 バイト: `f0 f1 f5 4b 11 18 4e 22 11 18 50 20 04 52 00 00`
    ——**積荷（`ESC 11 …`）の直後、同じレコードの中に `04 52 00 00`（READ MDT）がある。**
  - 積荷の長さは**どちらの採取でも 793 バイト**（F9 は本体 795＝2＋793、F9b は本体 799＝2＋793＋4）。
    ＝こちらが SAVE SCREEN 応答として送った本体そのもので、**長さは変わらずに返ってくる**。
  - **結論: 「レコードの残りを捨てる」は使えない。** 使うと QSH から戻ったときに READ MDT を失い、
    施錠が解けなくなる（過去に QSH が「待機中」で固まった経路と同じ壊れ方）。
    **積荷の長さぶんだけ読み飛ばす**必要がある。
  - **`ESC 13`（RESTORE PARTIAL）は、この採取でも観測できなかった**（QSH の出口は `ESC 12` だった。
    国勢調査でも回によって `0x12` と `0x13` のどちらが出るか変わる。`.aidev/backlog/datastream-commands.md`）。
    **未確認のまま。**

- **F9c: ACS が「残り全部」を消費して平気なのは、積荷から入力状態も戻すから**（F1・F2）。
  `processCommand(sArray, n, n2)` の `n2` は**終端の添字**（`while (n5 < n2)`・`if (n5 + 2 > n2)`）で、
  `processRestoreScreen(sArray, n5, n2 - 2)` は**レコードの末尾まで**を積荷として消費する
  ——末尾の READ があれば ACS も飲み込む。
  それでも困らないのは、`Save5250Net` が **`pending_read` / `pending_aid` / `keyboardLocked` を退避しており**、
  `restoreNetNulls` が `setPendingReadAndAID(...)` と `lockKeyboard`/`unlockKeyboard` で戻すから
  ——**退避した時点の保留 READ が復活するので、末尾の READ は冗長**。
  **当 PJ にはこの復元が無い**（F8）ので、同じ真似をすると READ を失う。
- **F10: 欠陥はセッション層だけで再現する**（同じ採取）。`setField` の直後は `MDT=true`・欄は `WRKACTJOB`。
  Attn → F12 の後は **欄が空・`MDT=false`**。
  ブラウザの `edits.clear()`（F6）とは**別に**、サーバー側だけでも失われている。
  - 理由: 積荷を組む `packages/tn5250/src/protocol/save-screen.ts:243` の `writeCell` が
    `cell.rawByte ?? 0x40` で、**`setField` で入れた文字は `rawByte` を持たない**
    （`buffer.ts:939-940`。`rawByte` を付けるのはホスト発の SBCS（`wtd-applier.ts:455`）・
    DBCS（同 450）・センチネル往復（`buffer.ts:931-937`）だけ）。
    SF は元の FFW を書き戻すので MDT も落ちる。
- **F11: ACS の基準線を取り直した**（2026-09-20・F0-2。`measurement-sanity` に従い再取得）。

  ```
  === menu       cursor=20,7  inhibit=0
  === typed      cursor=20,16 inhibit=0   20| ===> WRKACTJOB
  === after-attn cursor=20,26 inhibit=0   20| ===> WRKACTJOB
  === after-f12  cursor=20,16 inhibit=0   20| ===> WRKACTJOB
  ```

  **ACS は打鍵を保ち、カーソルを 20 行 16 桁へ戻す。** 前 work（`20260919-backlog-acs-triage` research N1）と同じ。
- **F12: `READ SCREEN`(0x62) は実機に到達していない。**
  - 国勢調査 2 回（11 画面 83 レコード・20 画面 142 レコード。`.aidev/backlog/datastream-commands.md`）で
    **0x62 は 1 件も出ていない**。届くのは `0x64`（READ SCREEN EXTENDED）。
  - 当 PJ は**設定に関わらず常に拡張 5250 を申告する**——`packages/tn5250/src/protocol/query-reply.ts:45` が
    `void enhanced;` で引数を捨て、同 88-89 が `t[53]=0x0f` / `t[54]=0xc8` を無条件に立てる。
    `enhanced` オプション（`session.ts:59`・`141`・`179`）は Query Reply のバイト列に影響しない。
  - **一方 `0x66` / `0x6A`（READ SCREEN TO PRINT）は到達する**——DSM の `QsnPutInpCmd(0x66)` で
    出させて確認済み（`packages/tn5250/test/datastream-real-commands.test.ts:110`・`115`）。
    これらは `buildReadScreenResponse`（0x62 と同じ組み立て）を使う（`session.ts:647-650`）。
    **したがって前置・opcode・打鍵文字の差は、0x66 / 0x6A 経由では今も生きている。**
- **F13: 手当てと衝突しうる既存テスト。**
  - `packages/tn5250/test/save-partial-screen.test.ts:135` 「パラメータを読まない——直後の WTD の先頭を食わない」
    — `ESC 13` の直後に WTD と READ を置き、**両方が生きる**ことを固定している。
  - 同 `:196` 「後続のコマンドを捨てない」— `ESC 13` ＋ `ESC 52` で `readRequested` が立つことを固定。
  - **`ESC 12` について同種のテストは無い**（`write-extent.test.ts:161-181` は `restored` フラグだけを見る）。
  - **したがって `ESC 12` を「残りを捨てる」に変えても既存テストとは衝突しない。`ESC 13` は衝突する。**

## 影響範囲

- `packages/tn5250/src/protocol/wtd-applier.ts`（RESTORE_SCREEN / RESTORE_PARTIAL_SCREEN）
- `packages/tn5250/src/screen/buffer.ts`（`savedStack` / `saveScreen` / `restoreScreen` と、
  `aidNoDataMask` / `systemMessage` / `msgLineRow` の所有）
- `packages/tn5250/src/protocol/save-screen.ts`（`writeCell` の `rawByte ?? 0x40`、
  `buildReadScreenResponse` の前置と opcode）
- `packages/web-ui/src/stores/sessions.ts:481`（`edits.clear()`）— **ここに触ると全セッションの
  画面更新経路に掛かる。共有の振る舞いなので影響が最も広い。**
- テスト: `save-partial-screen.test.ts` / `save-screen.test.ts` / `read-screen-session.test.ts` /
  `read-screen-field-end*.test.ts` / `system-message-lifetime.test.ts` / `write-extent.test.ts`

## 実現性 / リスク

- **`ESC 12` で残りを捨てるのは危険**（F9b）。末尾の READ MDT を失い、施錠が解けなくなる。
  **積荷の長さぶんだけ読み飛ばす**方式が要る。長さは**送った時点で分かる**（`buildSaveScreenResponse` が
  組み立てた本体の長さ）ので、退避スタックの各段に添えて持てる。
  - 残るリスク: ホストが積荷を改変して返す場合。**2 回の採取では長さ 793 バイトで一致**しており、
    改変の兆候は無い。ただし**先頭が一致するかを確かめてから読み飛ばす**ほうが安全
    （一致しなければ従来どおりの解析に落とす）。
- **`ESC 13` は形が未確認**（F9b でも観測できず）。当 PJ の SAVE PARTIAL 応答には長さが無く
  （`save-screen.ts:90-97` が 0x02 と同一のバイト列を返す）、ACS のように 2 バイト長では区切れない。
  ただし**積荷の長さを覚えておく方式なら 0x13 にも同じように効く**。
  既存テストが固定している「パラメータを読まない・後続が生きる」は、長さ方式なら壊さずに済む
  （積荷が無いときは 0 バイト読み飛ばし＝現状と同じ）。
- **ブラウザの `edits.clear()` を条件付きにするのは影響が広い**。RESTORE のときだけ残す形にしても、
  「ホストが同じ欄を書き直した」場合との区別が要る。design で扱う。
- **CA マスク・メッセージ行を退避に足すのは局所**（`savedStack` の型と 2 メソッド）。
  ただし `SAVE SCREEN が systemMessage を消す`（F8）は**テストで固定された既存の意図**なので、
  「消してから退避するのか、退避してから消すのか」を design で決める必要がある。
  ACS は `processSaveScreen` の冒頭で `clearErrorMode()` し、**その後に** `Save5250Net` を作る
  （＝消えた後の状態を退避する）。
- **0x62 は到達しない**ので、形式を合わせても実機では確かめられない。**0x66 / 0x6A なら DSM で出させられる**
  （`scripts/host-src/dscmd.c` / `scripts/build-dscmd.mjs` / `scripts/diag-5250-commands.mjs` が既にある）。

## 実装アンカー

- A1: RESTORE SCREEN の復元（`packages/tn5250/src/protocol/wtd-applier.ts:204` `case COMMAND.RESTORE_SCREEN`）
- A2: RESTORE PARTIAL の復元（同 `:218-229` `case COMMAND.RESTORE_PARTIAL_SCREEN`）
- A3: 退避の型と push / pop（`packages/tn5250/src/screen/buffer.ts:514-530` `savedStack` /
  `:564` `saveScreen()` / `:620` `restoreScreen()`）
- A4: CA マスク（`buffer.ts:654` `aidNoDataMask` / `:660-666` `setHeaderData()` /
  `:692-700` `sendsDataForAid()`）
- A5: メッセージ行（`buffer.ts:147` `systemMessage` / `:664-666` `msgLineRow` /
  `:676-687` `clearSystemMessageIfTouched()`。消す側は `wtd-applier.ts:201`・`:214`）
- A6: 積荷の文字を書く箇所（`packages/tn5250/src/protocol/save-screen.ts:243` `writeCell`）
- A7: 画面イメージ応答（`save-screen.ts:100-119` `buildReadScreenResponse`。
  前置は `:107-108`、opcode は `:112`、未書き込み桁は `writeCell` の `empty = 0x40`）
- A8: 応答の振り分け（`packages/tn5250/src/session/session.ts:609-651`）
- A9: ブラウザの編集差分の破棄（`packages/web-ui/src/stores/sessions.ts:481` `s.edits.clear()`）
- A10: 拡張 5250 の申告（`packages/tn5250/src/protocol/query-reply.ts:45` `void enhanced;` / `:88-89`）
- A11: ByteReader の残バイト（`packages/tn5250/src/protocol/bytes.ts:13-15` `remaining`）

## 実装時の注意

- **`RESTORE_PARTIAL_SCREEN` の既存の振る舞いは実測に裏打ちされている**（自作自演の 5 バイトを
  やめた経緯が `save-screen.ts:73-88` と `wtd-applier.ts:218-229` に書いてある）。
  **同じ轍を踏まないよう、`ESC 13` を触るなら実機レコードを採ってからにする。**
- **`SAVE SCREEN` は `systemMessage` を消す**という既存の意図（ACS の `clearErrorMode()` 由来）を
  壊さないこと。テストが固定している。
- **`aidNoDataMask` は CLEAR UNIT で 0 に戻るが、CLEAR UNIT ALTERNATE では戻さない**
  （`buffer.ts:553` のコメント。SFLCTL の再描画で何度も来るため）。退避・復元を足すときは
  この非対称を壊さない。
- **`rawByte` を付けない箇所には理由がある**（`setUnmappable` / `setShift` / ORDER 0x1C・0x1E は
  カタカナ表示モードでの再解釈による化けを避けるため）。`writeCell` の既定を変えるなら、
  これらが `0x40` のままでよいかを個別に見る。
- **web-ui のテストはパッケージ dir から実行する**（`cd packages/web-ui && npx vitest run`。`AGENTS.md`）。
- **root の `npm run build` は web-ui を検査しない**（`AGENTS.md`）。`npm run build -w @ts5250/web-ui` を別に回す。
- 実機の装置名は使い回す（`.env.verify` の枠内）。新しい名前は自動構成が効かない環境がある。

## design への申し送り

1. **積荷は「送った長さ」で読み飛ばす**（F9b）。レコードの残りを捨てるのは不可——ホストが同じレコードの
   末尾に READ MDT を付けてくることがある。退避スタックの各段に**送った積荷の本体の長さ**を添え、
   `ESC 12` / `ESC 13` の直後がその積荷と一致することを確かめてから読み飛ばす。
   一致しなければ従来どおり解析する（＝退行しない）。
2. **積荷の中身をどうするか**は 2 択。(a) 積荷を読まないのだから、打鍵を `0x40` にしても実害は無い
   ——ただし同じ `writeCell` が `0x66`/`0x6A` の応答にも使われるので、**そちらには実害が残る**（F12）。
   (b) `writeCell` に「現在の表示文字を EBCDIC へ戻す」経路を足す。design で選ぶ。
3. **退避に足す状態**: `aidNoDataMask`・`systemMessage`・`msgLineRow`。
   ACS に倣い **`clearErrorMode()` 相当を先に行い、その後の状態を退避する**（F2）。
   セッション層（`readCommand` / `pendingAid` / `state`）は、当 PJ では保留が残らない構造なので
   **対象外にできる見込み**。design で根拠を書いて確定する。
4. **ブラウザの編集差分（A9）をどうするか**が、利用者から見た AC1 の成否を分ける。
   サーバー側を直しても、`edits.clear()` が残れば画面は空に見える。
   候補: RESTORE 由来の画面（`lastWrite.restored`）では `edits` を捨てない／
   サーバーへ打鍵を随時送る（影響大）。**ここが今回いちばん判断の要る点。**
5. **AC5（画面イメージ応答）は「0x62 は到達しない」で閉じられる見込み**だが、
   **`0x66` / `0x6A` は到達する**ので、前置・opcode・打鍵文字の差はそちらで実測して決着させる。
   DSM の資材（`scripts/diag-5250-commands.mjs`）が使える。
6. 残る未確認: `ESC 13` の実機レコードの形／`0x66` 応答をホストがどう受け取るか（前置を外して受理されるか）。

## 追加調査（2026-09-20・ACS のワイヤ実測）

`AGENTS.md`「判断の原則」（ACS を聖典とする／推測せず実機で確定する／矛盾したら過去の決定を破棄する）に
従い、**ACS が実機と交わすバイト列そのもの**を採った。

### F0-5 ACS のワイヤを無人で記録する手立て

`scripts/tap-proxy.mjs` を中継として上げ、**ECL プローブの接続先をその中継へ向ける**
（`AS400_HOST=127.0.0.1 PROBE_PORT=<中継ポート> node … scripts/acs-probe.mjs <手順>`）。
これで **ACS のコアが出す 5250 レコードを、利用者の操作なしに記録できる**。
- 中継は 5250 telnet だけ hex 記録する。**記録にはサインオンが平文で残るので、解析後に必ず消す**
  （この work でも解析後に削除した）。
- 2323 は WSL 側で塞がっていたので別のポートを使った（`TAP_PORT`）。
- **注意: 中継が開いたままのログファイルを消すと、以後の書き込みが失われる**（追記ストリームが
  削除済みの inode を掴む）。採り直すときは中継を上げ直す。

### F14: ACS の SAVE SCREEN 応答は「zlib 圧縮した自分の状態」で、opcode は受信の写し

ACS→ホストの応答レコード（Attn の SAVE SCREEN に対して）:

```
len=2892  opcode=0x04  flags=0x00,0x80
本体: 04 12 78 9c ed 5c 7d 6c 1c c5 15 …
```

- **`78 9c` は zlib（Deflate）のヘッダ**。`Save5250Net.writeNetSavedScreen()`（Java のオブジェクト直列化）
  ＋ `compressNetBuffer()`（`Deflater`）そのもの（F1・F2 の一次資料と一致）。
- **opcode は `0x04`**——受信した SAVE SCREEN レコードの opcode の写し
  （ACS のコード `byArray2[n4++] = (byte)this.WorkHeader.Opcode;` と一致）。
- **当 PJ は `OPCODE.RESTORE_SCREEN`(0x05) を使っている**（`packages/tn5250/src/protocol/save-screen.ts:29`）。
  **差異。実測で確定した。** 既存テスト `packages/tn5250/test/save-screen.test.ts:32` が 0x05 を固定している。

### F15: ホストは ACS の積荷をバイト単位でそのまま返す

ホスト→ACS の RESTORE SCREEN レコード: `len=2892 opcode=0x05`、本体は
`04 12 78 9c ed 5c 7d 6c 1c c5 15 …`、末尾 16 バイトも ACS が送ったものと一致。
**長さも中身も往復で変わらない。**

### F16: 同じレコードに READ が続くかは、積荷の形式で変わる（**当 PJ だけ続く**）

| 誰の積荷か | 積荷の長さ | Attn→F12 の RESTORE レコード | QSH→F3 の RESTORE レコード |
|---|---|---|---|
| **ACS**（zlib） | 2,882 / 2,876 B | `04 12` ＋ 積荷で終わる。READ は**別レコード** | `04 12` ＋ 積荷で終わる。READ は**別レコード** |
| **当 PJ**（平文 WTD） | 793 B | `04 12` ＋ 積荷で終わる。READ は**別レコード** | **`04 12` ＋ 積荷 ＋ `04 52 00 00` が同一レコード** |

- 当 PJ の QSH→F3 は**2 回とも同じ形**（`@0:0412 @2:0411 @795:0452`。809 バイト）。再現性あり。
- ACS も QSH→F3 を通したが、RESTORE レコードは圧縮データで終わり、READ MDT は次のレコードで来た。
- **したがって「レコードの残りを捨てる」は当 PJ では使えない**——ACS でそれが成り立つのは、
  ACS の積荷ではホストが READ を別レコードにするからで、**当 PJ の積荷形式では成り立たない**。
  なぜ形式で変わるのかは**未確認**（設計には不要）。

### F17: ACS は Attn にも F12 にも欄データを載せない

ACS→ホストの小さいレコード（本体 12 バイト以下）:

| レコード | opcode | flags | 本体 | 何か |
|---|---|---|---|---|
| 10B | 0x00 | **0x40**,0x00 | （空） | **Attn**（フラグレコード。欄データ無し） |
| 13B | 0x03 | 0x00,0x80 | `14 1a 3c` | **F12**（カーソル 20,26 ＋ AID `0x3C`。**欄データ無し**） |
| 19B | 0x01 | 0x00,0x80 | `14 0a f1 11 14 07 d8 e2 c8` | **Enter**（AID `0xF1`）＋ SBA(20,7) ＋ `QSH` |

- **ACS も Attn に欄を載せない**（当 PJ の `isFlagKey` と同じ）。
- **F12 でも欄データを送っていない**——ACS の画面には `WRKACTJOB` が残っていた（F11）のに、である。
  ＝**打鍵を表示バッファに持つことと、それをホストへ送ることは別**。
  D6 で「Attn 後に打鍵済みの欄を送るようになる」と書いたのは**推測で、ACS の実測と食い違う**。
  **打鍵をサーバー側バッファへ入れる変更は、送信の有無を変えてはならない**——
  この点を受け入れ基準に入れて実機で確かめる。
