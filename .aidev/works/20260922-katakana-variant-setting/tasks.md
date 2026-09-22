# タスク: 930（Katakana / Katakana Extended）を利用者に選ばせる設定

## 実装方針

下から積む: `base`（型・CHARSET 切替）→ `ebcdic`（8 記号の集合）→ `tn5250` core（`ConnectOptions`）→
`server`（設定スキーマ・解決・メッセージ）→ `web-ui`（判定式・UI）。各層は単体テストで固定してから
上へ進む。最後に結合（web-ui の統合テスト）で通しを確認する。

## 作業順序と依存関係

下の `依存:` に従う。T1〜T4（base/ebcdic/core）は互いに独立なので並行できるが、対象ファイルが
小さくぶつからないため直列で進める（見積もりの合わせやすさを優先）。

## リスク / 留意点

- `deviceEnvFor` の第 2 引数はオプショナルにし、既存の呼び出し元（tn3270・vt は 930 を扱わないため
  無関係、tn5250 の他の呼び出し）が壊れないことを型検査で確認する
- `RejectReason` に新しい値を足すと `MSG_BY_REASON`（`Record<RejectReason, string>`）が
  網羅を要求する（TypeScript が検査する）ので、片方だけ足すと型エラーで気づける

## テスト方針

- 層ごとの単体テスト（base の `deviceEnvFor`・ebcdic の `isKatakana290InvalidChar`・
  server の `ConfigResolver`・web-ui の `rejectReason`／`ScreenGrid` 統合）
- ScreenGrid 統合テストで「Katakana で 8 記号を打つと操作員エラー状態に入る」ことまで確認
  （`isOperatorError` に自動で乗ることの回帰防止）
- mutation は主要な分岐（charSet 332 の条件・8 記号判定・大文字化の条件）に当てる

## タスク

- [x] T1: `packages/base/src/device-env.ts`: `KatakanaVariant` 型を追加し、`deviceEnvFor` に
      第 2 引数 `katakanaVariant?: KatakanaVariant` を足す。930/5026 で `"katakana"` のときだけ
      `charSet: 332`（既定・`"katakana-ex"` は現状の 1172 のまま）。`packages/base/src/index.ts:76`
      の再輸出（`export { deviceEnvFor, type DeviceEnv } from "./device-env.js"`）に
      `type KatakanaVariant` を追加する（無いと tn5250/server が `@ts5250/base` 経由で参照できない）
      対象: `packages/base/src/device-env.ts:26-43`・`packages/base/src/index.ts:76` /
      根拠: design「インターフェース / データ構造」
      依存: なし
      AC: AC1, AC2, AC3, AC4
