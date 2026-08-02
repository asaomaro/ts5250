/**
 * `@ts5250/ebcdic/catalog` の入口。**変換表を一切引き込まない**入口。
 *
 * ブラウザの UI が文字コードの選択肢を組み立てるためだけの一覧なので、
 * `codec.js`（EBCDIC の変換表を計 18,900 行・約 1.17 MB 同梱する）へ到達させない。
 * 復号・符号化そのものが要るならルート（`@ts5250/ebcdic`）を使う。
 *
 * **この分離は維持すること。** ここから `codec.js` / `ccsid-text.js` / `tables/` を
 * import した瞬間、それを使う側のバンドルに表が丸ごと入る——そして**型検査も
 * テストもビルドも通ってしまう**ため、壊れても気づけない。到達可能性は
 * `test/catalog-no-tables.test.ts` が機械的に検査している。
 */
export { TEXT_CCSIDS, ccsidLabel } from "./ccsid-catalog.js";
export type { LineEnding } from "./ccsid-catalog.js";
