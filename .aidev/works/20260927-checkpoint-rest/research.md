# 調査: 節目 9・10 の懸念と関連付けプリンターの残り

## 判明した事実
- F1: ACS `PS5250.processFieldPlusMinusAndExit` の Field− は `HostPlane[end] & 0x0F | 0xD0`（最終桁の実際のバイト）。当 PJ は数字・`.,+-` と空白以外を 0x40 扱い（`fieldEdit.ts` の `NUMERIC_ONLY_EBCDIC`）
- F2: 英大文字 A〜Z は 37・273・290・1027 ほかでどれも C1〜C9・D1〜D9・E2〜E9。英小文字は 290 で別のバイト
- F3: 関連付けプリンターの残りは ACS の画面の層（`SessionManager`・`AssociatedPrinterSession5250`）で、`acs-probe` の ECL のコアでは動かない
- F4: SAVE SCREEN の応答の中身は退避した時点の画面（`wtd-applier.ts` の `saveRequests` の depth）。応答の順の差は、1 本のレコードに応答の要るコマンドが複数あるときだけ

## 実装アンカー
- A1: `packages/web-ui/src/composables/fieldEdit.ts` `fieldSign`
