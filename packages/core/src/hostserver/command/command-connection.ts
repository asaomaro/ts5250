/**
 * コマンドサーバー（QZRCSRVS）への接続と、CL コマンド実行・プログラム呼び出し。
 *
 * 手順:
 *   1. signon サーバーへ接続してパスワードレベルを得る（用が済んだら閉じる）
 *   2. コマンドサーバー（0xE008）へ接続し `0x7001`→`0x7002` で認証する
 *   3. **交換属性（0x1001）を送る** — データストリームレベルが分からないと
 *      コマンド文字列の書式を決められない。呼び出し側に忘れさせないため手順に組み込む
 *
 * 参照: JTOpen(jtopenlite) の CommandConnection に対応する。
 */
import { As400Error } from "../../errors.js";
import { childLog } from "../../log.js";
import {
  openHostConnection,
  type HostConnection,
  type HostTlsOptions
} from "../../transport/host-connection.js";
import { HEADER_LEN } from "../datastream.js";
import { DEFAULT_PORT, resolveServicePort } from "../port-mapper.js";
import { signon } from "../signon.js";
import { startHostServer } from "../server-connect.js";
import {
  COMMAND_SERVER_ID,
  MIN_DATASTREAM_LEVEL,
  RC_OK,
  RC_FAILED_WITH_MESSAGES,
  REPLY_RC_OFFSET,
  buildExchangeAttributesRequest,
  parseExchangeAttributesReply,
  buildRunCommandRequest,
  buildCallProgramRequest,
  paramMaxLength,
  CP_PARAMETER,
  type CommandServerInfo,
  type ProgramParameter
} from "./command-datastream.js";
import { parseMessages, describeMessage, type HostMessage } from "./command-message.js";

const log = childLog({ component: "hostserver-command" });

export interface CommandConnectOptions {
  host: string;
  user: string;
  password: string;
  port?: number;
  tls?: boolean | HostTlsOptions;
  resolvePort?: boolean;
  timeoutMs?: number;
}

export interface CommandResult {
  /**
   * 戻りコードが 0 か。
   * **メッセージの有無で判断してはいけない**——成功したコマンドでも
   * 情報メッセージ（重大度 0）が返る（例 CPC2101 "Library list changed."）。
   */
  success: boolean;
  returnCode: number;
  messages: HostMessage[];
}

/** コマンド失敗。メッセージを**型として**公開する */
export class CommandError extends As400Error {
  constructor(
    readonly command: string,
    readonly result: CommandResult
  ) {
    super(
      "COMMAND_FAILED",
      `command failed: ${command}\n` +
        result.messages.map((m) => `  ${describeMessage(m)}`).join("\n")
    );
    this.name = "CommandError";
  }

  /** 最初のエラー以上のメッセージ（原因を指していることが多い） */
  get primary(): HostMessage | undefined {
    return this.result.messages.find((m) => m.kind === "error" || m.kind === "severe");
  }
}

export class CommandConnection {
  private closed = false;

  private constructor(
    private readonly conn: HostConnection,
    readonly info: CommandServerInfo,
    readonly host: string,
    readonly port: number
  ) {}

  static async connect(opts: CommandConnectOptions): Promise<CommandConnection> {
    const timeoutMs = opts.timeoutMs ?? 20_000;

    // 1) パスワードレベルは signon サーバーからしか得られない
    const signonInfo = await signon({
      host: opts.host,
      user: opts.user,
      password: opts.password,
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      ...(opts.resolvePort !== undefined ? { resolvePort: opts.resolvePort } : {}),
      timeoutMs
    });

    const port = await decidePort(opts, timeoutMs);
    const conn = await openHostConnection({
      host: opts.host,
      port,
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      timeoutMs
    });

    try {
      // 2) 認証（signon 以外のサーバー共通の手順）
      await startHostServer(conn, COMMAND_SERVER_ID, {
        user: opts.user,
        password: opts.password,
        passwordLevel: signonInfo.info.passwordLevel
      });

      // 3) 交換属性。ここで得るレベルがコマンドの書式を決める
      const info = parseExchangeAttributesReply(
        await conn.request(buildExchangeAttributesRequest())
      );
      if (info.datastreamLevel < MIN_DATASTREAM_LEVEL) {
        throw new As400Error(
          "HOST_SERVER_UNSUPPORTED",
          `command server datastream level ${info.datastreamLevel} is not supported ` +
            `(need ${MIN_DATASTREAM_LEVEL} or later; older servers use a different command encoding)`
        );
      }
      log.debug(
        `command server ${opts.host}:${port} ${info.version} ccsid=${info.ccsid} ` +
          `nlv=${info.nlv} dsLevel=${info.datastreamLevel}`
      );
      return new CommandConnection(conn, info, opts.host, port);
    } catch (e) {
      conn.close();
      throw e;
    }
  }

