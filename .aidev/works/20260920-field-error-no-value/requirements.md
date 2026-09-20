# 要件: 欄の検証エラーが打鍵した値をブラウザとログへ出さないようにする

## 背景 / 課題

- **欄の検証エラーの文言に、打鍵した値がそのまま埋まっている。** `validateFieldContent`
  （`packages/tn5250/src/screen/field-validate.ts`）の 3 か所が `JSON.stringify(value)` で値を埋める。
  **実測**（2026-09-20）:

  ```
  数値専用: code=FIELD_TYPE / 秘密が含まれる=はい
    message: numeric field accepts digits only: "P@ssw0rd-SECRET"
  英字専用: code=FIELD_TYPE / 秘密が含まれる=はい
    message: alphabetic-only field rejects: "P@ssw0rd-SECRET"
  ```

- **その文言はブラウザへ返る。** `packages/server/src/ws-handler.ts:322` の catch が
  `this.sendError(code, err instanceof Error ? err.message : String(err), fatal)` で
  **message をそのままクライアントへ送る**。
- **値はマクロ由来の秘密でもありうる。** `resolveField`（同 `:1194-1203`）が
  `store.resolveSecret(ref.data, this.user)` で**復号した秘密**を欄の値として渡す。
  その値が型の合わない欄（数値専用・英字専用・DBCS 専用）に当たると、上の経路で
  **復号済みの秘密が平文でブラウザへ返る**。
- `AGENTS.md`「セキュリティ / 秘密の扱い」は
  「**API/ブラウザには平文も暗号文も返さない**（有無だけ `hasSecret` / `autoSignon` で示す）。
  **ログにも値を出さない**」と定めている。**これに反している。**
- 出自: `20260920-restore-screen-parity` の review ラウンド 3 で発見（`code-quality-checks.md`）。
  同 work は**フラグキーの経路だけ**を塞ぎ（`errShape()` で message をログに出さないようにした）、
  **通常キーの経路はこのまま残った**。

## 目的 / ゴール

- **欄の検証エラーが、打鍵した値を 1 文字もブラウザへ返さない**状態。ログにも出ない。
- **それでも利用者が直せる**状態——どの欄が・なぜ弾かれたかは分かる
  （「数字しか入力できません（20 行 7 桁の欄）」のように、**値を含まず位置を含む**）。
- 「値を出さない」が**注記ではなく層で担保されている**状態
  （`20260920-restore-screen-parity` の retro——同じ穴を 2 回開けた反省）。

（`.aidev/charter.md` は無いので、charter ゴールとの紐付けは行わない）

## ユーザーストーリー

- US1: 端末の利用者として、型の合わない値を打ったときに**何をどう直せばよいか**が分かってほしい。
  なぜなら、「弾かれた」だけでは欄が多い画面でどこを直せばよいか分からないから。（受け入れ: AC3）
- US2: マクロで自動サインオンを再生する利用者として、**復号された秘密が画面やログに出ない**でほしい。
  なぜなら、秘密を暗号化して保存している意味が無くなり、画面を共有した瞬間に漏れるから。
  （受け入れ: AC1, AC2）
- US3: この PJ の保守者として、「値を出さない」が**テストで固定されて**いてほしい。
  なぜなら、直前の work で同じ性質を 2 回壊しており（`String(e)` / `stack` の 1 行目だけ）、
  注記だけでは守られないと分かっているから。（受け入れ: AC4, AC5）

## スコープ

### 対象

- **欄の検証エラーの文言**（`packages/tn5250/src/screen/field-validate.ts` の 3 か所）
  - 数値専用（`numeric field accepts digits only`）
  - 英字専用（`alphabetic-only field rejects`）
  - DBCS 専用（`DBCS-only (…) field rejects SBCS char`）
- **`ws-handler` の catch がブラウザへ返す message**（`packages/server/src/ws-handler.ts:322`）
- **同じ経路で投げる他の例外のうち、値を含むもの**——洗い出して判断する
  - `resolveField` の `invalid secretRef: ${ZodError.message}`（**クライアント由来の文字列が入る**）
  - `setField` が通る `buffer.ts` / `session.ts` の例外（`FIELD_OVERFLOW` ほか）
