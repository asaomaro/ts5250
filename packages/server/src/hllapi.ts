/**
 * HLLAPI / EHLLAPI の**意味づけ**——機能番号の分岐はここが唯一の場所。
 *
 * ## なぜロジックが TypeScript にあるのか
 *
 * 接続層（Rust の cdylib）は **C ABI ↔ HTTP** だけを担う。機能番号が何を意味するか、
 * PS をどう走査するか、どの `rc` を返すかは**一切 Rust に置かない**。
 * こうすると、対応する機能を増やすのも直すのも TypeScript 側だけで済み、
 * 利用者が再ビルドするネイティブの部品を触らずに更新できる。
 *
 * ## 状態はここが持つ
 *
 * HLLAPI は `A`〜`Z` の短縮名でセッションを指し、`Set Cursor` → `Send Key` のように
 * **呼び出しをまたいでカーソルを使う**。この状態を持つのはここ
 * （要件「Rust 側に状態を持たない」）。
 *
 * ## 未実装は黙って成功にしない
 *
 * 分岐の**既定が `HRC.FUNCTION_UNAVAILABLE`(10)**。機能を足し忘れても
 * 「成功したのに何も起きない」にはならない。10 は規約にある値（research F3）。
 */
import { As400Error } from "@ts5250/base";
import { audit } from "./audit.js";
import type { Field, ScreenSnapshot } from "@ts5250/tn5250";
import type { AuthUser } from "./auth.js";
import type { SessionEntry, SessionManager } from "./session-manager.js";
import { HF, HRC, type HllapiRequest, type HllapiResponse } from "./hllapi-types.js";
import { hasUnsupported, parseMnemonics, type AidKey, type LocalAction } from "./hllapi-keys.js";
import {
  fieldAt,
  fieldBytes,
  fieldStart,
  isInputField,
  nextInputField,
  posToRowCol,
  prevInputField,
  psBytes,
  psLength,
  psSearch,
  psSlice,
  rowColToPos
} from "./hllapi-ps.js";
import { decodeCp932, encodeCp932 } from "./hllapi-cp932.js";

/** 短縮名 1 文字（`A`〜`Z`） */
type PsName = string;

/** HLLAPI の接続 1 つぶん。**Rust ではなくここが持つ** */
interface Connection {
  sessionId: string;
  /** 論理カーソル（1 起点の通し番号）。`Set Cursor` と移動ニーモニックで動く */
  cursor: number;
}

/**
 * 呼び出しをまたいで残る状態。
 *
 * **プロセス内で 1 つ**（`SessionManager` と同じ寿命）。
 * 認証が有効なら利用者ごとに分ける——他人のセッションへ短縮名で届かないようにする。
 */
export class HllapiState {
  private readonly byUser = new Map<string, Map<PsName, Connection>>();

  private keyOf(user?: AuthUser): string {
    return user?.username ?? "";
  }

  connections(user?: AuthUser): Map<PsName, Connection> {
    const k = this.keyOf(user);
    const found = this.byUser.get(k);
    if (found) return found;
    const created = new Map<PsName, Connection>();
    this.byUser.set(k, created);
    return created;
  }

  /**
   * 予約の持ち主としての識別子。
   *
   * **利用者ごとに 1 つ**——短縮名の対応表と同じ粒度にする。接続層は状態を持たないので、
   * 同じ利用者の HLLAPI 呼び出しは**別プロセスからでも同じ自動化の続き**として扱う
   * （実機で「別プロセスから Connect し直せる」ことを確認済み）。
   * プロセスごとに分けると、落ちて上がり直した自動化が自分の予約に弾かれる。
   */
  holderOf(user?: AuthUser): string {
    return `hllapi:${this.keyOf(user)}`;
  }
}

/** 予約中であることを利用者に見せる名前 */
export const HLLAPI_RESERVATION_LABEL = "HLLAPI";

/**
 * 画面に出す「誰が操作しているか」。
 *
 * **自分以外のセッションを触るときは、操作している人の名前を出す。**
 * 管理者は他人のセッションへ届く（`assertOwner` が admin を通す）。支援としては正当だが、
 * **触られた側に「HLLAPI が自動操作中です」としか出ないのは不親切で、無断操作の抑止にもならない**。
 *
 * 自分のセッションなら仕組みの名前だけ——自分の操作に自分の名前を出しても情報が無い。
 */
