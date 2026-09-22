# 仕様: 930（Katakana / Katakana Extended）を利用者に選ばせる設定

## 概要

CCSID 930/5026 の入力規則（大文字化・8 記号の可否）と CHARSET 申告を、既存の `ccsid` と同じ
「システム設定 → セッション設定で上書き」の階層に `katakanaVariant`（`"katakana"` |
`"katakana-ex"` | 未設定）を追加して選べるようにする。未設定は現状の挙動（CHARSET 1172・
大文字化する・8 記号は許可）のまま変えない。

## 設計方針

- **既存の `ccsid` の通り道をそのまま複製する**（system → session → `ConnectOptions` →
  `DeviceEnv` / web-ui の `SessionMeta`）。新しい概念・新しい階層を作らない。
- **`fieldValidate.ts` の単一の判定点に寄せる**（同ファイルの既存コメント「判定はここ 1 か所に
  置き、`acceptsChar` はこれに委譲する」）。8 記号の拒否も `rejectReason` に足す
  ——`inputChar`（transform）とは別に `RejectReason`（拒否）を新設する。
- **操作員エラーへの合流は「通知メッセージを `MSG_BY_REASON` に足すだけ」**。`isOperatorError`
  は既に `Object.values(MSG_BY_REASON)` を全部エラー状態のトリガーとして見るため
  （`20260921-operator-error-mode`）、新しい状態機械は要らない。
- **8 記号の集合は `@ts5250/ebcdic/katakana` に置く**（`isKatakanaCcsid` と同じ理由——
  CP290 の文字集合という事実は 1 か所に住まわせる。web-ui 側にコピーしない）。

## 対象範囲

- `packages/base/src/device-env.ts`: `KatakanaVariant` 型・`deviceEnvFor` の第 2 引数
- `packages/ebcdic/src/katakana.ts`: `isKatakana290InvalidChar`
- `packages/tn5250/src/session/session.ts`: `ConnectOptions.katakanaVariant`
- `packages/server/src/config-types.ts`: system/session スキーマへ `katakanaVariant` を追加
- `packages/server/src/config-resolver.ts`: 解決（session が system を上書き）
- `packages/server/src/session-manager.ts`・`ws-handler.ts`: `OpenOptions` から `Session5250` へ、
  「開いた」通知（`opened` 等）へ
- `packages/server/src/ws-messages.ts`: `opened`/`host-reconnected` 相当のメッセージへ
  `katakanaVariant` を足す（`ccsid?: number`（63 行目）の隣。web-ui は `@ts5250/server` から
  `WsServerMessage` を `import type` で直参照する。`session-controller.ts:1`）
- `packages/web-ui/src/stores/sessions.ts`・`session-controller.ts`: `SessionMeta.katakanaVariant`
- `packages/web-ui/src/components/EmulatorPane.vue`: `uppercaseInput` の条件拡張・
  `katakanaRestricted` の新設・`ScreenGrid` への受け渡し
- `packages/web-ui/src/components/ScreenGrid.vue`: props 追加・`sessionKind` へ合流
- `packages/web-ui/src/composables/fieldValidate.ts`: `RejectReason` に `"katakana-invalid"`・
  `SessionKind.katakanaRestricted`
- `packages/web-ui/src/composables/opMessages.ts`: `MSG_BY_REASON["katakana-invalid"]`
- `packages/web-ui/src/hostCodePages.ts`: 930 のラベルから「拡張」を外す（変種は別の項目で選ぶため）
- `packages/web-ui/src/components/ConfigCard.vue`: システム設定・セッション設定のフォームに
  930/5026 のときだけ出る選択肢を足す

## 依拠する既存の事実

- ACS の「Katakana」（`KEY_JAPAN_KATAKANA`）は 290 として扱われ CHARSET 332、
  「Katakana Extended」（`KEY_JAPAN_KATAKANA_EX`）は CHARSET 1172
  （`.aidev/works/20260921-device-env-1399/decisions.md` D2。原典の読み）
