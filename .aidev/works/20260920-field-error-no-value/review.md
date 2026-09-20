# レビュー: 欄の検証エラーが値をブラウザへ返さないようにする

## タスク点検ログ

coding 工程内の独立点検（`protocol-check.md`「(b)」）。**ラウンド指摘とは母集団が違う**ので
`must` / `should` / `nit` の件数には数えない。

### cross（タスクをまたぐ不変条件・1 ラウンド目・delegated・指摘 16 件）

点検者に**変異注入での確認**を明示的に課した（条項 `verify-by-mutation`）。
その結果「テストが在るのに落ちない」を 3 件見つけており、**この点検の主産物はそこ**。

- [must] `packages/server/test/ws-macro-secret.test.ts` ws の漏れ検査が**直した経路を通っていない**
  ——index 1 は len 10 の欄で、18 文字の秘密は `field-validate.ts` へ届く前に
  `buffer.ts` の FIELD_OVERFLOW で落ちる。変異注入で確認済み（値を戻しても 10/10 緑のまま）
  / 対応: 数字専用欄を 1 つ置いた画面（`digitsOnlyTrace()`）を足し、**FIELD_TYPE で弾かれること**を
  検査に加えた。変異注入で 2 件落ちることを確認 [conv:verify-by-mutation!]
- [must] `packages/tn5250/src/session/session.ts` `at` の配線（`this.buf.rowColOf(field.startAddr)`）を
  **何も固定していない**——第 5 引数を削っても 3 パッケージすべて緑。値を消した代わりの
  唯一の手掛かりが位置なので致命的 / 対応: `packages/tn5250/test/field-error-position-wiring.test.ts`
  を新設（`Session5250.setField` 経由で実位置が入ることを見る。欄を動かすと文言も動くことまで）。
  変異注入で 3 件落ちる [conv:verify-by-mutation!]
- [should] 反射をやめた 4 か所のうち**固定されていたのは 1 か所だけ**（`invalid secretRef` のみ）
  / 対応: `packages/tn5250/test/aid-key-no-reflection.test.ts` 新設（`unsupported AID key` /
  `sysReqText is only valid with SysReq`）＋ `session-manager.test.ts` に読み取り専用の 1 件。
  変異注入で 4 サイトすべて落ちることを確認 [conv:verify-by-mutation!]
- [should] `packages/server/src/tn3270-adapt.ts` 5250 で消した `unsupported AID key: ${key}` の
  **3270 側の双子が残っている**（`:134` も同型）。decisions D4 の洗い出しに漏れ
  / 対応: 2 か所とも反射をやめ、`ws-tn3270.test.ts` に反射しないことの検査を追加 [conv:paired-artifact-sync!]
- [should] `packages/web-ui/src/composables/opMessages.ts` message を一律に捨てるため、
  **値を含まず日本語で書かれていたサーバー文言まで消える**（3270 のキー不可案内など）。
  D2 の影響欄は「素の英語が消える」しか見ていない / 対応: 方針は変えず、`PROTOCOL_ERROR` の
  見出しを `errors.ts` の語彙と矛盾しない言い方へ直し、**残りは台帳へ**（decisions D6）[conv:-]
- [should] `packages/web-ui/src/stores/services.ts` / `stores/watches.ts` が ws の message を
  生のまま表示状態へ入れており、D2 の「二重防御」が掛かっていない / 対応: **読んで確かめたうえで
  変えない**——打鍵値・秘密が流れるのは `type:"key"` 経路だけで、この 2 つは欄の値を運ばない。
  D2 の主張を key 経路に限定して decisions D7 に明記 [conv:paired-artifact-sync!]
- [should] `packages/server/src/ws-handler.ts:34` `:48` `:1141` の出所が古い
  ——`field-validate.ts` はもう `JSON.stringify(value)` を使わない。同じ JSDoc 内の 1 つだけ更新して
  3 か所を残した / 対応: 3 か所とも「撤去済み」と明記し、**撤去後も message を外し続ける理由**を added
  [conv:comment-provenance!]
