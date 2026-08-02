/**
 * ファイルサーバー（QZLSFILE）のデータストリーム。IFS のファイルを読み書きする。
 *
 * signon 系と同じ 20 バイトヘッダーだが、**テンプレート長が要求ごとに違う**。
 * ファイル名は UTF-16BE（CCSID 1200）で送る。
 *
 * 参照: JTOpen(jtopenlite) の FileConnection に対応する。
 */
import { As400Error } from "@ts5250/base";
import type { IfsEntry } from "./ifs-types.js";

/** ファイルサーバーのサーバー ID */
export const FILE_SERVER_ID = 0xe002;

/** 要求 ID */
export const FILE_REQ = {
  open: 0x0002,
  read: 0x0003,
  write: 0x0004,
  close: 0x0009,
  listFiles: 0x000a,
  delete: 0x000c,
  createDir: 0x000d,
  removeDir: 0x000e,
  rename: 0x000f,
  exchangeAttributes: 0x0016
} as const;

/** 読み書きの意図（OPEN の access intent） */
export const FILE_ACCESS = { read: 1, write: 2 } as const;

/**
 * 既存ファイルの扱い（OPEN の duplicate file option）。原典 `IFSOpenReq` の
 * `OPEN_OPTION_*`（値は原典どおり）。
 *
 * 1 = 無ければ作る／有れば**開く**（中身はそのまま残る）
 * 2 = 無ければ作る／有れば**置き換える**（＝開いた時点で 0 バイトになる）
 * 8 = 無ければ失敗／有れば開く
 * 16 = 無ければ失敗／有れば置き換える
 *
 * **「開く」と「置き換える」を取り違えると静かにファイルが壊れる**——
 * 開くだけだと書き込みは先頭からの上書きになり、元の方が長いと末尾が残る。
 * 41 バイトのファイルに 19 バイト保存して 41 バイトのまま、
 * 後半が旧内容という壊れ方を実機で踏んだ（`writeFile` は必ず全文を置く経路）。
 */
export const FILE_DUPLICATE = {
  createOrOpen: 1,
  createOrReplace: 2,
  openExisting: 8,
  replaceExisting: 16
} as const;

/** ファイル名のコードポイント */
const CP_FILENAME = 0x0002;
/**
 * ディレクトリ名のコードポイント。
 * **ファイル名の 0x0002 とは違う**（原典 `IFSCreateDirReq` / `IFSDeleteDirReq`）。
 */
const CP_DIRECTORY_NAME = 0x0001;
/** リネームの元・先の名前のコードポイント（原典 `IFSRenameReq`） */
const CP_RENAME_SOURCE = 0x0003;
const CP_RENAME_TARGET = 0x0004;
/** 一覧の続きを指定する Restart ID のコードポイント */
const CP_RESTART_ID = 0x000e;
/** 書き込みデータのコードポイント */
const CP_DATA = 0x0020;
/** ファイル名の CCSID（UTF-16BE） */
const FILENAME_CCSID = 1200;

/** 整数で範囲内か。小数・NaN・負数を弾く */
function isUint(value: number, max: number, min = 0): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** UTF-16BE のバイト列 */
function utf16be(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) v.setUint16(i * 2, text.charCodeAt(i));
  return out;
}

function writeHeader(v: DataView, total: number, templateLen: number, reqId: number): void {
  v.setUint32(0, total);
  v.setUint16(4, 0); // Header ID
  v.setUint16(6, FILE_SERVER_ID);
  v.setUint32(8, 0); // CS instance
  v.setUint32(12, 0); // Correlation ID
  v.setUint16(16, templateLen);
  v.setUint16(18, reqId);
}

/**
 * 交換属性要求（0x0016）。
 *
 * **接続時に必ず送る**——データストリームレベルと使用する CCSID をここで合わせる。
 */
export function buildFileExchangeAttributes(): Uint8Array {
  const total = 42;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, 10, FILE_REQ.exchangeAttributes);
  v.setUint16(20, 0); // 連鎖指示
  v.setUint16(22, 8); // データストリームレベル（V5R3 以降）
  // 6 = GMT を使う(4) ＋ PC のパターン一致(2)。POSIX 戻りコード(8) は使わない
  v.setUint16(24, 6);
  v.setUint32(26, 0xffffffff); // 最大データブロック（無制限）
  v.setUint32(30, 12); // CCSID の LL
  v.setUint16(34, 10); // CCSID の CP
  v.setUint16(36, 1200); // 優先 CCSID: UTF-16
  v.setUint16(38, 13488); // 同: UnicodeBig
  v.setUint16(40, 61952); // 同: 旧 IFS UnicodeBig
  return out;
}