- 実機の ACS のコア（社内機・2026-09-22。`scripts/acs-probe/ccsid290-invalid-chars.txt`）:
  Katakana（290）は半角英小文字を大文字化し `[ ] ^ ` { } ~ ¢` の 8 字をエラー（inhibit=5・
  「キーが定義されていないので正しくない」）にする。Katakana Extended（既定の 930）は
  小文字のまま・8 字とも入力できる
- 原典 `CodePage.isValidChar` は `icodepage == 290` のときだけこの 8 字を偽にする
  （同 probe ファイルのコメント。原典コードの直読）
- 当 PJ の現状（`packages/base/src/device-env.ts:33`・`ScreenGrid.vue:274`）: CODEPAGE は両変種とも
  290、CHARSET は 1172（Extended）を申告し、入力は大文字化する（Katakana 側）が 8 字は拒否しない
  （Extended 側）——ACS のどちらの変種とも一致しない折衷
- **出所: リポジトリ外**（利用者が本 work のヒアリング中に提示した ACS のスクリーンショット。
  file:line で辿れる形にはならないので明記する）。ACS の「ホスト・コード・ページ」設定画面
  （930 の選択はドロップダウンの 1 項目）を確認した——この設定は ACS 自身が**利用者ごとに
  選ばせる**ものであることの根拠
- `isOperatorError`（`packages/web-ui/src/composables/opMessages.ts:98-113`）は
  `Object.values(MSG_BY_REASON)` を全部エラー状態のトリガーに含める。`MSG_BY_REASON` は
  `RejectReason` をキーに持つ（`fieldValidate.ts:224`）
- `ConfigResolver.resolveTarget` の ccsid 解決（`config-resolver.ts:201-203`）:
  `const ccsid = session?.ccsid ?? system.ccsid; if (ccsid !== undefined) opts.ccsid = ccsid;`
  ——新しい設定もこの形をそのまま複製する
- セッション設定フォームの「システムの既定」オプション（`ConfigCard.vue:1141-1144`）:
  `<option :value="undefined">システムの既定</option>` ——同じ体裁を使う

## インターフェース / データ構造

```ts
// packages/base/src/device-env.ts
export type KatakanaVariant = "katakana" | "katakana-ex";
export function deviceEnvFor(ccsid: number, katakanaVariant?: KatakanaVariant): DeviceEnv | undefined;

// packages/ebcdic/src/katakana.ts
export function isKatakana290InvalidChar(ch: string): boolean;

// packages/tn5250/src/session/session.ts の ConnectOptions に追加
katakanaVariant?: KatakanaVariant; // 930/5026 のときだけ意味を持つ。既定 undefined（現状維持）

// packages/server/src/config-types.ts の systemSchema / セッション設定スキーマに追加
katakanaVariant: z.enum(["katakana", "katakana-ex"]).optional()

// packages/web-ui の SessionMeta に追加
katakanaVariant?: "katakana" | "katakana-ex";

