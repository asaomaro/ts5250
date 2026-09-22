/**
 * **セッション寿命の組合せ表**（`20260908-session-lifetime-rules-fold` AC4）。
 *
 * 端末種別 × 切れ方 × viewer の有無 × 接続の役割 の全組合せに対する、
 * **現行の振る舞い**を書き出したもの。`session-lifetime-matrix.test.ts`（サーバー／クライアントの
 * 2 本）がここから回る。**期待値は畳み込みの前に現行実装で埋めてある**——後から書くと
 * 畳み込み後のコードに合わせた期待値になり、安全網として機能しないため
 * （`architecture.md`「tasks への申し送り」）。
 *
 * **なぜ web-ui/test に置くか。** サーバーとクライアントの両方から読む必要があるが、
 * 向きは一方しか成立しない——`packages/web-ui` は `tsconfig.test.json` が `composite: true` で
 * `include: ["src","test"]` なので、その外のファイルを取り込めない。逆にサーバーのテストは
 * 型検査の対象外（`packages/server/tsconfig.json` の `include` が `["src"]`）なので、
 * ここから相対パスで読める。**プロダクトコードでは通さない依存の向き**だが、
 * テスト専用のデータに限って許す（`architecture.md` A4）。
 *
 * **表を 2 つに割らないこと。** 複製すると「片方だけ更新される」が必ず起きる。
 * サーバーとクライアントで見える軸が違うぶんは `clientViewOf()` の射影で吸収する。
 *
 * 出所は `20260908-session-lifetime-rules-fold/research.md` の Q4（一次資料は `90f5636f` 時点の実装）。
 */

/** 端末種別。5250 とプリンターは同じ `sessionId` に載る（research F5） */
export type Terminal = "5250" | "3270" | "vt" | "printer";

/**
 * 切れ方。**`transportLost` と `heartbeatDead` は `dispose` に同じ引数で入る**ので
 * サーバーの結論は同じだが、**経路が別**なので行を分けて固定する（research Q4）。
 * `hostEnded` は `dispose` を通らない別経路。
 */
export type Disconnect = "clientClose" | "transportLost" | "heartbeatDead" | "hostEnded";

/**
 * この接続がセッションに対して持つ役割。
 *
 * **「見に来ただけ（viewer）× 持ち主」は起こり得ない**——`resume` 無しの attach は `claim` を
 * 呼ばないため（research F8）。逆に「open したのに持ち主でない」も起こり得ない。
 * その 2 つを型で潰してあるので、この 4 値に不到達の組合せは無い。
 */
export type Role =
  | "owner" //              いま自分が持ち主（open / resume 付き attach）
  | "handedOverPresent" //  交代済みで、後任がまだ居る
  | "handedOverAbsent" //   交代済みで、いま持ち主が誰も居ない
  | "viewer"; //            見に来ただけ（resume 無しの attach）

/** サーバー側の結論 */
export type ServerOutcome =
  | "close" //          その場でホストセッションを閉じる
  | "hold" //           猶予に入れる（既定 90 秒）
  | "keep" //           何もしない（閉じない・猶予にも入れない）
  | "entryRemoved" //   ホスト側の終了でエントリごと消える（`ended: true` を送る）
  | "hostReconnect" //  ホストに切られて自動で繋ぎ直す。エントリは残り `closed` は出ない（`20260921-auto-reconnect`）
  | "printerError" //   非常駐プリンター: エントリは残り state="error"
  | "printerRetry" //   常駐プリンター: 待ち受けを張り直す
  | "nothing"; //       何も起きない（3270 のホスト終了。通知もエントリ削除も無い）

/** クライアント側の結論 */
export type ClientOutcome =
  | "reconnect" //        5 段のはしごを回す
  | "connectionLost" //   繋ぎ直さず「接続が切れました」を出す
  | "silent" //           通知を出さない（次の打鍵で理由が出る）
  | "vtNotice" //         VT 専用の経路（closeReason を優先）
  | "printerState" //     プリンターの state だけが更新される（転送は生きたまま）
  | "nothing" //          **クライアントには何も届かない**
  | "notStarted"; //      利用者が閉じた後なので繋ぎ直しに入らない（セッションが既に無い）