- [should] `packages/web-ui/src/composables/opMessages.ts:190` も古い根拠（「生の英語＋UUID が残る」は
  もう起きない）/ 対応: 起票当時の記述として残し、**いまの理由**（既定文では「開き直せばよい」と
  分からない）へ書き替え [conv:comment-provenance!]
- [should] `field at (行,桁)` は**生産者 4 つと正規表現 1 つの契約**なのに両側を結ぶテストが無い。
  core 側で書式を変えても core のテストを直せば緑になり、通知は黙って見出しだけに退化する
  / 対応: `packages/web-ui/test/field-at-contract.test.ts` を新設（走査＋実文言の往復）。
  **最初の版はコメントに当たって変異注入で素通りした**ので、コメントを落としてから見る形に直した
  [conv:paired-artifact-sync!]
- [should] `buffer.ts` / `session.ts` の `FIELD_OVERFLOW` が**秘密の長さをブラウザへ返す**（D4 は
  「長さだけ」として許容）のに、`field-validate.test.ts` は「長さも出さない」を不変条件にしている
  ——同じ work の中で二重基準 / 対応: requirements FR1 に寄せて両方から打鍵値の長さを外した
  （decisions D5）。ws 経由の回帰テストを追加し変異注入で確認 [conv:-]
- [should] `packages/web-ui/test/field-keystroke-rules.test.ts` が文言リテラルを直書き
  （`MSG_UNKNOWN_ERROR` が未 export で参照できない）/ 対応: 定数を export して参照に変更 [conv:-]
- [nit] `PROTOCOL_ERROR` の見出しが `packages/base/src/errors.ts` の定義と逆向きの案内
  / 対応: 「この操作は受け付けられませんでした」へ（上の should と同じ修正）[conv:comment-provenance]
- [nit] `field-validate.ts` の `import type { DbcsFieldType }` が import 群から分断されている
  / 対応: 先頭の import ブロックへ戻した [conv:-]
- [nit] `toThrow(/alphabetic-only/)` → `code` だけへ弱めたため「どの規則が発火したか」の判別力が落ちた
  / 対応: 新しい文言は値を含まず安定しているので、`message: stringContaining(理由)` を足して
  判別力を戻した（10 か所）[conv:-]
- [nit] `NOTICE_BY_ERROR[code]` の素引きは `constructor` 等で継承プロパティが返り `??` が効かない
  / 対応: `Object.hasOwn` で引くようにし、4 つの危険な code で検査を追加 [conv:-]
- [nit] `at?` は任意だが本番の呼び出し元は 1 か所で必ず渡している。必須にすればテストの中にしか
  存在しない分岐が消える / 対応: **変えない**——design「インターフェース 1」が
  「既存の呼び出しを壊さない」ために任意と決めているため。
  ~~位置なしの文言は `validateFieldContent` を直接使う利用側（ライブラリとしての公開面）に残す~~
  → **これは事実誤り**（review ラウンド 3 が指摘）。`validateFieldContent` は
  `packages/tn5250/src/index.ts` / `browser.ts` のどちらからも export されておらず**公開面に無い**。
  任意のままにする理由は design の決定であって、公開面の互換ではない [conv:comment-provenance!]

## ラウンド 1（独立レビュー・delegated）

指摘 16 件（must 0 / should 7 / nit 9）。**AC9 が本線で破れていた**のが最大の収穫。

- [should][conv:-] `packages/server/src/ws-handler.ts:257` `handle()` が `JSON.parse(raw) as WsClientMessage`
  で実行時検証をしないため、`fields[].field` に任意文字列を入れると `"index" in target` の
  **素の TypeError がそのままブラウザへ返る**（AC9 違反。再現済み）
  / 対応: `wsFieldRefSchema` を足し `resolveField` の入口で検証（decisions D8）。
  変異注入＝検証を外すと新テストが赤 [conv:-]
