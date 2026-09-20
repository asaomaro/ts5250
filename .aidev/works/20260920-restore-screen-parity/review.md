# レビュー記録

## タスク点検ログ（coding 工程内・`protocol.md`「3.3」(b)）

### T4（RESTORE SCREEN の積荷読み飛ばし。delegated・ラウンド 1・7 件）

- [should][conv:-] `packages/tn5250/src/screen/buffer.ts` `attachSavePayload` — **頂点に添えるので、1 レコードに SAVE が 2 回入ると先の段に積荷が付かず、欠陥が無警告で再発する**（委譲先が dist で実測し、2 段目の RESTORE で "AB" が "RR" になることを再現）／ 対応: 修正済（`saveScreen()` が段の深さを返し、`attachSaveContext(depth, …)` で段を指定する形に変更）
- [should][conv:-] `packages/tn5250/src/protocol/wtd-applier.ts` `restoreAndSkipPayload` — 積荷が `undefined` のときの早期 return が無警告。JSDoc の「黙って落ちない」という主張と食い違う／ 対応: 修正済（`no payload recorded` を warn。テストで固定）
- [should][conv:-] `packages/tn5250/src/protocol/wtd-applier.ts:349` — 迷子の JSDoc。`applyCc` の 1 行コメントが新関数の直前に取り残された／ 対応: 修正済（`applyCc` の直前へ戻した）
- [should][conv:comment-provenance!] 同 `restoreAndSkipPayload` の JSDoc — 後半の `research F16` / `decisions D10` が work 未修飾。同ファイルには別 work の素の `research F5` があり、**同じ表記が 2 つの work の別の項目を指す**状態だった／ 対応: 修正済（`20260920-restore-screen-parity` を付けた）
- [nit][conv:measurement-sanity] 同 JSDoc — 「当 PJ の積荷だとホストは同じレコードに READ を載せてくる」が経路を落として一般則に読める。実測では QSH→F3 だけで、Attn→F12 では別レコードだった／ 対応: 修正済（経路名を明記）
- [nit][conv:comment-provenance] `packages/tn5250/test/restore-screen-payload.test.ts` — 「1 バイト目だけ変えて」と書いて最終バイトを反転していた／ 対応: 修正済（コメント側を直した。末尾反転の方が全バイト照合を効かせるので実装は据え置き）
- [nit][conv:paired-artifact-sync] `savedStack` の「積んだ項目が全部戻る」が目視でしか担保されていない／ 対応: 修正済（往復テストを追加）

### cross（タスクをまたぐ不変条件。delegated・ラウンド 1・7 件）

- [must][conv:-] `packages/tn5250/src/session/session.ts` — **退避の段が「バッファ」と「セッション」の 2 か所で管理され、間に早期 return 6 か所と catch 1 か所がある**。RESTORE と READ SCREEN 等が同じレコードに載ると `restoredCount` が捨てられ、以後ずっと 1 段古い `readCommand` を復元し続ける。戻す経路が無い／ 対応: 修正済（**スタックを 1 本に畳んだ**。`readCommand` を `ScreenBuffer` の退避段へ入れ、`savedInputState` / `pushInputState` / `popInputState` を撤去。復元値の反映は `applyDataStream` の直後＝早期 return より前へ）
- [must][conv:-] `packages/server/src/ws-handler.ts` — 逃げ道の判定が `KEYBOARD_LOCKED` しか見ていない。`setField` は `FIELD_TYPE` / `FIELD_OVERFLOW` / `FIELD_PROTECTED`・欄が見つからない・秘密の復号でも投げ、**その場合 `sendAid` に到達せず Attn / SysReq がホストへ出ない**／ 対応: 修正済（フラグキーの同期を try/catch の best-effort にし、失敗しても送信を止めない。warn だけ残す）
- [should][conv:-] 1 レコードに SAVE が 2 回（T4 の 1 件目と同根）／ 対応: 修正済（同上）
- [should][conv:-] `pushInputState()` が捉える `state` が、そのレコードの施錠／解錠より前の値。**READ を伴わない RESTORE で `ready` のセッションが `locked` に戻る**／ 対応: 修正済（**`state` は退避しない**ことにした。ACS の `SaveKeyboardLocked` は OIA の表示に近く、当 PJ の `state` は `sendAid` の門番も兼ねる別概念。decisions D12 に「未対応」として記録）
- [should][conv:-] 「ホストへ送るバイト列は変わらない」が言い過ぎ。MDT が立つので、直後に READ IMMEDIATE(0x72) / READ MDT IMMEDIATE ALT(0x83) が来ると自動応答で欄が出る／ 対応: 修正済（注記を「そのキー自身のレコードは変わらない」に直し、0x72/0x83 の経路を ⚠ で明示。**実機で確かめる**ことを AC11 / T14 へ送った）
- [should][conv:paired-artifact-sync] 対の資産の片側だけが直っていた。`isFlagKey` の doc が「欄は載せない」のまま／ 対応: 修正済（doc を現状に合わせ、**施錠中はクライアント側でも欄を落とす**ようにし、web-ui にその分岐のテストを追加）
- [should][conv:-] `setUnmappable()` に `hostByte` が及んでいない。**ホストの UNMAPPABLE バイトが 3 経路すべてで空白に化ける**（ヘルプ本文＝READ SCREEN で返す当の画面で出る）／ 対応: 修正済（`setUnmappable(addr, UNMAPPABLE)` を渡す）