/**
 * 交換属性応答（0x8009）が報告するデータストリームレベル。
 *
 * **要求した値（`buildFileExchangeAttributes` は 8）以下とは限らない**——
 * PUB400 は 24 を返す（research F3）。OA2 の CCSID をどのオフセットで読むかがこれで決まるので、
 * 要求値から決め打ちにせず、応答の値を保持して使うこと（`parseContentCcsid`）。
 *
 * 参照: JTOpen `IFSExchangeAttrRep.getDataStreamLevel()`（offset 22）。
 */
export function replyDatastreamLevel(frame: Uint8Array): number {
  if (frame.length < 24) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `file server exchange attributes reply too short: ${frame.length} bytes`
    );
  }
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(22);
}

export interface OpenFileOptions {
  path: string;
  /** 読み取りか書き込みか */
  access: number;
  /** 無ければ作るか */
  create: boolean;
  /**
   * 既存の中身を捨てて開くか（既定 false＝残したまま開く）。
   * **全文を置き換える書き込みは必ず true にする**（さもないと元の方が長いとき末尾が残る）。
   */
  replace?: boolean;
  /** ファイル内容の CCSID。0 でサーバー既定 */
  dataCcsid?: number;
}

/** ファイルを開く要求（0x0002） */
export function buildOpenFileRequest(opts: OpenFileOptions): Uint8Array {
  if (opts.path.length === 0) {
    throw new As400Error("CONFIG_ERROR", "path is empty");
  }
  const name = utf16be(opts.path);
  // データストリームレベル 16 未満は 36。誤ると全体の配置がずれ、rc=17 等で失敗する
  const templateLength = 36;
  const total = 26 + templateLength + name.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, templateLength, FILE_REQ.open);

  let at = 20;
  v.setUint16(at, 0); at += 2; // 連鎖指示
  v.setUint16(at, FILENAME_CCSID); at += 2;
  v.setUint32(at, 1); at += 4; // 作業ディレクトリハンドル
  v.setUint16(at, opts.dataCcsid ?? 0); at += 2;
  v.setUint16(at, opts.access); at += 2;
  v.setUint16(at, 0); at += 2; // 共有: 0 = すべて許可
  v.setUint16(at, 0); at += 2; // データ変換なし
  // 「作るか」と「既存をどうするか」の 2 軸。原典の定数はこの 4 通りをそのまま持つ
  v.setUint16(
    at,
    opts.create
      ? opts.replace
        ? FILE_DUPLICATE.createOrReplace
        : FILE_DUPLICATE.createOrOpen
      : opts.replace
        ? FILE_DUPLICATE.replaceExisting
        : FILE_DUPLICATE.openExisting
  );
  at += 2;
  v.setUint32(at, 0); at += 4; // 作成サイズ
  v.setUint32(at, 0); at += 4; // 固定属性
  v.setUint16(at, 1); at += 2; // 属性リストレベル
  v.setUint32(at, 0); at += 4; // 事前読み取りオフセット
  v.setUint32(at, 0); at += 4; // 事前読み取り長
  // ここまでで 20 + 36 = 56
  v.setUint32(at, name.length + 6); at += 4;
  v.setUint16(at, CP_FILENAME); at += 2;
  out.set(name, at);
  return out;
}

/** 読み取り要求（0x0003） */
export function buildReadRequest(handle: number, offset: number, length: number): Uint8Array {
  const templateLength = 22;
  const total = 20 + templateLength;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, templateLength, FILE_REQ.read);
  v.setUint16(20, 0); // 連鎖指示
  v.setUint32(22, handle);
  v.setUint32(26, 0); // 基準オフセット
  v.setUint32(30, offset);
  v.setUint32(34, length);
  v.setUint16(38, 1); // 事前読み取り
  return out;
}

/** 書き込み要求（0x0004） */
export function buildWriteRequest(handle: number, offset: number, data: Uint8Array): Uint8Array {
  // データストリームレベル 16 未満は 18。全体長は 26 + template + データ長
  const templateLength = 18;
  const total = 26 + templateLength + data.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, templateLength, FILE_REQ.write);

  let at = 20;
  v.setUint16(at, 0); at += 2; // 連鎖指示
  v.setUint32(at, handle); at += 4;
  v.setUint32(at, 0); at += 4; // 基準オフセット
  v.setUint32(at, offset); at += 4;
  // データフラグ: 3 = 書き込みを確定させる（2 は同期せず即戻る）
  v.setUint16(at, 3); at += 2;
  v.setUint16(at, 0); at += 2; // データ CCSID（0 = 変換しない）
  // ここまでで 20 + 18 = 38
  v.setUint32(at, data.length + 6); at += 4;
  v.setUint16(at, CP_DATA); at += 2;
  out.set(data, at);
  return out;
}

