# 仕様: SBCS のセッションの打鍵と MONOCASE

## 設計方針
- `fieldValidate.ts` に `SessionKind { sbcsOnly }` を足し、`rejectReason` / `acceptsChar` / `dbcsByteLength` が受け取る。SBCS だけのセッションでは
  幅の判定を `isCertainWideGlyph`（どのフォントでも 2 桁の字＝漢字・かな・全角英数）にし、バイト長は 1 字 1 バイト。省略時は従来どおり。
- `ScreenGrid` に `sbcsSession` を足し、判定と予算（`byteLen`）へ渡す。MONOCASE は `toUpperCase`（`µ`・2 字になる大文字・DBCS のセッションの全角を除く）。
- `EmulatorPane` はセッションの CCSID から `sbcsSession` を決める（`@ts5250/tn5250/browser` から `isDbcsCcsid` を出す。CCSID の集合を複製しない）。
- 漢字・かなを SBCS のセッションでも打った時点で弾くのは、core が送信時に弾くのと揃えるため（ACS は受け付けて送るときに置き換える。D1）。

## 依拠する既存の事実
- research F1〜F5。CCSID の集合は `packages/tn5250/src/session/terminal-type.ts` の `DBCS_CCSIDS`。

## 受け入れ基準との対応
- AC1: `test/field-validate.test.ts`（SBCS だけのセッション 4 件）・`test/sbcs-session-input.test.ts`（37 / 930 / 不明）・`test/ffw-behavior-bits.test.ts`
- AC2: `test/ffw-behavior-bits.test.ts`（SBCS の MONOCASE・DBCS のセッション）
- AC3: mutation