export interface ServerCase {
  readonly id: string;
  readonly terminal: Terminal;
  readonly disconnect: Disconnect;
  /** 3270 / VT には役割の軸が無い（`claim` を打たない。research F5） */
  readonly role: Role | "n/a";
  /** 他に見ている接続が残っているか。**プリンターは viewers を数えない**（research F6） */
  readonly otherViewer: boolean | "n/a";
  /** 常駐プリンターか。プリンター以外に軸は無い */
  readonly resident: boolean | "n/a";
  readonly outcome: ServerOutcome;
  /** なぜその結論になるか（research の項目 ID） */
  readonly why: string;
}

export interface ClientCase {
  readonly id: string;
  readonly terminal: Terminal;
  readonly disconnect: Disconnect;
  /** 見に来ただけのタブか（サーバー側の `role === "viewer"` に対応） */
  readonly attachedOnly: boolean;
  readonly outcome: ClientOutcome;
  readonly why: string;
}

const S = (
  id: string,
  terminal: Terminal,
  disconnect: Disconnect,
  role: Role | "n/a",
  otherViewer: boolean | "n/a",
  resident: boolean | "n/a",
  outcome: ServerOutcome,
  why: string
): ServerCase => ({ id, terminal, disconnect, role, otherViewer, resident, outcome, why });

/**
 * **サーバー側の全組合せ**（64 行）。
 *
 * 5250: 役割 4 × viewer 2 × 切れ方 4 ＝ 32 /
 * プリンター: 役割 3 × 常駐 2 × 切れ方 4 ＝ 24（viewer の軸が無い）/
 * 3270: 切れ方 4 / VT: 切れ方 4。
 */