### 主エージェントが自分で見つけた分

- [must][conv:-] `packages/tn5250/test/restore-screen-payload.test.ts` — `sendsDataForAid()` は**キー番号（1〜24）**を取るのに AID コード（`0x3c`）を渡しており、**CA マスクの検査が常に true で空振りしていた**／ 対応: 修正済（`12` に直し、「申告が効いている」ことを先に固定して空振りを塞いだ）

## ラウンド 1（2026-09-20・主エージェントの観点）

要件適合・価値適合・規約適合は主エージェントが見た（`protocol.md`「2.5」——この 3 つは work の文脈が
要るので委譲しない）。正確性・保守性は別コンテキストへ委譲した（下の「委譲分」）。

### 要件適合

- `aidev coverage`: **ac=12 / design 12/12 / tasks 12/12 / gaps=0**。tasks 承認時と同じ被覆で、
  `ac_drift` は出ていない（design と実装の乖離なし）。
- `aidev verify`: **OK**。

### 価値適合

`requirements.md` の 4 つのゴールに照らして確認した。3 つは実測で満たされている（`test-result.md`）。
4 つ目で 1 件ずれを見つけた:

- [should][conv:-] `packages/tn5250/src/protocol/save-screen.ts:21` — ゴールに掲げた
  「`save-screen.ts` の『積荷は読まない』という記述と実装が一致している」が**まだ一致していない**。
  積荷を**画面へ適用**はしなくなったが、照合のために**読んで**いる／
  対応: 修正済（「積荷を画面へ適用せず」に直し、「照合のためには読む」を明示して
  `restoreAndSkipPayload` へ参照を張った）

### 規約適合

- `console.*` 0 件・ピュアロジック層への `node:*` 0 件（`AGENTS.md`「コーディング規約」）
- 実機の固有名詞 0 件・ACS の逐語引き写し 0 件・秘密 0 件（`AGENTS.md`「セキュリティ」「実機の識別子」）
- [must][conv:-] `eslint.config.js` — **`npm run lint` が 25 件のエラーで落ちる**。
  すべて `IBMiAccess_v1r1/`（IBM の頒布物のインストーラ script）。前の work で `.gitignore` には
  足したが eslint の除外が漏れていた。**他人が書いた頒布物をこちらの規約で裁かない**／
  対応: 修正済（`ignores` に `IBMiAccess_v1r1/**` を追加。`npm run lint` が通るようになった）
- [should][conv:comment-provenance!] `packages/tn5250/src/protocol/wtd-applier.ts` /
  `packages/tn5250/src/screen/buffer.ts` / `packages/tn5250/src/session/session.ts` /
  `packages/server/src/ws-handler.ts` — 新しく書いたコメントのうち 4 か所が
  `（cross 点検で実測）` `（同 work の cross 点検で実測）` のように**work 未修飾**で、
  同じブロックに slug が無い。T4 点検で同じ類型を直したのに**隣で再発した**／
  対応: 修正済（4 か所すべてに `20260920-restore-screen-parity` を付けた。
  slug が同じブロックに在るものは「同 work の」のままとした——リポジトリの既存の書き方に合わせる）

### 委譲分（正確性・保守性。delegated・29 件）

**must**