/** 閉じる要求（0x0009） */
export function buildCloseRequest(handle: number): Uint8Array {
  const templateLength = 6;
  const total = 20 + templateLength;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, templateLength, FILE_REQ.close);
  v.setUint16(20, 0); // 連鎖指示
  v.setUint32(22, handle);
  return out;
}

export interface ListFilesOptions {
  /** 最大取得件数。既定 0xFFFF（無制限相当） */
  maxCount?: number;
  /** 属性リストレベル。既定 0x0101 */
  attributeListLevel?: number;
  /** パターン一致（0 = しない / 1 = する）。既定 1 */
  patternMatching?: number;
  /**
   * 続きから取るための Restart ID（応答の offset 77 の値）。
   *
   * 原典（`IFSListAttrsReq`）のコメントに File Server チーム由来の注意がある——
   * **QDLS と QSYS は Restart *Name* を許すが /root（EPFS）は許さない**。
   * IFS ルート配下を辿る本 UI では ID の方を使う。
   */
  restartId?: number;
}

/**
 * ディレクトリ一覧要求（0x000A）。
 *
 * **応答は 1 エントリ = 1 フレームで連鎖して返る**（ReqRep 0x8005）。
 * 最後に 0x8001 が rc=18（No more files）で来て終わる。
 * したがって `request()` ではなく `requestStream()` で受けること。
 *
 * path はワイルドカード付きで渡す（例 `/home/USER/ifsdemo/*`）。
 */
export function buildListFilesRequest(path: string, opts: ListFilesOptions = {}): Uint8Array {
  if (path.length === 0) {
    throw new As400Error("CONFIG_ERROR", "path is empty");
  }
  // 範囲外は**黙って切り詰められる**（setUint16 に 65536 を渡すと 0 になり「無制限」に化ける）。
  // これらは HTTP の本文から来るので、ここで弾く
  if (opts.maxCount !== undefined && !isUint(opts.maxCount, 0xffff, 1)) {
    throw new As400Error("CONFIG_ERROR", `maxCount out of range: ${opts.maxCount}`);
  }
  if (opts.restartId !== undefined && !isUint(opts.restartId, 0xffffffff)) {
    throw new As400Error("CONFIG_ERROR", `restartId out of range: ${opts.restartId}`);
  }
  const name = utf16be(path);
  const templateLength = 20;
  // Restart ID は名前の後ろに LL(4)+CP(2)+値(4) = 10 バイトの塊として足す
  const restart = opts.restartId !== undefined ? 10 : 0;
  const total = 26 + templateLength + name.length + restart; // 46 + 名前 (+ 10)
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, templateLength, FILE_REQ.listFiles);

  let at = 20;
  v.setUint16(at, 0); at += 2; // 連鎖指示
  v.setUint32(at, 0); at += 4; // ファイルハンドル
  v.setUint16(at, FILENAME_CCSID); at += 2;
  v.setUint32(at, 1); at += 4; // 作業ディレクトリハンドル
  v.setUint16(at, 0); at += 2; // 権限チェック
  v.setUint16(at, opts.maxCount ?? 0xffff); at += 2;
  v.setUint16(at, opts.attributeListLevel ?? 0x0101); at += 2;
  v.setUint16(at, opts.patternMatching ?? 1); at += 2;
  // ここまでで 20 + 20 = 40
  v.setUint32(at, name.length + 6); at += 4;
  v.setUint16(at, CP_FILENAME); at += 2;
  out.set(name, at); at += name.length;
  if (opts.restartId !== undefined) {
    v.setUint32(at, 10); at += 4;
    v.setUint16(at, CP_RESTART_ID); at += 2;
    v.setUint32(at, opts.restartId);
  }
  return out;
}

/**
 * 属性リストレベル: OA2 構造体を返させる ＋ 開いたインスタンス（ファイルハンドル）を使う。
 * 原典 `IFSListAttrsReq(handle, OA2, …)` の `0x44`。OA1 は 0x42、OA なしは 0x01。
 */