- **クライアント由来の文字列の反射**（research F2 で洗い出した 4 件。利用者の判断で範囲に入れた）
  - `session.ts:420` `unsupported AID key: ${key}`——**任意文字列がそのまま反射する**
  - `session.ts:405` `sysReqText is only valid with SysReq (got ${key})`
  - `session-manager.ts:1635` `key ${key} not allowed on read-only session`
  - `ws-handler.ts:1199` `invalid secretRef: ${ZodError.message}`（zod の `unrecognized_keys`）
- **利用者に見える文言**（`AGENTS.md`「利用者に見えるメッセージは日本語で、文体を揃える」。
  定数は `composables/opMessages.ts` に 1 か所へ置く）
- 回帰テスト（値が出ないこと・位置が出ること）

### 対象外

- **欄を書く経路の外での、クライアント由来の識別子の反射**（`sessionId` / `watchId` /
  `session` / `system` / `host`）。`printer session <文字列> not found` /
  `watch <文字列> not found` / `invalid session reference "<文字列>"` /
  `connect timeout after 15000ms (<ホスト名>:<ポート>)` の 10 通りを review ラウンド 4 が実測した。
  - **なぜ外すか**: どれも**送った本人に自分の識別子が返るだけ**で、復号された秘密でも
    他人の値でもない。塞ぐと `ws-handler` / `session-manager` / `watch-registry` /
    `config-resolver` / `tn5250` の transport まで触ることになり、本題から遠い。
    接続失敗のホスト名を消すと**「どのホストに繋がらなかったか」が運用者に分からなくなる**副作用もある。
  - **実害のあった面は閉じた**——反射が残っていると**クライアントが web-ui の表示文を選べた**
    （`{"type":"printer-stop","sessionId":"field at (9,9) accepts digits only"}` で
    「数字項目には数字しか入力できません（9 行 9 桁の欄）」が出るのを実測）。
    `wsErrorNotice` が message の中身を見るのを**欄の検証の code のときだけ**に絞って塞いである。
  - 残りは `.aidev/backlog/code-quality-checks.md` に起票済み。

- **`packages/hostserver` の `CONFIG_ERROR` 系**（`db-decimal.ts` / `program-args.ts` /
  `message-receive.ts` / `pcml-layout.ts`）。ws の欄の値の経路を通らず、
  **利用者の打鍵・秘密が流れ込む道が無い**。別項目として台帳に残す。
- **MCP / HLLAPI の「出し方」**（`errorResult` / rc への畳み込み）。**そこは漏れではない**——
  `resolveSecret` は **ws 経路だけが呼ぶ**（`macro-store.ts:14`）ので、MCP に返るのは
  **呼び出し元が自分で渡した値**だけ。HLLAPI は rc しか返さない（research F6）。
  ただし **core で値を外すので、MCP に返る文言も結果として変わる**（診断能力は下がるが、
  呼び出し元は自分が送った値を知っているので実害は無い）。この波及は design で明記する。
- エラーの表示のしかた（トースト・OIA など）の作り直し。文言の中身だけを変える。
- 監査ログ（`withAudit`）の形式。既に `code` しか記録していない。

## 機能要件

- FR1: 欄の検証エラーの `message` に、**打鍵した値・その一部・その長さ**を含めない。
- FR2: 代わりに**欄の位置**（行・桁）と**なぜ弾かれたか**を含める。
- FR3: 同じ経路でブラウザへ返る他の例外についても、**値を含むものは含めない形に直す**。
  直さないものは「なぜ安全か」を記録する。
- FR4: サーバー側のログにも値を出さない（`20260920-restore-screen-parity` の `errShape()` と同じ態度）。
- FR5: 利用者に見える文言は日本語・です・ます調・句点なし。定数は 1 か所に置く。
- FR6: 「値を出さない」を**テストで固定する**。テストは**実装を元に戻すと落ちる**こと。

## 非機能要件 / 制約