- [must][conv:comment-provenance!] `packages/web-ui/src/session-controller.ts:171-181` — 旧 JSDoc が消されずに新 JSDoc と二重に積まれている。旧側の「**欄は載せない**」は実装と正反対で、関数に結び付くのは下のブロックだけなので**エディタでは見えないまま腐る**
- [must][conv:comment-provenance!] `packages/tn5250/src/protocol/save-screen.ts:17` — 「opcode は RESTORE_SCREEN（0x05）。」が同じ JSDoc の後半（「受信したレコードの写し」）と正面から矛盾

**should**

- [should][conv:-] `packages/server/src/ws-handler.ts:1059` — `assertWritable` が死んだ検査（`assertKeyAllowed` が既に見ており、フラグキーは `READONLY_ALLOWED_KEYS` に無いので必ず通る）。しかも try の中なので認可の失敗が best-effort の skip と区別できない
- [should][conv:-] 同 `:1058-1065` — 施錠を「`setField` が投げるのを捕まえる」で判定しているため、**施錠中に打ちかけが残る正常経路で毎回 warn が出る**（server のテスト実行でも 2 本出ている）。本当に気づきたい異常が定常ノイズに埋もれる
- [should][conv:comment-provenance!] 同 `:1047` — 出所が実在しない（`ScreenGrid.vue` に `inputInhibited` は無い。実体は `session-controller.ts:132`）
- [should][conv:-] 同 `:1047` — 「ここで捨てて失う打鍵は無い」は誤り。**施錠前に打った内容は `s.edits` に残り、クライアントが施錠中のフラグキーでそれを落とす**——「固まったので Attn で逃げる」というまさに狙った場面で失われる
- [should][conv:comment-provenance!] 同 `:1040` — 「実機で確かめる（AC11 / T14）」が既に閉じた項目を未着手のように指している。ただし pass の根拠はフラグレコードの前後比較で、**0x72/0x83 の経路は測っていない**。確認済みと未確認を書き分ける
- [should][conv:-] 同 `:1056` — 「書けなくても失うものは無い」は言い過ぎ。失わないのは**ホストへ送るバイト列**だけ
- [should][conv:paired-artifact-sync] 同 `:1049-1076` — フラグ／非フラグの 2 分岐が `resolveField` ＋ `setField` を二重に持ち、片方だけが D11（秘密は 1 欄も書く前に全部解決）を明示している
- [should][conv:-] `packages/tn5250/src/session/session.ts:619-638` — SAVE の応答を**レコードを流し終えてから**組むので、同じレコードに SAVE ＋重ね描きが載ると「重ね描き後」の画面をホストに預ける。ACS は SAVE の処理中に即時で組む。`saveRequests`/`depth` を入れた今なら SAVE の時点で組める
- [should][conv:comment-provenance!] 同 `:599-601` — 「後段の `result.readCommand` が上書きする」は保証されない。上書きは早期 return 群の**後ろ**にあり、3 行上のコメント自身がそれを理由に位置を決めている
- [should][conv:comment-provenance!] `packages/tn5250/src/protocol/wtd-applier.ts:83-91` — `restoredCount` は本番で誰も読まない。doc が謳う「施錠を同じ段数だけ戻す」は未実装（AC12 で「未対応」と記録済み）
- [should][conv:comment-provenance!] 同 `:32-33,77-82` — `saveScreenRequested` は本番の読み手がゼロ、`savePartialScreen` もテスト専用に。「応答に写して返すため」も `void params` と食い違う。**同じ事実を表す状態が 3 つ並んでいる**
- [should][conv:comment-provenance!] 同 `:239-240` — 「（opcode PUT/GET）」「パラメータは応答へそのまま写す」がどちらも現実装と違う
- [should][conv:comment-provenance!] `packages/tn5250/src/protocol/save-screen.ts:98` — 「opcode は PUT/GET」が stale
- [should][conv:comment-provenance!] `packages/tn5250/src/screen/buffer.ts:624` — `attachSavePayload()` は存在しない名前（改名の取り残し）
- [should][conv:measurement-sanity] `packages/tn5250/src/protocol/save-screen.ts:134-148` — 形式を決めた実測は **0x66** で採ったもので、この関数の主用途 **0x62**（PDM F1 の背面再現）では採っていない。原典で「0x62 も同じ `processReadScreen` に入る」ことを確かめて明記するか、0x62 の観測を 1 本足す
- [should][conv:paired-artifact-sync!] 同 `:225` — **拡張版（0x64）だけ opcode が固定のまま**。対の片方だけが直っている
- [should][conv:-] 同 `:272-279` — DBCS 分岐だけが保持済みの生バイトを使わず再符号化する。SBCS 側を「受信した生バイト」に変えたのと非対称
- [should][conv:-] `packages/tn5250/src/screen/buffer.ts:825` — `setChar(addr, char, rawByte?, hostByte?)` に JSDoc が無く、意味の違う任意 `number` が 2 つ隣り合う
- [should][conv:paired-artifact-sync!] `packages/web-ui/src/session-controller.ts:1178` ＋ `packages/server/src/ws-handler.ts:1044` — 「施錠中は欄を運ばない」が**別の述語**で二重化（`busy || keyboardLocked` と `assertReady`）。対応を固定するテストが無く、`busy` だけ真のとき打鍵が黙って落ちる
- [should][conv:-] `packages/server/test/ws-handler.test.ts:395-402` — 「欄を書かない」と名乗りながら error が出ないことしか見ていない。`mdt` が false のままを見ないと回帰資産にならない
- [should][conv:comment-provenance!] `packages/tn5250/test/save-partial-screen.test.ts:245-246` — opcode の検査を落とし、コメントだけ残った。セッション経路で SAVE PARTIAL 応答の opcode を見る唯一のテスト
- [should][conv:comment-provenance!] `AGENTS.md:21-22` — 「場所と手順は『既存プロトコル実装の移植』節」と書いたが、その節に `acsbundle.jar` もデコンパイル手順も無い。**最優先の原則が実在しない手順を指している**