export const SERVER_CASES: readonly ServerCase[] = [
  // ---- 5250 表示セッション: 利用者が閉じた（close メッセージ） ----
  S("5250/close/owner/noViewer", "5250", "clientClose", "owner", false, "n/a", "close", "research Q4 #1"),
  S("5250/close/owner/viewer", "5250", "clientClose", "owner", true, "n/a", "keep", "research Q4 #2（ゲート1）"),
  S("5250/close/handedPresent/noViewer", "5250", "clientClose", "handedOverPresent", false, "n/a", "keep", "research Q4 #3（ゲート2）"),
  S("5250/close/handedPresent/viewer", "5250", "clientClose", "handedOverPresent", true, "n/a", "keep", "research Q4 #4"),
  S("5250/close/handedAbsent/noViewer", "5250", "clientClose", "handedOverAbsent", false, "n/a", "close", "research Q4 #5（自分が最後の 1 人）"),
  S("5250/close/handedAbsent/viewer", "5250", "clientClose", "handedOverAbsent", true, "n/a", "keep", "research Q4 #6"),
  S("5250/close/viewer/noViewer", "5250", "clientClose", "viewer", false, "n/a", "keep", "research Q4 #7（見に来た人は殺さない）"),
  S("5250/close/viewer/viewer", "5250", "clientClose", "viewer", true, "n/a", "keep", "research Q4 #8"),

  // ---- 5250: 転送断（onSocketClose） ----
  S("5250/transport/owner/noViewer", "5250", "transportLost", "owner", false, "n/a", "hold", "research Q4 #1（90 秒猶予）"),
  S("5250/transport/owner/viewer", "5250", "transportLost", "owner", true, "n/a", "keep", "research Q4 #2"),
  S("5250/transport/handedPresent/noViewer", "5250", "transportLost", "handedOverPresent", false, "n/a", "keep", "research Q4 #3"),
  S("5250/transport/handedPresent/viewer", "5250", "transportLost", "handedOverPresent", true, "n/a", "keep", "research Q4 #4"),
  S("5250/transport/handedAbsent/noViewer", "5250", "transportLost", "handedOverAbsent", false, "n/a", "hold", "research Q4 #5（穴 F15-(2)）"),
  S("5250/transport/handedAbsent/viewer", "5250", "transportLost", "handedOverAbsent", true, "n/a", "keep", "research Q4 #6"),
  S("5250/transport/viewer/noViewer", "5250", "transportLost", "viewer", false, "n/a", "keep", "research Q4 #7"),
  S("5250/transport/viewer/viewer", "5250", "transportLost", "viewer", true, "n/a", "keep", "research Q4 #8"),

  // ---- 5250: 心拍の死判定（転送断と同じ引数・別経路） ----
  S("5250/hbdead/owner/noViewer", "5250", "heartbeatDead", "owner", false, "n/a", "hold", "research Q4 #1（(b) と同一）"),
  S("5250/hbdead/owner/viewer", "5250", "heartbeatDead", "owner", true, "n/a", "keep", "research Q4 #2（穴 F15-(4)）"),
  S("5250/hbdead/handedPresent/noViewer", "5250", "heartbeatDead", "handedOverPresent", false, "n/a", "keep", "research Q4 #3"),
  S("5250/hbdead/handedPresent/viewer", "5250", "heartbeatDead", "handedOverPresent", true, "n/a", "keep", "research Q4 #4"),
  S("5250/hbdead/handedAbsent/noViewer", "5250", "heartbeatDead", "handedOverAbsent", false, "n/a", "hold", "research Q4 #5"),
  S("5250/hbdead/handedAbsent/viewer", "5250", "heartbeatDead", "handedOverAbsent", true, "n/a", "keep", "research Q4 #6"),
  S("5250/hbdead/viewer/noViewer", "5250", "heartbeatDead", "viewer", false, "n/a", "keep", "research Q4 #7"),
  S("5250/hbdead/viewer/viewer", "5250", "heartbeatDead", "viewer", true, "n/a", "keep", "research Q4 #8"),

  // ---- 5250: ホスト側の終了（dispose を通らない） ----
  // **ブラウザから開いた端末は繋ぎ直す**（`20260921-auto-reconnect`。ACS と同じ）。エントリは残り `closed` は出ない。
  // ~~役割・viewer に依らずエントリ削除（research F9）~~ は、自動再接続を入れる前の事実。
  // 「見に来ただけ（viewer）」の行は **MCP が開いたセッション**（自動再接続なし）を見に来る形なので、エントリ削除のまま
  S("5250/hostEnded/owner/noViewer", "5250", "hostEnded", "owner", false, "n/a", "hostReconnect", "20260921-auto-reconnect（ブラウザから開いた端末）"),
  S("5250/hostEnded/owner/viewer", "5250", "hostEnded", "owner", true, "n/a", "hostReconnect", "20260921-auto-reconnect（ブラウザから開いた端末）"),
  S("5250/hostEnded/handedPresent/noViewer", "5250", "hostEnded", "handedOverPresent", false, "n/a", "hostReconnect", "20260921-auto-reconnect（ブラウザから開いた端末）"),
  S("5250/hostEnded/handedPresent/viewer", "5250", "hostEnded", "handedOverPresent", true, "n/a", "hostReconnect", "20260921-auto-reconnect（ブラウザから開いた端末）"),
  S("5250/hostEnded/handedAbsent/noViewer", "5250", "hostEnded", "handedOverAbsent", false, "n/a", "hostReconnect", "20260921-auto-reconnect（ブラウザから開いた端末）"),
  S("5250/hostEnded/handedAbsent/viewer", "5250", "hostEnded", "handedOverAbsent", true, "n/a", "hostReconnect", "20260921-auto-reconnect（ブラウザから開いた端末）"),
  S("5250/hostEnded/viewer/noViewer", "5250", "hostEnded", "viewer", false, "n/a", "entryRemoved", "research F9"),
  S("5250/hostEnded/viewer/viewer", "5250", "hostEnded", "viewer", true, "n/a", "entryRemoved", "research F9"),

  // ---- プリンター（非常駐）。viewers を数えないので otherViewer は "n/a" ----
  S("prt/close/owner/transient", "printer", "clientClose", "owner", "n/a", false, "close", "research Q4 プリンター表"),
  S("prt/close/handedPresent/transient", "printer", "clientClose", "handedOverPresent", "n/a", false, "keep", "research Q4（保持者ガード）"),
  S("prt/close/handedAbsent/transient", "printer", "clientClose", "handedOverAbsent", "n/a", false, "close", "research Q4"),
  S("prt/transport/owner/transient", "printer", "transportLost", "owner", "n/a", false, "close", "research F7（猶予は表示専用）"),
  S("prt/transport/handedPresent/transient", "printer", "transportLost", "handedOverPresent", "n/a", false, "keep", "research Q4"),
  S("prt/transport/handedAbsent/transient", "printer", "transportLost", "handedOverAbsent", "n/a", false, "close", "research Q4"),
  S("prt/hbdead/owner/transient", "printer", "heartbeatDead", "owner", "n/a", false, "close", "research Q4"),
  S("prt/hbdead/handedPresent/transient", "printer", "heartbeatDead", "handedOverPresent", "n/a", false, "keep", "research Q4"),
  S("prt/hbdead/handedAbsent/transient", "printer", "heartbeatDead", "handedOverAbsent", "n/a", false, "close", "research Q4"),
  S("prt/hostEnded/owner/transient", "printer", "hostEnded", "owner", "n/a", false, "printerError", "research F9（printers からは消さない）"),
  S("prt/hostEnded/handedPresent/transient", "printer", "hostEnded", "handedOverPresent", "n/a", false, "printerError", "research F9"),
  S("prt/hostEnded/handedAbsent/transient", "printer", "hostEnded", "handedOverAbsent", "n/a", false, "printerError", "research F9"),

  // ---- プリンター（常駐）。役割に依らず閉じない ----
  S("prt/close/owner/resident", "printer", "clientClose", "owner", "n/a", true, "keep", "research Q4（isResident。穴 F15-(1)）"),
  S("prt/close/handedPresent/resident", "printer", "clientClose", "handedOverPresent", "n/a", true, "keep", "research Q4"),
  S("prt/close/handedAbsent/resident", "printer", "clientClose", "handedOverAbsent", "n/a", true, "keep", "research Q4"),
  S("prt/transport/owner/resident", "printer", "transportLost", "owner", "n/a", true, "keep", "research Q4"),
  S("prt/transport/handedPresent/resident", "printer", "transportLost", "handedOverPresent", "n/a", true, "keep", "research Q4"),
  S("prt/transport/handedAbsent/resident", "printer", "transportLost", "handedOverAbsent", "n/a", true, "keep", "research Q4"),
  S("prt/hbdead/owner/resident", "printer", "heartbeatDead", "owner", "n/a", true, "keep", "research Q4"),
  S("prt/hbdead/handedPresent/resident", "printer", "heartbeatDead", "handedOverPresent", "n/a", true, "keep", "research Q4"),
  S("prt/hbdead/handedAbsent/resident", "printer", "heartbeatDead", "handedOverAbsent", "n/a", true, "keep", "research Q4"),
  S("prt/hostEnded/owner/resident", "printer", "hostEnded", "owner", "n/a", true, "printerRetry", "research F9（reconnectPrinter）"),
  S("prt/hostEnded/handedPresent/resident", "printer", "hostEnded", "handedOverPresent", "n/a", true, "printerRetry", "research F9"),
  S("prt/hostEnded/handedAbsent/resident", "printer", "hostEnded", "handedOverAbsent", "n/a", true, "printerRetry", "research F9"),

  // ---- 3270: 役割・viewer の軸が無い。**dispose を通る 3 つは常に閉じる**が、ホスト終了は別経路 ----
  S("3270/close", "3270", "clientClose", "n/a", "n/a", "n/a", "close", "research F5（条件を見ずに閉じる）"),
  S("3270/transport", "3270", "transportLost", "n/a", "n/a", "n/a", "close", "research F5"),
  S("3270/hbdead", "3270", "heartbeatDead", "n/a", "n/a", "n/a", "close", "research F5"),
  S("3270/hostEnded", "3270", "hostEnded", "n/a", "n/a", "n/a", "nothing", "research F9（購読が無い。バグに見えるが対象外）"),

  // ---- VT: 役割・viewer の軸が無い。**dispose を通る 3 つは常に閉じる**。ホスト終了は vt-manager が削除 ----
  S("vt/close", "vt", "clientClose", "n/a", "n/a", "n/a", "close", "research F5"),
  S("vt/transport", "vt", "transportLost", "n/a", "n/a", "n/a", "close", "research F5"),
  S("vt/hbdead", "vt", "heartbeatDead", "n/a", "n/a", "n/a", "close", "research F5"),
  S("vt/hostEnded", "vt", "hostEnded", "n/a", "n/a", "n/a", "entryRemoved", "research F9（vt-manager が削除）")
];