- [x] T2: `packages/ebcdic/src/katakana.ts`: `isKatakana290InvalidChar(ch: string): boolean` を追加
      （`[ ] ^ ` { } ~ ¢` の 8 字。原典 `CodePage.isValidChar` への参照コメントを添える）
      対象: `packages/ebcdic/src/katakana.ts`（末尾に追加） / 根拠: design「振る舞いの詳細」8 記号の拒否
      依存: なし
      AC: AC1, AC2
- [x] T3: `packages/tn5250/src/session/session.ts`: `ConnectOptions` に `katakanaVariant?: KatakanaVariant`
      を足し、`deviceEnvFor(opts.ccsid ?? 37, opts.katakanaVariant)` に変更。`Session5250` に
      `get katakanaVariant(): KatakanaVariant | undefined` を足す（`get ccsid()` と同じ形）
      対象: `packages/tn5250/src/session/session.ts:43-48, 253-270, 308, 671-672` / 根拠: design「対象範囲」
      依存: T1
      AC: AC1, AC2, AC3, AC4
- [x] T4: `packages/server/src/config-types.ts`: `systemSchema` とセッション設定スキーマに
      `katakanaVariant: z.enum(["katakana", "katakana-ex"]).optional()` を追加（`ccsid` の隣）
      対象: `packages/server/src/config-types.ts:204, 323` / 根拠: design「インターフェース / データ構造」
      依存: なし
      AC: AC1, AC2, AC3, AC4
- [x] T5: `packages/server/src/config-resolver.ts`: `resolveTarget` に
      `const katakanaVariant = session?.katakanaVariant ?? system.katakanaVariant; if (katakanaVariant !== undefined) opts.katakanaVariant = katakanaVariant;`
      を `ccsid` の解決の直後に足す
      対象: `packages/server/src/config-resolver.ts:201-205` / 根拠: design「振る舞いの詳細」解決順 1
      依存: T3, T4
      AC: AC1, AC2, AC3, AC4
- [x] T6: `packages/server/src/ws-messages.ts`・`ws-handler.ts`:
      `WsOpened.katakanaVariant` を足し、2 か所の送出（`onOpen` の新規オープン・`attach` の既存セッションへの
      合流）で埋める（`ccsid` と同じ配線）。**プリンターセッション（`printerOptsFrom`・`PrinterConnectOptions`）は
      対象外**——`printer-session.ts` は KBDTYPE/CODEPAGE/CHARSET を申告しない設計（コメントに明記。
      `deviceEnvFor` を呼ばない）ので、`katakanaVariant` を足しても読み手が無い。ブラウザ直指定
      （`WsOpen.katakanaVariant`・`buildDirect`）にも足す——保存済み設定に無い ad-hoc 接続だけ
      機能が使えない食い違いを避ける（tasks 承認後に気付いた拡張。decisions に記録）
      対象: `packages/server/src/ws-messages.ts:63,273`・`ws-handler.ts` の `onOpen`/`attach` の
      `send({ type: "opened", … })` 2 か所・`buildDirect` / 根拠: design「対象範囲」
      依存: T3, T5
      AC: AC1, AC2, AC3, AC4
- [x] T7: `packages/web-ui/src/stores/sessions.ts`・`session-controller.ts`: `SessionMeta` に
      `katakanaVariant?: "katakana" | "katakana-ex"` を足し、`msg.katakanaVariant` から埋める
      対象: `packages/web-ui/src/stores/sessions.ts:26, 177`・`session-controller.ts:780` 付近 /
      根拠: design「対象範囲」
      依存: T6
      AC: AC1, AC2, AC3, AC4
- [x] T8: `packages/web-ui/src/composables/fieldValidate.ts`: `RejectReason` に `"katakana-invalid"`
      を、`SessionKind` に `katakanaRestricted?: boolean` を追加。`rejectReason` の `kbd-inhibited`
      直後に 8 記号の拒否を足す（`isKatakana290InvalidChar` を `@ts5250/ebcdic/katakana` から import）
      対象: `packages/web-ui/src/composables/fieldValidate.ts:29-46` / 根拠: design「振る舞いの詳細」
      依存: T2
      AC: AC1, AC2
- [x] T9: `packages/web-ui/src/composables/opMessages.ts`: `MSG_BY_REASON["katakana-invalid"]` に
      文言を追加（です・ます調・句点なし。ACS 原文の意味を踏まえる）
      対象: `packages/web-ui/src/composables/opMessages.ts:224` 付近（`MSG_BY_REASON`） /
      根拠: design「振る舞いの詳細」8 記号の拒否
      依存: T8
      AC: AC1
- [x] T10: `packages/web-ui/src/components/EmulatorPane.vue`: `uppercaseInput` の式を
      `isKatakanaCcsid(state.value?.ccsid) && state.value?.katakanaVariant !== "katakana-ex"` に、
      新しい `katakanaRestricted` computed を
      `isKatakanaCcsid(state.value?.ccsid) && state.value?.katakanaVariant === "katakana"` で足し、
      `ScreenGrid` へ `:katakana-restricted="katakanaRestricted"` を渡す
      対象: `packages/web-ui/src/components/EmulatorPane.vue:97-98, 1597` 付近 / 根拠: design「振る舞いの詳細」解決順 3
      依存: T7
      AC: AC1, AC2, AC3, AC4
- [x] T11: `packages/web-ui/src/components/ScreenGrid.vue`: props に `katakanaRestricted?: boolean` を足し、
      `sessionKind` computed へ合流（`{ sbcsOnly: …, katakanaRestricted: props.katakanaRestricted === true }`）
      対象: `packages/web-ui/src/components/ScreenGrid.vue:153, 237` / 根拠: design「対象範囲」
      依存: T8, T10
      AC: AC1, AC2
- [x] T12: `packages/web-ui/src/hostCodePages.ts`: 930 のラベルから「拡張」を外す
      （「930 — 日本語（カタカナ）」に）
      対象: `packages/web-ui/src/hostCodePages.ts:31` / 根拠: design「振る舞いの詳細」UI
      依存: なし
      AC: なし
- [x] T13: `packages/web-ui/src/components/ConfigCard.vue`: システム設定・セッション設定の
      フォームに、930/5026 のときだけ出る「カタカナのキー配列」の `<select>` を足す
      （システム: 既定/`katakana`/`katakana-ex` の 3 択。セッション: システムの既定/`katakana`/
      `katakana-ex` の 3 択。`v-if="isKatakanaCcsid(…)"` で 930/5026 以外は隠す）
      対象: `packages/web-ui/src/components/ConfigCard.vue:885-908（システム）, 1140-1145（セッション）` /
      根拠: design「振る舞いの詳細」UI
      依存: T4, T12
      AC: AC1, AC2, AC3
- [x] T14: 結合テスト——Katakana を選んだセッションで 8 記号を打つと操作員エラー状態（施錠・Reset で解ける）
      に入ることを ScreenGrid の統合テストで固定する（`isOperatorError` に自動で乗ることの回帰防止）
      対象: 未特定（既存の `operator-error-mode.test.ts` か新規ファイル）
      依存: T9, T11
      AC: AC1
