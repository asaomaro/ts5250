/**
 * DDM（レコードレベルアクセス）で物理ファイルにレコードを追記する。
 *
 * **他のホストサーバーと握手が違う**（spec D4 / research F1）——
 * signon / database / command / netprint / IFS は `0x7001`→`0x7002` の枠を使うが、
 * DDM は **EXCSAT → ACCSEC → SECCHK** という DRDA 系の手順で、ポートも **446**（TLS 448）である。
 * したがって `startHostServer()` は使えない。
 *
 * ただし**資格情報のバイト化とパスワード置換値の生成は既存と同一**である。
 * 原典自身が `getUserBytes` / `getPasswordBytes` / `getEncryptedPassword` に
 * `// Copied from HostServerConnection.` と書いており、共通であることが確認できている。
 *
 * ⚠ **コミット制御は使わない**（原典も false 固定）。書いたレコードは即座に確定し、
 * 途中で失敗しても巻き戻らない。複数レコードの原子性が要る場合は、
 * 呼び出し側が SQL のトランザクションや CL で扱うこと（この層では扱わない）。
 *
 * 参照: jtopenlite の `com.ibm.jtopenlite.ddm.DDMConnection`
 * （getConnection / open / write / close）に対応する。逐語移植ではなく、
 * バイト配置・定数・手順という事実に基づく書き起こし。
 */
import { As400Error } from "../../errors.js";
import { childLog } from "../../log.js";
import { codecForCcsid } from "../../codec/codec.js";
import { openDdmTransport, type DdmTransport } from "../../transport/ddm-transport.js";
import type { HostTlsOptions } from "../../transport/host-connection.js";
import { signon } from "../signon.js";
import {
  generateClientSeed,
  passwordSubstituteSha,
  MIN_SHA_PASSWORD_LEVEL,
  SEED_LEN
} from "../password.js";
import { passwordUnicode, userIdEbcdic37, userIdUnicode } from "../credentials.js";
import { DEFAULT_PORT } from "../port-mapper.js";
import {
  DDM_CP,
  DdmReader,
  DdmWriter,
  SECMEC_SHA,
  frame,
  padName10,
  param,
  readHeader,
  type DdmMessage
} from "./ddm-datastream.js";
import { buildRecordLayout, type ColumnLayoutInput, type RecordLayout } from "./record-layout.js";
import { encodeChar, encodeInt, encodePacked, encodeZoned } from "./encode.js";

const log = childLog({ component: "hostserver-ddm" });

/** 要求フレームのフォーマット ID（RQSDSS） */
const FMT_RQSDSS = 1;
/** S38PUTM に続く S38BUF のフォーマット ID（OBJDSS・同一相関） */
const FMT_OBJDSS_SAME_CORR = 3;

/**
 * DDM の**制御情報**（ファイル名・ライブラリ名・メンバー名・宣言名）専用のコーデック。
 *
 * ここは CCSID 37 で固定してよい——オブジェクト名は英数字と `$#@` に限られ、
 * どの EBCDIC でも同じ位置にある。**レコードのデータ部には使わない**
 * （データは列ごとの CCSID で符号化する。design D1）。
 */
const ebcdic37 = codecForCcsid(37);
const encode37 = (t: string): { bytes: Uint8Array; substituted: number } => ebcdic37.encode(t);
const decode37 = (b: Uint8Array): string => ebcdic37.decode(b);

/**
 * 列の CCSID → エンコーダ。同じ CCSID を何度も引かないよう覚えておく
 * （1 レコードにつき列数ぶん引かれ、行数ぶん繰り返されるため）。
 */
const encoderCache = new Map<number, (t: string) => { bytes: Uint8Array; substituted: number }>();
function encoderFor(ccsid: number | undefined): (t: string) => {
  bytes: Uint8Array;
  substituted: number;
} {
  // CCSID 不明の文字列列は 37 とみなす。**黙って化けるより、既定を明示して例外で気づけるようにする**
  // （表現できない文字があれば encodeChar が拒否する）
  const key = ccsid ?? 37;
  let enc = encoderCache.get(key);
  if (!enc) {
    const codec = codecForCcsid(key);
    enc = (t: string) => codec.encode(t);
    encoderCache.set(key, enc);
  }
  return enc;
}