const C = (
  terminal: Terminal,
  disconnect: Disconnect,
  attachedOnly: boolean,
  outcome: ClientOutcome,
  why: string
): ClientCase => ({ id: clientKey(terminal, disconnect, attachedOnly), terminal, disconnect, attachedOnly, outcome, why });

/**
 * **クライアント側の全組合せ**（20 行）。
 *
 * クライアントは役割も viewer 数も見えないので、軸は
 * 端末種別 × 切れ方 × 「見に来ただけか」に縮む。`clientViewOf()` がその射影を与える。
 */
export const CLIENT_CASES: readonly ClientCase[] = [
  // 5250・自分が開いた（または resume で引き取った）タブ
  C("5250", "clientClose", false, "notStarted", "利用者が閉じた後はセッションが無い（session-controller:276）"),
  C("5250", "transportLost", false, "reconnect", "4 門をすべて通過（research F3）"),
  C("5250", "heartbeatDead", false, "reconnect", "ping 見張り → ws.close() → 同じ onClose"),
  C("5250", "hostEnded", false, "silent", "**WS は閉じない**ので startReconnect に入らない。closed{ended:true} で endedByHost を立て connected=false にするだけ（session-controller:548-559）"),
  // 5250・見に来ただけのタブ（門1 で弾かれる。**門の順序が観測できるのは CLIENT_ORDER_CASES だけ**）
  C("5250", "clientClose", true, "notStarted", "同上"),
  C("5250", "transportLost", true, "connectionLost", "門1（attachedOnly）"),
  C("5250", "heartbeatDead", true, "connectionLost", "門1"),
  C("5250", "hostEnded", true, "silent", "**見に来ただけのタブも同じ購読を張る**（ws-handler:919 → :857-865）ので owner と同じ。WS は閉じないので門を通らない"),
  // 3270（門1 の meta.terminal で弾かれる）
  C("3270", "clientClose", false, "notStarted", "同上"),
  C("3270", "transportLost", false, "connectionLost", "門1（meta.terminal === \"3270\"）"),
  C("3270", "heartbeatDead", false, "connectionLost", "門1"),
  C("3270", "hostEnded", false, "nothing", "**サーバーが購読していない**（tn3270-manager.ts:78）ので closed も送られず WS も閉じない。クライアントは終了を知る手段が無い"),
  // VT（startReconnect を通らない専用経路）
  C("vt", "clientClose", false, "notStarted", "専用 onClose の早期 return（session-controller:762）。startReconnect は通らない"),
  C("vt", "transportLost", false, "vtNotice", "session-controller:760-766（closeReason を優先）"),
  C("vt", "heartbeatDead", false, "vtNotice", "同上"),
  C("vt", "hostEnded", false, "vtNotice", "closed{ended:true}（ws-handler:631）→ vtStore.setConnected(false, msg.reason)。**onClose ではなく closed 経由**（session-controller:735-741）"),
  // プリンター（専用 onClose。門1 は保険）
  C("printer", "clientClose", false, "notStarted", "専用 onClose の早期 return（session-controller:931）。startReconnect は通らない"),
  C("printer", "transportLost", false, "connectionLost", "session-controller:929-934"),
  C("printer", "heartbeatDead", false, "connectionLost", "同上"),
  C("printer", "hostEnded", false, "printerState", "**WS は閉じない**。printer-state の push で state='error'（常駐なら reconnecting）になるだけで、connected は true のまま（session-controller:887-902）")
];