- [should][conv:paired-artifact-sync!] `packages/web-ui/test/field-at-contract.test.ts:43`
  `stripComments` が既存の共有ヘルパ（`test/source-scan.ts` の `code()`。
  **「複製しないこと」と明記**）を複製し、かつ弱い——行末コメントを落とせず偽緑になる
  / 対応: `code()` へ差し替え。`const x = 1; // \`field at (${row},${col})\`` を仕込む変異注入で、
  自前版は緑・`code()` 版は赤になることを確認 [conv:paired-artifact-sync!]
- [should][conv:-] 同 `:27` `PRODUCERS` が 4 件だが、**この work が 5 つ目**を足していた
  （`session.ts` の DBCS 桁あふれ。D5）/ 対応: 5 件目を追加、JSDoc の「4 つ」も直した [conv:-]
- [should][conv:-] `packages/web-ui/src/composables/opMessages.ts:236` **理由が消えた**——
  `FIELD_TYPE` の 4 つの理由が見出し 1 本に畳まれ、FR2「位置**と**なぜ弾かれたか」・US1 を満たさない
  / 対応: 閉じた語彙 `REASON_PHRASES` で理由だけを日本語にする（decisions D9）[conv:-]
- [should][conv:comment-provenance!] `opMessages.ts:97` / `session-controller.ts:496`
  「サーバーの理由をそのまま出す」が**この work で偽になった**のに残っている
  （`:179` `:190` は直したのに対の片方だけ）/ 対応: 2 か所とも取り消し線で更新 [conv:comment-provenance!]
- [should][conv:-] `.aidev/backlog/code-quality-checks.md:44` 起票元の項目が `- [ ]` のまま
  / 対応: **deliver（T10）で消化**する。`aidev verify` が閉じ忘れを FAIL で止める [conv:-]
- [nit][conv:comment-provenance] `decisions.md:51` 「22 種」の出所がリポジトリ内で突き合わせられない
  （research も 7 件、表は 17 行）/ 対応: 件数の主張をやめ、表に並んでいるものがすべてと明記 [conv:comment-provenance!]
- [nit][conv:-] `macro-store.ts:85` D4 が「参照子だけなので安全」とした箇所が
  **スキーマで閉じていない**（`macroId` は `z.string().min(1)`）/ 対応: 反射をやめた（decisions D10）[conv:-]
- [nit][conv:-] テスト名「先頭 1 文字…」が過大——ループが英数字を飛ばすので先頭 `d` は見ていない
  / 対応: 名前を実際の検査に合わせた（2 か所）[conv:-]
- [nit][conv:-] ws の合成画面を signon と同じ (5,25) に置いたため、位置を定数で埋めても ws 側は緑
  / 対応: 合成画面を (7,30) へずらした [conv:-]
- [nit][conv:-] `${m[1]} 行 ${m[2]} 桁の欄` が定数になっておらずテストがリテラルで突き合わせている
  / 対応: `fieldAtLabel()` を export しテストから参照 [conv:-]
- [nit][conv:comment-provenance] `aid-key-no-reflection.test.ts:52` 「await では捕まらない」が不正確
  （捕まらないのは `.rejects` の形）/ 対応: 現物に合わせて書き直した [conv:comment-provenance!]
- [nit][conv:-] `session.ts` が `rowColOf` を 1 関数内で 2 回呼ぶ / 対応: 1 回に束ねた [conv:-]
- [nit][conv:paired-artifact-sync] 「数字専用欄 1 つの画面」を 3 通りで作っている
  / 対応: **変えない**——server からは定数を引けず（exports は `.` と `./browser` だけ）、
  hex 共有は tn5250 の test を server から読む形になって依存の向きが増える。
  契約は `field-at-contract.test.ts` が別途見ている [conv:-]
- [nit][conv:-] 未追跡の `ts5250改修内容.pdf` がある / 対応: **コミットに混ぜない**（deliver で確認）[conv:-]