export function reservationLabel(entry: SessionEntry, user?: AuthUser): string {
  const crossUser = user !== undefined && entry.owner !== undefined && entry.owner !== user.username;
  return crossUser ? `${user.username}（${HLLAPI_RESERVATION_LABEL}）` : HLLAPI_RESERVATION_LABEL;
}

export interface HllapiDeps {
  sessions: SessionManager;
  state: HllapiState;
  /** テストから待ち時間を差し替える */
  sleep?: (ms: number) => Promise<void>;
}

/** Wait / Pause の上限。**無限に待たない**（HTTP の向こうで呼び出し側が固まる） */
const MAX_WAIT_MS = 30_000;
const POLL_MS = 100;

/** 成功。`bytes` があれば base64 にして返す */
const ok = (bytes?: Uint8Array): HllapiResponse => ({
  rc: HRC.SUCCESSFUL,
  ...(bytes !== undefined ? { dataB64: toB64(bytes), length: bytes.length } : {})
});

const toB64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

/** 要求のバッファを CP932 のバイト列として取り出す */
const reqBytes = (req: HllapiRequest): Uint8Array => fromB64(req.dataB64);
/** 要求のバッファを文字列として取り出す（短縮名・ニーモニック・入力文字） */
const reqText = (req: HllapiRequest): string => decodeCp932(reqBytes(req));

/** ASCII 文字列をそのままバイトにする（一覧などこちらが組み立てる応答用） */
const asciiBytes = (s: string): Uint8Array => encodeCp932(s).bytes;

function sizeOf(s: ScreenSnapshot): { rows: number; cols: number } {
  return { rows: s.rows, cols: s.cols };
}

/**
 * 機能番号で分岐する唯一の入口。
 *
 * **`data` の中身をログに出さない**——サインオン画面への入力が通るため（spec「秘密の扱い」）。
 */
export async function callHllapi(
  deps: HllapiDeps,
  req: HllapiRequest,
  user?: AuthUser
): Promise<HllapiResponse> {
  const conns = deps.state.connections(user);
  const res = await dispatch(deps, conns, req, user);
  auditIfWrite(deps, conns, req, res, user);
  return res;
}

/**
 * 画面を変えうる操作を**監査に載せる**。
 *
 * MCP は `withAudit` を 25 箇所、WebSocket は 12 箇所で通しているのに、
 * ここだけ素通しだった。**HLLAPI は管理者が他人のセッションへ届く経路**でもあるので
 * （`assertOwner` は admin を通し、`list` も admin には全件返す）、
 * 誰が誰のセッションを動かしたか残らないのはまずい。
 *
 * **バッファの中身は載せない**（サインオン画面への入力が通る）。
 * 載せるのは機能番号・`rc`・対象セッションと**その所有者**——
 * 所有者を出すのは、**自分以外のセッションを触ったこと**が読み取れるようにするため。
 */
const WRITES = new Set<number>([HF.CONNECT_PS, HF.SEND_KEY, HF.COPY_STRING_TO_PS, HF.COPY_STRING_TO_FIELD, HF.RESERVE, HF.RELEASE]);

function auditIfWrite(
  deps: HllapiDeps,
  conns: Map<PsName, Connection>,
  req: HllapiRequest,
  res: HllapiResponse,
  user?: AuthUser
): void {
  if (!WRITES.has(req.function)) return;
  const sessionId = [...conns.values()][0]?.sessionId;
  let owner: string | undefined;
  if (sessionId !== undefined) {
    try {
      owner = deps.sessions.get(sessionId, user).owner;
    } catch {
      // 消えていれば所有者は出せない。監査そのものは残す
    }
  }
  audit({
    op: `hllapi_${req.function}`,
    ...(sessionId !== undefined ? { sessionId } : {}),
    // **自分以外のセッションを触ったことが読み取れるように**、対象の所有者を key に載せる
    ...(owner !== undefined && owner !== user?.username ? { key: `owner=${owner}` } : {}),
    result: res.rc === HRC.SUCCESSFUL ? "ok" : "error",
    ...(res.rc === HRC.SUCCESSFUL ? {} : { code: `rc=${res.rc}` })
  });
}

async function dispatch(
  deps: HllapiDeps,
  conns: Map<PsName, Connection>,
  req: HllapiRequest,
  user?: AuthUser
): Promise<HllapiResponse> {

  switch (req.function) {
    case HF.CONNECT_PS:
      return connect(deps, conns, req, user);
    case HF.DISCONNECT_PS:
      return disconnect(deps, conns, req, user);
    case HF.QUERY_SESSIONS:
      return querySessions(deps, conns, user);
    case HF.QUERY_SYSTEM:
      return querySystem();
    case HF.CONVERT_POS_ROWCOL:
      // **セッションを要さない**（換算だけ）
      return convert(req);
    default:
      return withConnection(deps, conns, req, user);
  }
}

