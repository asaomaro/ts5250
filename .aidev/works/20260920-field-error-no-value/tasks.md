# タスク: 欄の検証エラーが値をブラウザへ返さないようにする

## 実装方針

**core から外へ**の順で進める。`field-validate.ts` で値を外し（T1・T2）、位置を渡す配線を足し（T3）、
反射をやめ（T4）、web-ui の文言を組み直す（T5）。テストは**足すたびに変異注入で落ちることを確かめる**
（条項 `verify-by-mutation`。直前の work でここを怠り、review の must が 2 件出た）。

## 作業順序と依存関係

- **T1（値を外す）と T3（位置を渡す）は分ける。** T1 だけでも漏れは止まるので、
  **先に安全側へ倒してから**利便（位置）を足す。途中で止めても危険な状態にしない。
- T5（web-ui）は T1 の後でないと意味が無い——サーバーが値を出したままでは、
  web-ui で隠しても `message` は届いている。
- 既存テストの追従（T6）は T1・T3・T4 の後。まとめて 1 回で直す。

## リスク / 留意点

- **`field-keystroke-rules.test.ts:148-152` は「打鍵値が画面に出ること」を固定している。**
  これは覆す対象（design「依拠する既存の事実」）。**消さずに書き替え**、覆した理由を残す。
- **`NOTICE_BY_ERROR` に見出しの無い code がある**（`PROTOCOL_ERROR` ほか 4 つ）。
  message を出さなくするので、**足さないと「エラー: 」だけになる**。
- **MCP の文言も変わる**（漏れではないが診断能力は下がる）。`decisions.md` に判断を残す。
- `validateFieldContent` の `at` は**任意引数**。既存の呼び出し（テスト）を壊さない。

## テスト方針

- **単体**: `packages/tn5250/test/` に「値が 1 文字も含まれない」「位置が入る」を足す。
  既存の文言依存（`toThrow(/numeric field/)` 等 10 件）を新しい形へ。
- **結合**: `packages/server/test/` に **ws 経由で秘密が返らない**ことを足す
  （`ws-macro-secret.test.ts` の基盤を使う。research F1-b・F1-c の計測と同じ形）。
- **web-ui**: `wsErrorNotice` が値を出さず、位置と日本語の見出しを出すことを固定。
- **変異注入**: T1・T3・T4・T5 のそれぞれで、**実装を元に戻すとテストが落ちる**ことを確かめる。
- **起動確認**: `aidev smoke`。

## タスク

- [x] T1: `field-validate.ts` の 3 か所から値を外す（位置なしの形でまず安全側へ倒す）
      対象: `packages/tn5250/src/screen/field-validate.ts:58` `:69` `:78` / 手本は同 `:89-92` / 根拠: research F2, design「インターフェース 2」
      依存: なし
      AC: AC1
- [x] T2: 値が 1 文字も含まれないことを固定するテスト（3 経路）＋ **変異注入で落ちることを確認**
      対象: `packages/tn5250/test/field-validate.test.ts`（code だけを見ており文言に依存していない）へ追記 / 根拠: design「受け入れ基準との対応 AC1」, 条項 `verify-by-mutation`
      依存: T1
      AC: AC1, AC5
- [x] T3: `Session.setField` が行・桁を作って `validateFieldContent` へ渡す（任意引数 `at`）
      対象: `packages/tn5250/src/session/session.ts:280-295` / `packages/tn5250/src/screen/buffer.ts:528-530` `rowColOf` / 根拠: research F3, design「インターフェース 1」
      依存: T1
      AC: AC3
- [x] T4: クライアント由来の文字列の反射を 4 か所でやめる
      対象: `packages/tn5250/src/session/session.ts:420` `:405` / `packages/server/src/session-manager.ts:1635` / `packages/server/src/ws-handler.ts:1199` / 根拠: research F2, design「インターフェース 3」
      依存: なし
      AC: AC9
- [x] T5: web-ui の文言を組み直す（`wsErrorNotice` が message を出さず、位置を拾って日本語にする）
      対象: `packages/web-ui/src/composables/opMessages.ts:181-199` / 根拠: design「インターフェース 4」
      依存: T1, T3
      AC: AC3
- [x] T6: 文言に依存している既存テストを新しい形へ（research F5 の一覧）
      対象: `packages/tn5250/test/field-validate-current.test.ts`（8 件）/ `field-ffw-bits.test.ts`（2 件）/ `packages/web-ui/test/field-keystroke-rules.test.ts:148-186` / `session-reconnect.test.ts:531-603` / 根拠: research F5
      依存: T1, T3, T5
      AC: AC7