const ATTR_LIST_LEVEL_OA2 = 0x44;
/** OA2 構造体のコードポイント（OA1 は 0x0010）。原典 `IFSListAttrsRep.getObjAttrBytes` */
const CP_OBJ_ATTRS2 = 0x000f;

/**
 * ハンドル指定の属性一覧要求（0x000A）。**ファイル内容の CCSID タグを取るための唯一の経路**。
 *
 * 原典 `IFSFileDescriptorImplRemote.listObjAttrs()` の設計メモ:
 * 「OA* 構造体を応答に含めさせるには、名前ではなく**ハンドル**でファイルを指定しなければならない」。
 * 実際、パターン指定の一覧（`buildListFilesRequest`）では OA2 が返らず、
 * 応答 offset 73 は名前の CCSID（1200）でしかない（research F1-5）。
 *
 * **応答は `request()` で受けること**——`requestStream()` は使わない。
 * パターン指定の一覧と違い、**終端フレーム（0x8001 rc=18）は来ない**。
 * 連鎖指示 0 の `0x8005` が 1 フレーム返って終わりで、次を待つと 20 秒固まる（research F2 で実測）。
 */
export function buildListAttrsByHandleRequest(handle: number): Uint8Array {
  if (!isUint(handle, 0xffffffff)) {
    throw new As400Error("CONFIG_ERROR", `invalid file handle: ${handle}`);
  }
  const templateLength = 20;
  const total = 20 + templateLength; // ハンドル指定＝名前を送らないので可変部は無い
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, templateLength, FILE_REQ.listFiles);
  v.setUint16(20, 0); // 連鎖指示
  v.setUint32(22, handle);
  v.setUint16(26, 0); // 名前 CCSID: ハンドル指定では使わない（原典も設定しない）
  v.setUint32(28, 1); // 作業ディレクトリハンドル
  v.setUint16(32, 0); // 権限チェック不要（既に開けているため）
  v.setUint16(34, 0xffff); // 最大件数: 無制限
  v.setUint16(36, ATTR_LIST_LEVEL_OA2);
  v.setUint16(38, 0); // パターン一致: POSIX
  return out;
}

/**
 * OA2 応答（0x8005）から**ファイル内容の CCSID タグ**を取り出す。取れなければ `undefined`。
 *
 * 可変部（`20 + 宣言テンプレート長`。ハンドル指定の応答は 8 で、一覧応答の 93 とは違う）から
 * LL/CP を辿り、CP が `0x000F` の塊が OA2 本体（LL/CP の 6 バイトを除いた部分）。
 *
 * **CCSID の位置はサーバーが報告したデータストリームレベルで変わる**
 * （原典 `IFSObjAttrs2.determineCCSIDOffset`）。固定値を埋め込まないこと:
 *
 * - 0 → OA2: 126（コードページ）
 * - 0xF4F4 → OA2a: 142（コードページ）
 * - それ以外 → OA2b / OA2c: 134（CCSID of object）
 *
 * タグは**中身を説明しているとは限らない**（我々が書いた UTF-8 のファイルに 850 が付く。research F4）。
 * 復号の決定表では中身の推定を先に置くこと。
 */
export function parseContentCcsid(frame: Uint8Array, datastreamLevel: number): number | undefined {
  if (replyId(frame) !== REPLY_LIST_ENTRY || frame.length < 20) return undefined;
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const offsetInOa = datastreamLevel === 0 ? 126 : datastreamLevel === 0xf4f4 ? 142 : 134;
  let at = 20 + v.getUint16(16);
  while (at + 6 <= frame.length) {
    const ll = v.getUint32(at);
    if (ll < 6 || at + ll > frame.length) return undefined; // 壊れた LL で無限ループ・範囲外にしない
    if (v.getUint16(at + 4) === CP_OBJ_ATTRS2) {
      const valueAt = at + 6 + offsetInOa;
      // 構造体が短い（想定より古い OA2 形）なら、無関係なバイトを CCSID として読まない
      if (valueAt + 2 > at + ll) return undefined;
      return v.getUint16(valueAt);
    }
    at += ll;
  }
  return undefined;
}

/**
 * ディレクトリ作成要求（0x000D）。
 *
 * 参照: JTOpen `IFSCreateDirReq`。
 *
 * **コードポイントが 0x0001 で、ファイル名の 0x0002 とは違う。**
 * 形がほぼ同じ `buildDeleteRequest`（0x0002）からコピペすると、ここだけが残って壊れる。
 *
 * 応答は 0x8001（`IFSReturnCodeRep`）で返るが、**これはエラーを意味しない**——rc=0 が成功。
 */