/** 接続を要する機能。**接続していなければ `rc=8`**（呼ぶ順序が違う） */
async function withConnection(
  deps: HllapiDeps,
  conns: Map<PsName, Connection>,
  req: HllapiRequest,
  user?: AuthUser
): Promise<HllapiResponse> {
  // 短縮名を明示しない機能は「現在の接続」を使う。**接続が 1 つも無ければ順序違い**
  const current = [...conns.entries()][0];
  if (!current) return { rc: HRC.PROCEDURE_ERROR };
  const [, conn] = current;

  let entry: SessionEntry;
  try {
    entry = deps.sessions.get(conn.sessionId, user);
  } catch {
    // セッションが消えている（閉じられた・期限切れ）
    return { rc: HRC.PS_ID_INVALID };
  }
  // **操作のたびに予約を延ばす。** 接続層は状態を持たないので、落ちた自動化は
  // `Release` を送れない。期限で自然に解けるようにしておき、生きている間は延ばす
  deps.sessions.touchReservation(conn.sessionId, deps.state.holderOf(user));
  const snapshot = entry.session.snapshot();

  switch (req.function) {
    case HF.RESERVE:
      return reserve(deps, entry, user);
    case HF.RELEASE:
      return release(deps, entry, user);
    case HF.SEND_KEY:
      return sendKey(deps, entry, conn, req, user);
    case HF.WAIT:
      return wait(deps, entry);
    case HF.PAUSE:
      return pause(deps, entry, req);
    case HF.COPY_PS:
      return copyPs(snapshot, req);
    case HF.COPY_PS_TO_STRING:
      return copyPsToString(snapshot, req, conn);
    case HF.SEARCH_PS:
      return searchPs(snapshot, req);
    case HF.QUERY_CURSOR_LOCATION:
      return queryCursor(snapshot);
    case HF.SET_CURSOR:
      return setCursor(snapshot, conn, req);
    case HF.COPY_STRING_TO_PS:
      return copyStringToPs(deps, entry, snapshot, conn, req, user);
    case HF.QUERY_SESSION_STATUS:
      return querySessionStatus(conns, conn, snapshot, req);
    case HF.SEARCH_FIELD:
      return searchField(snapshot, conn, req);
    case HF.FIND_FIELD_POSITION:
      return findFieldPosition(snapshot, conn, req);
    case HF.FIND_FIELD_LENGTH:
      return findFieldLength(snapshot, conn, req);
    case HF.COPY_FIELD_TO_STRING:
      return copyFieldToString(snapshot, conn, req);
    case HF.COPY_STRING_TO_FIELD:
      return copyStringToField(deps, entry, snapshot, conn, req, user);
    default:
      // **足し忘れはここに落ちる。** 黙って成功にしない
      return { rc: HRC.FUNCTION_UNAVAILABLE };
  }
}

// ---- 接続 ----

/**
 * Connect Presentation Space (1)。
 *
 * **新しいホストセッションを開かない。** HLLAPI の Connect は
 * 「既にあるエミュレーターの画面に繋ぐ」意味なので、開くのは ts5250 側の役目。
 * 対応するセッションが無ければ `rc=1`。
 */
