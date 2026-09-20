# 決定記録

## D1: 三層の判定は full（aidev-00-start 手順 0）

- 背景: `code-quality-checks.md` の「検証エラーの文言がブラウザへ返る経路を塞ぐ（優先度 高）」に
  着手するにあたり、対象外 / light / full のどれかを決める必要があった。
- 決定: **full**。利用者に確認した（2026-09-20）。
- 理由 / 代替案: エラーの文言が変わる（振る舞いの変更）うえ、`@ts5250/tn5250` の共有モジュールと
  `packages/server` / `packages/web-ui` にまたがる。light の 4 条件を満たさない。
- 影響: 上流 3 工程をそれぞれのゲートで回し、research も挟んだ。

## D2: 値を外すのは **core**。web-ui はサーバーの message を出さない

- 背景: 漏れは 3 点の合成で起きていた（research F1。**推測ではなく動かして確かめた**）——
  (1) `validateFieldContent` が `JSON.stringify(value)` で値を埋める
  (2) `ws-handler.ts:322` が message をそのままブラウザへ返す
  (3) `resolveSecret` が復号した平文を欄の値として渡す（**ws 経路だけが呼ぶ**）
- 決定: **core（`field-validate.ts`）で値を埋めるのをやめる。** あわせて web-ui の
  `wsErrorNotice` も**サーバーの message を出さない**（位置だけを拾う）。
- 理由 / 代替案:
  - **退けた案「ws だけで絞る」**（`ws-handler.ts:322` で定型文へ詰め替える）。MCP の診断能力は
    保てるが、**core の例外に値が残る**ので、ログや将来の利用側で再発する。
    同じ性質を直前の work（`20260920-restore-screen-parity`）で 2 回壊しており、
    「1 か所で止める」形に倒したかった。
  - web-ui 側も塞ぐのは**二重防御**。core が値を入れなくなっても、拾う対象を位置だけに限れば
    将来また値が混ざっても画面には出ない。
- 影響:
  - **既存の決定を覆した**（`AGENTS.md` 判断の原則 3）——`opMessages.ts:178` の
    「頭に日本語の要約を置き、**元のメッセージも残す**——どの欄のどの値かは元の文にしかない」と、
    それを固定していた `packages/web-ui/test/field-keystroke-rules.test.ts:148-152`
    （「打鍵値が画面に出ること」を検査していた）。**消さずに書き替え、理由を残した。**
  - **MCP に返る文言も変わる**（`mcp-tools.ts` の `errorResult` は message を無加工で返す）。
    **漏れではない**——MCP に返るのは呼び出し元が自分で渡した値（research F6）——が、
    診断能力は下がる。呼び出し元は自分が送った値を知っているので実害は無いと判断した。
  - `NOTICE_BY_ERROR` に見出しの無い code（`PROTOCOL_ERROR` ほか 5 つ）を足した。
    足さないと**素の英語が消えたぶん手掛かりが何も残らない**。

## D3: クライアント由来の文字列の反射も同時にやめる

- 背景: research F2 で、**クライアントが送った文字列がそのまま message に反射する**箇所が
  4 つ見つかった（`unsupported AID key: ${key}` ほか）。秘密ではないが、入力の反射という別種の面。
- 決定: **4 か所とも値を落とす**（利用者の判断、2026-09-20）。
- 理由 / 代替案: どれも `code` が既に種別を伝えており（`PROTOCOL_ERROR` / `READ_ONLY_SESSION`）、
  **どのキーを押したかは押した側が知っている**。切り分けが要るならログ側へ出す
  （`errShape` と同じ態度）。
- 影響: `packages/tn5250/src/session/session.ts`（2 か所）・
  `packages/server/src/session-manager.ts`・`packages/server/src/ws-handler.ts`。

## D4: 例外の一覧——直したものと「値を含まないので安全」なもの（AC6）

`type:"key"` 経路が投げうる例外を、**何を埋めているかを読んで**判断した（推測していない）。
対象は下の 2 表に挙げた 17 か所＋「未確認として残す」の 2 件
——**この数がすべて下に並んでいる**（本文に書いた件数と表の行数が合わないと、
読み手はどちらが正なのか確かめようがない。条項 `comment-provenance`）。

**直した（値・クライアント文字列が入っていた）**