export function buildCreateDirRequest(path: string): Uint8Array {
  if (path.length === 0) {
    throw new As400Error("CONFIG_ERROR", "path is empty");
  }
  const name = utf16be(path);
  const templateLength = 8;
  const total = 34 + name.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, templateLength, FILE_REQ.createDir);
  v.setUint16(20, 0); // 連鎖指示
  v.setUint16(22, FILENAME_CCSID);
  v.setUint32(24, 1); // 作業ディレクトリハンドル
  v.setUint32(28, name.length + 6);
  v.setUint16(32, CP_DIRECTORY_NAME);
  out.set(name, 34);
  return out;
}

/** listFiles の 1 エントリ応答の ReqRep ID */
export const REPLY_LIST_ENTRY = 0x8005;

/** 固定属性のビット（DOS 由来）。ディレクトリ判定の裏取りに使う */
const FA_DIRECTORY = 0x10;

/** 一覧を最後まで返しきったことを表す戻りコード */
const RC_NO_MORE_FILES = 18;
/**
 * 一覧が**件数上限で打ち切られた**ことを表す戻りコード。
 *
 * 実機で確認: `maxCount` に達して止まると 0x8001 が rc=**0** で返り、
 * 全件返しきったときだけ rc=18 になる。原典にこの区別の記述は見当たらず、
 * 実機のダンプで判明した（research F1 の追試）。
 */
const RC_TRUNCATED = 0;
/**
 * 一覧応答の種類。
 *
 * **終端は連鎖指示では判定できない**——実機（PUB400）では最後のエントリでも
 * 連鎖指示が `0x0001` のままで 0 に落ちない。連鎖ビットで抜けようとすると、
 * 来ないフレームを待ち続けてハングする。`0x8001` の受信で終端とすること。
 */
export type ListReplyKind = "entry" | "end" | "truncated" | "error";

/**
 * 続きを取りに行ってよいか。**Restart ID が前へ進むときだけ true**。
 *
 * 実機の `/QSYS.LIB` は全エントリの Restart ID を 0 で返す。これを次の要求に渡すと
 * 毎回先頭の数件が返り、**無限ループになる**（実際に踏んだ。decisions D6）。
 * `/home` では 6 → 1401 → 2157 と単調に増えるので、単調増加を条件にすれば
 * 「0 が返る」「同じ値が返る」「後戻りする」をまとめて弾ける。
 *
 * 接続クラスの中ではなくここに置いてあるのは、**接続を張らずに単体テストするため**。
 * 中に埋めるとテスト側に式を写すことになり、本体を壊しても気づけないテストになる。
 */
export function canRestartFrom(last: number | undefined, requested?: number): boolean {
  if (last === undefined) return false;
  return last > (requested ?? 0);
}

export function listReplyKind(frame: Uint8Array): ListReplyKind {
  const id = replyId(frame);
  if (id === REPLY_LIST_ENTRY) return "entry";
  if (id !== REPLY_ERROR) return "error";
  const rc = replyReturnCode(frame);
  if (rc === RC_NO_MORE_FILES) return "end";
  if (rc === RC_TRUNCATED) return "truncated";
  // 「存在しない」も含めて `error` に寄せ、rc → コードの対応は `fileFailure` 1 箇所に持たせる。
  // ここでも rc を分類すると「どの rc が not-found か」の真実が 2 箇所になり、片方だけ直る
  return "error";
}

/**
 * ファイルサーバーの戻りコードを、**呼び出し側が区別できる** `As400Error` に変換する。
 *
 * まとめて `PROTOCOL_ERROR` にすると server 側で 502（＝上流の通信失敗）に落ち、
 * 「ホストが落ちている」と「指定が間違っている」を利用者が区別できなくなる。
 *
 * `replyId` を受け取るのは、**`0x8001` 以外の応答で rc を語らないため**——
 * `replyReturnCode()` は非 `0x8001` に対して 0 を返す仕様なので、
 * その 0 を戻りコードとして文言にすると「error 0」という無意味な表示になる。
 */
/** OPEN の成功応答。テンプレート先頭がファイルハンドル（戻りコードではない） */
export const REPLY_OPEN = 0x8002;
/** WRITE の成功応答。**0x8001 ではない**（実機で確認） */
export const REPLY_WRITE = 0x800b;