function connect(
  deps: HllapiDeps,
  conns: Map<PsName, Connection>,
  req: HllapiRequest,
  user?: AuthUser
): HllapiResponse {
  // **`"A"` は標準どおり。`"A <指定>"` は ts5250 の拡張**——1 文字しか渡さない
  // 既存資産はそのまま動き、狙ったセッションを指したいときだけ後ろに足す
  //
  // **最初の NUL で切る。** 呼び出し側は固定長のバッファを渡してくるのが普通で
  // （VBA の `String * 64` や C の `char[64]`）、余りは NUL のまま届く。
  // `trim()` は NUL を落とさないので、これが無いと名前が `検証\0\0…` になって当たらない
  const raw = reqText(req).split("\0")[0]!.trim();
  const name = (raw[0] ?? "").toUpperCase();
  if (!/^[A-Z]$/u.test(name)) return { rc: HRC.PARAMETER_ERROR };
  const spec = raw.slice(1).trim();

  const existing = conns.get(name);
  if (existing && spec === "") {
    try {
      deps.sessions.get(existing.sessionId, user);
      return ok();
    } catch {
      conns.delete(name);
    }
  }

  // **開いているセッションを古い順に `A` から割り当てる**（対応表はここが持つ）
  const open = deps.sessions.list(user).sort((a, b) => a.connectedAt.localeCompare(b.connectedAt));
  // **指定を書かないときは自分のセッションだけを見る。**
  //
  // `SessionManager.list` は **admin には全件返す**（`ownedOnly` が admin を素通し）。
  // そのままだと管理者の `Connect("A")` が「サーバー上で最も古いセッション」——
  // 十中八九**他人の画面**——を黙って掴む。支援のために他人を触るのは正当な用途だが、
  // **既定であってはならない**。名指しすれば届くので、越権は明示的な操作に閉じる。
  //
  // 認証オフでは `user` も `owner` も `undefined` で一致するため、何も変わらない。
  // 一般利用者は `list` の時点で自分の分しか来ないので、これも変わらない。
  const mine = open.filter((e) => e.owner === user?.username);
  const taken = new Set([...conns.values()].map((c) => c.sessionId));

  let target: SessionEntry | undefined;
  if (spec !== "") {
    // **指定されたら、当たらなければ諦める。** 黙って別のセッションへ繋ぐと、
    // 自動化が意図しない画面を操作する（別システムの本番かもしれない）
    const hits = open.filter((e) => matchesTarget(e, spec));
    if (hits.length === 0) return { rc: HRC.PS_ID_INVALID };
    // **曖昧なら断る**（同じ名前のセッションが 2 つ開いている等）
    if (hits.length > 1) return { rc: HRC.RESOURCE_UNAVAILABLE };
    target = hits[0];
    // 既に別の短縮名に束ねられているなら、そちらを解いてから貼り替える
    for (const [k, v] of [...conns]) if (v.sessionId === target!.id && k !== name) conns.delete(k);
  } else {
    const slot = name.charCodeAt(0) - 65;
    const free = mine.filter((e) => !taken.has(e.id));
    target = mine[slot] && !taken.has(mine[slot]!.id) ? mine[slot] : free[0];
  }
  if (!target) return { rc: HRC.PS_ID_INVALID };

  const snapshot = target.session.snapshot();
  const cursor = rowColToPos(snapshot.cursor.row, snapshot.cursor.col, sizeOf(snapshot)) ?? 1;
  conns.set(name, { sessionId: target.id, cursor });
  return ok();
}

/**
 * Disconnect (2)。**セッションは閉じない**（HLLAPI の意味に合わせる）。
 *
 * ただし**予約は外す**——外さないと、自動化が正しく終了したのに
 * 期限が切れるまで人間が締め出されたままになる。
 */
function disconnect(
  deps: HllapiDeps,
  conns: Map<PsName, Connection>,
  req: HllapiRequest,
  user?: AuthUser
): HllapiResponse {
  const name = (reqText(req)[0] ?? "").toUpperCase();
  const drop = (key: PsName): HllapiResponse => {
    const conn = conns.get(key);
    conns.delete(key);
    if (conn) deps.sessions.release(conn.sessionId, deps.state.holderOf(user));
    return ok();
  };
  if (name && conns.has(name)) return drop(name);
  // 短縮名を指定しない実装もある。1 つだけなら外す
  const first = [...conns.keys()][0];
  if (first !== undefined) return drop(first);
  return { rc: HRC.PROCEDURE_ERROR };
}

/**
 * Reserve (11)。**自動操作の間、人間の入力を締め出す。**
 *
 * これが無いと、利用者がブラウザで打ちかけている最中に画面が変わり、
 * 打ちかけが別の画面の欄へ送られる（5250 は欄の値を AID と一緒に送るため）。
 *
 * 既に**別の主体**が予約していれば `rc=11`（資源が使えない）。
 * 同じ主体の再予約は期限の延長として通る。
 */
function reserve(deps: HllapiDeps, entry: SessionEntry, user?: AuthUser): HllapiResponse {
  try {
    deps.sessions.reserve(entry.id, deps.state.holderOf(user), reservationLabel(entry, user), user);
    return ok();
  } catch (e) {
    if (e instanceof As400Error && e.code === "SESSION_RESERVED") {
      return { rc: HRC.RESOURCE_UNAVAILABLE };
    }
    // 閲覧専用のセッションは予約しても書けないので、断る意味を変えない
    return { rc: HRC.FUNCTION_INHIBITED };
  }
}

