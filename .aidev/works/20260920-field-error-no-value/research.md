# 調査: 欄の検証エラーが値をブラウザへ返す経路

## 調査の問い

- Q1: 漏れは本当に起きるか（推測ではなく動かして確かめる）。
- Q2: 同じ catch を通ってブラウザへ返る例外のうち、**値・秘密が入るのはどれか**。
- Q3: 「20 行 7 桁の欄」の文言を作れる場所はどこか。
- Q4: 利用者に見える文言はどこに置き、web-ui はどう出しているか。
- Q5: 文言に依存しているテストはどれか。
- Q6: MCP / HLLAPI はどう返すか。ws と分ける余地はあるか。

## 調べ方（F0）

- **F0-1 主エージェントが動かして確かめた**（原則 2。直前の work で推測して手戻りしたため、
  ここは先に測った）。`validateFieldContent` を直接呼ぶ計測と、`WsConnection` を使った ws 経路の計測。
- **F0-2 経路の洗い出しは別コンテキストへ委譲**（一次資料を要しない範囲）。
  結論は取り込み、**手当ての根拠になる箇所は主エージェントが `file:line` を開き直して確かめた**。

## 判明した事実

### 漏れは実際に起きる（F1・実測）

**F1-a: 検証エラーの文言に値がそのまま入る。**

```
数値専用: code=FIELD_TYPE / 秘密が含まれる=はい
  message: numeric field accepts digits only: "P@ssw0rd-SECRET"
英字専用: code=FIELD_TYPE / 秘密が含まれる=はい
  message: alphabetic-only field rejects: "P@ssw0rd-SECRET"
```

**F1-b: `ws-handler` の catch は message をそのままブラウザへ返す。**
`WsConnection` に不正な欄を書かせたときの `error` メッセージ:

```
{ "type": "error", "code": "FIELD_OVERFLOW", "fatal": false,
  "message": "value length 18 exceeds field length 10" }
```

**F1-c: クライアントが送った文字列も返る。** 不正な `secretRef` に余分なキーを入れると:

```
{ "code": "PROTOCOL_ERROR",
  "message": "invalid secretRef: [ { \"code\": \"unrecognized_keys\",
    \"keys\": [ \"LEAK_MARKER_XYZ\" ], … } ]" }
```

→ **中継は verbatim**。F1-a と組み合わさると、**復号済みの秘密が平文でブラウザへ返る**。

### 値・秘密が入る例外（F2）

`type:"key"` の経路で投げうる例外は 22 種。**値が入るのは 3 つだけ**（`packages/tn5250/src/screen/field-validate.ts`）:

| # | 場所 | code | 入るもの |
|---|---|---|---|
| 14 | `field-validate.ts:58` | FIELD_TYPE | **打鍵値の全体**（`JSON.stringify(value)`） |
| 15 | `field-validate.ts:69` | FIELD_TYPE | **打鍵値の全体** |
| 16 | `field-validate.ts:78` | FIELD_TYPE | **違反した 1 文字**（`JSON.stringify(ch)`） |

**クライアント由来の文字列が反射するもの**（秘密ではないが利用者入力）:

| # | 場所 | code | 入るもの |
|---|---|---|---|
| 8 | `ws-handler.ts:1199` | PROTOCOL_ERROR | zod の `unrecognized_keys` に**クライアントが付けたキー名** |
| 22 | `session.ts:420` | PROTOCOL_ERROR | `unsupported AID key: ${key}`——**任意文字列がそのまま反射** |
| 21 | `session.ts:405` | PROTOCOL_ERROR | `sysReqText is only valid with SysReq (got ${key})` |
| 5 | `session-manager.ts:1635` | READ_ONLY_SESSION | `key ${key} not allowed…` |

**値を含まないもの**（位置・長さ・参照子だけ）: `FIELD_PROTECTED`（`buffer.ts:1055`——
**位置を出している既存例**）／`FIELD_OVERFLOW`（長さのみ）／`macro-store` の各種
（`:194` のコメントが「理由は残すが値は残さない」と明示）／`field-validate.ts:89-92`
（`value contains characters not representable in CCSID …`——**同じ検証層でこれだけは安全な形**）。

