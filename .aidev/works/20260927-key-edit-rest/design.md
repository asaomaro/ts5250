# 仕様: キー編集の細部の残り

## 設計方針
- 文字の割当 `char:<字>` を足し、欄の keydown で**修飾の無い同じ字の keydown を投げ直す**（打鍵と同じ経路）。ペインの割当の処理では何もしない。既定の版 6 に Alt+@・Alt+\・Alt+- と Alt+Pause（Test Request）。
- Home: ホーム位置が SO の桁（J 欄・全角の状態の E 欄・先頭が SO の桁）なら次の桁へ移り、Record Backspace は送らない。
- CSRINPONLY: core が SOH の 0x10 をスナップショット `cursorInputOnly` に載せる（CLEAR 系・CFT・SOH で下ろす。SAVE / RESTORE で退避）。web-ui の `moveCell` が ACS の規則（`snapToInput`）で寄せる。
- PA1〜3（AID 0x6C・0x6E・0x6B。欄データ無し＝`NO_DATA_AIDS`）と TestRequest（フラグのレコード。Attn・SysReq と同じく施錠中も通す）を `AidKey` に足し、server のキー名の表・HLLAPI（`@x@y@z`・`@A@C`）に通す。

## 依拠する既存の事実
- research F1〜F5

## 受け入れ基準との対応
- AC1: `test/acs-default-keys.test.ts`・`test/keybindings.test.ts`
- AC2: `test/home-key-acs.test.ts`
- AC3: `test/csr-input-only.test.ts`・`packages/tn5250/test/aid-data-mask.test.ts`
- AC4: `packages/tn5250/test/pa-test-keys.test.ts`・server の HLLAPI のテスト・`scripts/verify-pa-test-keys.mjs`
- AC5: DLTPGM と IFS の削除