| 場所 | 変更前 | 変更後 |
|---|---|---|
| `field-validate.ts:58` | `numeric field accepts digits only: "<値>"` | `field at (20,7) accepts digits only` |
| `field-validate.ts:69` | `alphabetic-only field rejects: "<値>"` | `field at (20,7) accepts alphabetic characters only` |
| `field-validate.ts:78` | `DBCS-only (…) field rejects SBCS char: "<文字>"` | `field at (20,7) accepts double-byte characters only` |
| `field-validate.ts:89` | `value contains characters not representable in CCSID …` | `field at (20,7) cannot hold characters outside CCSID …`（値は元から無い。形を揃えた） |
| `session.ts` `buildAidRecord` | `sysReqText is only valid with SysReq (got ${key})` | `sysReqText is only valid with SysReq` |
| `session.ts` `buildAidRecord` | `unsupported AID key: ${key}` | `unsupported AID key` |
| `session-manager.ts` `assertKeyAllowed` | `key ${key} not allowed on read-only session` | `key not allowed on read-only session` |
| `ws-handler.ts` `resolveField` | `invalid secretRef: ${ZodError.message}` | `invalid secretRef` |

**直していない（値を含まない。根拠は「何を埋めているか」を読んだ結果）**

| 場所 | code | 埋めているもの | なぜ安全か |
|---|---|---|---|
| `buffer.ts` `setFieldValue` | FIELD_PROTECTED | 行・桁 | 位置だけ。**位置の出し方はここに合わせた** |
| ~~`buffer.ts` `setFieldValue`~~ | FIELD_OVERFLOW | ~~文字数~~・欄長 | ~~長さだけ。値の中身は出ない~~ **→ D5 で「直した」側へ移した**（打鍵値の長さを外した） |
| ~~`session.ts` `setField`~~ | FIELD_OVERFLOW | ~~バイト数~~・欄長 | ~~同上~~ **→ 同じく D5** |
| `buffer.ts` `fieldByIndex` / `fieldAt` | FIELD_NOT_FOUND | 欄番号・座標 | クライアント指定だが**値ではなく指定子**。位置は元から出す設計 |
| `buffer.ts` `addrOf` | PROTOCOL_ERROR | 行・桁 | 同上 |
| `session.ts` `assertReady` | KEYBOARD_LOCKED | セッションの状態名 | サーバー内部の語 |
| ~~`macro-store.ts` 各所~~ | SESSION_NOT_FOUND / CONFIG_ERROR | ~~マクロ id~~・step・field 番号 | ~~**参照子だけ**~~ **→ D10 で「直した」側へ移した**（`macroId` は `z.string().min(1)` で型が閉じておらず、任意文字列が反射していた） |
| `session-manager.ts` `assertNotReserved` | SESSION_RESERVED | 予約者のラベル | 利用者名だが打鍵値ではない。既存の設計判断 |
| `auth.ts` `assertOwner` | FORBIDDEN | 固定文 | 埋め込み無し |

**未確認として残す**

- VT core（`packages/vt`）が投げる例外に打鍵内容が入るか（`onVtInput` / `onVtResize` 経由）。
- 非 `As400Error`（ソケットの errno 等）が実際にブラウザへ届くこと。
  **コード上は `ws-handler.ts:322` の `String(err)` 分岐で通る**が、再現はしていない。
  ホスト名・ポートが出うるので、別項目として台帳に残す。

## D5: 桁あふれも「値の長さ」を出さない——D4 の二重基準を寄せた

- 背景: cross 点検（coding 手順 5.5）が **D4 の中の食い違い**を指摘した。D4 は
  `FIELD_OVERFLOW`（`buffer.ts` の `value length ${chars.length} exceeds field length …` /
  `session.ts` の `DBCS value ${bytes} bytes …`）を「長さだけなので安全」として直さない側に置いた。
  一方で同じ work の `field-validate.test.ts` は「**長さも出さない**」を不変条件として検査しており、
  requirements FR1 も「打鍵した値・その一部・**その長さ**を含めない」と書いてある。
  **同じ work の中で長さの扱いが二重基準**になっていた。
- 決定: **FR1 に寄せる**。両方から打鍵値の長さを外し、`field at (行,桁) accepts at most N characters`
  （DBCS は `… N bytes`）にした。