**検証された主張**（レビューが実行して確かめたもの）: `resolveSecret` は ws の key 経路だけが呼ぶ／
D4 の 4 つの反射はすべて外れている／`type:"key"` 経路で値・値の長さはブラウザへ届かない／
`rowColOf` は常に安全に呼べる（`resize()` が `fields=[]` を伴うため範囲外にならない）／
`digitsOnlyTrace()` のバイト注記は `constants.ts` と一致／`Object.hasOwn` の変更は正しい。

## ラウンド 2（自己レビュー・ラウンド 1 の修正を点検）

ラウンド 1 の修正（D8 の `wsFieldRefSchema`）が**本当に全経路を塞いだか**を確かめ、1 件見つけた。

- [must][conv:paired-artifact-sync!] `packages/server/src/tn3270-adapt.ts:168` `:177`
  **3270 の欄書き込みは `resolveField` を通らない**（`ws-handler.ts:831` → `applyFields` が別経路）。
  D8 の検証は 5250 側にしか掛かっておらず、3270 では `ref.row` が `undefined` になって欄が見つからず
  `no field at ${JSON.stringify(ref)}` として**クライアントの値がそのまま返る**
  / 対応: 検証を `packages/server/src/ws-field-ref.ts` に切り出して**両方の入口から呼ぶ**。
  `applyFields` の反射もやめた。3270 側の回帰テストを `ws-tn3270.test.ts` に追加し、
  変異注入（検証を外す）で落ちることを確認 [conv:paired-artifact-sync!]

**この 1 件が示したこと**: ラウンド 1 で「`resolveField` は値がホストへ向かう 1 本の漏斗」と書いたが、
**それは 5250 の話**で、3270 は最初から別の漏斗だった。`20260920-restore-screen-parity` 以来
この work で `paired-artifact-sync` に触れるのは 3 度目（3270 のキー割り当て・キー名の反射・欄の指定）
——**5250 に何かを足したら 3270 を見る**を、条項の効果判定の材料として retro へ送る。

### 境界の再確認（ラウンド 2 で実行した）

- `npm test` 全パッケージ緑（既存 flake 1 件を除く。`test-result.md`）/ `npm run build` / `vue-tsc -b` /
  `npm run lint` / `aidev smoke` すべて pass。
- `packages/server/test/import-from-owner.test.ts` 緑——新設した `ws-field-ref.ts` が
  パッケージ境界（在り処から取る）を崩していない。
- **`ws-messages.ts` には zod を入れていない**——あのファイルは web-ui が `import type` する型専用で、
  実行時コードを入れるとブラウザのバンドルに載る（`AGENTS.md`「パッケージ分割と入口」）。
  新設モジュールに置いた理由をファイル冒頭に書いた。

## ラウンド 3（独立レビュー・delegated）

指摘 15 件（must 1 / should 5 / nit 9）。**ラウンド 2 の修正が 3270 で半分しか閉じていなかった**のが最大の収穫。

- [must][conv:paired-artifact-sync!] `packages/server/src/tn3270-adapt.ts:165`
  **D8 の修正が 3270 で閉じていない**——`if (!("value" in f))` が `parseFieldRef` **より前**に走るので、
  配列の要素そのものがプリミティブだと `in` が素の TypeError を投げ、
  **クライアントの文字列がそのままブラウザへ返る**（`fields: ["LEAK_MARKER_XYZ"]` で再現）。
  回帰テストは `{ field, value }` の**オブジェクトの中しか振っておらず**当たらなかった
  / 対応: `parseKeyFieldShape()` を新設し「**要素が物であること**」から確かめる形にして、
  5250・3270 の**両方で最初に呼ぶ**（呼ぶ関数だけでなく**呼ぶ位置**を揃えた）。
  テストに「要素そのものがプリミティブ」の形を足し、変異注入で確認 [conv:paired-artifact-sync!]
- [should][conv:-] `packages/server/src/ws-handler.ts:1221` `選択できません（fieldId=${msg.fieldId}）` が
  **クライアント文字列を反射**（AC9 違反）。D6 はこの行を名指しで読んでいたのに反射の面を見ていなかった
  / 対応: `parseFieldId()` で検証し、文言から id を外して `FIELD_NOT_FOUND` に [conv:-]
