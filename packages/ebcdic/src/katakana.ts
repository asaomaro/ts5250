/**
 * `@as400web/ebcdic/katakana` の入口。**CCSID 930 の SBCS 部だけ**に依存する。
 *
 * ACS の表示コード切替（半角カナ ⇔ 英小文字）を再現するためだけの 1 関数で、
 * ブラウザの画面描画から 1 桁ごとに同期呼び出しされる。
 *
 * **`codec.js` から独立させてある理由はバンドルサイズ。** 元はこの関数が
 * `codec.ts` に同居しており、そのせいで web-ui の本番バンドルに
 * ibm930 / ibm939 の変換表が丸ごと（DBCS 部込みで約 600 KB）入っていた。
 * 実際に読むのは `ibm930Sbcs.ebcdicToUnicode` の 256 要素だけなのに、
 * bundler が落とせるのはモジュール単位だから運ばれていた。
 *
 * **ここから `codec.js` や `*-dbcs.js` を import しないこと。** した瞬間に元へ戻り、
 * しかも**型検査もテストもビルドも通る**——サイズを見ていなければ誰も気づかない。
 * 到達可能性は `test/katakana-no-dbcs.test.ts` が機械的に検査している。
 */
import { ibm930Sbcs } from "./tables/ibm930-sbcs.js";

/**
 * 生 EBCDIC バイトをカタカナ SBCS（CCSID 930 の SBCS 部）で再解釈する。
 * ACS の表示コード切替（半角カナ⇔英小文字）用。英小文字位置がカタカナに化ける。
 */
export function katakanaChar(byte: number): string {
  return String.fromCharCode(ibm930Sbcs.ebcdicToUnicode[byte & 0xff] ?? 0xfffd);
}