  /**
   * CL コマンドを実行する。**失敗しても例外にせず結果で返す**
   * （呼び出し側がメッセージを見て判断できるように）。
   */
  async run(command: string): Promise<CommandResult> {
    this.assertOpen();
    const reply = await this.conn.request(buildRunCommandRequest(command));
    // コマンド実行は 0 か 0x0400 しか返さない。他は想定外として例外にする
    return this.toResult(reply, command, true);
  }

  /** 失敗を例外にする版。呼び出し側で分岐したくない場合に使う */
  async runOrThrow(command: string): Promise<CommandResult> {
    const result = await this.run(command);
    if (!result.success) throw new CommandError(command, result);
    return result;
  }

  /**
   * プログラムを呼び出す。
   *
   * 出力パラメータの値は**呼び出し順に対応する配列**で返る
   * （入力専用・NULL の位置は undefined）。
   */
  async call(
    program: string,
    library: string,
    params: readonly ProgramParameter[]
  ): Promise<{ result: CommandResult; outputs: (Uint8Array | undefined)[] }> {
    this.assertOpen();
    const reply = await this.conn.request(buildCallProgramRequest(program, library, params));
    // プログラム呼び出しは 0 以外に様々な値を返す（実機で 0x0501 を観測）。
    // コマンド実行と判定規則が違うので、ここでは戻りコードを絞らない
    const result = this.toResult(reply, `${library}/${program}`, false);
    return { result, outputs: extractOutputs(reply, params) };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.conn.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new As400Error("SESSION_CLOSED", "command connection is closed");
    }
  }

  /**
   * 応答から戻りコードとメッセージを取り出す。
   *
   * @param strictReturnCode コマンド実行のように取りうる値が決まっている場合 true。
   *   プログラム呼び出しは 0 以外に様々な値を返すため false にする
   *   （実機で `QGYOLSPL` が 0x0501 を返すのを観測した）。
   */
  private toResult(reply: Uint8Array, what: string, strictReturnCode: boolean): CommandResult {
    if (reply.length < HEADER_LEN + 2) {
      throw new As400Error("PROTOCOL_ERROR", `command reply too short: ${reply.length} bytes`);
    }
    const v = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
    const returnCode = v.getUint16(REPLY_RC_OFFSET);
    if (strictReturnCode && returnCode !== RC_OK && returnCode !== RC_FAILED_WITH_MESSAGES) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `unexpected return code 0x${returnCode.toString(16)} from command server (${what})`
      );
    }
    return { success: returnCode === RC_OK, returnCode, messages: parseMessages(reply) };
  }
}

/**
 * 応答から出力パラメータを取り出す。
 *
 * **前提**: 出力を持つパラメータが、要求したのと同じ順で返る。
 * その順序でしか位置合わせできないため、返る数が足りない場合は
 * 後ろが undefined になる（誤った値を割り当てない）。
 *
 * 入力専用・NULL の位置は undefined にして、呼び出し側が添字で対応付けられるようにする。
 * なお**失敗した呼び出しでもここは走る**——実際に受け取ったバイト列を返すので嘘ではないが、
 * 使う前に `result.success` を見ること。
 */
function extractOutputs(
  reply: Uint8Array,
  params: readonly ProgramParameter[]
): (Uint8Array | undefined)[] {
  const outputs: (Uint8Array | undefined)[] = params.map(() => undefined);
  const wantsOutput = params.map((p) => p.type === "out" || p.type === "inout");
  if (!wantsOutput.some(Boolean)) return outputs;

  const v = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  // メッセージ列と同じ LL/CP 形式でパラメータが返る
  let pos = HEADER_LEN + 4;
  const received: Uint8Array[] = [];
  while (pos + 6 <= reply.length) {
    const ll = v.getUint32(pos);
    if (ll < 6 || pos + ll > reply.length) break;
    const cp = v.getUint16(pos + 4);
    if (cp === CP_PARAMETER && pos + 12 <= reply.length) {
      received.push(reply.subarray(pos + 12, pos + ll));
    }
    pos += ll;
  }

  let i = 0;
  params.forEach((p, idx) => {
    if (!wantsOutput[idx]) return;
    const got = received[i++];
    if (got) outputs[idx] = got.subarray(0, Math.min(got.length, paramMaxLength(p)));
  });
  return outputs;
}

async function decidePort(opts: CommandConnectOptions, timeoutMs: number): Promise<number> {
  if (opts.port !== undefined) {
    if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
      throw new As400Error("CONFIG_ERROR", `invalid port: ${opts.port}`);
    }
    return opts.port;
  }
  if (opts.resolvePort) {
    // TLS では "-s" 付きのサービス名で問い合わせないと平文ポートが返る
    return resolveServicePort(opts.host, "command", { timeoutMs, tls: Boolean(opts.tls) });
  }
  return opts.tls ? DEFAULT_PORT.command.tls : DEFAULT_PORT.command.plain;
}