- [should][conv:paired-artifact-sync!] `packages/tn5250/src/session/session.ts:325`
  上の双子 `no GUI selection field id=${fieldId}` も同じ / 対応: 同様に反射をやめた [conv:paired-artifact-sync!]
- [should][conv:verify-by-mutation!] `packages/web-ui/test/field-at-contract.test.ts` の走査が
  **ファイル単位**（「どこかに 1 つあれば緑」）なので、`buffer.ts` の 2 か所のうち
  `FIELD_OVERFLOW` 側だけ書き換えても `FIELD_PROTECTED` が当たって素通りする
  / 対応: **個数で見る**形に変え（`count`）、変異注入で確認 [conv:verify-by-mutation!]
- [should][conv:-] `opMessages.ts` の `reasonOf` は**反射が残っている限りクライアントが表示文を選べる**
  （`fieldId` に定型句を入れると別の理由が出る）/ 対応: **根治は反射をやめる側**なので上の 2 件で閉じた。
  閉じた語彙なので任意文字列の注入にはならず D2 は破れない [conv:-]
- [should][conv:paired-artifact-sync] `NOTICE_BY_ERROR` が `Record<string, string>` で
  `ErrorCode`（27 種）と結ばれておらず、同期を保つものが無い
  / 対応: `Partial<Record<ErrorCode | "INTERNAL_ERROR", string>>` に型付け。
  **これで `INTERNAL_ERROR` が `ErrorCode` に無いことが分かった**——`ws-handler.ts:310` が
  `err instanceof As400Error ? err.code : "INTERNAL_ERROR"` でその場で作る文字列で、
  語彙に登録されていない（型付けして初めて見えた）[conv:paired-artifact-sync!]
- [nit][conv:-] `z.ZodType<WsFieldRef>` は Output が共変なので型の広がりを検知しない
  / 対応: **変えない**——実行時には必ず弾かれ、`WsFieldRef` を広げる変更は
  `applyFields` / `resolveField` の分岐に必ず触れるので気づける [conv:-]
- [nit][conv:-] `field-keystroke-rules.test.ts` に見出しのリテラル直書きが 2 か所残っていた
  / 対応: `noticeFor()` を export して参照に [conv:-]
- [nit][conv:-] 4 つ目の理由だけ名前付き定数になっていない
  / 対応: `MSG_OUTSIDE_CCSID` として export [conv:-]
- [nit][conv:comment-provenance] `decisions.md` D4 の表に、D5・D10 で「直した」側へ移った 3 行が
  **古い事実主張のまま**残っていた / 対応: 取り消し線で事実主張だけを消し、移り先を書いた [conv:comment-provenance!]
- [nit][conv:comment-provenance] cross 点検の最終項の根拠が事実と違う
  （`validateFieldContent` は `index.ts` / `browser.ts` のどちらからも export されておらず**公開面に無い**）
  / 対応: 取り消し線で訂正。判断自体（`at?` を任意のままにする）は design の決定なので変えない [conv:comment-provenance!]
- [nit][conv:-] `msg.cursor` が無検証（3270 は `cursorPos = NaN` になりうる。5250 は自前で守っている）
  / 対応: **この work では直さない**——反射は数値に化ける値だけで**文字列漏れにはならず**、
  AC9 の範囲外。台帳へ起票した [conv:-]
- [nit][conv:-] 空振り検知の `throw` が `try` の中にあり自分の `catch` に捕まる（2 か所）
  / 対応: 3270 側は `msg` を `undefined` 初期値にして `toBeDefined()` で見る形に直した [conv:-]

### 何も見つからなかった軸（レビューが実行して確かめた）