- **`AGENTS.md` の「判断の原則」に従う。** とくに原則 2——
  **「この経路は安全なはず」を推測で書かない。動かして確かめる。**
  （直前の work で、この原則を外して同じ性質を 2 回壊した）
- 条項 `verify-by-mutation`——回帰テストを足したら、**実装を戻して落ちることを 1 回確かめる**。
- 条項 `comment-provenance`——出所は work slug 付きで書く。
- `AGENTS.md` のコーディング規約（ログは stderr のみ・`console.*` 禁止・
  ピュアロジック層に `node:*` を持ち込まない）。
- 秘密をコミットしない。`.aidev` の成果物にも実資格情報を書かない（伏字・ダミー値を使う）。

## 完了条件 (受け入れ基準)

- [ ] AC1: 型の合わない値（秘密を模した文字列）を欄へ書いたとき、**`As400Error.message` に
  その値が 1 文字も含まれない**。数値専用・英字専用・DBCS 専用の 3 経路すべてで確かめる。
- [ ] AC2: 同じ操作を ws 経由で行ったとき、**クライアントへ送られる `error` メッセージに値が含まれない**。
  マクロの `secretRef` を型の合わない欄へ再生する経路で確かめる。
- [ ] AC3: エラーの文言に**欄の位置（行・桁）**と理由が含まれ、利用者が直せる。
  文言は日本語・です・ます調・句点なしで、定数は 1 か所にある。
- [ ] AC4: サーバーのログにも値が出ない（`ws-handler` の warn / `withAudit` の記録）。
- [ ] AC5: AC1〜AC4 を固定するテストがあり、**実装を元に戻すと落ちる**ことを確かめてある
  （条項 `verify-by-mutation`）。
- [ ] AC6: 同じ catch を通ってブラウザへ返る例外を**洗い出した一覧**があり、
  それぞれ「直した」か「値を含まないので安全（根拠つき）」のどちらかになっている。
- [ ] AC7: `npm test` ／ `npm run build`（web-ui は `npm run build -w @ts5250/web-ui`）／
  `npm run lint` ／ `aidev smoke` が通る。既存のテストが文言に依存していれば**定数参照に直す**
  （`AGENTS.md`「テストは文言リテラルではなく定数を参照する」）。
- [ ] AC8: リポジトリに秘密・実機の固有名詞が入っていない。
- [ ] AC9: **クライアントが送った文字列が、そのまま `message` に反射しない**
  ——**欄を書く経路に限る**（`type:"key"` の `fields` / `key` / `sysReqText`、および
  `gui-select` / `gui-submit`）。値そのものではなく「その位置・その種別」で伝える。
  AC5 と同じくテストで固定し、戻すと落ちる。
  **経路を限定したのは 2026-09-20（review ラウンド 4 のあと。利用者の判断）**——
  起票時は経路を書いておらず「ws で返る全部」と読めたが、実際には
  `sessionId` / `watchId` / `session` / `system` / `host` も反射しており（10 通りを実測）、
  そこまで塞ぐとこの work の本題（欄の検証エラー）から遠い範囲に広がる。
  **限定した残りは「対象外」に書き、台帳へ送った。**

## 未確定事項 / 確認したいこと

- **同じ catch を通る例外の全体像**。`setField` は `session.ts` → `buffer.ts` と降りるので、
  `FIELD_OVERFLOW` / `FIELD_PROTECTED` / 欄が見つからない 系がどんな文言を持つかを research で洗う。
- **欄の位置をどこで足すか**。`validateFieldContent` は `field` を受け取っているので中で足せるが、
  **`As400Error` の message を利用者向けの日本語にするのか、code から web-ui が引くのか**で
  設計が変わる（`AGENTS.md`「利用者に見えるメッセージは日本語で」と
  「定数は `opMessages.ts` に 1 か所」を踏まえて design で決める）。
- **MCP / HLLAPI で値が要るか**。自動化の切り分けには値があったほうが親切だが、
  同じ `As400Error` を共有している。分けるならどこで分けるか。
- **既存テストが文言に依存している数**。変更の影響範囲の見積もりに要る。