/** Release (12)。予約を外す。**持っていなくても成功**（HLLAPI の慣行に合わせる） */
function release(deps: HllapiDeps, entry: SessionEntry, user?: AuthUser): HllapiResponse {
  deps.sessions.release(entry.id, deps.state.holderOf(user));
  return ok();
}

// ---- 問い合わせ ----

/**
 * セッションが指定に当たるか。**大文字小文字は無視する**（VBA から書く名前なので）。
 *
 * 当てられるもの:
 *
 * - 実行中のセッション id（起動のたびに変わる。`Query Sessions` で見える）
 * - セッション設定の参照（`srv:<id>` / `own:<id>`）
 * - **設定上の名前**（利用者が付けた名前。これが一番書きやすい）
 * - `<システム参照>/<名前>`（名前が複数のシステムで重なるとき）
 */
export function matchesTarget(entry: SessionEntry, spec: string): boolean {
  const want = spec.trim().toLowerCase();
  if (want === "") return false;
  const t = entry.target;
  const candidates = [
    entry.id,
    t?.session,
    t?.name,
    t?.system && t.name ? `${t.system}/${t.name}` : undefined
  ];
  return candidates.some((c) => c !== undefined && c.toLowerCase() === want);
}

/**
 * Query Sessions (10)。短縮名・ホスト・画面サイズを 1 行ずつ。
 *
 * **`Connect` に渡せる指定も出す**——これが無いと、狙ったセッションの指し方が分からない。
 */
function querySessions(
  deps: HllapiDeps,
  conns: Map<PsName, Connection>,
  user?: AuthUser
): HllapiResponse {
  const lines: string[] = [];
  for (const [name, conn] of conns) {
    try {
      const e = deps.sessions.get(conn.sessionId, user);
      const s = e.session.snapshot();
      const spec = e.target?.name ?? e.target?.session ?? e.id;
      lines.push(`${name} ${e.host} ${s.rows}x${s.cols} ${spec}`);
    } catch {
      // 消えたセッションは一覧に出さない
    }
  }
  return ok(asciiBytes(lines.join("\n")));
}

/** Query System (20)。実装の識別（**版数は名乗るが、ホストの情報は名乗らない**） */
function querySystem(): HllapiResponse {
  return ok(asciiBytes("ts5250 HLLAPI"));
}

/** Query Session Status (22) */
function querySessionStatus(
  conns: Map<PsName, Connection>,
  conn: Connection,
  snapshot: ScreenSnapshot,
  req: HllapiRequest
): HllapiResponse {
  const name = [...conns.entries()].find(([, c]) => c === conn)?.[0] ?? "A";
  const text = `${name} ${snapshot.rows} ${snapshot.cols} ${snapshot.keyboardLocked ? "locked" : "ready"}`;
  void req;
  return ok(asciiBytes(text));
}

/** Query Cursor Location (7)。**位置は `rc` に載せる**のが HLLAPI の規約 */
function queryCursor(snapshot: ScreenSnapshot): HllapiResponse {
  const pos = rowColToPos(snapshot.cursor.row, snapshot.cursor.col, sizeOf(snapshot));
  return pos === undefined ? { rc: HRC.PS_POSITION_INVALID } : { rc: pos };
}

/**
 * Convert Position or RowCol (99)。
 *
 * `data` の 2 文字目が `P`（位置 → 行桁）か `R`（行桁 → 位置）。
 * **セッションを要さない**ので画面サイズは `data` から受ける（`24x80` 等）。既定は 24x80。
 */
function convert(req: HllapiRequest): HllapiResponse {
  const text = reqText(req);
  const mode = (text[1] ?? "").toUpperCase();
  const m = /(\d+)x(\d+)/u.exec(text);
  const size = { rows: m ? Number(m[1]) : 24, cols: m ? Number(m[2]) : 80 };
  if (mode === "P") {
    const rc = posToRowCol(req.pos, size);
    return rc === undefined
      ? { rc: HRC.PS_POSITION_INVALID }
      : { rc: rc.row, dataB64: toB64(asciiBytes(`${rc.row} ${rc.col}`)), length: 0 };
  }
  if (mode === "R") {
    const pos = rowColToPos(req.pos, req.length, size);
    return pos === undefined ? { rc: HRC.PS_POSITION_INVALID } : { rc: pos };
  }
  return { rc: HRC.PARAMETER_ERROR };
}