zod の境界値（`0` / `-0` / `1.5` / `Infinity` / `NaN` / `1e21` / `"5"` / `{row:1}` / `{}` / `[]` /
`{row:1,col:1,x:2}` はすべて拒否。通るのは `1…MAX_SAFE_INTEGER` と範囲内の `{row,col}` だけで下流も壊れない）／
`{index:N}` 拒否で壊れる実クライアントは無い（web-ui は素の数値、MCP・HLLAPI は ws を通らない）／
`type:"key"` 経路で打鍵値・その一部・その長さがブラウザ／ログへ出る箇所は 5250・3270 とも無い／
`REASON_PHRASES` の 4 句はすべて `field-validate.ts` が逐語で作り、死んだ項目も取り違えも無い／
日本語の文体は です・ます調・句点なしで揃っている／**zod はブラウザへ漏れていない**
（`ws-messages.ts` に zod の import は無く、web-ui は `ws-field-ref` を参照していない）。

## ラウンド 4（独立レビュー・delegated）

指摘 13 件（must 1 / should 6 / nit 6）。**AC9 を「pass」と書いていたのが事実と違った**のが最大の収穫。
レビューは `packages/server/dist` を読み出して **ws へ生 JSON を流し、10 通りの反射を実測**している。

- [must][conv:-] **AC9 は `type:"key"` の外でまだ破れている**。`sessionId` / `watchId` / `session` /
  `system` / `host` が `error` の message に入る（`printer session <文字列> not found` /
  `watch <文字列> not found` / `invalid session reference "<文字列>"` /
  `connect timeout after 15000ms (<ホスト名>:23)`）。
  **`test-result.md` の「AC9 pass」は事実と違う** / 対応: **記述を事実に戻した**（`AGENTS.md` 判断の原則 3）。
  塞ぐ範囲は利用者の判断を仰ぐ（下記「未決」）。
  **ただし実害のある面は閉じた**——残った反射で**クライアントが web-ui の表示文を選べた**
  （`{"type":"printer-stop","sessionId":"field at (9,9) accepts digits only"}` で
  「数字項目には数字しか入力できません（9 行 9 桁の欄）」が出るのを実測）。
  `wsErrorNotice` が message の中身を見るのを**欄の検証の code のときだけ**に絞った [conv:-]
- [should][conv:paired-artifact-sync!] `msg.fields` の**容れ物**が未検証。要素は守ったが
  `{"type":"key","fields":"LEAK…"}` は 5250 で `fields.map is not a function` を**素の V8 の文言のまま**
  返し、3270 は文字列を 1 文字ずつ回る——**同じ入力に双子が別の答えを返していた**
  / 対応: `parseKeyFields()` を `ws-field-ref.ts` に足し、両方の入口で呼ぶ。変異注入で確認 [conv:paired-artifact-sync!]
- [should][conv:paired-artifact-sync!] ラウンド 3 で見つかった「要素そのものがプリミティブ」の形が
  **3270 のテストにしか入っていない**——5250 側で並びを戻しても緑のまま
  / 対応: 5250 のテストに同じ 8 形を振った（**対で同じ形を振る**）[conv:paired-artifact-sync!]
- [should][conv:verify-by-mutation!] 走査の正規表現が実行時より緩い（`\s*` を許す）。
  `` `field at (${row}, ${col})` `` にすると**走査は 6/6 緑のまま実行時だけ位置を拾えなくなる**
  / 対応: 走査側も空白不可に揃えた。変異注入で確認 [conv:verify-by-mutation!]
- [should][conv:paired-artifact-sync!] `tn3270-adapt.ts` の `IBMI_ONLY[key]` が素引きで、
  `planKey3270("constructor", true)` が関数を `aid` として返す——**cross 点検で
  `NOTICE_BY_ERROR` を直したのと同じ欠陥の双子**（しかも `key` はクライアントが自由に決める側）
  / 対応: `Object.hasOwn` で引く [conv:paired-artifact-sync!]
- [should][conv:-] D6 の棚卸しが**接続失敗系を見ていない**。`printer-start` / `printer-stop` は
  その場で接続を張るので `SESSION_REJECTED`（8925）/ `CONNECT_FAILED` / `NEGOTIATION_TIMEOUT` /
  `TLS_CERT_INVALID` が届き、見出しが無いので「エラーが起きました」の一行になる
  / 対応: 見出しを 4 つ足した [conv:-]