- **フラグキー（Attn / SysReq）では例外が握り潰される**（`ws-handler.ts:1137-1149`。
  直前の work で入れた best-effort）ので、**通常キーだけがこの経路を通る**。
- **非 `As400Error` も素通しする**（`ws-handler.ts:322` の `err instanceof Error ? err.message : String(err)`）。
  ソケットの `ECONNREFUSED <ホスト>:23` 等が届きうる——**コード上は確実に通るが、実行確認は未実施**。

### 位置は throw の場所では作れない（F3）

- `validateFieldContent` が受け取るのは **`InternalField`**（`field-validate.ts:5`・`:21-26`）。
  `buffer.ts:113-128` のとおり **`row` / `col` を持たず**、`startAddr`（線形アドレス）だけ。
  変換に要る `cols` も渡っていない。→ **この関数の中では「20 行 7 桁」を作れない**。
- **`ScreenBuffer.setFieldValue` の中では作れる**（`this.rowColOf(field.startAddr)`。
  `buffer.ts:528-530`）。実際 `FIELD_PROTECTED` はそうしている（`buffer.ts:1054-1055`）が、
  同じ関数の `FIELD_OVERFLOW`（`:1061-1064`）は作れるのに入れていない。
- **`Session.setField` でも作れる**（`session.ts:136` の `private readonly buf` を持つ）。

### 文言の置き場と web-ui の出し方（F4）

- 定数は `packages/web-ui/src/composables/opMessages.ts`。**です・ます調・句点なし**（`:10` に明記）。
  `MSG_<用途>` の SCREAMING_SNAKE。ACS の英語原文を脇にコメントで残す規約あり。
- `NOTICE_BY_ERROR`（`:181-193`）に code → 日本語見出しが既にある
  （`FIELD_TYPE`＝「入力できない文字があるため送信しませんでした」ほか 9 件）。
  **`CONFIG_ERROR` / `PROTOCOL_ERROR` / `SESSION_CLOSED` / `INTERNAL_ERROR` は無い**。
- **`wsErrorNotice`（`:196-199`）はサーバーの message を捨てていない**:

  ```ts
  const head = NOTICE_BY_ERROR[code];
  return head ? `${head}（${message}）` : `エラー: ${message}`;
  ```

- ⚠ **これは意図的な既存の決定**。`:178` の JSDoc に
  「頭に日本語の要約を置き、**元のメッセージも残す**——どの欄のどの値かは元の文にしかない」
  と書いてある。**今回の変更はこの決定を覆すことになる**（`AGENTS.md` 判断の原則 3）。
- 表示は `session-controller.ts:650-655` → `SessionState.notice` → `EmulatorPane.vue:672` →
  画面最下行の `.opmsg`。

### 文言に依存しているテスト（F5）

**文言を変えると落ちる**:

- `packages/tn5250/test/field-validate-current.test.ts:55/60/65/71/77/83/89/153`（`toThrow(/numeric field/)` 等 8 件）
- `packages/tn5250/test/field-ffw-bits.test.ts:142/146`（2 件）
- **`packages/web-ui/test/field-keystroke-rules.test.ts:148-152`** ——
  **「打鍵値が画面に出ること」を明示的に固定している**（`expect(m).toContain('"1.5"')`）。
  **塞ぐなら必ず衝突する。**
- 同 `:155-157`（未知 code で message 素通し）・`:182-186`
- `packages/web-ui/test/session-reconnect.test.ts:531-532/597-598/603`（message の素通しに依存）
- `packages/server/test/ws-tn3270.test.ts:225`・`ws-vt.test.ts:156`（別経路の文言）

**code だけを見ている**（影響なし）: `field-validate.test.ts` 全件ほか多数。

### MCP / HLLAPI（F6）

- **MCP は message を無加工で返す**（`mcp-tools.ts:387-405` の `errorResult`。
  `${code}: ${message}` をテキスト化）。`set_fields` / `send_key` / run-steps の 3 か所が使う。
- **HLLAPI は rc しか返さない**（`hllapi.ts:614-617`）。**値は一切漏れない。**
- 外への写し方は **ws / MCP / HLLAPI の 3 か所で完全に独立**している。
- **重要な非対称**: `resolveSecret` は **ws 経路だけが呼ぶ**（`macro-store.ts:14` に明記）。
  MCP の `set_fields` は**呼び出し元が渡した値**を返すだけなので、**MCP は「漏れ」ではない**
  （自分が送った値が返るだけ）。**漏れているのは ws の secretRef 経路だけ。**