/**
 * **クライアント専用の順序ケース**（D13。サーバーの行から射影できないので別に持つ）。
 *
 * ホスト終了は WS を閉じないので、上の表の `hostEnded` 行では `startReconnect` の門を通らない。
 * **門の順序が効くのは「ホストが終わったあとに転送も落ちた」とき**で、これは切れ方が 1 つではなく
 * 2 つ続いた状況——単一の切れ方を軸にした上の表には収まらない。
 */
export const CLIENT_ORDER_CASES: readonly ClientCase[] = [
  {
    id: "5250/hostEnded+transport/owner",
    terminal: "5250",
    disconnect: "transportLost",
    attachedOnly: false,
    outcome: "silent",
    why: "門2（endedByHost。session-controller:305）で黙って戻る。次の打鍵の MSG_SESSION_ENDED は refuseIfDisconnected:152 が出す"
  },
  {
    id: "5250/hostEnded+transport/viewer",
    terminal: "5250",
    disconnect: "transportLost",
    attachedOnly: true,
    outcome: "connectionLost",
    why: "**門1 が門2 より先に効く**——endedByHost が立っていても通知は MSG_CONNECTION_LOST（session-controller:299 vs :305）"
  }
];

/** 表の行キー（両側の突き合わせに使う） */
export function clientKey(terminal: Terminal, disconnect: Disconnect, attachedOnly: boolean): string {
  return `${terminal}/${disconnect}/${attachedOnly ? "viewer" : "owner"}`;
}

/**
 * サーバーの行を、**クライアントから見える形へ射影する**。
 *
 * これが「表は 1 つ」を成立させている——サーバー側にしかない軸（役割・viewer 数）を
 * 落として突き合わせるので、**片方に無い組合せがあれば機械的に分かる**。
 */
export function clientViewOf(c: ServerCase): string {
  return clientKey(c.terminal, c.disconnect, c.role === "viewer");
}