**nit**

- [nit][conv:-] `packages/tn5250/test/restore-screen-payload.test.ts:138-142` — 2 段ぶんの payload が同一バイト列なので、段の取り違えは警告の有無でしか落ちない
- [nit][conv:-] `packages/tn5250/src/screen/buffer.ts:664-668` — `depth` は位置であって同一性ではない。SAVE → RESTORE → SAVE で同じ深さが別の段を指す
- [nit][conv:-] `packages/server/src/ws-handler.ts:1064` — `String(e)` が `As400Error` の `code` とスタックを落とす
- [nit][conv:-] `packages/tn5250/src/screen/buffer.ts:838-847` — `setUnmappable` の JSDoc 見出しが「rawByte は渡さない」のままで、`hostByte` の説明が本体コメントにしかない
- [nit][conv:-] `packages/tn5250/src/protocol/save-screen.ts:294-300` — `encodeSbcs` は DBCS に届かない（`bytes.length !== 1` で 0x40 に倒れる）。従来と同じなので退行ではないが限界を明記する

## ラウンド 2（2026-09-20・差し戻し 29 件を直した後）

### 主エージェントが見つけた退行

- [must][conv:-] `packages/tn5250/test/client-flag2.test.ts:62` ほか 6 か所 —
  `buildReadScreenExtendedResponse` に `replyOpcode` を足したのに、**テストの呼び出しが
  引数 2 つのまま通っていた**（`undefined` が opcode として渡る）。
  **`packages/tn5250` の tsconfig は `include: ["src"]` でテストを型検査しない**ので、
  引数不足が静かに通る（`AGENTS.md`「ビルド・テスト」にこの非対称の注記はあるが、
  **この class の欠陥を止める層が無い**）／
  対応: 修正済（7 か所すべてに `OPCODE.READ_SCREEN` を渡した）。
  **見つけ方**: 一時の tsconfig でテストを型検査し、`TS2554`（引数不足）を洗った。
  残った `TS2554` は `snapshot()` の既存の呼び方で、今回の変更とは無関係。
  **層を下げる手当て**（tn5250 / hostserver のテストも型検査する）は backlog へ起票する。
- [should][conv:-] `packages/tn5250/src/protocol/save-screen.ts:293` — DBCS の生バイト参照で
  `buf.cellAt(addr + 1)` が画面末尾で例外を投げうる（`cellAt` は `checkAddr` で投げる）。
  `setDbcs()` が `checkAddr(addr + 1)` で守るので lead が最終桁に来ることは無いが、
  **ここで投げると応答そのものが組めなくなる**／ 対応: 修正済（境界を確かめてから読む）

### 撤去の取りこぼし検査

- `grep -rn "saveScreenRequested\|savePartialScreen" packages/ --include=*.ts` — **0 件**（完全撤去）
- `buildReadScreenExtendedResponse` の呼び出し元 — 本番 1 か所・テスト 7 か所すべて追従済み

### 検証