- 理由 / 代替案: この経路は**実際に秘密が流れる**——18 文字の秘密を 10 桁の欄へ再生すると
  `value length 18 exceeds field length 10` がブラウザへ返っていた（`ws-macro-secret.test.ts` の
  「桁あふれで弾かれたときも、平文の長さを返さない」で固定。変異注入で確認済み）。
  長さは値そのものではないが、**秘密について外へ出る情報を増やす理由が無い**。
  **欄の桁数（`field.length`）は残す**——ホストが宣言した値で、利用者が直すのに要る。
  代替案「D4 のまま長さを許し、`field-validate.test.ts` の検査を緩める」は、
  FR1 を後から実装に合わせて書き換えることになるので採らない。
- 影響: D4 の表の `FIELD_OVERFLOW` 2 行は「直していない」側から「直した」側へ移る。
  位置が入るようになったので、web-ui は `FIELD_OVERFLOW` でも欄の位置を出せる。

## D6: サーバーが作っていた日本語の文言は出なくなる——見出しへ寄せ、残りは台帳へ

- 背景: D2 で web-ui が message を出さなくしたが、cross 点検が
  **値を含まず操作員向けに日本語で書かれていたサーバー文言まで消える**ことを指摘した。
  3270 セッションも同じ経路（`session-controller.ts` → `wsErrorNotice`）なので、
  `tn3270-adapt.ts` の「（キー）はこのホスト（メインフレーム）の 3270 には割り当てがありません」や
  `ws-handler.ts` の「選択できません（fieldId=…）」が見出しだけになる。
  D2 の影響欄は「素の英語が消える」しか見ていなかった。
- 決定: **message を出さない方針は変えない**。代わりに、
  1. `tn3270-adapt.ts` の 2 か所から**キー名の反射をやめ**（AC9。5250 側と対。条項 `paired-artifact-sync`）、
     文言を英語の診断語に揃えた（`key has no 3270 assignment on this host` / `unsupported AID key`）。
  2. web-ui の `PROTOCOL_ERROR` の見出しを「この操作は受け付けられませんでした」にした。
     元の「送信の内容に誤りがあるため送信しませんでした」は、`packages/base/src/errors.ts` の
     `PROTOCOL_ERROR` の定義（**ホスト側の逸脱**・「利用者が直せる問題に使ってはならない」）と
     逆向きの案内だった。
  3. **「どのキーが送れないか」を code で伝え分ける**のは別作業として台帳に残した。
- 理由 / 代替案: 「サーバーが operator-safe の印を付けた message だけ出す」案は、
  **印の付け忘れが漏れになる**（fail-open）ので採らない。
  `AGENTS.md`「利用者に見えるメッセージは日本語で…定数は `opMessages.ts` に 1 か所」に従えば、
  そもそもこれらの日本語はサーバー側に在るべきでない——**code で引けるようにするのが本筋**だが、
  そのためには語彙（`ErrorCode`）を増やす判断が要るので、この work では踏み込まない。
- 影響: 3270 で割り当ての無いキーを押したときの案内が具体性を失う（見出しのみ）。
  `.aidev/backlog/code-quality-checks.md` に起票した。

## D7: `services` / `watches` ペインは message をそのまま出したままにする

- 背景: cross 点検が、`WsConnection` の catch を共有する**他の 2 消費者**
  （`packages/web-ui/src/stores/services.ts` / `stores/watches.ts`）が
  ws の `error` message を生のまま表示状態へ入れていると指摘した。
  D2 の「web-ui 側も塞ぐのは二重防御」は `wsErrorNotice` にしか掛かっていない。
- 決定: **この work では変えない**。
- 理由: **読んで確かめた**（推測ではない。`AGENTS.md` 判断の原則 2）——
  打鍵値と復号した秘密が流れるのは `type:"key"` の経路だけで（`resolveSecret` は
  `macro-store.ts` の注記どおり ws の key 経路だけが呼ぶ）、サービス操作・監視操作は
  欄の値を運ばない。したがってこの 2 か所は**漏れの経路ではない**。
  加えて、これらの message は**その操作が断られた理由の唯一の手掛かり**（権限・設定不備）で、
  見出しへ落とすと運用者が原因を切り分けられなくなる。