// fieldValidate.ts
export type RejectReason = … | "katakana-invalid";
export interface SessionKind {
  sbcsOnly?: boolean;
  katakanaRestricted?: boolean; // 930/5026 系 + katakanaVariant === "katakana"
}
```

`Session5250`（tn5250 core）は既に `get ccsid()` を持つ（`session.ts:671`）ので、同じ形で
`get katakanaVariant(): KatakanaVariant | undefined` を足す（サーバーが `entry.session.katakanaVariant`
を読める形。`ws-handler.ts:1203` の `ccsid: entry.session.ccsid` と並べる）。

## 振る舞いの詳細

### 解決順（system → session → core → web-ui）

1. `ConfigResolver`: `katakanaVariant = session?.katakanaVariant ?? system.katakanaVariant`
   （`ccsid` の解決と同じコードパターン。未設定同士なら `undefined` のまま）
2. `deviceEnvFor(ccsid, katakanaVariant)`: `ccsid` が 930/5026 かつ `katakanaVariant === "katakana"`
   のときだけ `charSet: 332`。それ以外（未設定・`"katakana-ex"`・930/5026 以外）は現状どおり
   （930/5026 は 1172、他の CCSID は変更なし）
3. web-ui（`EmulatorPane.vue`）:
   - `uppercaseInput = isKatakanaCcsid(ccsid) && katakanaVariant !== "katakana-ex"`
     （未設定＝真のまま。`"katakana-ex"` を明示したときだけ偽になる）
   - `katakanaRestricted = isKatakanaCcsid(ccsid) && katakanaVariant === "katakana"`
     （未設定・`"katakana-ex"` は偽のまま。`"katakana"` を明示したときだけ真になる）

この 2 つの式で、AC1（`"katakana"`: 大文字化 true・8 記号拒否 true）・AC2（`"katakana-ex"`:
大文字化 false・8 記号拒否 false）・AC4（未設定: 大文字化 true・8 記号拒否 false＝現状維持）が
同時に成り立つ。3 状態（未設定／katakana／katakana-ex）を 2 個の独立フラグで表す。

### 8 記号の拒否

`rejectReason`（`fieldValidate.ts`）の**先頭**（`kbd-inhibited` の直後）に足す:

```ts
if (session?.katakanaRestricted === true && isKatakana290InvalidChar(ch)) return "katakana-invalid";
```

先頭に置く理由: ACS の `CodePage.isValidChar` はフィールド型を見ずに文字そのものを弾く
（DBCS 系の打鍵経路で一律）。型別の判定（数値・DBCS 専用等）より先に見ても、この 8 記号は
どの型の判定にも該当しない記号なので結果は変わらない——**先に見て意図を明確にする**。

`MSG_BY_REASON["katakana-invalid"]` に新しい文言を足す（ACS 原文「Key not defined, invalid
selection」に相当する意味。AGENTS.md の文体規約に合わせ「です・ます調・句点なし」）。
`isOperatorError` が自動的にこれを拾うので、押すと ACS と同じくキーボードが施錠され、
Reset で解ける（`20260921-operator-error-mode` の既存の状態機械にそのまま乗る）。

### UI（システム設定・セッション設定フォーム）

- `hostCodePages.ts`: 930 のラベルを「930 — 日本語（カタカナ）」に直す（「拡張」を外す。
  拡張かどうかは新しい項目で選ぶため、二重に意味を持たせない）
- `ConfigCard.vue`: `isKatakanaCcsid(該当フォームの ccsid)` のときだけ、システム設定・
  セッション設定それぞれに「カタカナのキー配列」の `<select>` を出す
  - システム設定: `<option :value="undefined">既定（従来どおり）</option>` +
    `<option value="katakana">Katakana（290。大文字化・記号 8 種は入力不可）</option>` +
    `<option value="katakana-ex">Katakana Extended（小文字可・記号 8 種も入力可）</option>`
  - セッション設定: `<option :value="undefined">システムの既定</option>` + 同じ 2 択
    （`ccsid` の「システムの既定」オプションと同じ体裁。`ConfigCard.vue:1141-1144`）
  - 930/5026 以外の CCSID を選んだときは行ごと隠す（`v-if`）。隠れても保存値は消さない
    （`ccsid` を選び直せば以前の値が戻る。挙動は AC3 の「値を持っていても無視される」で担保
    されるので、消す必要が無い）

## ドメイン固有の考慮

- 930/5026 以外の CCSID にこの項目は意味を持たない。`deviceEnvFor`・web-ui の判定式とも
  `isKatakanaCcsid` の外では無視する形にする（フォーム側の非表示は補助。境界は必ずサーバー/
  ロジック側でも閉じる——AGENTS.md「UI の出し分けは補助であって境界ではない」と同じ原則を、
  信頼境界でなく妥当性の境界に適用する）

## エラー処理 / 異常系

- 該当なし。新しい設定値は列挙型で、スキーマ検証（zod）が不正値を弾く。930/5026 以外の CCSID に
  付いていても実害は無い（無視するだけ）ので、検証で追加のエラーは出さない

## 受け入れ基準との対応

- AC1: `deviceEnvFor` の `charSet: 332` 分岐・`uppercaseInput`/`katakanaRestricted` の式・
  `rejectReason` の `katakana-invalid`
- AC2: 同上の逆方向（`"katakana-ex"` で両方 false）
- AC3: `isKatakanaCcsid` を通らない CCSID では `deviceEnvFor`・`uppercaseInput`・
  `katakanaRestricted` のどの式も `katakanaVariant` を見ない
- AC4: 未設定（`undefined`）で `uppercaseInput = true`・`katakanaRestricted = false`
  （現状の式 `isKatakanaCcsid(ccsid)` とそれぞれ同値になる）