- [should][conv:comment-provenance!] D7 の「生 message を出す消費者」の一覧が 5 分の 2 しかない
  （`session-controller.ts` の 3 か所が漏れ）/ 対応: D7 に追記 [conv:comment-provenance!]
- [nit] `noticeFor` が素引き（`wsErrorNotice` は `hasOwn`）/ 対応: 揃えた [conv:-]
- [nit] `parseFieldId` が `0` / 負数 / `1e21` を通す（`wsFieldRefSchema` は `.int().positive()`）
  / 対応: `Number.isSafeInteger` ＋ `> 0` に揃えた [conv:-]
- [nit] `msg.selected` が未検証で `snapshot()` に載り**同席者全員**へ配られる
  （レビューは**読んで判断しただけで実行していない**と明記）/ 対応: 台帳へ [conv:-]
- [nit] `withAudit` の `key` が無検証・無制限で監査ログに積まれ `GET /api/admin/logs` から読める
  / 対応: 台帳へ（D3 がログに出す判断自体は明示しているので方針違反ではない）[conv:-]
- [nit][conv:comment-provenance] 台帳に足した項目の題が「**非 As400Error** が素通し」だが、
  実測した反射は `As400Error("CONNECT_FAILED", …)` で `INTERNAL_ERROR` 分岐ではない
  / 対応: 題を事実に合わせて直した [conv:comment-provenance!]

### 何も見つからなかった軸（レビューが実行して確かめた）

`resolveField` / `applyFields` はどちらも**最初の文**が `parseKeyFieldShape(f)`（ラウンド 3 の修正は正しい）／
`msg.key` `msg.sysReqText` `msg.cursor` `msg.choiceIndex` から文言への反射は無い／
core の 6 か所は値・値の一部・値の長さを含まない／`field at (${` はちょうど 6 か所で一覧に漏れは無く、
個数判定は生産者ごとに個別に落ちる／zod はブラウザへ漏れていない。

## ラウンド 5（ラウンド 4 の指摘の消化を確認）

ラウンド 4 の must は**範囲の判断**だったので、利用者に諮って決めた（decisions D11）。

- **AC9 を欄を書く経路に限定**（`requirements.md` の AC9 と「対象外」に経緯つきで記載）。
  残り（`sessionId` / `watchId` / `session` / `system` / `host`）は台帳へ。
- **実害のあった面は閉じた**——表示の乗っ取り（`CODES_WITH_FIELD_DETAIL`）。
- `test-result.md` の AC9 を**事実に戻した**（`AGENTS.md` 判断の原則 3）。

ラウンド 4 の should / nit は 6 件とも対応済み（`fields` の容れ物・5250 のテストの形・
走査の厳しさ・`IBMI_ONLY` の素引き・接続系の見出し・D7 の一覧）。
nit のうち 2 件（`msg.selected` の未検証・監査ログの `key`）は台帳へ送った。

**指摘なし**（この work の範囲において）。`must` / `should` は残っていない。

### 通算の指摘数

| ラウンド | must | should | nit |
|---|---|---|---|
| cross 点検（coding 内） | 2 | 9 | 5 |
| review ラウンド 1 | 0 | 7 | 9 |
| review ラウンド 2（自己） | 1 | 0 | 0 |
| review ラウンド 3 | 1 | 5 | 9 |
| review ラウンド 4 | 1 | 6 | 6 |
| review ラウンド 5 | 0 | 0 | 0 |

**review の通算: must 3 / should 18 / nit 24**（cross 点検の 16 件は母集団が違うので数えない。
`protocol.md`「8.」）。差し戻し 3 回。

**must 3 件のうち 2 件は「前のラウンドの修正そのものの欠陥」**だった
（ラウンド 2・3 とも 3270 側。条項 `paired-artifact-sync` の材料として retro へ送る）。
