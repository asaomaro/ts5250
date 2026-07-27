/**
 * `@as400web/core/codec` サブパスの後方互換ファサード。
 *
 * 実体は **`@as400web/ebcdic`** に移した（EBCDIC の変換は TN5250 と独立に価値があるため）。
 * このファイルは `package.json` の `exports["./codec"] → ./dist/codec/codec.js` という
 * マッピングを保つためだけに在る。**新しいコードは `@as400web/ebcdic` を直接使うこと。**
 *
 * ここを消したり `exports` を書き換えたりすると、既存の利用側が黙って壊れる:
 *   - `packages/server/src/host-dtaq.ts` — `codecForCcsid`
 *
 * **ブラウザからはここを使わない。** この入口は CCSID 930/939/1399 の変換表を
 * DBCS 部込みで引き込む（実測で web-ui のバンドルが約 1.1 MB 膨らむ）。
 * 半角カナ表示だけが要る web-ui は `@as400web/core/browser` の `katakanaChar` を使う
 * （`20260726-ccsid-table-bundling`）。ここの `katakanaChar` は後方互換のために残してある。
 *
 * **`export *` は使わない。** 再輸出を機械的に広げると、何が外に出ているのかが
 * 目視できなくなる——`As400Error` の改名時に re-export の一括置換で旧名が外へ出なく
 * なった事故（`20260719-core-debt-payoff`）と同じ轍を踏まないため、公開面は列挙する。
 * 到達可能性は `test/codec-reexport.test.ts` が実行時に検査している。
 *
 * **参照先はバレル（`@as400web/ebcdic`）ではなく `/codec` サブパス。** 分割前の
 * このサブパスは `codec.ts` 1 モジュールだけを指しており、バレルに向けると
 * `pure-dbcs` / `ccsid-text` まで module graph に入って web-ui のバンドルが
 * 628 バイト増えた（実測。`decisions.md` D2）。狭い入口を狭いまま保つ。
 */
export {
  SbcsCodec,
  DbcsCodec,
  codecForCcsid,
  katakanaChar,
  SO,
  SI,
  type Codec
} from "@as400web/ebcdic/codec";
