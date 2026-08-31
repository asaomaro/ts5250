/**
 * `@ts5250/ebcdic/katakana` の入口。**日本語 SBCS 2 表の「表示コード切替」だけ**に依存する。
 *
 * ACS の表示コード切替（半角カナ ⇔ 英小文字）を再現するためだけの 2 関数で、
 * ブラウザの画面描画から 1 桁ごとに同期呼び出しされる。
 *
 * **切り替えとは「もう一方の表で読み直すこと」**——CCSID 930 の SBCS 部（CP290）と
 * 939 の SBCS 部（CP1027）は互いの鏡像で、カタカナと英小文字の位置が入れ替わっている
 * （例: `0x81` は 930 で `ｱ`・939 で `a`／`0x62` は 930 で `a`・939 で `ｲ`）。
 * だから**両方の表が要る**。930 の表しか持たないと、ホストが 930 のセッションでは
 * 「再解釈しても同じ結果」になり、切替が無反応になる（利用者報告で判明）。
 *
 * **`codec.js` から独立させてある理由はバンドルサイズ。** 元はこの関数が
 * `codec.ts` に同居しており、そのせいで web-ui の本番バンドルに
 * ibm930 / ibm939 の変換表が丸ごと（DBCS 部込みで約 600 KB）入っていた。
 * 実際に読むのは各表の `ebcdicToUnicode` 256 要素だけなのに、
 * bundler が落とせるのはモジュール単位だから運ばれていた。
 *
 * **ここから `codec.js` や `*-dbcs.js` を import しないこと。** した瞬間に元へ戻り、
 * しかも**型検査もテストもビルドも通る**——サイズを見ていなければ誰も気づかない。
 * 到達可能性は `test/katakana-no-dbcs.test.ts` が機械的に検査している
 * （SBCS 部 2 つを読むようになっても、上限は据え置きで収まる）。
 */
import { ibm930Sbcs } from "./tables/ibm930-sbcs.js";
import { ibm939Sbcs } from "./tables/ibm939-sbcs.js";

/**
 * 生 EBCDIC バイトをカタカナ SBCS（CCSID 930 の SBCS 部＝CP290）で再解釈する。
 * ACS の表示コード切替（半角カナ⇔英小文字）用。英小文字位置がカタカナに化ける。
 */
export function katakanaChar(byte: number): string {
  return String.fromCharCode(ibm930Sbcs.ebcdicToUnicode[byte & 0xff] ?? 0xfffd);
}

/**
 * 生 EBCDIC バイトを英小文字 SBCS（CCSID 939 の SBCS 部＝CP1027）で再解釈する。
 * `katakanaChar` の対。**カタカナ系ホスト（930/5026）で「英」表示にするときに使う**——
 * そちらはセッションのコーデックが既にカタカナ表なので、英字はこの表でしか出せない。
 */
export function latinChar(byte: number): string {
  return String.fromCharCode(ibm939Sbcs.ebcdicToUnicode[byte & 0xff] ?? 0xfffd);
}

/**
 * その CCSID の SBCS 部が**カタカナ側の表**（CP290）か。
 *
 * 「そのまま復号した字がカナと英のどちらの読みか」を決めるのはこれ 1 つで、
 * 画面・保存 HTML・帳票のすべてが同じ答えを使う。**2 表がここに住んでいるので、
 * どちらを使っているかの判定もここに置く**——別の場所に書き写すと必ずずれる。
 */
export function isKatakanaCcsid(ccsid: number | undefined): boolean {
  return ccsid === 930 || ccsid === 5026;
}