- `npx vitest run --root packages/tn5250` — 675 passed / 0 failed
- `npm run build` ＋ `npm run lint` — 成功

### 委譲分（ラウンド 2・退行の点検。delegated・10 件）

- [must][conv:-] `packages/server/src/ws-handler.ts:1077` — **新設の warn が打鍵した欄の値をサーバーログへ出す**。
  `FIELD_TYPE` の文言は値をそのまま埋め（`packages/tn5250/src/screen/field-validate.ts:58` ほか
  `${JSON.stringify(value)}`）、その `value` は**マクロ由来の秘密でもありうる**（`resolveSecret`）。
  `log.ts` に redact は無く、**ログへ message を出す経路はここが唯一**（`withAudit` は `code` しか記録せず、
  `sendError` はクライアントへ送るだけ）。`AGENTS.md`「秘密の扱い」の「ログにも値を出さない」に反する。
  **ラウンド 1 の nit（`String(e)` は code とスタックを落とす）に応じた修正が生んだ退行**
- [should][conv:-] 同 `:1073-1078` — 今回足した try/catch（＝逃げ道の担保）に**回帰テストが無い**。
  新規 2 件は「施錠されていない＝書く」「施錠中＝書かない」だけで、**`setField` が投げる場面**を通っていない
- [should][conv:paired-artifact-sync] `packages/tn5250/test/restore-screen-payload.test.ts:121-158` —
  「1 レコードに SAVE が 2 回」の検査が**セッション層を再現していない**。本番は毎回おなじ `this.buf` から
  組むので 2 本の積荷がバイト単位で同一になるが、テストは段ごとに画面を書き替えて差を作っている。
  **頂点に戻す退行が起きてもこのテストは通る**（＝T4 が見つけた欠陥を固定できていない）
- [should][conv:comment-provenance!] `packages/tn5250/src/protocol/save-screen.ts:292` —
  `（review ラウンド 1 の指摘）` が work 未修飾。**同じ類型が 3 ラウンド続けて出ている**
- [should][conv:paired-artifact-sync] `packages/tn5250/test/save-partial-screen.test.ts:249` —
  stale な主張がテストに残る（`opcode は RESTORE_SCREEN` が直後の「受信の写し」と矛盾）。
  `save-screen.ts` 側だけ直して対を直し忘れた形
- [nit][conv:-] `ws-handler.ts:1059` — `msg.fields!` の non-null assertion。`if` の手前で `const fields` を
  取れば不要になり、将来 `write()` を遅延実行へ動かしても型で守られる
- [nit][conv:-] `save-screen.ts:296` — tail の判定が `charKind === "dbcs-tail"` を見ていない。
  lead の対が SBCS で上書きされた欄では、その SBCS バイトを trail として送る
- [nit][conv:-] `packages/tn5250/src/screen/buffer.ts:615` — `cellAt` の上に別メソッド（`saveScreen`）の
  JSDoc が孤児として残り二重になっている。**ラウンド 1 の must（重複 JSDoc）と同じ欠陥が 5 行上に残っていた**
- [nit][conv:-] `save-partial-screen.test.ts:253-254` — opcode の検査が `toBeDefined()` より前にあり、
  応答が無いとき用意した説明文言に到達しない
- [nit][conv:-] `save-screen.ts:115-121` — `params` が儀式になった（`void params`・doc は「写さない」・
  呼び出し側は `?? new Uint8Array(0)`）。引数ごと落とせば「写さない」が構造で真になる

## ラウンド 3（2026-09-20・委譲分 12 件）

- [must][conv:-] `packages/server/src/ws-handler.ts:42-49` — `errShape()` は `stack` の**1 行目しか
  落とさない**ので、**message が複数行なら 2 行目以降が `at` に残る**。同じ try に到達経路がある
  （`resolveField` が投げる `invalid secretRef: ${ZodError.message}` は整形 JSON で複数行。
  `.strict()` なので未知キー名＝クライアント由来の文字列も入る）。委譲先が実測し、18 行中 17 行が残った。
  **JSDoc の「1 行目は `<name>: <message>`（V8 の書式）」は推測のまま検証していなかった**
  （`AGENTS.md` 判断の原則 2 違反）。**ラウンド 2 の must（秘密のログ出力）の修正が生んだ退行**
- [should][conv:-] `packages/tn5250/test/save-screen-session.test.ts:99-100` — 新しい回帰テストの
  最終検査が**警告の部分集合**しか見ないので、復元に到達しなくても緑になる
  （委譲先が `ll` を +1 して `parseRecord` を落としても 2 件とも pass することを実測）
