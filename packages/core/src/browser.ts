/**
 * ブラウザから安全に import できる純粋な部品だけを集めた入口。
 *
 * **root（`@as400web/core`）は使えない**——`log.js`(pino) と `transport/`(`node:net`/`node:tls`) を
 * 巻き込むため、バンドラが node 組み込みを externalize し、実行時に落ちる
 * （AGENTS.md の codec サブパスと同じ理由）。
 *
 * ここに置いてよいのは **`node:*` にも I/O にも触れないもの**に限る。
 */
export { parseCsv, type CsvParseResult } from "./csv-parse.js";
export {
  assertIdentifier,
  isValidIdentifier,
  IDENTIFIER_PATTERN
} from "./identifier.js";
