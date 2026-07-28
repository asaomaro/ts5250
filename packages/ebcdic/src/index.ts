/**
 * `@as400web/ebcdic` の入口。IBM i の EBCDIC ⇔ Unicode 変換を、**外部依存ゼロ**で提供する。
 *
 * SBCS（37 / 273 / 290 / 1027）・SO/SI 付きの混在 DBCS（930 / 939 / 1399 とエイリアス）・
 * 純 DBCS（300 / 16684）に対応し、CCSID を指定したテキスト復号/符号化の入口も持つ。
 *
 * **この入口は全部入りのバレル**で、変換表（計 18,900 行）に加えて純 DBCS・CCSID テキストも
 * 引き込む。バンドルサイズが効く利用側は、必要な範囲だけの狭い入口を使うこと:
 *
 * | 入口 | 中身 | 用途 |
 * |---|---|---|
 * | `@as400web/ebcdic` | 全部 | サーバー側・使う範囲が広いとき |
 * | `@as400web/ebcdic/codec` | SBCS/DBCS の変換だけ（**5 表すべて入る**） | 変換だけが要るとき |
 * | `@as400web/ebcdic/katakana` | `katakanaChar` / `latinChar` だけ（**930・939 の SBCS 部のみ**） | ブラウザの表示コード切替 |
 * | `@as400web/ebcdic/catalog` | CCSID の一覧だけ（**表ゼロ**） | ブラウザの選択 UI |
 *
 * バレル経由だと bundler の解析が及ばず、要らない部分まで残ることがある——実測で
 * `@as400web/core/codec` をこのバレルに向けた版は、狭い入口に向けた版より
 * web-ui のバンドルが 628 バイト大きかった（`decisions.md` D2）。
 */

// 文字変換（SBCS / DBCS）
export {
  SbcsCodec,
  DbcsCodec,
  codecForCcsid,
  katakanaChar,
  latinChar,
  SO,
  SI,
  type Codec
} from "./codec.js";
export type { SbcsTable, StatefulTable, DbcsPart, PureDbcsTable } from "./table-types.js";

// 純 DBCS（GRAPHIC 列。SO/SI を持たず 2 バイト固定）
export {
  PureDbcsCodec,
  pureDbcsCodecForCcsid,
  isPureDbcsCcsid,
  ibm16684,
  ibm300
} from "./pure-dbcs.js";

// CCSID 指定のテキスト復号・符号化（EBCDIC 表と TextDecoder の両方を束ねる入口）
export {
  canDecodeCcsid,
  canEncodeCcsid,
  decodeCcsidText,
  encodeCcsidText,
  isEbcdicCcsid,
  TEXT_CCSIDS,
  ccsidLabel,
  type CcsidText,
  type LineEnding
} from "./ccsid-text.js";