- [should][conv:-] `packages/tn5250/src/protocol/save-screen.ts:327,338` — **この work の中心の修正**
  （`rawByte ?? hostByte ?? encodeSbcs(...)`）に**テストが 1 件も無い**。`hostByte` はテスト全体で 0 ヒット
- [should][conv:comment-provenance!] `packages/tn5250/test/restore-screen-payload.test.ts:229` —
  「`savedStack` に項目を足したら落ちるはず」という**網羅の主張が成立していない**。
  同じ差分で足した `msgLineRow` を見ていない（リポジトリ全体で往復の検査 0 件）
- [should][conv:-] `packages/tn5250/test/save-partial-screen.test.ts:110` — `params` 撤去の追従漏れ。
  「受け取った 5 バイトは送り返さない」が**もう受け取っていない**値を検査しており、何も固定しない
- [should][conv:-] `packages/server/src/ws-handler.ts:1255`（差分外・既往）— `sendError(code, err.message)` が
  検証エラーの文言をそのままブラウザへ返す。**復号済みの秘密が平文でクライアントへ返る**経路がある
  （`AGENTS.md`「API/ブラウザには平文も暗号文も返さない」）。ラウンド 2 の must と同じ系統
- [nit][conv:-] `packages/web-ui/src/session-controller.ts:1179` — コメントは「施錠中は載せない」だが
  実装は `busy` でも落とす。サーバーのゲートは `keyboardLocked` のみで非対称
- [nit][conv:-] `packages/server/src/ws-handler.ts:1076` — `assertWritable` が try の外。いまは等価だが
  「読み取り専用でも逃げ道は通す」を入れた瞬間に壊れる
- [nit][conv:-] `packages/tn5250/src/protocol/save-screen.ts:120-126` — `params` 撤去後、
  `buildSavePartialScreenResponse` は `buildSaveScreenResponse` の完全な別名
- [nit][conv:-] `packages/tn5250/test/save-partial-screen.test.ts:251-252` — 同じ注記が 2 行連続で重複
- [nit][conv:-] `packages/server/src/ws-handler.ts:44-47` — `at` に開発機の絶対パスを含む全フレームが入る
- [nit][conv:-] `packages/tn5250/src/protocol/save-screen.ts:338-343` — `encodeSbcs` が order 帯（<0x20）を素通しする

## ラウンド 4（2026-09-20）

### 主エージェントが見つけた退行（**またラウンド 3 の修正由来**）

- [must][conv:-] `packages/server/src/ws-handler.ts` `errShape()` — **`at ` の行だけを残す実装は、
  message の行頭が `at ` なら漏れる**。実測:

  ```
  1 行 message に at: 漏れない
  複数行 message の行頭が at: !!! 漏れる
  ```

  利用者が打った値・zod のキー名がそうなりうる。**行の「形」で選ぶ限り message を排除できない**／
  対応: 修正済（`stack` を `<name>: <message>` の**長さで切って**からフレームを拾う。
  先頭がその形でないランタイムに備え、一致しなければ 1 行目だけ落として `at ` で絞る）。
  テストを 2 件足し、**ラウンド 3 の実装を注入すると落ちる**ことを確かめた。

  **これで 3 世代ぶんの誤りがすべてテストで止まる**——`String(e)`（ラウンド 2 の must）/
  1 行目だけ落とす（ラウンド 3 の must）/ `at ` の行だけ（ラウンド 4 の must）。
  いずれも**測らずに書いた**のが原因（`AGENTS.md` 判断の原則 2）。

### 自分で測って確かめたこと（推測で通さない）

- **`encodeSbcs` の `b < 0x20` で表示文字が落ちないか** — CCSID 37 で ASCII の表示文字（0x20〜0x7E）を
  全部符号化し、**EBCDIC で 0x20 未満になるものは 1 つも無い**ことを確認した。

### 委譲分（ラウンド 4・9 件）

- [must][conv:-] `packages/tn5250/test/restore-screen-payload.test.ts:249-275` —
  `msgLineRow` の往復検査が**構造的に落ちない**。SOH に入れた `0x18`＝24 は**既定値**で、
  SAVE と RESTORE の間の「全部を別物にする」操作（`CLEAR_UNIT` ＋ WTD）は `msgLineRow` に触れない
  （`clearUnit()` が 0 に戻すのは `aidNoDataMask` だけ）。
  **主エージェントが確認**: `restoreScreen()` から `this.msgLineRow = saved.msgLineRow` を消しても
  15 件すべて緑のまま。コメントが「往復はこれが唯一の検査」と書いているぶん、埋まったように見えて無防備