/**
 * 応答が成功か検査し、失敗なら区別できるエラーを投げる。
 *
 * **成功応答の ReqRep ID は要求ごとに違う**（実機で確認）:
 * mkdir と delete は `0x8001` で rc=0、**WRITE は `0x800B`**、OPEN は `0x8002`。
 * 揃っていると思い込んで一律に `0x8001` を期待すると、書き込みが
 * `unexpected reply 0x800b` で全部落ちる（実際に踏んだ）。
 *
 * 個別に書くと、`replyReturnCode()` が非 `0x8001` に対して 0 を返す仕様を踏んで
 * **想定外の応答を成功と誤認する**。判定をここに集めて、片方だけ直す事故を防ぐ。
 *
 * @param successReplyId この ID なら成功とみなす（`0x8001` rc=0 は常に成功扱い）
 */
export function assertOk(reply: Uint8Array, what: string, successReplyId?: number): void {
  const id = replyId(reply);
  if (successReplyId !== undefined && id === successReplyId) return;
  const rc = replyReturnCode(reply);
  if (id === REPLY_ERROR && rc === 0) return;
  throw fileFailure(what, rc, id);
}

export function fileFailure(what: string, rc: number, replyId: number): As400Error {
  if (replyId !== REPLY_ERROR) {
    return new As400Error(
      "PROTOCOL_ERROR",
      `${what}: unexpected reply 0x${replyId.toString(16).padStart(4, "0")}`
    );
  }
  const detail = `${what}: ${fileErrorText(rc)} (rc=${rc})`;
  switch (rc) {
    case 2:
    case 3:
      return new As400Error("NOT_FOUND", detail);
    case 4:
      return new As400Error("ALREADY_EXISTS", detail);
    case 5:
    case 13:
      return new As400Error("ACCESS_DENIED", detail);
    // 中身が残っている（rmdir）。**待っても権限を足しても変わらない**——
    // 中を先に消すという別の行動が要るので、専用のコードで返す
    case 9:
      return new As400Error("NOT_EMPTY", detail);
    // 使用中 / 共有違反 / ロック違反。権限ではなく**時間**の問題なので、
    // 「ホストが落ちている」を意味する扱いにしない（待てば通りうる）
    case 1:
    case 32:
    case 33:
      return new As400Error("RESOURCE_BUSY", detail);
    default:
      return new As400Error("PROTOCOL_ERROR", detail);
  }
}

/**
 * 一覧エントリ応答（0x8005）を解く。
 *
 * 参照: JTOpen の `IFSListAttrsRep`（フィールド位置）と `IFSFileImplRemote`（種別の判定方法）。
 * 配置は**実機のダンプで確かめた**（research F1-3）。原典と食い違う点が 2 つある:
 *
 * - jtopenlite は offset 73 を「ファイル内容の CCSID」として読むが、**実機では常に 1200**（名前の CCSID）で、
 *   内容の CCSID は応答に載っていない。JTOpen 本体の `NAME_CCSID_OFFSET` の方が正しい
 * - 原典の読み方は templateLength >= 92 を暗黙に仮定するが、**実機は 93 を返す**。
 *   固定値を埋め込むと LL を 1 バイトずれて読み、名前が空になる。宣言値を使うこと
 */