// ---- 画面の読み書き ----

/** Copy PS (5)。**改行を入れない**（固定長の連結。`hllapi-ps.ts` の注記） */
function copyPs(snapshot: ScreenSnapshot, req: HllapiRequest): HllapiResponse {
  const bytes = psBytes(snapshot);
  if (req.length > 0 && req.length < bytes.length) {
    // **切り詰めたことを黙らない**
    const cut = bytes.slice(0, req.length);
    return { rc: HRC.DATA_ERROR, dataB64: toB64(cut), length: cut.length };
  }
  return ok(bytes);
}

/** Copy PS to String (8)。`pos`（無ければ論理カーソル）から `length` 文字 */
function copyPsToString(snapshot: ScreenSnapshot, req: HllapiRequest, conn: Connection): HllapiResponse {
  const pos = req.pos > 0 ? req.pos : conn.cursor;
  const bytes = psSlice(snapshot, pos, req.length);
  if (bytes === undefined) return { rc: HRC.PS_POSITION_INVALID };
  return bytes.length < req.length
    ? { rc: HRC.DATA_ERROR, dataB64: toB64(bytes), length: bytes.length }
    : ok(bytes);
}

/** Search PS (6)。**見つかった位置を `rc` に返す**。無ければ `rc=7` */
function searchPs(snapshot: ScreenSnapshot, req: HllapiRequest): HllapiResponse {
  const at = psSearch(snapshot, reqBytes(req), req.pos > 0 ? req.pos : 1);
  return at === undefined ? { rc: HRC.PS_POSITION_INVALID } : { rc: at };
}

/** Set Cursor (40)。`pos` を論理カーソルにする */
function setCursor(snapshot: ScreenSnapshot, conn: Connection, req: HllapiRequest): HllapiResponse {
  if (posToRowCol(req.pos, sizeOf(snapshot)) === undefined) return { rc: HRC.PS_POSITION_INVALID };
  conn.cursor = req.pos;
  return ok();
}

/**
 * Copy String to PS (15)。
 *
 * **入力欄にしか書けない**。保護欄・欄の外なら `rc=5`（PS がロックされている扱い）
 * ——ホストが受け付けない場所へ書いたことを黙らない。
 */
function copyStringToPs(
  deps: HllapiDeps,
  entry: SessionEntry,
  snapshot: ScreenSnapshot,
  conn: Connection,
  req: HllapiRequest,
  user?: AuthUser
): HllapiResponse {
  const pos = req.pos > 0 ? req.pos : conn.cursor;
  const field = fieldAt(snapshot, pos);
  if (!field || !isInputField(field)) return { rc: HRC.FUNCTION_INHIBITED };
  return writeIntoField(deps, entry, snapshot, field, pos, reqText(req), user);
}

/** Copy String to Field (33)。`pos` を含む入力欄へ、欄の先頭から書く */
function copyStringToField(
  deps: HllapiDeps,
  entry: SessionEntry,
  snapshot: ScreenSnapshot,
  conn: Connection,
  req: HllapiRequest,
  user?: AuthUser
): HllapiResponse {
  const pos = req.pos > 0 ? req.pos : conn.cursor;
  const field = fieldAt(snapshot, pos);
  if (!field || !isInputField(field)) return { rc: HRC.FUNCTION_INHIBITED };
  const start = fieldStart(field, sizeOf(snapshot));
  if (start === undefined) return { rc: HRC.PS_POSITION_INVALID };
  return writeIntoField(deps, entry, snapshot, field, start, reqText(req), user);
}

/**
 * 欄の一部に文字列を差し込む（欄の現在値を保ったまま該当桁だけ差し替える）。
 *
 * **書ける相手かを先に確かめる。** 読み取り専用のセッションへ HLLAPI から書けてしまうと、
 * 画面の入口（web-ui / MCP）で塞いでいる境界を横から破ることになる
 * ——MCP の `send_key` が `assertWritable` を通しているのと同じにする。
 */