export interface DdmConnectOptions {
  host: string;
  user: string;
  password: string;
  port?: number;
  tls?: boolean | HostTlsOptions;
  resolvePort?: boolean;
  timeoutMs?: number;
}

/** 開いたファイルのハンドル。`recordIncrement - recordLength` が NULL 指標マップ */
export interface DdmFile {
  library: string;
  file: string;
  member: string;
  /** 宣言名（DCLNAM）。接続内で一意 */
  dclNam: Uint8Array;
  recordLength: number;
  recordIncrement: number;
  nullFieldByteMapOffset: number;
  /**
   * 1 バッチに実際に詰める件数。**open の応答が来てから決まる**——
   * 要求値・形式上の上限（32767）・`recordIncrement` から決まる上限の最小。
   */
  effectiveBatchSize: number;
}

/** ブロッキング係数の既定。原典 `DDMConnection.open` の preferred batch size に倣う */
const DEFAULT_BLOCKING_FACTOR = 100;

export class DdmConnection {
  private closed = false;
  private correlation = 1;

  private constructor(
    private readonly transport: DdmTransport,
    readonly host: string,
    readonly port: number
  ) {}

  private nextCorrelation(): number {
    this.correlation = (this.correlation + 1) & 0x7fff;
    return this.correlation;
  }

  /** DCLNAM は EBCDIC の数字 8 桁（接続内の連番）。原典 `generateDCLNAM` に対応 */
  private nextDclNam(): Uint8Array {
    const n = String(this.nextCorrelation()).padStart(8, "0");
    const out = new Uint8Array(8);
    for (let i = 0; i < 8; i++) out[i] = 0xf0 + (n.charCodeAt(i) - 0x30);
    return out;
  }

  static async connect(opts: DdmConnectOptions): Promise<DdmConnection> {
    // **passwordLevel を得るために先に signon する**（他の 4 接続と同じ）
    const info = await signon({
      host: opts.host,
      user: opts.user,
      password: opts.password,
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      ...(opts.resolvePort !== undefined ? { resolvePort: opts.resolvePort } : {})
    });
    const level = info.info.passwordLevel;
    // DDM(DRDA) の SECCHK は SHA(SECMEC) 前提で実装している。パスワードレベル 0/1 の DES 経路は
    // signon/ホストサーバー（command/SQL/IFS 等）では対応済みだが、DDM 独自ハンドシェイクは未対応。
    // signon が通ったあと SECCHK で分かりにくく失敗するより、ここで明示的に断る。
    if (level < MIN_SHA_PASSWORD_LEVEL) {
      throw new As400Error(
        "HOST_SERVER_UNSUPPORTED",
        `DDM (データ転送/DRDA) はパスワードレベル ${level}（DES 認証）にまだ対応していません。` +
          `コマンド/SQL/IFS 等のホストサーバーは対応しています`
      );
    }

    const port = opts.port ?? (opts.tls ? DEFAULT_PORT.ddm.tls : DEFAULT_PORT.ddm.plain);
    const transport = await openDdmTransport({
      host: opts.host,
      port,
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {})
    });