export function parseListEntry(frame: Uint8Array): IfsEntry {
  // 固定部の末尾（symlink フラグ）まで読めることを先に確かめる
  if (frame.length < 92) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `file server list entry too short: ${frame.length} bytes`
    );
  }
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

  // 更新日時: 4 バイト秒（UNIX エポック）＋ 4 バイトマイクロ秒。実機の値が作成時刻と一致することを確認済み
  const modifiedAt = v.getUint32(30) * 1000 + Math.floor(v.getUint32(34) / 1000);

  // **固定属性は 4 バイト**。2 バイトで読むと上位が 0 で埋まり、全エントリが 0 になる
  const fixedAttributes = v.getUint32(50);
  const objectType = v.getUint16(54);
  const restartId = v.getUint32(77);
  // サイズは 8 バイト版を使う（交換属性でデータストリームレベル 8 を要求済み）。
  // 4 バイト版（offset 46）は 4GB 超で溢れる
  const size = Number(v.getBigUint64(81));
  const isSymlink = v.getUint8(91) === 1;

  // 種別だけでは足りない——QSYS の LIB/PF が種別 2 で返るため、固定属性のビットで裏を取る
  // （JTOpen 本体 `IFSFileImplRemote.determineIsDirectory` と同じ考え方）
  const isDirectory = objectType === 2 && (fixedAttributes & FA_DIRECTORY) !== 0;

  // 名前は「宣言された」テンプレート長の後ろ。固定値にしないこと（上のヘッダ参照）
  const templateLength = v.getUint16(16);
  const llAt = 20 + templateLength;
  if (frame.length < llAt + 6) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `file server list entry has no name (templateLength=${templateLength}, frame=${frame.length})`
    );
  }
  const nameBytes = v.getUint32(llAt) - 6;
  const nameAt = llAt + 6;
  // **奇数長も弾く**。名前は UTF-16BE なので偶数バイトのはず。
  // 奇数を通すと 2 バイトずつ読むループの最後の 1 回が範囲外に出て、
  // As400Error ではなく生の RangeError が飛ぶ（呼び出し側が分類できなくなる）
  if (nameBytes < 0 || nameBytes % 2 !== 0 || nameAt + nameBytes > frame.length) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `file server list entry name length out of range (${nameBytes} bytes at ${nameAt}, frame=${frame.length})`
    );
  }
  let name = "";
  for (let i = 0; i < nameBytes; i += 2) name += String.fromCharCode(v.getUint16(nameAt + i));

  return { name, isDirectory, isSymlink, size, modifiedAt, restartId };
}

/** 削除要求（0x000C） */
export function buildDeleteRequest(path: string): Uint8Array {
  const name = utf16be(path);
  const templateLength = 8;
  const total = 34 + name.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, templateLength, FILE_REQ.delete);
  v.setUint16(20, 0); // 連鎖指示
  v.setUint16(22, FILENAME_CCSID);
  v.setUint32(24, 1); // 作業ディレクトリハンドル
  v.setUint32(28, name.length + 6);
  v.setUint16(32, CP_FILENAME);
  out.set(name, 34);
  return out;
}

/**
 * リネーム要求（0x000F）。**元も先もフルパスで送る**（同じ要求で別フォルダへ移動もできる）。
 *
 * 参照: JTOpen `IFSRenameReq`。テンプレート長 16 で、可変部に
 * 元の名前（CP `0x0003`）→ 先の名前（CP `0x0004`）の順に 2 つ並べる。
 *
 * `replace` は既定 false。**既存の名前を黙って上書きしない**——
 * 上書きしたい場面が来るまで許さない方が、事故が起きたときに戻せる（rc=4 で失敗する）。
 */
export function buildRenameRequest(
  from: string,
  to: string,
  opts: { replace?: boolean } = {}
): Uint8Array {
  if (from.length === 0 || to.length === 0) {
    throw new As400Error("CONFIG_ERROR", "rename needs both source and target paths");
  }
  const src = utf16be(from);
  const dst = utf16be(to);
  const templateLength = 16;
  const total = 20 + templateLength + 6 + src.length + 6 + dst.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, templateLength, FILE_REQ.rename);
  v.setUint16(20, 0); // 連鎖指示
  v.setUint16(22, FILENAME_CCSID); // 元の名前の CCSID
  v.setUint16(24, FILENAME_CCSID); // 先の名前の CCSID
  v.setUint32(26, 1); // 元の作業ディレクトリハンドル
  v.setUint32(30, 1); // 先の作業ディレクトリハンドル
  v.setUint16(34, opts.replace ? 1 : 0); // 置換フラグ
  v.setUint32(36, src.length + 6);
  v.setUint16(40, CP_RENAME_SOURCE);
  out.set(src, 42);
  const at = 42 + src.length;
  v.setUint32(at, dst.length + 6);
  v.setUint16(at + 4, CP_RENAME_TARGET);
  out.set(dst, at + 6);
  return out;
}

/**
 * ディレクトリ削除要求（0x000E）。
 *
 * **ファイル削除（0x000C）と形が違う**（原典 `IFSDeleteDirReq`）——
 * テンプレート長が 10 で、名前 LL の前に**フラグ 2 バイト**が入る。
 * `buildDeleteRequest` をコピーしてコードポイントだけ差し替えると、そこで 2 バイトずれる。
 *
 * 中身が残っていると rc=9（`NOT_EMPTY`）で失敗する。再帰的に消すのは呼び出し側の責任。
 */