- [x] T7: ws 経由で秘密が返らないことを固定するテスト ＋ **変異注入で落ちることを確認**
      対象: `packages/server/test/ws-macro-secret.test.ts`（基盤を再利用）/ 根拠: research F1-b・F1-c, design「受け入れ基準との対応 AC2」
      依存: T1, T4
      AC: AC2, AC5
- [x] T8: ログにも値が出ないことを確かめる（`errShape` を通らない経路を含む）
      対象: `packages/server/src/ws-handler.ts:68-87` `errShape` / `packages/server/test/err-shape.test.ts` / 根拠: design「受け入れ基準との対応 AC4」
      依存: T1
      AC: AC4
- [x] T9: 例外の一覧を `decisions.md` に残す（「直した」か「値を含まないので安全＋根拠」）
      対象: 未特定（research F2 の表を根拠に判断を書く）/ 根拠: design「受け入れ基準との対応 AC6」
      依存: T4
      AC: AC6
- [ ] T10: **【deliver で消化】** 秘密・実機の固有名詞の走査と片付け
      対象: 未特定 / 根拠: requirements「非機能要件」, `AGENTS.md`「セキュリティ」
      依存: T9
      AC: AC8
- [x] T11: 全体の緑を確認（`npm test` / `npm run build` / `npm run lint` / `aidev smoke`）
      対象: 未特定 / 根拠: design「受け入れ基準との対応 AC7」
      依存: T6, T7, T8
      AC: AC7
- [x] T12: cross 点検（手順 5.5）の指摘 16 件を直す
      対象: `packages/server/test/ws-macro-secret.test.ts`（FIELD_TYPE に届く画面を用意）/
      `packages/tn5250/test/field-error-position-wiring.test.ts`（新規・位置の配線）/
      `packages/tn5250/test/aid-key-no-reflection.test.ts`（新規・反射）/
      `packages/web-ui/test/field-at-contract.test.ts`（新規・書式の契約）/
      `packages/server/src/tn3270-adapt.ts`（3270 側の双子）/
      `packages/tn5250/src/screen/buffer.ts` `packages/tn5250/src/session/session.ts`（長さを外す）/
      `packages/web-ui/src/composables/opMessages.ts` / `packages/server/src/ws-handler.ts`（出所の更新）
      / 根拠: `review.md`「タスク点検ログ」, decisions D5・D6・D7
      依存: T11
      AC: AC1, AC2, AC5, AC9
- [x] T13: review ラウンド 1 の指摘 16 件を直す（差し戻し 1 回目）
      対象: `packages/server/src/ws-handler.ts`（`wsFieldRefSchema` で欄の指定を検証）/
      `packages/server/src/macro-store.ts`（id の反射をやめる）/
      `packages/web-ui/src/composables/opMessages.ts`（理由を戻す・`fieldAtLabel`）/
      `packages/web-ui/test/field-at-contract.test.ts`（共有ヘルパ `source-scan.ts` の `code()` へ）/
      `packages/web-ui/src/session-controller.ts`（古い注記）
      / 根拠: `review.md`「ラウンド 1」, decisions D8・D9・D10
      依存: T12
      AC: AC3, AC9
- [x] T14: review ラウンド 3 の指摘 15 件を直す（差し戻し 2 回目）
      対象: `packages/server/src/ws-field-ref.ts`（`parseKeyFieldShape` / `parseFieldId` を追加）/
      `packages/server/src/tn3270-adapt.ts` `packages/server/src/ws-handler.ts`（**検証を呼ぶ位置**を揃える）/
      `packages/tn5250/src/session/session.ts`（`gui-submit` の id 反射）/
      `packages/web-ui/src/composables/opMessages.ts`（`ErrorCode` への型付け・`noticeFor` / `MSG_OUTSIDE_CCSID`）/
      `packages/web-ui/test/field-at-contract.test.ts`（ファイル単位 → **個数**で見る）
      / 根拠: `review.md`「ラウンド 3」, decisions D8 の追記
      依存: T13
      AC: AC9
- [x] T15: review ラウンド 4 の指摘 13 件を直す（差し戻し 3 回目）
      対象: `packages/web-ui/src/composables/opMessages.ts`（`CODES_WITH_FIELD_DETAIL` で
      表示の乗っ取りを塞ぐ・接続系の見出し 4 つ）/ `packages/server/src/ws-field-ref.ts`
      （`parseKeyFields` で容れ物を検証・`parseFieldId` を `.positive()` に揃える）/
      `packages/server/src/tn3270-adapt.ts`（`IBMI_ONLY` の素引き）/
      `packages/server/test/ws-macro-secret.test.ts`（5250 にも同じ入力の形を振る）/
      `packages/web-ui/test/field-at-contract.test.ts`（走査を実行時と同じ厳しさに）/
      `requirements.md`（AC9 の経路を限定）
      / 根拠: `review.md`「ラウンド 4」, decisions D11
      依存: T14
      AC: AC9