- [should][conv:-] `packages/server/src/ws-handler.ts:66` — `stack` が `<name>: <message>` で
  始まらないときの退避路が **fail-open**（1 行目しか落とさない＝ラウンド 3 で漏れた形に戻る）。
  秘密を出さないことが唯一の目的の関数なので**閉じる側**に倒すべき
- [should][conv:-] `packages/tn5250/src/protocol/save-screen.ts:350` — `b < 0x20` は**半分しか塞いでいない**。
  委譲先が ibm37/273/930/939/1399 の全表を走査して実測: 表示可能文字は 0x20 未満へ落ちない（＝
  従来の文字は失っていない）が、**C0 制御は属性帯 0x20–0x3F へ落ちる**（U+000A→0x25・U+001A→0x3F ほか）。
  `validateFieldContent` は制御文字を弾かないので、WS/MCP/マクロ経由の値が**属性バイト**として応答に載る
- [should][conv:comment-provenance] `packages/tn5250/test/restore-screen-payload.test.ts:320-324` —
  この 1 件だけ `applyDataStream` を通さず `setUnmappable` を直に呼ぶので、
  **この work が足した配線（`wtd-applier` の `setUnmappable(addr++, UNMAPPABLE)`）を固定していない**。
  さらに `// UNMAPPABLE` は事実と違う（`UNMAPPABLE = 0x1f`。渡していた 0x3F は属性帯）
- [nit][conv:-] 同 `:357-369` — `msgLineRowOf` は差分行が無いと `findIndex` の -1 から **0 を返す**
  （プローブの失敗が値に化ける）。`systemMessage` を残すので呼ぶ順にも依存する
- [nit][conv:comment-provenance] `packages/server/src/ws-handler.ts:40-46` —
  「2 回間違えた」と書きながら取り消し線は 3 つ。また
  「利用者が打った値・zod のキー名が `at ` で始まりうる（**実測で確認した**）」は**裏が取れない**
  ——`field-validate.ts` は `JSON.stringify(value)` なので打鍵値の改行はエスケープされ行頭を作れず、
  zod の整形 JSON の行頭は `"`/`{`/`[`。**防御は妥当だが出所の書き方が誤り**
- [nit][conv:-] `packages/tn5250/src/session/session.ts:599-600` — 「後段の `result.readCommand` が
  上書きする」は**早期 return が挟まらないときだけ**成り立つ。2 行上で同じ罠を警告しているので書き添える
- [nit][conv:-] `packages/server/test/err-shape.test.ts:56-58` — `at` が付かないときも 1 で通るので
  「ちゃんと採れている」を固定できない
- [nit][conv:-] `AGENTS.md:12-27` — 新設の「判断の原則 1」は ACS のデコンパイルを正典として読めと言うが、
  「逐語移植は二次的著作物」「事実に基づいて書き起こす」という歯止めは下の JTOpen 向けの節にしか無い。
  **ACS は独占物で JTOpen より制約が強い**ので、最優先節の側に明記すべき

## ラウンド 5（2026-09-20）

### 主エージェントが先に測って確かめたこと

ラウンド 4 の修正のうち、**いちばん壊しやすい 3 点**を先に確かめた（推測で通さない）。

- **`stackFrames` の fail-closed で正常系の `at` が空にならないか** — `As400Error` は
  `super(message)` の**後**に `this.name` を代入するので、`stack` の頭が `"Error: …"` に
  なっていれば `at` が丸ごと消える。実測:

  ```
  e.name: As400Error
  stack の 1 行目: "As400Error: numeric only"
  期待する頭:      "As400Error: numeric only"
  startsWith で一致するか: 一致
  ```

  V8 は `stack` を**遅延生成**するので、代入後の `name` が使われる。空にならない。
- **`b < 0x40` で属性セルが壊れないか** — `writeCell` は `cell.type === "attr"` を
  `encodeSbcs` の**手前**で別分岐しており（`w.u8(cell.byte)`）、属性バイトはこの条件を通らない。