export function buildRemoveDirRequest(path: string): Uint8Array {
  if (path.length === 0) {
    throw new As400Error("CONFIG_ERROR", "path is empty");
  }
  const name = utf16be(path);
  const templateLength = 10;
  const total = 20 + templateLength + 6 + name.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, templateLength, FILE_REQ.removeDir);
  v.setUint16(20, 0); // 連鎖指示
  v.setUint16(22, FILENAME_CCSID);
  v.setUint32(24, 1); // 作業ディレクトリハンドル
  v.setUint16(28, 0); // フラグ（原典も 0 固定）
  v.setUint32(30, name.length + 6);
  v.setUint16(34, CP_DIRECTORY_NAME);
  out.set(name, 36);
  return out;
}

/**
 * エラー応答の ReqRep ID。
 *
 * **応答は ReqRep ID で意味が変わる**——`0x8001` はエラーで、テンプレート先頭が戻りコード。
 * 成功応答（`0x8002` = OPEN 等）は戻りコードを持たず、テンプレート先頭が結果そのもの。
 * ここを取り違えると、ハンドルを戻りコードとして読んでしまう。
 */
export const REPLY_ERROR = 0x8001;

/** 応答の ReqRep ID */
export function replyId(frame: Uint8Array): number {
  if (frame.length < 20) {
    throw new As400Error("PROTOCOL_ERROR", `file server reply too short: ${frame.length} bytes`);
  }
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(18);
}

/**
 * エラー応答なら戻りコードを返す。成功応答なら 0。
 *
 * **テンプレートの先頭 2 バイトは連鎖指示**で、戻りコードはその次（オフセット 22）。
 * 20 を読むと常に 0 に見えて、失敗を成功と誤認する。
 */
export function replyReturnCode(frame: Uint8Array): number {
  if (replyId(frame) !== REPLY_ERROR) return 0;
  if (frame.length < 24) {
    throw new As400Error("PROTOCOL_ERROR", "file server error reply has no return code");
  }
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(22);
}

/** 戻りコードの意味（原典 FileConstants） */
export function fileErrorText(rc: number): string {
  switch (rc) {
    case 1:
      return "File in use";
    case 2:
      return "File not found";
    case 3:
      return "Path not found";
    case 4:
      return "Duplicate directory entry name";
    case 5:
      return "Access denied to directory entry";
    case 6:
      return "Invalid handle";
    case 7:
      return "Invalid directory entry name";
    case 9:
      return "Directory not empty";
    case 13:
      return "Access denied";
    case 16:
      return "Invalid request";
    case 17:
      return "Data stream syntax error";
    case 18:
      return "No more files";
    case 22:
      return "No more data";
    case 32:
      return "Sharing violation";
    case 33:
      return "Lock violation";
    default:
      return `error ${rc}`;
  }
}

/**
 * OPEN 応答（0x8002）のファイルハンドル。
 * 連鎖指示(2) の次から 4 バイト。
 */
export function replyFileHandle(frame: Uint8Array): number {
  if (frame.length < 26) {
    throw new As400Error("PROTOCOL_ERROR", "file server open reply has no handle");
  }
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(22);
}

/** READ 成功応答の ReqRep ID */
export const REPLY_READ = 0x8003;

/**
 * READ 応答からデータを取り出す。
 *
 * **LL/CP 形式ではない**——連鎖指示(2) ＋ CCSID(2) ＋ データ長(4) の後に実データが続き、
 * 実データの長さは「データ長 − 6」。ここを LL/CP と誤解すると 0 バイトになる。
 */
export function readReplyData(frame: Uint8Array): Uint8Array | undefined {
  if (replyId(frame) !== REPLY_READ) return undefined;
  if (frame.length < 28) return undefined;
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  // 20: 連鎖指示(2) / 22: CCSID(2) / 24: データ長(4) / 28: データ
  // データ長には LL/CP の 6 バイトが含まれる。実データはその 6 バイト後ろから始まる
  const declared = v.getUint32(24) - 6;
  if (declared <= 0) return undefined;
  // 配置: 20 連鎖指示(2) / 22 CCSID(2) / 24 データ長(4) / 28 LL・CP 相当(2) / 30 データ
  //
  // 応答が宣言するテンプレート長からは求められない（宣言値とデータ開始位置が一致しない）。
  // 実機で確認した固定配置を使う。**変更するときは必ず実機で往復を確かめること**——
  // テンプレート長から求める形に「整理」して壊した実績がある。
  const dataAt = 30;
  const available = frame.length - dataAt;
  if (available <= 0) return undefined;
  return frame.subarray(dataAt, dataAt + Math.min(declared, available));
}

export { CP_DATA as FILE_CP_DATA };