function writeIntoField(
  deps: HllapiDeps,
  entry: SessionEntry,
  snapshot: ScreenSnapshot,
  field: Field,
  pos: number,
  value: string,
  user?: AuthUser
): HllapiResponse {
  try {
    deps.sessions.assertWritable(entry.id, user, deps.state.holderOf(user));
  } catch {
    return { rc: HRC.FUNCTION_INHIBITED };
  }
  const start = fieldStart(field, sizeOf(snapshot));
  if (start === undefined) return { rc: HRC.PS_POSITION_INVALID };
  const offset = pos - start;
  const current = decodeCp932(fieldBytes(snapshot, field)).padEnd(field.length, " ");
  const truncated = value.length > field.length - offset;
  const fit = truncated ? value.slice(0, field.length - offset) : value;
  const next = (current.slice(0, offset) + fit + current.slice(offset + fit.length)).slice(0, field.length);
  try {
    entry.session.setField({ index: field.index }, next);
  } catch (e) {
    // **書けなかったことを黙らない**（型違反・コードページ外の文字など）
    if (e instanceof As400Error) return { rc: HRC.FUNCTION_INHIBITED };
    return { rc: HRC.SYSTEM_ERROR };
  }
  return truncated ? { rc: HRC.DATA_ERROR } : ok();
}

/** Copy Field to String (34) */
function copyFieldToString(
  snapshot: ScreenSnapshot,
  conn: Connection,
  req: HllapiRequest
): HllapiResponse {
  const field = fieldAt(snapshot, req.pos > 0 ? req.pos : conn.cursor);
  if (!field) return { rc: HRC.PS_POSITION_INVALID };
  if (field.length === 0) return { rc: HRC.FIELD_ZERO_LENGTH };
  return ok(fieldBytes(snapshot, field));
}

/** Find Field Position (31)。**位置を `rc` に返す** */
function findFieldPosition(
  snapshot: ScreenSnapshot,
  conn: Connection,
  req: HllapiRequest
): HllapiResponse {
  const field = fieldAt(snapshot, req.pos > 0 ? req.pos : conn.cursor);
  if (!field) return { rc: HRC.PS_POSITION_INVALID };
  const start = fieldStart(field, sizeOf(snapshot));
  return start === undefined ? { rc: HRC.PS_POSITION_INVALID } : { rc: start };
}

/** Find Field Length (32)。**長さを `rc` に返す** */
function findFieldLength(
  snapshot: ScreenSnapshot,
  conn: Connection,
  req: HllapiRequest
): HllapiResponse {
  const field = fieldAt(snapshot, req.pos > 0 ? req.pos : conn.cursor);
  if (!field) return { rc: HRC.PS_POSITION_INVALID };
  return field.length === 0 ? { rc: HRC.FIELD_ZERO_LENGTH } : { rc: field.length };
}

/** Search Field (30)。欄の中だけを探す */
function searchField(snapshot: ScreenSnapshot, conn: Connection, req: HllapiRequest): HllapiResponse {
  const field = fieldAt(snapshot, req.pos > 0 ? req.pos : conn.cursor);
  if (!field) return { rc: HRC.PS_POSITION_INVALID };
  const start = fieldStart(field, sizeOf(snapshot));
  if (start === undefined) return { rc: HRC.PS_POSITION_INVALID };
  const hay = fieldBytes(snapshot, field);
  const needle = reqBytes(req);
  const at = psSearch(snapshot, needle, start) ?? 0;
  // 欄の外で見つかったものは採らない
  return at === 0 || at > start + hay.length - needle.length
    ? { rc: HRC.PS_POSITION_INVALID }
    : { rc: at };
}

// ---- キー送信と待ち ----

/**
 * Send Key (3)。
 *
 * ニーモニックを解析し、**文字は欄へ、AID はホストへ、移動はこちら側で**処理する。
 * **写せないニーモニックが 1 つでもあれば、何も送らずに `rc=20`**
 * ——一部だけ送ると画面が半端な状態になり、呼び出し側から復旧できない。
 */