- 影響: D2 の「二重防御」の主張は **key 経路に限る**と読むこと。この節がその限定。
- **追記（review ラウンド 4）**: 「生 message を出す消費者」の一覧が**不完全だった**。
  `services.ts` / `watches.ts` の 2 つに加えて、`session-controller.ts` の 3 か所
  （`reject(new Error(\`${msg.code}: ${msg.message}\`))`。開く前の失敗を `openError` へ流す）も同じ。
  **結論は変わらない**（どれも欄の値・秘密を運ばない）が、「message を出す場所はどこか」を
  次に数える人が 2 か所だと思うと間違える。数えるなら **5 か所**。

## D8: `fields[].field` を ws の境界で検証する——AC9 は本線でまだ破れていた

- 背景: review が **AC9 の主経路が塞がっていない**ことを実測で示した。
  `WsConnection.handle()` は `JSON.parse(raw) as WsClientMessage` で**型を名乗らせているだけ**なので、
  `{"type":"key","fields":[{"field":"LEAK_MARKER_XYZ","value":"x"}]}` を送ると
  `Session.resolveField` の `"index" in target` が
  `TypeError: Cannot use 'in' operator to search for 'index' in LEAK_MARKER_XYZ` を投げ、
  catch が**それをそのままクライアントへ返していた**（再現済み。`ws-macro-secret.test.ts` の
  「欄の指定が壊れていても…」が赤になることで確認した）。
- 決定: `ws-handler.ts` に `wsFieldRefSchema`（zod）を置き、**`resolveField` の入口で
  `f.field` と `f.value` の形を検証する**。弾くときは中身を文言に出さない（D3 と同じ）。
- 理由 / 代替案: 同じ関数が `secretRef` は検証しながら（「秘密を守る経路なので形を検証する」と
  注記まで付けて）**隣の `field` は素通し**していた。`handle()` 全体を zod で検証する案は
  ws メッセージ型が大きく影響範囲も広いので採らず、**値がホストへ向かう 1 本の漏斗**である
  `resolveField` に寄せた。スキーマは `ws-messages.ts` に置かない——**あのファイルは
  web-ui が `import type` する型専用**で、zod を入れるとバンドルに実行時コードが載る（`AGENTS.md`）。
- 影響: `{ index: N }` 形は `WsFieldRef` に無いので拒否される（型どおり。ブラウザが送るのは
  `s.edits` の `Map<number, string>` 由来の**数値**なので影響しない）。
  D4 の「未確認として残す」は**ソケット errno だけ**を挙げており、この経路は棚卸しから漏れていた。
- **追記（review ラウンド 2）**: 最初 `ws-handler.ts` の中だけに置いたが、
  **3270 の欄書き込みは `resolveField` を通らない**（`applyFields` が別経路）ので塞げていなかった。
  検証を `ws-field-ref.ts` へ切り出し、5250 と 3270 の**両方の入口から呼ぶ**形に直した。
  「1 本の漏斗」という見立てが 5250 にしか当てはまっていなかった——条項 `paired-artifact-sync`。
- **追記（review ラウンド 3）**: その修正も**半分しか閉じていなかった**。`applyFields` は
  `if (!("value" in f))` を `parseFieldRef` **より前**に置いており、配列の要素そのものが
  プリミティブだと `in` の素の TypeError にクライアントの文字列が載る
  （`fields: ["LEAK_MARKER_XYZ"]` で再現）。**同じ関数を呼ぶだけでは足りず、呼ぶ位置まで揃える**
  必要がある——「要素が物であること」から確かめる `parseKeyFieldShape()` にまとめ、
  両方の入口で**最初に**呼ぶ形にした。回帰テストが `{ field, value }` というオブジェクトの中しか
  振っていなかったことが、2 ラウンド見逃した直接の原因（テストの**入力の形**が狭かった）。
- **追記 2**: 同じ穴が `gui-select` / `gui-submit` の `fieldId` にもあった
  （`選択できません（fieldId=…）` / `no GUI selection field id=…`）。`parseFieldId()` で検証し、
  文言から id を外した。**D4 の棚卸しが `type:"key"` 経路に限られていた**のが見落としの構造的な原因で、
  AC9 は経路を限定していない。

