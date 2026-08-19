/**
 * `@ts5250/tn3270` — IBM メインフレーム向け TN3270（基本 TN3270 / RFC 1576）。
 *
 * **`@ts5250/tn5250` とは同位で、互いに依存しない**（`dependency-direction.test.ts` が検査）。
 * 5250 と 3270 は telnet の枠組みこそ似ているが、合意するオプションもレコード構造も別物
 * （5250 は SGA / NEW-ENVIRON と GDS ヘッダを持つが、3270 はどちらも持たない）。
 *
 * ブラウザからは `@ts5250/tn3270/browser` を使う（root は `node:net` / `node:tls` を含む）。
 */
export * from "./browser.js";

// Node 専用（node:net / node:tls）
export { TcpTransport, type TcpConnectOptions } from "./transport/tcp.js";
export { TelnetLayer, type TelnetOptions } from "./telnet/telnet.js";
export { IAC, CMD, OPT, TT_IS, TT_SEND } from "./telnet/constants.js";
export {
  Tn3270Session,
  type Connect3270Options,
  type SessionState
} from "./session/session.js";
