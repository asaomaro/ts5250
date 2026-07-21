/**
 * IFS（統合ファイルシステム）のファイル読み書き。
 *
 * ファイルサーバー（QZLSFILE / 8473・9473）へ接続し、
 * **交換属性 → OPEN → READ/WRITE → CLOSE** の手順でファイルを扱う。
 *
 * 参照: JTOpen(jtopenlite) の FileConnection / FileHandle に対応する。
 */
import { As400Error } from "../../errors.js";
import type { IfsEntry, IfsListResult } from "./ifs-types.js";
import { childLog } from "../../log.js";
import { traced } from "../frame-trace.js";
import {
  openHostConnection,
  type HostConnection,
  type HostTlsOptions
} from "../../transport/host-connection.js";
import { DEFAULT_PORT, resolveServicePort } from "../port-mapper.js";
import { signon } from "../signon.js";
import { startHostServer } from "../server-connect.js";
import {
  FILE_SERVER_ID,
  FILE_ACCESS,
  buildFileExchangeAttributes,
  buildOpenFileRequest,
  buildReadRequest,
  buildWriteRequest,
  buildCloseRequest,
  buildDeleteRequest,
  buildListFilesRequest,
  buildCreateDirRequest,
  parseListEntry,
  listReplyKind,
  canRestartFrom,
  fileFailure,
  assertOk,
  replyId,
  REPLY_ERROR,
  REPLY_OPEN,
  REPLY_WRITE,
  replyReturnCode,
  replyFileHandle,
  readReplyData
} from "./ifs-datastream.js";

const log = childLog({ component: "hostserver-ifs" });

/** 1 回の読み書きで扱う既定のバイト数 */
const DEFAULT_CHUNK = 32768;
/** 1 ファイルの上限。終端が返らない異常時の歯止め */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

export interface IfsListOptions {
  /**
   * 1 回で取る最大件数。巨大ディレクトリ対策に必須——
   * 実機の `/QSYS.LIB` は直下だけで 21,192 件あり、1 エントリ = 1 フレームで返る（research F5）。
   */
  maxCount?: number;
  /** 続きから取るときに、前回の最後のエントリの `restartId` を渡す */
  restartId?: number;
  /**
   * 受信した生フレームを覗く診断用のフック（`tools/hostserver-check` の `ifs-list --raw`）。
   *
   * **解析の前に呼ぶ**——レイアウトが想定と違って解析に失敗する場面こそダンプが要るため。
   * 生の接続を外に出さずに、レイアウトを実機で確かめ直せるようにするための口。
   */
  onRawFrame?: (frame: Uint8Array) => void;
}

export interface IfsConnectOptions {
  host: string;
  user: string;
  password: string;
  port?: number;
  tls?: boolean | HostTlsOptions;
  resolvePort?: boolean;
  timeoutMs?: number;
}

export class IfsConnection {
  private closed = false;

  private constructor(
    private readonly conn: HostConnection,
    readonly host: string,
    readonly port: number
  ) {}

  /**
   * 既に確立した接続から組み立てる。**テスト専用**（`connect()` を使うこと）。
   *
   * signon も交換属性も行わないため、実機に対しては使えない。
   * これが無いと `listFiles` の連鎖ループ・`.`/`..` の除外・打ち切り判定・
   * 失敗時の接続破棄が**どれも単体テストできない**（実ソケットを開く経路しか無くなる）。
   *
   * module 直下の関数にできれば公開クラスの表面を増やさずに済むが、
   * **private constructor は同一 module でもクラス宣言の外からは呼べない**（TS2673）。
   * 引数の `HostConnection` 型は `index.ts` から出していないので、
   * パッケージの外からはそもそも呼び出しを書けない。
   */
  static forTesting(conn: HostConnection): IfsConnection {
    return new IfsConnection(conn, "test", 0);
  }

  static async connect(opts: IfsConnectOptions): Promise<IfsConnection> {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const signonInfo = await signon({
      host: opts.host,
      user: opts.user,
      password: opts.password,
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      ...(opts.resolvePort !== undefined ? { resolvePort: opts.resolvePort } : {}),
      timeoutMs
    });

    const port = await decidePort(opts, timeoutMs);
    const rawConn = await openHostConnection({
      host: opts.host,
      port,
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      timeoutMs
    });
    // **接続を 1 度包む**——request() の呼び出しごとに書くと 1 箇所の書き忘れが穴になる
    const conn = traced(rawConn, log);
    try {
      await startHostServer(conn, FILE_SERVER_ID, {
        user: opts.user,
        password: opts.password,
        passwordLevel: signonInfo.info.passwordLevel
      });
      // 交換属性は接続手順に組み込む（送らないと以降の要求が通らない）
      const rc = replyReturnCode(await conn.request(buildFileExchangeAttributes()));
      if (rc !== 0) {
        throw new As400Error(
          "PROTOCOL_ERROR",
          `file server exchange attributes failed (rc=0x${rc.toString(16)})`
        );
      }
      log.debug(`file server ready at ${opts.host}:${port}`);
      return new IfsConnection(conn, opts.host, port);
    } catch (e) {
      conn.close();
      throw e;
    }
  }