- **`messageLineRow` ゲッターが公開面を広げないか** — `ScreenBuffer` は
  `packages/tn5250/src/index.ts` からも `browser.ts` からも**輸出されていない**（`grep` で 0 件）。
  パッケージの公開 API は変わらない。

### 委譲分（ラウンド 5・8 件）

- [must][conv:-] `packages/tn5250/src/protocol/save-screen.ts:358` — **ラウンド 4 の修正
  （`b < 0x20` → `b < 0x40`）を落とすテストが 1 件も無い**。委譲先が変異注入で実測:
  `b < 0x20` に戻しても **682 件すべて緑**。ラウンド 4 の must と同じ「テストが構造的に落ちない」形
- [must][conv:-] `packages/server/src/ws-handler.ts:72` — **ラウンド 4 の fail-closed を落とすテストが無い**。
  ラウンド 3 の退避路に戻しても **34 件すべて緑**（変異注入で実測）。
  いまのテストは「頭が一致する例外」しか渡していないので、**分岐に一度も入らない**
- [should][conv:comment-provenance!] 同 `:52` — **fail-closed が効きすぎて、この Node でも `at` が消える**。
  node v24.15.0 で実測: ① Node 内部の `ERR_*` は `stack` の頭が `TypeError [ERR_INVALID_ARG_TYPE]: …`
  なのに `name` は `"TypeError"`（`Buffer.from(123n)` で再現）② message が空だと V8 が `": "` を出さない。
  **`setField` / `resolveField` の失敗をいちばん切り分けたい場面で位置が残らない**。
  JSDoc の「ランタイム差」という書き方も誤り
- [should][conv:-] `packages/tn5250/src/screen/buffer.ts:795` — 新設した `messageLineRow` ゲッターを
  `clearSystemMessageIfTouched` の JSDoc と当の関数の**間に挿し込んだ**ため、その JSDoc が宙に浮いた。
  **同じ欠陥を `cellAt` の側では直しているのに、隣で作り直している**
- [should][conv:comment-provenance!] `packages/tn5250/src/protocol/save-screen.ts:226` —
  「ACS は `DS5250` の**どの Read でも** `WorkHeader.Opcode` を写す」と網羅を主張しているが、
  **当 PJ の Read 応答 5 経路のうち 2 つ（`buildReadImmediateResponse` 0x72 /
  `buildReadMdtImmediateAltResponse` 0x83）は `PUT_GET` 固定のまま**
- [nit][conv:measurement-sanity] 同 `:354` — 実測の範囲が「全表」と読めるが走査したのは 5 CCSID
  （`codecForCcsid` が受けるのは 10 個）。また U+0080–U+009F・U+007F は 0x40 未満へ落ちるので、
  「表示文字は 1 件も無い」は C1 / DEL を制御として数えた場合にだけ成り立つ。**範囲を書き添える**
- [nit][conv:-] `packages/tn5250/src/protocol/wtd-applier.ts:402` — `no payload recorded` は
  **同一レコードに SAVE → RESTORE が載った場合にも必ず出る**（応答はレコードを流し終えた後に組むため）。
  無害な空振りだが、本当の配線のずれと区別が付かない
- [nit][conv:-] `packages/tn5250/src/session/session.ts:636` — 退避段へ預ける `readCommand` は
  **そのレコードを流す前の値**。`READ → SAVE` が同一レコードに載ると ACS と食い違う。実機では未観測

## ラウンド 6（2026-09-20・締め）

ラウンド 5 の 8 件をすべて直し、**must 2 件は変異注入で落ちることを確かめた**（上記 test-result）。

- 指摘なし（新規）。利用者の判断で review を締める。
- **件数の推移**: 29 → 10 → 12 → 9 → 8。must の性質は
  「製品の欠陥」→「直前の修正が生んだ退行」×2 →「自分のテストが構造的に落ちない」×2 と移った。
- **残した未確認**（`test-result.md`「未検証の穴」に一覧）:
  `READ SCREEN`(0x62) 固有の扱い / SEU の F1 → F12 / `ESC 13` の実機レコード /
  `0x72`・`0x83` の opcode / 同一レコードの `READ → SAVE` の順 / 並列実行の既知フレーク 3 件。
- **範囲外として起票**: `sendError` が検証文言をブラウザへ返す（優先度 高）／
  tn5250・hostserver のテストを型検査の対象にする（どちらも `code-quality-checks.md`）。

承認は `must=11 should=46 nit=24`（全ラウンドの通算。タスク点検ログは別集計）。