## D9: 弾かれた「理由」を操作員に戻す——見出しへ畳むと FR2 を満たさない

- 背景: review が「利用者に届くのは位置だけで**理由が消えた**」と指摘した。
  `FIELD_TYPE` は 4 つの理由（数字だけ / 英字だけ / 全角だけ / コードページ外）を 1 つの code で運ぶので、
  code から見出しを引くだけだと「入力できない文字があるため送信しませんでした」に畳まれる。
  requirements FR2 は「位置**と**なぜ弾かれたか」、US1 は「何を**どう**直せばよいかが分かってほしい」。
- 決定: `opMessages.ts` に **`REASON_PHRASES`（閉じた語彙）** を置き、
  **こちらが知っている定型句に一致したときだけ**対応する日本語（既存の `MSG_BY_REASON`）を出す。
- 理由 / 代替案: 「message を出さない」（D2）は**サーバーの文を素通しさせない**ための決定であって、
  「理由を伝えない」ことが目的ではない。閉じた語彙への一致なら、message が何であれ
  **画面に出るのはこちらが書いた定数**なので D2 は保たれる（`field-keystroke-rules.test.ts` の
  「知らない文は理由として通さない」が固定している）。
  「code を増やして伝え分ける」案は `ErrorCode` の語彙に手を入れるので、D6 と同じく踏み込まない。
- 影響: 操作員が見る文言が「数字項目には数字しか入力できません（20 行 7 桁の欄）」に戻る。

## D10: `macro-store` の id 反射もやめた——D4 の「参照子だけなので安全」を覆す

- 背景: review が、D4 で「参照子だけなので安全」とした箇所が**スキーマで型が閉じていない**と指摘した。
  `macroSecretRefSchema.macroId` は `z.string().min(1)` なので、ws の `secretRef` から
  **任意の文字列**が届き、`macro <その文字列> not found` として反射する。
- 決定: `macro not found` / `macro step N not found` にした（`step` は zod で数値に閉じているので残す）。
- 理由: D3 が `unsupported AID key: ${key}` を落とした理由（「サーバーを鏡にしない」）と同じ性質で、
  **同じ work の中で判断の基準が揃っていなかった**。D4 の当該行はこの決定で上書きする。

## D11: AC9 を「欄を書く経路」に限定する——pass と書けないものを pass と書かない

- 背景: review ラウンド 4 が ws へ生 JSON を流し、**AC9 が欄の経路の外でまだ破れている**ことを
  10 通り実測した（`printer session <文字列> not found` / `watch <文字列> not found` /
  `invalid session reference "<文字列>"` / `connect timeout after 15000ms (<ホスト名>:<ポート>)`）。
  **`test-result.md` は AC9 を「pass」と書いていた**——事実と違った。
- 決定（利用者の判断、2026-09-20）: **この work は欄を書く経路まで**とし、
  `requirements.md` の AC9 に経路の限定を書き、残りは「対象外」＋台帳へ送る。
- 理由 / 代替案:
  - 残っている反射は**送った本人に自分の識別子が返るだけ**で、復号された秘密でも他人の値でもない。
  - **実害のあった面（表示の乗っ取り）は既に閉じた**——反射が残っていると
    クライアントが `wsErrorNotice` の拾う対象を注入でき、操作員の画面に**嘘の日本語**を出せた。
    `CODES_WITH_FIELD_DETAIL` で「欄の検証が出す code のときだけ message の中身を見る」に絞った。
  - 「全部塞ぐ」案は `ws-handler` / `session-manager` / `watch-registry` / `config-resolver` /
    `tn5250` の transport まで広がり、本題から遠い。接続失敗のホスト名を消すと
    **どのホストに繋がらなかったかが運用者に分からなくなる**副作用もある。
  - 「AC9 を pass のままにする」案は採らない——`AGENTS.md` 判断の原則 3。
    **主張を証拠の範囲に戻す**のであって、証拠のほうを主張に合わせない。
- 影響: `test-result.md` の AC9 は「欄の経路は pass / それ以外は対象外」に書き替えた。
  **起票時の AC9 は経路を書いておらず「ws で返る全部」と読めた**ので、その事実は
  requirements に取り消し線ではなく「限定した経緯」として残す（次に読む人が、
  なぜ範囲が狭いのかを辿れるように）。