  /** ファイルを読む */
  async readFile(path: string): Promise<Uint8Array> {
    this.assertOpen();
    const handle = await this.open(path, FILE_ACCESS.read, false);
    const chunks: Uint8Array[] = [];
    let offset = 0;
    try {
      for (;;) {
        const reply = await this.conn.request(buildReadRequest(handle, offset, DEFAULT_CHUNK));
        // 読み終わりはエラー応答で返る。例外にしない
        if (replyReturnCode(reply) !== 0) break;
        const data = readReplyData(reply);
        if (!data || data.length === 0) break;
        chunks.push(new Uint8Array(data));
        offset += data.length;
        if (offset > MAX_FILE_BYTES) {
          throw new As400Error(
            "PROTOCOL_ERROR",
            `file exceeded ${MAX_FILE_BYTES} bytes without reaching end (${path})`
          );
        }
        if (data.length < DEFAULT_CHUNK) break;
      }
    } finally {
      await this.closeQuietly(handle);
    }
    return concat(chunks);
  }

  /** ファイルを書く（既定で無ければ作る） */
  async writeFile(path: string, data: Uint8Array, opts: { create?: boolean } = {}): Promise<void> {
    this.assertOpen();
    const handle = await this.open(path, FILE_ACCESS.write, opts.create ?? true);
    try {
      let offset = 0;
      while (offset < data.length) {
        const slice = data.subarray(offset, offset + DEFAULT_CHUNK);
        assertOk(
          await this.conn.request(buildWriteRequest(handle, offset, slice)),
          `failed to write ${path} at offset ${offset}`,
          REPLY_WRITE
        );
        offset += slice.length;
      }
    } finally {
      await this.closeQuietly(handle);
    }
  }

  /**
   * ディレクトリの中身を一覧する。
   *
   * **終端は 0x8001（rc=18）の受信で判定する。連鎖指示では判定しない**——
   * 実機では最後のエントリでも連鎖指示が 0x0001 のままで 0 に落ちず、
   * 連鎖ビットで抜けようとすると来ないフレームを待ってハングする（research F1-2）。
   *
   * `.` と `..` はサーバーが返してくるので、ここで落とす。
   *
   * 件数を絞りたいときは `maxCount` を使う（受信側で打ち切ると連鎖の残骸が
   * 次の要求に混ざるため）。打ち切られたら `hasMore: true` を返すので、
   * 最後のエントリの `restartId` を次の呼び出しに渡すと続きが取れる。
   */
  async listFiles(path: string, opts: IfsListOptions = {}): Promise<IfsListResult> {
    this.assertOpen();
    // 空パスを弾く。素通しすると `""` → `"/*"` になってファイルシステムのルートを一覧してしまう
    if (path.length === 0) {
      throw new As400Error("CONFIG_ERROR", "path is empty");
    }
    // パターンを付けないと当のディレクトリ自身が 1 件返るだけになる
    const pattern = path.includes("*") ? path : `${path.replace(/\/$/, "")}/*`;
    const maxCount = opts.maxCount;
    const entries: IfsEntry[] = [];
    let truncated = false;
    /** 終端フレームが伝えたエラー。**連鎖はそこで終わっている**ので、抜けた後に投げる */
    let endError: { rc: number; replyId: number } | undefined;
    let lastRestartId: number | undefined;
    let failure: unknown;

    try {
      await this.conn.requestStream(
        buildListFilesRequest(pattern, {
          ...(maxCount !== undefined ? { maxCount } : {}),
          ...(opts.restartId !== undefined ? { restartId: opts.restartId } : {})
        }),
        (frame) => {
          // 解析より先に渡す（解析に失敗する場面こそダンプが要る）
          opts.onRawFrame?.(frame);
          const kind = listReplyKind(frame);
          if (kind === "entry") {
            const entry = parseListEntry(frame);
            // 続きの起点は**除外前**の最後から取る。
            // `.` と `..` だけで上限に達した場合、除外後は空になり起点を失うため
            lastRestartId = entry.restartId;
            // 自分自身と親は一覧に出さない
            if (entry.name !== "." && entry.name !== "..") entries.push(entry);
            return true;
          }
          if (kind === "truncated") {
            truncated = true;
            return false;
          }
          if (kind === "end") return false;
          // **ここで throw しない。** `0x8001` は終端フレームで後続が無いため、
          // コールバック内で抜けると「連鎖の途中で放棄した」扱いになり、
          // 実際には正常に終わっている接続まで毒化してしまう。
          // 権限エラー等で 1 ディレクトリが読めなくても、同じ接続で走査を続けられるべき
          // （design の ifs-collect は 1 接続で再帰的に集める）
          endError = { rc: replyReturnCode(frame), replyId: replyId(frame) };
          return false;
        }
      );
    } catch (e) {
      // 連鎖を最後まで読み切れなかった。残量が分からないので、この接続は捨てる
      // （残骸を次の要求の応答として読むのを防ぐ。design「連鎖の扱い」）
      failure = e;
    }
    if (failure !== undefined) {
      this.close();
      throw failure;
    }

    // 存在しない・権限が無い等はここで投げる。rc → コードの対応は fileFailure が持つ
    if (endError) {
      throw fileFailure(`failed to list ${path}`, endError.rc, endError.replyId);
    }
    // 打ち切りは**終端フレームの rc が正**（rc=0 が打ち切り、rc=18 が全件）。
    // 件数の比較では判定できない——`.` と `..` もサーバーの件数上限を消費するため、
    // 除外後の件数は maxCount に届かないことがある。
    // その結果 **entries が空でも hasMore が true** になりうる（maxCount=2 で `.` と `..` だけが返る等）。
    // 呼び出し側は「空 = 終わり」と解釈しないこと
    const canContinue = truncated && canRestartFrom(lastRestartId, opts.restartId);
    const next = canContinue ? lastRestartId : undefined;
    return {
      entries,
      hasMore: truncated,
      canContinue,
      ...(next !== undefined ? { nextRestartId: next } : {})
    };
  }