async function sendKey(
  deps: HllapiDeps,
  entry: SessionEntry,
  conn: Connection,
  req: HllapiRequest,
  user?: AuthUser
): Promise<HllapiResponse> {
  const strokes = parseMnemonics(reqText(req));
  // **一部だけ送らない。** 途中で写せないキーに当たると画面が半端な状態で止まり、
  // 呼び出し側からは何がどこまで進んだか分からなくなる
  if (hasUnsupported(strokes)) return { rc: HRC.UNDEFINED_COMBINATION };

  for (const stroke of strokes) {
    const snapshot = entry.session.snapshot();
    if (stroke.kind === "text") {
      if (snapshot.keyboardLocked) return { rc: HRC.FUNCTION_INHIBITED };
      const field = fieldAt(snapshot, conn.cursor);
      if (!field || !isInputField(field)) return { rc: HRC.FUNCTION_INHIBITED };
      const r = writeIntoField(deps, entry, snapshot, field, conn.cursor, stroke.text, user);
      if (r.rc !== HRC.SUCCESSFUL && r.rc !== HRC.DATA_ERROR) return r;
      conn.cursor = Math.min(conn.cursor + stroke.text.length, psLength(sizeOf(snapshot)));
      continue;
    }
    if (stroke.kind === "local") {
      moveCursor(snapshot, conn, stroke.action);
      continue;
    }
    // 上で弾いているのでここには来ないが、**型で閉じておく**（分岐の追加漏れを防ぐ）
    if (stroke.kind === "unsupported") return { rc: HRC.UNDEFINED_COMBINATION };
    // AID キー——ホストへ送る
    const r = await sendAid(deps, entry, conn, stroke.key, user);
    if (r.rc !== HRC.SUCCESSFUL) return r;
  }
  return ok();
}

/** ローカル操作でカーソルを動かす（ホストへ送らない） */
function moveCursor(snapshot: ScreenSnapshot, conn: Connection, action: LocalAction): void {
  const size = sizeOf(snapshot);
  const max = psLength(size);
  switch (action) {
    case "home": {
      const first = nextInputField(snapshot, 0);
      conn.cursor = first ? (fieldStart(first, size) ?? 1) : 1;
      return;
    }
    case "tab": {
      const f = nextInputField(snapshot, conn.cursor);
      if (f) conn.cursor = fieldStart(f, size) ?? conn.cursor;
      return;
    }
    case "backtab": {
      const f = prevInputField(snapshot, conn.cursor);
      if (f) conn.cursor = fieldStart(f, size) ?? conn.cursor;
      return;
    }
    case "left":
      conn.cursor = Math.max(1, conn.cursor - 1);
      return;
    case "right":
      conn.cursor = Math.min(max, conn.cursor + 1);
      return;
    case "up":
      conn.cursor = Math.max(1, conn.cursor - size.cols);
      return;
    case "down":
      conn.cursor = Math.min(max, conn.cursor + size.cols);
      return;
    default:
      // eraseEof / delete / backspace / newline / reset は
      // **画面の書き換えを伴う**ので、この版では位置だけ据え置く（docs に明記）
      return;
  }
}

async function sendAid(
  deps: HllapiDeps,
  entry: SessionEntry,
  conn: Connection,
  key: AidKey,
  user?: AuthUser
): Promise<HllapiResponse> {
  try {
    deps.sessions.assertKeyAllowed(entry.id, key, user, deps.state.holderOf(user));
  } catch {
    // 読み取り専用のセッションで更新キーを送ろうとした
    return { rc: HRC.FUNCTION_INHIBITED };
  }
  const snapshot = entry.session.snapshot();
  const rc = posToRowCol(conn.cursor, sizeOf(snapshot));
  try {
    const r = await entry.session.sendAid(key, rc ? { cursor: rc } : {});
    const after = r.screen;
    conn.cursor = rowColToPos(after.cursor.row, after.cursor.col, sizeOf(after)) ?? conn.cursor;
    return r.timedOut ? { rc: HRC.PS_BUSY } : ok();
  } catch {
    return { rc: HRC.SYSTEM_ERROR };
  }
}

/** Wait (4)。キーボードのロックが解けるまで。時間切れは `rc=4` */
async function wait(deps: HllapiDeps, entry: SessionEntry): Promise<HllapiResponse> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let waited = 0; waited <= MAX_WAIT_MS; waited += POLL_MS) {
    if (!entry.session.snapshot().keyboardLocked) return ok();
    await sleep(POLL_MS);
  }
  return { rc: HRC.PS_BUSY };
}

/**
 * Pause (18)。`length` は 1/2 秒単位（HLLAPI の慣行）。
 * 途中で画面が変われば `rc=26`（更新があった）。
 */
async function pause(deps: HllapiDeps, entry: SessionEntry, req: HllapiRequest): Promise<HllapiResponse> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const total = Math.min(Math.max(req.length, 0) * 500, MAX_WAIT_MS);
  const before = Buffer.from(psBytes(entry.session.snapshot())).toString("base64");
  for (let waited = 0; waited < total; waited += POLL_MS) {
    await sleep(POLL_MS);
    if (Buffer.from(psBytes(entry.session.snapshot())).toString("base64") !== before) {
      return { rc: HRC.PS_UPDATED };
    }
  }
  return ok();
}