    try {
      const conn = new DdmConnection(transport, opts.host, port);
      await conn.handshake(opts.user, opts.password, level);
      log.debug(`DDM server ready at ${opts.host}:${port}`);
      return conn;
    } catch (e) {
      transport.close();
      throw e;
    }
  }

  /** EXCSAT → ACCSEC → SECCHK（research F1） */
  private async handshake(user: string, password: string, passwordLevel: number): Promise<void> {
    // --- EXCSAT（交換サーバー属性） ---
    this.transport.send(buildExcsat());
    const excsatReply = new DdmReader(await this.transport.receive());
    const excsatHdr = readHeader(excsatReply, "EXCSAT");
    excsatReply.skip(2, "EXCSAT LL");
    const excsatCp = excsatReply.u16("EXCSAT CP");
    if (excsatCp !== DDM_CP.EXCSATRD) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `EXCSATRD を期待したが 0x${excsatCp.toString(16)} が返りました`
      );
    }
    excsatReply.skip(excsatHdr.length - 10, "EXCSAT rest");

    // --- ACCSEC（セキュリティ機構の合意 ＋ クライアント乱数） ---
    const clientSeed = generateClientSeed();
    this.transport.send(buildAccsec(clientSeed));
    const accsecReply = new DdmReader(await this.transport.receive());
    const accsecHdr = readHeader(accsecReply, "ACCSEC");
    accsecReply.skip(2, "ACCSEC LL");
    const accsecCp = accsecReply.u16("ACCSEC CP");
    if (accsecCp !== DDM_CP.ACCSECRD) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `ACCSECRD を期待したが 0x${accsecCp.toString(16)} が返りました`
      );
    }
    // 10 バイト読み飛ばした先にサーバー乱数 8 バイト（原典 :185-188）
    accsecReply.skip(10, "ACCSEC pad");
    const serverSeed = accsecReply.take(SEED_LEN, "server seed");
    accsecReply.skip(accsecHdr.length - 28, "ACCSEC rest");

    // --- SECCHK（認証） ---
    // 置換値の生成は既存と同一（原典が「Copied from HostServerConnection」と明記）
    const substitute = await passwordSubstituteSha(
      userIdUnicode(user),
      passwordUnicode(password),
      clientSeed,
      serverSeed
    );
    this.transport.send(buildSecchk(userIdEbcdic37(user), substitute, passwordLevel));
    const secReply = new DdmReader(await this.transport.receive());
    const secHdr = readHeader(secReply, "SECCHK");
    secReply.skip(2, "SECCHK LL");
    const secCp = secReply.u16("SECCHK CP");
    if (secCp !== DDM_CP.SECCHKRD) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `SECCHKRD を期待したが 0x${secCp.toString(16)} が返りました`
      );
    }
    secReply.skip(8, "SECCHK pad");
    const codeCp = secReply.u16("SECCHKCD CP");
    if (codeCp !== DDM_CP.SECCHKCD) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `SECCHKCD を期待したが 0x${codeCp.toString(16)} が返りました`
      );
    }
    const rc = secReply.u8("SECCHK rc");
    if (rc !== 0) {
      throw new As400Error("UNAUTHENTICATED", `DDM の認証に失敗しました（rc=${rc}）`);
    }
    secReply.skip(secHdr.length - 21, "SECCHK rest");
  }

  /**
   * ファイルを**書き込み用に**開く。
   * 読み取りは扱わない（SQL があるため。spec D3）。
   */
  async open(
    library: string,
    file: string,
    opts: { member?: string; recordFormat?: string; blockingFactor?: number } = {}
  ): Promise<DdmFile> {
    this.assertOpen();
    const dclNam = this.nextDclNam();
    const member = opts.member ?? "*FIRST";
    const recordFormat = opts.recordFormat ?? file;
    // 既定 100 は原典の preferred batch size に倣う（`DDMConnection.open` の既定値）
    const requested = opts.blockingFactor ?? DEFAULT_BLOCKING_FACTOR;
    this.transport.send(
      buildS38Open(
        this.nextCorrelation(),
        dclNam,
        library,
        file,
        member,
        recordFormat,
        requested
      )
    );

    const r = new DdmReader(await this.transport.receive());
    const hdr = readHeader(r, "S38OPEN");
    let ll = r.u16("S38OPEN LL");
    let cp = r.u16("S38OPEN CP");
    let numRead = 10;
    /**
     * 応答に混ざるメッセージ。**これがあっても失敗とは限らない**——
     * 成否は「S38OPNFB（オープンのフィードバック）が来たか」で判断する。
     *
     * 実機で `CPF427D Substitution characters may be used in data conversion.` が
     * S38OPNFB と**一緒に**返ることを確認した（ジョブ CCSID と表の CCSID が違う場合の通知）。
     * 最初のメッセージで打ち切ると、開けているのに失敗として扱ってしまう。
     */
    const messages: DdmMessage[] = [];
    while (cp !== DDM_CP.S38OPNFB && numRead + 4 <= hdr.length) {
      if (cp === DDM_CP.S38MSGRM) {
        messages.push(readMessage(r, ll));
      } else {
        r.skip(ll - 4, "S38OPEN skip");
      }
      numRead += ll;
      if (numRead + 4 > hdr.length) break;
      ll = r.u16("S38OPEN LL");
      cp = r.u16("S38OPEN CP");
      numRead += 4;
    }
    if (cp !== DDM_CP.S38OPNFB) {
      // ここで初めて失敗と判断する。メッセージがあれば理由として添える
      const why = messages.map((m) => `${m.id} ${m.text}`.trim()).join(" / ");
      throw new As400Error(
        "PROTOCOL_ERROR",
        why
          ? `ファイルを開けませんでした（${library}/${file}）: ${why}`
          : `S38OPNFB を期待したが 0x${cp.toString(16)} が返りました`
      );
    }
    if (messages.length > 0) {
      log.debug(
        `open ${library}/${file} advisory: ${messages.map((m) => m.id).join(" ")}`
      );
    }

    // --- S38OPNFB の中身（原典 :467-495 の並び） ---
    r.u8("open type");
    const realFile = decode37(r.take(10, "file")).trim();
    const realLibrary = decode37(r.take(10, "library")).trim();
    const realMember = decode37(r.take(10, "member")).trim();
    const recordLength = r.u16("record length");
    r.skip(10, "opnfb pad1");
    r.u32("num records");
    r.skip(2, "access type");
    r.u8("dup keys");
    r.u8("source file");
    r.skip(10, "UFCB params");
    r.u16("max blocked records");
    const recordIncrement = r.u16("record increment");
    r.u8("open flags1");
    r.skip(6, "opnfb pad2");
    r.u16("max record length");
    r.u32("record wait time");
    r.u16("open flags2");
    const nullFieldByteMapOffset = r.u16("null map offset");

    // 残りとチェインされたフレームは読み捨てる
    await this.drain(hdr);

    // **実効値は応答が来てから決まる**。ブロッキング係数は open 要求に載せるのに、
    // 上限を決める recordIncrement は応答で分かる（順序が逆）。宣言値以下に丸めるのは
    // 安全側なので、要求は希望値・実際の詰め込みはここで丸めた値、という二段構えにする
    const effectiveBatchSize = effectiveBatchSizeFor(requested, recordIncrement);

    log.debug(
      `opened ${realLibrary}/${realFile}(${realMember}) ` +
        `recordLength=${recordLength} increment=${recordIncrement} batch=${effectiveBatchSize}`
    );
    return {
      library: realLibrary,
      file: realFile,
      member: realMember,
      dclNam,
      recordLength,
      recordIncrement,
      nullFieldByteMapOffset,
      effectiveBatchSize
    };
  }

  /**
   * レコードを 1 件追記する。
   *
   * ⚠ **巻き戻らない**——コミット制御を使っていないため、失敗しても
   * それまでに書いたレコードは残る。
   */
  async write(file: DdmFile, record: DdmRecord | Uint8Array): Promise<void> {
    const rec: DdmRecord =
      record instanceof Uint8Array ? { data: record, nulls: [] } : record;
    // 1 件書きは **N=1 のバッチ**。フレームの組み立てを二重に持たない（design DD3）
    await this.sendBatch(file, [rec]);
  }

  /**
   * レコードをまとめて追記する。**1 バッチ = 1 往復**なので、
   * 往復数は件数ではなくバッチ数になる（実機は 1 往復 4〜7 秒）。
   *
   * ⚠ **巻き戻らない**。途中のバッチで失敗したとき、そのバッチの何件目まで
   * 確定したかは**ホストの応答から特定できない**。よって「n 行目で失敗」とは言わず、
   * 確定した件数と、確定したか不明な範囲を分けて返す（design DD4）。
   */
  async writeAll(file: DdmFile, records: readonly DdmRecord[]): Promise<WriteAllResult> {
    this.assertOpen();
    const batch = Math.max(1, file.effectiveBatchSize);
    let committed = 0;
    while (committed < records.length) {
      const slice = records.slice(committed, committed + batch);
      try {
        await this.sendBatch(file, slice);
      } catch (e) {
        return {
          committedRows: committed,
          // 1 始まりの行範囲。**この範囲は書けたか書けなかったか分からない**
          uncertainRange: { from: committed + 1, to: committed + slice.length },
          error: e instanceof Error ? e.message : String(e)
        };
      }
      committed += slice.length;
    }
    return { committedRows: committed };
  }

  /** S38PUTM ＋ S38BUF を 1 往復で送る（1 件でも N 件でも同じ経路） */
  private async sendBatch(file: DdmFile, records: readonly DdmRecord[]): Promise<void> {
    this.assertOpen();
    if (records.length === 0) return;
    for (const rec of records) {
      if (rec.data.length !== file.recordLength) {
        throw new As400Error(
          "CONFIG_ERROR",
          `レコード長が一致しません（期待 ${file.recordLength} / 実際 ${rec.data.length}）`
        );
      }
    }
    const id = this.nextCorrelation();
    this.transport.send(buildS38Putm(id, file.dclNam));
    this.transport.send(buildS38Buf(id, records, file.recordIncrement));

    const r = new DdmReader(await this.transport.receive());
    const hdr = readHeader(r, "S38PUTM");
    const messages = readMessages(r, hdr.length);
    const error = messages.find((m) => m.id.startsWith("CPF") || m.id.startsWith("MCH"));
    if (error) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `レコードの書き込みに失敗しました: ${error.id} ${error.text}`.trim()
      );
    }
    await this.drain(hdr);
  }

  /** ファイルを閉じる。ホストからのメッセージを返す */
  async close(file: DdmFile): Promise<DdmMessage[]> {
    this.assertOpen();
    this.transport.send(buildS38Close(this.nextCorrelation(), file.dclNam));
    const r = new DdmReader(await this.transport.receive());
    const hdr = readHeader(r, "S38CLOSE");
    const messages = readMessages(r, hdr.length);
    await this.drain(hdr);
    return messages;
  }

  /** チェインされた後続フレームを読み捨てる */
  private async drain(hdr: { chained: boolean }): Promise<void> {
    let chained = hdr.chained;
    while (chained) {
      const next = new DdmReader(await this.transport.receive());
      const h = readHeader(next, "chained");
      chained = h.chained;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new As400Error("SESSION_CLOSED", "DDM 接続は閉じています");
  }

  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * レコード配置に従って値をバイト列に詰める。
 *
 * 値は**列の宣言順**で渡す。数が合わなければ失敗させる（黙って詰めない）。
 */
export interface WriteAllResult {
  /** **成功が確定したバッチ**までの累計行数（確実に書けた下限） */
  committedRows: number;
  /**
   * 失敗したバッチの行範囲（1 始まり）。この範囲は**書けたか書けなかったか不明**。
   * 成功時は付かない。
   */
  uncertainRange?: { from: number; to: number };
  /** 失敗の理由（`uncertainRange` があるときのみ） */
  error?: string;
}

export interface DdmRecord {
  /** 固定部のバイト列（recordLength ぶん） */
  data: Uint8Array;
  /** 列ごとの NULL かどうか。**指標マップに反映される**（列の宣言順） */
  nulls: boolean[];
}

export function buildDdmRecord(
  layout: RecordLayout,
  values: readonly (string | number | bigint | null)[]
): DdmRecord {
  if (values.length !== layout.fields.length) {
    throw new As400Error(
      "CONFIG_ERROR",
      `列数が一致しません（期待 ${layout.fields.length} / 実際 ${values.length}）`
    );
  }
  const out = new Uint8Array(layout.recordLength).fill(0x40);
  const nulls: boolean[] = new Array(layout.fields.length).fill(false);
  for (let i = 0; i < layout.fields.length; i++) {
    const f = layout.fields[i]!;
    const v = values[i]!;
    if (v === null) {
      if (!f.nullable) {
        throw new As400Error("CONFIG_ERROR", `列 ${f.name} は NULL を受け付けません`);
      }
      // NULL でも固定部は埋めておく（**実際の NULL は指標マップが示す**）
      out.set(new Uint8Array(f.size).fill(f.kind === "char" ? 0x40 : 0x00), f.offset);
      nulls[i] = true;
      continue;
    }
    let bytes: Uint8Array;
    switch (f.kind) {
      case "char":
        // **列ごとの CCSID で符号化する**（design D1）。同じ表に 273 と 5035 が同居しうる
        bytes = encodeChar(String(v), f.size, encoderFor(f.ccsid));
        break;
      case "packed":
        bytes = encodePacked(v as string | number | bigint, f.precision, f.scale);
        break;
      case "zoned":
        bytes = encodeZoned(v as string | number | bigint, f.precision, f.scale);
        break;
      case "int":
        bytes = encodeInt(v as string | number | bigint, f.size as 2 | 4 | 8);
        break;
    }
    out.set(bytes, f.offset);
  }
  return { data: out, nulls };
}

export { buildRecordLayout, type ColumnLayoutInput, type RecordLayout };

// ---- フレーム組み立て（原典の send*Request に対応） ----

/**
 * EXCSAT（交換サーバー属性）。**原典の固定 126 バイトをそのまま送る**。
 * マネージャレベル一覧（MGRLVLLS）の中身は合意事項であり、こちらで削ると相手が拒否しうる。
 */
function buildExcsat(): Uint8Array {
  const mgr = new DdmWriter();
  const levels: [number, number][] = [
    [0x1403, 3], // AGENT
    [0x1423, 3], // ALTINDF
    [0x1405, 3], // CMBACCAM
    [0x1406, 3], // CMBKEYAM
    [0x1407, 3], // CMBRNBAM
    [0x1474, 5], // CMNTCPIP
    [0x1458, 1], // DICTIONARY
    [0x1457, 3], // DIRECTORY
    [0x140c, 3], // DIRFIL
    [0x1419, 3], // DRCAM
    [0x141e, 3], // KEYFIL
    [0x1422, 3], // LCKMGR
    [0x240f, 3], // RDB
    [0x1432, 3], // RELKEYAM
    [0x1433, 3], // RELRNBAM
    [0x1440, 1], // SECMGR
    [0x143b, 3], // SEQFIL
    [0x2407, 3], // SQLAM
    [0x1463, 3], // STRAM
    [0x1465, 3], // STRFIL
    [0x143c, 3], // SUPERVISOR
    [0x147f, 4], // SYSCMDMGR
    [0x14a0, 4] // RSCRCVM
  ];
  for (const [cp, lvl] of levels) mgr.u16(cp).u16(lvl);

  const body = new DdmWriter();
  const inner = new DdmWriter();
  // EXTNAM は EBCDIC "TBOX2"（原典の値。クライアント識別名で、内容は任意だが長さが効く）
  inner.bytes(param(DDM_CP.EXTNAM, Uint8Array.from([0xe3, 0xc2, 0xd6, 0xe7, 0xf2])));
  // SRVCLSNM は CHRSTRDR(0x0009) を内包し EBCDIC "QA5"
  const srv = new DdmWriter();
  srv.bytes(param(0x0009, Uint8Array.from([0xd8, 0xc1, 0xe2])));
  inner.bytes(param(0x1147, srv.build()));
  inner.bytes(param(0x1404, mgr.build())); // MGRLVLLS
  body.bytes(param(DDM_CP.EXCSAT, inner.build()));
  return frame(FMT_RQSDSS, 0, body.build());
}

/** ACCSEC。SECMEC に SHA、SECTKN にクライアント乱数 8 バイト */
function buildAccsec(clientSeed: Uint8Array): Uint8Array {
  const inner = new DdmWriter();
  const mec = new DdmWriter().u16(SECMEC_SHA);
  inner.bytes(param(DDM_CP.SECMEC, mec.build()));
  inner.bytes(param(DDM_CP.SECTKN, clientSeed));
  const body = new DdmWriter().bytes(param(DDM_CP.ACCSEC, inner.build()));
  return frame(FMT_RQSDSS, 1, body.build());
}

/** SECCHK。USRID は EBCDIC 10 バイト、PASSWORD は置換値 */
function buildSecchk(
  userEbcdic: Uint8Array,
  substitute: Uint8Array,
  passwordLevel: number
): Uint8Array {
  const inner = new DdmWriter();
  // SHA（置換値 20 バイト）なら 8、DES なら 6。DES 経路は未対応（password.ts が弾く）
  const mec = new DdmWriter().u16(substitute.length === 20 ? SECMEC_SHA : passwordLevel);
  inner.bytes(param(DDM_CP.SECMEC, mec.build()));
  inner.bytes(param(DDM_CP.USRID, userEbcdic.subarray(0, 10)));
  inner.bytes(param(DDM_CP.PASSWORD, substitute));
  const body = new DdmWriter().bytes(param(DDM_CP.SECCHK, inner.build()));
  return frame(FMT_RQSDSS, 2, body.build());
}

/**
 * S38OPEN。UFCB（User File Control Block）を組み立てる。
 * **書き込み専用**に固定しているので、原典の分岐のうち `doWrite && !doRead` の経路だけを持つ。
 */
function buildS38Open(
  correlationId: number,
  dclNam: Uint8Array,
  library: string,
  file: string,
  member: string,
  recordFormat: string,
  blockingFactor: number
): Uint8Array {
  const ufcb = new DdmWriter();
  ufcb.bytes(padName10(file, encode37));
  ufcb.u16(72); // WDMHLIB
  ufcb.bytes(padName10(library, encode37));
  ufcb.u16(73); // WDMHMBR
  ufcb.bytes(padName10(member, encode37));
  ufcb.u32(0).u32(0).u32(0); // 12 バイト空き
  // open オプション: 0x1002 を基底に、**書き込み専用は 0x10**
  ufcb.u16(0x1002 | 0x10);
  ufcb.u32(0xf0f1f0f0); // リリース・バージョン
  ufcb.u32(0);
  ufcb.u32(0x20000000); // レコードブロッキング ON
  ufcb.u32(0x02000000); // NULL 可能フィールドを扱う
  ufcb.u32(0).u32(0).u32(0).u32(0);
  ufcb.u16(6).u8(0); // LVLCHK しない
  ufcb.u16(58).u8(0xc0); // SEQONLY = YES（読み書き両方でないため）
  // ブロッキング係数。原典も open 要求に載せる（`sendS38OpenRequest` の `writeShort(batchSize)`）。
  // **形式上の上限は 0x7FFF**（原典が `batchSize & 0x7FFF` で丸める）
  ufcb.u16(Math.max(1, Math.min(blockingFactor, 0x7fff)));
  ufcb.u16(9).u16(1).u16(1); // レコード形式グループ / 最大 / 現在
  ufcb.bytes(padName10(recordFormat, encode37));
  ufcb.u16(32767); // 可変長 UFCB の終端

  const inner = new DdmWriter();
  inner.bytes(param(DDM_CP.DCLNAM, dclNam));
  inner.bytes(param(DDM_CP.S38UFCB, ufcb.build()));
  const body = new DdmWriter().bytes(param(DDM_CP.S38OPEN, inner.build()));
  return frame(FMT_RQSDSS, correlationId, body.build());
}

/** S38PUTM（書き込み要求。データは続く S38BUF に載る） */
function buildS38Putm(correlationId: number, dclNam: Uint8Array): Uint8Array {
  const inner = new DdmWriter().bytes(param(DDM_CP.DCLNAM, dclNam));
  const body = new DdmWriter().bytes(param(DDM_CP.S38PUTM, inner.build()));
  // フォーマット ID 0x51 = チェイン(0x40) ＋ 同一相関(0x10) ＋ RQSDSS(0x01)
  return frame(0x51, correlationId, body.build());
}

/**
 * S38BUF（レコードデータ）。
 * `recordIncrement - recordLength` の差分が **NULL 指標マップ**で、
 * 0xF0 = 非 NULL / 0xF1 = NULL（原典 :1596-1601）。
 */
function buildS38Buf(
  correlationId: number,
  records: readonly DdmRecord[],
  recordIncrement: number
): Uint8Array {
  // **N 件を recordIncrement 刻みで並べるだけ**。1 件のときと構造は同じで、
  // 長さが N 倍になる（原典 `sendS38BUFRequest`: `total = batchSize * recordIncrement`）
  const payload = new Uint8Array(records.length * recordIncrement).fill(0xf0);
  for (let n = 0; n < records.length; n++) {
    const { data, nulls } = records[n]!;
    const base = n * recordIncrement;
    payload.set(data, base);
    // 固定部の後ろが NULL 指標マップ。列ごとに 0xF1 = NULL / 0xF0 = 非 NULL
    for (let i = 0; i < nulls.length && data.length + i < recordIncrement; i++) {
      if (nulls[i]) payload[base + data.length + i] = 0xf1;
    }
  }
  const body = new DdmWriter().bytes(param(DDM_CP.S38BUF, payload));
  return frame(FMT_OBJDSS_SAME_CORR, correlationId, body.build());
}

/**
 * 1 バッチに詰められる最大件数。
 *
 * S38BUF の LL は **2 バイト**で、外側フレームが `total + 10`、内側が `total + 4` を書く
 * （原典 `sendS38BUFRequest`）。よって `N * recordIncrement + 10 <= 65535`。
 * 加えて原典が `batchSize & 0x7FFF` で丸めるので 32767 件が形式上の上限。
 */
export function maxBatchSize(recordIncrement: number): number {
  if (recordIncrement <= 0) return 1;
  return Math.max(1, Math.min(0x7fff, Math.floor((0xffff - 10) / recordIncrement)));
}

/** 要求値・形式上の上限・レコード長から決まる上限の最小 */
export function effectiveBatchSizeFor(requested: number, recordIncrement: number): number {
  return Math.max(1, Math.min(Math.floor(requested), maxBatchSize(recordIncrement)));
}

function buildS38Close(correlationId: number, dclNam: Uint8Array): Uint8Array {
  const inner = new DdmWriter().bytes(param(DDM_CP.DCLNAM, dclNam));
  const body = new DdmWriter().bytes(param(DDM_CP.S38CLOSE, inner.build()));
  return frame(FMT_RQSDSS, correlationId, body.build());
}

// ---- 応答の解析 ----

/** S38MSGRM の中身（SVRCOD / S38MID / S38MTEXT）。原典 `getMessage` に対応 */
function readMessage(r: DdmReader, ll: number): DdmMessage {
  let id = "";
  let text = "";
  let read = 0;
  while (read < ll - 4) {
    const msgLl = r.u16("msg LL");
    const msgCp = r.u16("msg CP");
    switch (msgCp) {
      case 0x1149: // SVRCOD
        r.u16("severity");
        r.skip(msgLl - 6, "svrcod rest");
        break;
      case 0xd112: // S38MID
        id = decode37(r.take(msgLl - 4, "msg id")).trim();
        break;
      case 0xd116: // S38MTEXT
        r.skip(2, "text pad");
        text = decode37(r.take(msgLl - 6, "msg text")).trim();
        break;
      default:
        r.skip(msgLl - 4, "msg skip");
    }
    read += msgLl;
  }
  return { id, text };
}

/** フレーム内のメッセージをすべて集める */
function readMessages(r: DdmReader, frameLength: number): DdmMessage[] {
  const messages: DdmMessage[] = [];
  let numRead = 6;
  while (numRead + 4 <= frameLength && r.remaining >= 4) {
    const ll = r.u16("LL");
    const cp = r.u16("CP");
    numRead += 4;
    if (cp === DDM_CP.S38MSGRM) {
      messages.push(readMessage(r, ll));
    } else {
      r.skip(Math.min(ll - 4, r.remaining), "skip");
    }
    numRead += ll - 4;
  }
  return messages;
}
