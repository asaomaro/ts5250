/**
 * SQL の結果セットを保持する（画面のページング用）。
 *
 * **これはこのアプリで唯一「接続を掴み続ける」場所である。**
 * ホストサーバー接続は原則として単発完結（`20260719-hostserver-mcp-tools` D2）だが、
 * 遅延ローディングは状態なしでは成立しない——実測で、1 ページごとに接続を張り直すと
 * **150 件 3 ページで 19 秒**かかった（カーソルを保持すれば 2.4 秒）。
 *
 * MCP の `host_sql` は単発完結のまま変えていない。状態を持つのは**画面の都合**なので、
 * 画面の経路にだけ持たせる。
 *
 * 掴み続ける以上、歯止めを型と実装で持つ:
 *   - アイドル 60 秒で閉じる
 *   - 1 利用者あたり 4 つまで（超えたら**最も古いものを閉じる**）
 *   - プロセス終了時に全部閉じる
 */
import { childLog, type As400Error, type ColumnMeta, type DbConnection, type Row } from "@as400web/core";
import { assertOwner, type AuthUser } from "./auth.js";

const log = childLog({ component: "result-set" });

/** アイドルで閉じるまで。スクロール間隔としては十分な長さ */
const IDLE_MS = 60_000;
/** 1 利用者が同時に開ける数 */
const MAX_PER_USER = 4;

export interface ResultSet {
  id: string;
  owner: string | undefined;
  columns: ColumnMeta[];
  /** 次の行を取り出す。カーソルは開いたまま */
  rows: AsyncGenerator<Row, void, undefined>;
  conn: DbConnection;
  /**
   * 読み終わった接続の始末。既定は閉じる。
   * プールを使う経路では**閉じずにプールへ返す**（`db-pool.ts` 参照）。
   */
  release: (conn: DbConnection) => void;
  /** 先読みして持ち越した 1 行（「続きがあるか」の判定に使う） */
  pending?: Row | undefined;
  done: boolean;
  lastUsed: number;
}

export interface PageResult {
  rows: Row[];
  hasMore: boolean;
}

export class ResultSetStore {
  private readonly sets = new Map<string, ResultSet>();
  private seq = 0;

  constructor(
    private readonly idleMs: number = IDLE_MS,
    private readonly maxPerUser: number = MAX_PER_USER,
    /** テストから時刻を差し替える */
    private readonly now: () => number = () => Date.now()
  ) {}

  get size(): number {
    return this.sets.size;
  }

  /**
   * 結果セットを預かる。
   * **1 利用者の上限を超えたら最も古いものを閉じる**（溜め込ませない）。
   */
  open(opts: {
    owner: string | undefined;
    columns: ColumnMeta[];
    rows: AsyncGenerator<Row, void, undefined>;
    conn: DbConnection;
    release?: (conn: DbConnection) => void;
  }): ResultSet {
    this.sweep();
    const mine = [...this.sets.values()].filter((s) => s.owner === opts.owner);
    while (mine.length >= this.maxPerUser) {
      const oldest = mine.reduce((a, b) => (a.lastUsed <= b.lastUsed ? a : b));
      void this.close(oldest.id);
      mine.splice(mine.indexOf(oldest), 1);
    }
    const id = `rs-${++this.seq}-${this.now().toString(36)}`;
    const set: ResultSet = {
      id,
      owner: opts.owner,
      columns: opts.columns,
      rows: opts.rows,
      conn: opts.conn,
      release: opts.release ?? ((c) => c.close()),
      done: false,
      lastUsed: this.now()
    };
    this.sets.set(id, set);
    log.debug(`opened result set ${id} (${this.sets.size} open)`);
    return set;
  }

  /** 所有者を検査して取り出す。無ければ undefined（期限切れと区別しない） */
  get(id: string, user: AuthUser | undefined): ResultSet | undefined {
    this.sweep();
    const set = this.sets.get(id);
    if (!set) return undefined;
    // 認証オフは全通過・admin は全許可・所有者一致で許可（既存の規則に乗る）
    assertOwner(set.owner, user);
    return set;
  }

  /**
   * 次のページを取る。**1 件多く読んで持ち越す**ことで「続きがあるか」を判断する
   * （SQLCODE 100 を待つ形にすると、最後がちょうど n 件のときに余計な往復が出る）。
   */
  async next(set: ResultSet, pageSize: number): Promise<PageResult> {
    const rows: Row[] = [];
    if (set.pending) {
      rows.push(set.pending);
      set.pending = undefined;
    }
    while (rows.length < pageSize) {
      const r = await set.rows.next();
      if (r.done) {
        set.done = true;
        break;
      }
      rows.push(r.value);
    }
    if (!set.done) {
      // 次の 1 件を覗いて、あるなら持ち越す
      const peek = await set.rows.next();
      if (peek.done) set.done = true;
      else set.pending = peek.value;
    }
    set.lastUsed = this.now();
    return { rows, hasMore: !set.done || set.pending !== undefined };
  }

  /**
   * 結果セットを手放す。
   *
   * **カーソルが閉じ切ってから接続を手放す**——`rows.return()` の中で
   * closeCursor が走る（query.ts の finally）ので、それを待たずにプールへ返すと
   * 次の借り手がカーソルの閉じかけた接続を掴む。
   * 閉じ方が分からない状態（`return()` が失敗）なら**使い回さずに閉じる**。
   *
   * `hard` はプロセス終了時用。プールへ返さずその場で閉じる。
   *
   * **返る Promise は「接続を手放し終えた」ところまでを表す。**
   * 画面が再実行の前に手放しを待てるようにするため（待たないと、まだ貸し出し中の
   * 接続をプールから拾えず、再実行のたびに 4〜6 秒かかる。実測で気づいた）。
   */
  close(id: string, opts: { hard?: boolean } = {}): Promise<void> {
    const set = this.sets.get(id);
    if (!set) return Promise.resolve();
    this.sets.delete(id);
    const hardClose = (): void => {
      try {
        set.conn.close();
      } catch (e) {
        log.debug(`closing result set ${id} failed: ${String(e)}`);
      }
    };
    log.debug(`closing result set ${id} (${this.sets.size} open)`);
    if (opts.hard) {
      void set.rows.return(undefined).catch(() => undefined);
      hardClose();
      return Promise.resolve();
    }
    return set.rows.return(undefined).then(
      () => set.release(set.conn),
      () => hardClose()
    );
  }

  /** アイドルのものを閉じる */
  sweep(): void {
    const limit = this.now() - this.idleMs;
    for (const [id, set] of this.sets) {
      if (set.lastUsed < limit) void this.close(id);
    }
  }

  /** **プロセス終了時に必ず呼ぶ**。掴んだ接続を残さない（プールへ返さずその場で閉じる） */
  closeAll(): void {
    for (const id of [...this.sets.keys()]) void this.close(id, { hard: true });
  }
}

export type { As400Error };