  /**
   * ディレクトリを作る。
   *
   * **応答は 0x8001 で返るが、これはエラーを意味しない**——rc=0 が成功。
   * 既存の `replyReturnCode()` は「0x8001 ならエラー」という前提で使われているので、
   * ここでは rc を直接見る（research F2）。
   */
  async makeDirectory(path: string): Promise<void> {
    this.assertOpen();
    assertOk(await this.conn.request(buildCreateDirRequest(path)), `failed to create directory ${path}`);
  }

  /** ファイルを削除する */
  async deleteFile(path: string): Promise<void> {
    this.assertOpen();
    assertOk(await this.conn.request(buildDeleteRequest(path)), `failed to delete ${path}`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.conn.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private async open(path: string, access: number, create: boolean): Promise<number> {
    const reply = await this.conn.request(buildOpenFileRequest({ path, access, create }));
    // OPEN の成功応答は 0x8002 で、テンプレート先頭がハンドルそのもの。
    // 失敗は 0x8001 で rc が入る。**ID を見ずに rc だけで分岐すると**、
    // 想定外の応答で rc=0（`replyReturnCode` の仕様）になり、
    // 無関係なバイトをファイルハンドルとして使ってしまう
    if (replyId(reply) === REPLY_ERROR) {
      throw fileFailure(`failed to open ${path}`, replyReturnCode(reply), REPLY_ERROR);
    }
    if (replyId(reply) !== REPLY_OPEN) {
      throw fileFailure(`failed to open ${path}`, 0, replyId(reply));
    }
    return replyFileHandle(reply);
  }

  /** 片付けの失敗で結果を捨てない */
  private async closeQuietly(handle: number): Promise<void> {
    try {
      await this.conn.request(buildCloseRequest(handle));
    } catch (e) {
      log.debug(`close file handle ${handle} failed: ${String(e)}`);
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new As400Error("SESSION_CLOSED", "IFS connection is closed");
    }
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

async function decidePort(opts: IfsConnectOptions, timeoutMs: number): Promise<number> {
  if (opts.port !== undefined) {
    if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
      throw new As400Error("CONFIG_ERROR", `invalid port: ${opts.port}`);
    }
    return opts.port;
  }
  if (opts.resolvePort) {
    return resolveServicePort(opts.host, "file", { timeoutMs, tls: Boolean(opts.tls) });
  }
  return opts.tls ? DEFAULT_PORT.file.tls : DEFAULT_PORT.file.plain;
}