## 影響範囲

- `packages/tn5250/src/screen/field-validate.ts`（3 か所）と、位置を足すなら
  `packages/tn5250/src/screen/buffer.ts` / `packages/tn5250/src/session/session.ts`
- `packages/server/src/ws-handler.ts:322`（ws だけで絞るなら）
- `packages/web-ui/src/composables/opMessages.ts`（`wsErrorNotice` と `NOTICE_BY_ERROR`）
- テスト 10 ファイル以上（上記 F5）

## 実現性 / リスク

- **`wsErrorNotice` の既存の意図（値を残す）を覆すことになる。** 覆す根拠は実測した漏れ（F1）。
  ただし**利用者の利便は確実に下がる**——「どの欄のどの値か」が文から消える。
  **位置を足して補う**必要がある（requirements AC3）。
- **`field-validate.ts` から位置は作れない**（F3）。文言の組み立て場所を動かすか、引数を増やすか。
- **MCP を黙らせる必要は無い**（F6）。core で値を外すと MCP の診断能力も下がるので、
  **どこで塞ぐか**が設計の分かれ目。

## 実装アンカー

- A1: 値を埋める 3 か所（`packages/tn5250/src/screen/field-validate.ts:58` `:69` `:78`）
- A2: 安全な形の既存例（同 `:89-92`——値を埋めずに CCSID だけ出す）
- A3: 位置を出している既存例（`packages/tn5250/src/screen/buffer.ts:1054-1055` `FIELD_PROTECTED`）
- A4: 位置を作れる場所（`buffer.ts:528-530` `rowColOf` / `buffer.ts:1052` `setFieldValue` /
  `packages/tn5250/src/session/session.ts:280-295` `setField`）
- A5: ws の中継（`packages/server/src/ws-handler.ts:322`）
- A6: 文言の組み立て（`packages/web-ui/src/composables/opMessages.ts:181-199`）
- A7: 覆す対象のテスト（`packages/web-ui/test/field-keystroke-rules.test.ts:148-152`）
- A8: ログ側の前例（`packages/server/src/ws-handler.ts:68-87` `errShape` と `test/err-shape.test.ts`）

## 実装時の注意

- **`field-validate.ts:89-92` は既に安全な形**（値を埋めない）。3 か所をこの形に揃えるのが自然。
- **`FIELD_PROTECTED` が位置を出している**ので、位置の出し方はそこに合わせる（`(row,col)`）。
- **テストは文言リテラルではなく定数を参照する**（`AGENTS.md`）。`field-keystroke-rules.test.ts` は
  リテラルを持っているので、直すついでに定数参照へ寄せる。
- `NOTICE_BY_ERROR` に `PROTOCOL_ERROR` / `CONFIG_ERROR` が無いので、
  message を落とすと**未知 code の経路が「エラー: 」だけになる**。見出しを足す必要がある。

## design への申し送り

1. **どこで塞ぐか**——(a) core（`field-validate.ts`）で値を埋めるのをやめる／
   (b) ws の中継（`ws-handler.ts:322`）で絞る／(c) 両方。
   **MCP は漏れではない**（F6）ので、(b) なら MCP の診断能力を保てる。
   ただし (b) だけだと**core の例外に値が残る**ので、ログや将来の利用側で再発しうる。
2. **位置をどこで足すか**——`field-validate.ts` では作れない（F3）。
   `Session.setField` で包み直すか、`validateFieldContent` に row/col を渡すか。
3. **`wsErrorNotice` の既存の決定を覆す**（F4）。`field-keystroke-rules.test.ts:148-152` が
   その決定を固定しているので、**テストごと書き替える**（原則 3）。
4. **クライアント文字列の反射**（F2 の #8・#22 ほか）を今回の範囲に入れるか。
   秘密ではないが、`unsupported AID key: ${key}` は任意文字列の反射で、**別種の面**を持つ。
5. 残る未確認: VT core の例外／非 `As400Error` が実際に届くこと／MCP の他の出口。
