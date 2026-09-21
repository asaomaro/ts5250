# 仕様: 既定のキー割り当てと End の行き先

## 設計方針
- `keybindings.ts` に版 4 を足す（F2 のうち既存機能に当たるもの。End は入れない＝F3）。保存済みの割り当てが優先（既存の `load` の規則）。
- 版 1 の Ctrl+F1 / Ctrl+F3 を ACS の向きに直す（F6）。版 4 より前の保存値は、**組が丸ごと古い既定のときだけ**入れ替える（`CORRECTED_BY_VERSION`）。
  片方だけ変えた人の意図は壊さない。
- `useKeymap.ts` に `hasKeyBinding(ev)` を置き、ScreenGrid の Insert・End（SBCS・DBCS）は割り当てがあればペインへ委ねる。
  キーマップは IME の変換中（`isComposing` / `Process`）のキーを拾わない。
- `fieldEdit.ts` の `end`: 最後の桁まで埋まっていれば最後の桁（F4）。

## 依拠する既存の事実
- ペインの keydown は、システム要求行・ドロップダウン・日付ピッカーの Esc を割り当てより先に処理する（`EmulatorPane.vue` `onKeydown`）。
- 割り当てはホストへ送る前に `preventDefault` する（`makeKeydownHandler`）。Shift+Insert のブラウザ既定（貼り付け）も止まる。

## 受け入れ基準との対応
- AC1: `acs-default-keys.test.ts`「既定の割り当ての中身」「キーハンドラー」
- AC2: 同「欄の中で押したとき」「DBCS 欄でも同じ」
- AC3: `field-edit.test.ts`・`acs-default-keys.test.ts`
- AC4: 同「保存済みの割り当てへの反映」
- AC5: mutation
