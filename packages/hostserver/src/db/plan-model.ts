/**
 * SQL 実行計画のモデル——**DB モニターの記録を畳んで画面・MCP・保存に使える形にする**。
 *
 * ## この層の位置づけ
 *
 * **純関数だけ**を置く（`node:*` を触らない。AGENTS.md「ピュアロジック層は Node API 非依存」）。
 * ホストと話すのは `plan-capture.ts` / `plan-cache.ts` の役目で、ここは
 * 「記録の配列 → `QueryPlan`」の変換に閉じる。**実機なしでテストできる**ことが狙い。
 *
 * ## 階層は「文 → クエリブロック → ノード」の 3 層（実測で確定）
 *
 * DB モニターの記録は横並びで、**演算子の親子リンクは持っていない**。
 * `20260802-sql-visual-explain` の design 工程で、結合・集約・副問合せ・UNION を
 * 実機(7.3) の監視下に流して調べた結果:
 *
 * - **`QQQDTN` はクエリブロックの番号**。UNION で `1` / `2` に割れ、集合演算の記録（`3026`）が
 *   後続ブロックに付いた。副問合せ（`K IN (SELECT …)`）は平坦化されてブロックが増えなかった。
 * - **`QQQDTL` は階層に使えない**。ほぼ全て `1` で、`3019` だけ `0`。
 * - **`3000` は表ごとに 1 件**（結合で 2 件出て、対象表が `QVQTBL` に入る）。
 *
 * → **演算子木は推定で組まない**（`design.md` 判断 A1）。誤った依存関係を見せるほうが、
 *   階層が浅いことより害が大きい。
 *
 * ## 知らない記録種別に名前を付けない
 *
 * 名前を与えるのは、**IBM の文書化された名称とこちらの実測が一致した種別だけ**
 * （`PlanNodeKind` の表を参照）。それ以外は `other` として、値の入っていた列を
 * そのまま属性に載せる（`design.md` 判断 A2）。
 * 出所の無いラベルは、そのまま利用者の判断材料になってしまう。
 */

/**
 * 計画ノードの種別。
 *
 * **名前を与えるのは、IBM の文書化された名称と、こちらの実測が一致したものだけ。**
 * 出所は IBM Documentation の "Database monitor view NNNN - …"。
 * 実測は `scripts/research-visual-explain-records.mjs`（形の違う SQL を 9 通り流し、
 * 種別ごとに「どの形で出たか」と「どの列が埋まったか」を採った）。
 *
 * | QQRID | IBM の名称 | 実測での裏付け |
 * |---|---|---|
 * | 1000 | SQL Information | 文テキスト・文番号・サーバー名・所要時間 |
 * | 3000 | Table Scan | 表ごとに 1 件・`QVQTBL` に対象表 |
 * | 3001 | Index Used | `QVINAM` に索引名（`QADBILLB`）・索引を使う文でだけ出た |
 * | 3002 | Index Created | （未観測。文書のみ） |
 * | 3003 | Query Sort | `GROUP BY` / `ORDER BY` のときだけ出た |
 * | 3004 | Temp Table | （未観測。文書のみ） |
 * | 3006 | Access Plan Rebuilt | `QQC102=QAQQINI`・`QQRCOD=A0` |
 * | 3007 | Optimizer Timed Out | 索引の多い `QSYS2.SYSCOLUMNS` でだけ出た |
 * | 3008 | Subquery Processing | （未観測。文書のみ） |
 * | 3010 | Host Variable & ODP Implementation | `QQ1000` にリテラル値（`100` / `'QSYS2'`） |
 * | 3014 | Generic QQ Information | 全文で 1 件 |
 * | 3015 | Statistics Information | **7.5 でだけ出た**（7.3 では出ない） |
 * | 3019 | Rows Retrieved | 全文で 1 件（`QQQDTL=0`。ノードにせず要約へ） |
 * | 3020 | Index advised (SQE) | `QQIDXA='Y'` と助言キー列 `QQIDXD` |
 * | 3021 | Bitmap Created | 索引評価が走った文でだけ出た |
 * | 3023 | Temp Hash Table Created | 結合・集約・UNION・副問合せで出た |
 * | 3025 | Distinct Processing | **`DISTINCT` のときだけ**出た |
 * | 3026 | Set Operation | **`UNION` のときだけ**出た |
 * | 3028 | Grouping | 集約を伴う文で出た |
 *
 * **`3018` / `5002` / `5005` は名前を与えない。** 観測はしたが（`3018` は版数・PTF 群・
 * 利用者名を持ち、モニターの開始/終了で 1 件ずつ出る）、文書化された名称を確認できていない。
 * 推測でラベルを付けると、そのまま利用者の判断材料になってしまう。
 */
export type PlanNodeKind =
  // --- 計画のステップ（図に出す） ---
  | "table-scan"
  | "index-used"
  | "index-created"
  | "sort"
  | "temp-table"
  | "temp-hash-table"
  | "bitmap-created"
  | "distinct"
  | "set-operation"
  | "grouping"
  | "subquery"
  // --- 付帯情報（図に出さず脇に出す） ---
  | "index-advised"
  | "host-variable"
  | "generic-info"
  | "statistics"
  | "access-plan-rebuilt"
  | "optimizer-timeout"
  | "sql-information"
  /** 名前を与えていない種別。**中身は属性で見せる** */
  | "other";

/**
 * ノードの位置づけ。**図に出すのは `step` だけ**。
 *
 * `3006`（Access Plan Rebuilt）や `3014`（Generic QQ Information）は**ほぼ全文で出る**ので、
 * 計画のステップと同じ列に並べると図が付帯情報で埋まる。分けて脇に出す。
 */
export type PlanNodeCategory = "step" | "info";

/** ノード詳細パネルに出す 1 項目 */
export interface PlanAttribute {
  label: string;
  value: string;
}

export interface PlanNode {
  /** `${ブロック番号}-${ブロック内の連番}` */
  id: string;
  kind: PlanNodeKind;
  /** 図に出すか（`step`）、脇に出すか（`info`） */
  category: PlanNodeCategory;
  /** 元の記録種別（`QQRID`）。**未知でも必ず保持する** */
  recordType: number;
  /** ノードに出す短い表示名 */
  label: string;
  table?: { schema: string; name: string };
  index?: { schema?: string; name: string };
  /** `QQTOTR` 総行数 */
  totalRows?: number;
  /** `QQREST` 推定行数 */
  estimatedRows?: number;
  /** `QQEPT` 推定処理時間（ms） */
  estimatedMs?: number;
  /** `QQRCOD` オプティマイザの理由コード。実測で `T1` / `T3` / `I1` / `I2` / `F7` / `A0` を確認 */
  reasonCode?: string;
  /** **値の入っていた列だけ**を並べる。未知種別はここが情報の全て */
  attributes: PlanAttribute[];
}

/** クエリブロック（`QQQDTN` 単位）。UNION などで複数になる */
export interface PlanBlock {
  number: number;
  nodes: PlanNode[];
}

export interface IndexAdvice {
  table: { schema: string; name: string };
  /** `QQIDXD` の助言キー列（例 `"DBIREL, DBILB2, DBILFI, DBIATR"`） */
  keyColumns: string;
  /** 生成した `CREATE INDEX` 文。**利用者に見せてから実行する** */
  createStatement: string;
  reasonCode?: string;
  /** その表の総行数（助言の重みを判断する材料） */
  totalRows?: number;
}

export interface PlanSummary {
  nodeCount: number;
  /** 計画のステップの数（図に出るノード）。`nodeCount` は付帯情報も含む総数 */
  stepCount: number;
  blockCount: number;
  /** 走査した表（`schema.name`・重複なし） */
  tables: string[];
  /** 使った索引（重複なし） */
  indexes: string[];
  adviceCount: number;
  /** 推定処理時間の最大値（ms） */
  maxEstimatedMs?: number;
  /** 実測の経過（`run` のときだけ。呼び出し側が入れる） */
  elapsedMs?: number;
}

/** どうやって採った計画か */
export type PlanCapture = "run" | "no-rows" | "plan-cache";

export interface QueryPlan {
  statement: string;
  captured: PlanCapture;
  /** 採取時刻（ISO 8601。呼び出し側が入れる＝純関数に時計を持ち込まない） */
  at: string;
  /** ホストのジョブ名（自ジョブ採取のときだけ） */
  job?: string;
  blocks: PlanBlock[];
  advice: IndexAdvice[];
  summary: PlanSummary;
  /**
   * 名前を与えられなかった記録種別（重複なし・昇順）。**版数差を黙って捨てないため**に持つ。
   * 7.5 では `3015` がここに出る（7.3 では出ない。research F17）。
   *
   * **ノードにできた種別（`other` として表示したもの）と、ブロック番号を持たず落とした種別の
   * 両方を含む。** 落とした側を除くと、`QQQDTN` を持たない版数固有の記録が黙って消える。
   */
  unknownRecordTypes: number[];
}

/**
 * モニター記録の 1 行。**`SELECT *` はしない**ので、読み出す列だけを型にする。
 *
 * ダンプ表は 282 列あり、うち 3 列（`QQJFLD` / `QQBLOB1` / `QXC43`）が CCSID 65535。
 * 列を明示すればそこを避けられるし、要らない列を運ばずに済む（`design.md` 判断 A6）。
 */
export interface MonitorRecord {
  /** 記録種別 */
  QQRID: number;
  /** 文の識別子。**同じ文の記録をまとめる鍵** */
  QQUCNT: number | null;
  /** クエリブロック番号 */
  QQQDTN: number | null;
  /** レベル。`3019` を要約として切り分けるためだけに使う */
  QQQDTL: number | null;
  /** 文テキスト */
  QQ1000: string | null;
  /** 対象表 */
  QVQTBL: string | null;
  QVQLIB: string | null;
  /** 使った索引 */
  QVINAM: string | null;
  QVILIB: string | null;
  /** 総行数 */
  QQTOTR: number | null;
  /** 推定行数 */
  QQREST: number | null;
  /** 推定処理時間 */
  QQEPT: number | null;
  /** 索引助言の有無（`Y` / `N`） */
  QQIDXA: string | null;
  /** 助言キー列 */
  QQIDXD: string | null;
  /** 理由コード */
  QQRCOD: string | null;
  /** ジョブ名 */
  QQJOB: string | null;
}

/**
 * 採取時に `SELECT` する列。**`SELECT *` を使わないための単一の真実**。
 * `MonitorRecord` のキーとずれないこと（`plan-model.test.ts` が固定している）。
 */
export const MONITOR_COLUMNS = [
  "QQRID",
  "QQUCNT",
  "QQQDTN",
  "QQQDTL",
  "QQ1000",
  "QVQTBL",
  "QVQLIB",
  "QVINAM",
  "QVILIB",
  "QQTOTR",
  "QQREST",
  "QQEPT",
  "QQIDXA",
  "QQIDXD",
  "QQRCOD",
  "QQJOB"
] as const;

/** 文レベルの要約であってノードではない記録種別（`QQQDTL=0` の `3019`。IBM: Rows Retrieved） */
const STATEMENT_SUMMARY_RECORD = 3019;

/**
 * 記録種別 → ノード種別。**出所は上の表**（IBM の文書化された名称＋実測）。
 * ここに無い種別は `other` として、値の入った列をそのまま見せる。
 */
const KIND_BY_RECORD = new Map<number, PlanNodeKind>([
  [1000, "sql-information"],
  [3000, "table-scan"],
  [3001, "index-used"],
  [3002, "index-created"],
  [3003, "sort"],
  [3004, "temp-table"],
  [3006, "access-plan-rebuilt"],
  [3007, "optimizer-timeout"],
  [3008, "subquery"],
  [3010, "host-variable"],
  [3014, "generic-info"],
  [3015, "statistics"],
  [3020, "index-advised"],
  [3021, "bitmap-created"],
  [3023, "temp-hash-table"],
  [3025, "distinct"],
  [3026, "set-operation"],
  [3028, "grouping"]
]);

/** 図に出さない（脇に出す）ノード種別 */
const INFO_KINDS = new Set<PlanNodeKind>([
  "sql-information",
  "index-advised",
  "host-variable",
  "generic-info",
  "statistics",
  "access-plan-rebuilt",
  "optimizer-timeout"
]);

/** 種別ごとの表示名。**IBM の名称を日本語にしたもの**（原語は上の表） */
const LABEL_BY_KIND: Record<PlanNodeKind, string> = {
  "table-scan": "表の走査",
  "index-used": "索引の使用",
  "index-created": "索引の作成",
  sort: "並べ替え",
  "temp-table": "一時表",
  "temp-hash-table": "一時ハッシュ表の作成",
  "bitmap-created": "ビットマップの作成",
  distinct: "重複の除去",
  "set-operation": "集合演算",
  grouping: "グループ化",
  subquery: "副問合せの処理",
  "index-advised": "索引の助言",
  "host-variable": "ホスト変数・ODP",
  "generic-info": "クエリ情報",
  statistics: "統計情報",
  "access-plan-rebuilt": "アクセスプランの再作成",
  "optimizer-timeout": "オプティマイザの打ち切り",
  "sql-information": "SQL 文の情報",
  other: ""
};

/**
 * **こちらが意図して使っている**ので「未対応」に数えない記録種別。
 *
 * - `1000`: 文テキスト（`QQ1000`）の在りか。文の同定に使っている
 * - `3019`: 文レベルの要約
 *
 * 数えてしまうと**毎回必ず「未対応の記録種別があります」と出る**ことになり、
 * 版数差（7.5 だけに出る `3015` など）という本来見せたい信号がノイズに埋もれる。
 * 実機 2 台の疎通で気づいた。
 */
const CONSUMED_RECORDS = new Set([1000, STATEMENT_SUMMARY_RECORD]);

/** 索引の助言を運ぶ記録（IBM: Index advised (SQE)） */
const RECORD_INDEX_ADVICE = 3020;

function kindOf(recordType: number): PlanNodeKind {
  return KIND_BY_RECORD.get(recordType) ?? "other";
}

function categoryOf(kind: PlanNodeKind): PlanNodeCategory {
  // **未対応種別は `info` に寄せる**。図に出すと、意味の分からない箱が計画の流れに紛れる
  return kind === "other" || INFO_KINDS.has(kind) ? "info" : "step";
}

function trimOrUndefined(v: string | null | undefined): string | undefined {
  const s = v?.trim();
  return s ? s : undefined;
}

function numOrUndefined(v: number | null | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function tableOf(r: MonitorRecord): { schema: string; name: string } | undefined {
  const name = trimOrUndefined(r.QVQTBL);
  if (!name) return undefined;
  return { schema: trimOrUndefined(r.QVQLIB) ?? "", name };
}

function indexOf(r: MonitorRecord): { schema?: string; name: string } | undefined {
  const name = trimOrUndefined(r.QVINAM);
  if (!name) return undefined;
  const schema = trimOrUndefined(r.QVILIB);
  return schema === undefined ? { name } : { schema, name };
}

/**
 * ノードの表示名。**名前を与えていない種別は種別番号をそのまま出す**（知ったかぶりをしない）。
 * 対象（表・索引）が分かるときは添える——「表の走査」だけでは、どの表かが読めない。
 */
function labelOf(kind: PlanNodeKind, r: MonitorRecord): string {
  if (kind === "other") return `記録 ${r.QQRID}`;
  const base = LABEL_BY_KIND[kind];
  const index = indexOf(r);
  if (kind === "index-used" && index) return `${base}: ${index.name}`;
  const table = tableOf(r);
  return table ? `${base}: ${table.name}` : base;
}

/** 値の入っていた列だけを属性にする。**未知種別ではここが情報の全て** */
function attributesOf(r: MonitorRecord): PlanAttribute[] {
  const out: PlanAttribute[] = [];
  const push = (label: string, value: string | number | null | undefined): void => {
    if (value === null || value === undefined) return;
    const s = typeof value === "string" ? value.trim() : String(value);
    if (s === "") return;
    out.push({ label, value: s });
  };
  const table = tableOf(r);
  push("記録種別", r.QQRID);
  push("クエリブロック", r.QQQDTN);
  push("表", table ? `${table.schema}/${table.name}` : undefined);
  push("索引", indexOf(r)?.name);
  push("総行数", r.QQTOTR);
  push("推定行数", r.QQREST);
  push("推定処理時間(ms)", r.QQEPT);
  push("理由コード", r.QQRCOD);
  push("索引助言", r.QQIDXA);
  push("助言キー列", r.QQIDXD);
  return out;
}

/**
 * 助言から `CREATE INDEX` 文を組み立てる。
 *
 * **索引名は決め打ちで生成する**（ホストは名前を要求するが、助言は名前を持たない）。
 * 利用者が画面で編集できる前提の叩き台で、**そのまま実行させない**
 * （`spec.md`「索引の作成」: 文を見せて確認を取ってから既存の SQL 経路へ送る）。
 */
export function buildCreateIndexStatement(
  table: { schema: string; name: string },
  keyColumns: string,
  seq: number
): string {
  const keys = keyColumns
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "")
    .join(", ");
  const qualified = table.schema ? `${table.schema}.${table.name}` : table.name;
  // 索引名は表名から作る。**長すぎると弾かれる**ので 18 文字で切って連番を足す
  const base = table.name.slice(0, 18);
  return `CREATE INDEX ${table.schema ? `${table.schema}.` : ""}${base}_IX${seq} ON ${qualified} (${keys})`;
}

/**
 * モニター記録を 1 つの実行計画に畳む。
 *
 * @param records 1 つの文（同じ `QQUCNT`）に属する記録。**呼び出し側で絞ってから渡す**
 * @param meta 記録からは決まらないもの（採取方法・時刻）。**純関数に時計を持ち込まない**
 */
export function buildQueryPlan(
  records: MonitorRecord[],
  meta: { captured: PlanCapture; at: string; statement?: string; elapsedMs?: number }
): QueryPlan {
  // 文テキストは記録のどれかに入る。**一番長いものを採る**——
  // `3010`（ホスト変数）にも QQ1000 が入り、そちらは値の羅列で文ではない
  const statement =
    meta.statement ??
    records
      .map((r) => r.QQ1000?.trim() ?? "")
      .reduce((longest, s) => (s.length > longest.length ? s : longest), "");

  const job = trimOrUndefined(records.find((r) => trimOrUndefined(r.QQJOB))?.QQJOB);

  const blockMap = new Map<number, PlanNode[]>();
  const unknown = new Set<number>();
  const advice: IndexAdvice[] = [];

  for (const r of records) {
    // `QQQDTL=0` の `3019` は文レベルの要約。**ノードにしない**（design の実測）
    if (r.QQRID === STATEMENT_SUMMARY_RECORD) continue;

    const kind = kindOf(r.QQRID);
    // **未対応種別は、ノードにできたかに関わらず積む。**
    // ブロック番号を持たない記録も対象にするのは、**版数差を黙って捨てないため**——
    // 7.5 だけに出る `3015` が `QQQDTN` を持つ保証はなく、
    // 「ブロックがあるものだけ」にすると版数差の可視化という目的を果たせない
    // （自己レビューで気づいた。research F17）
    if (kind === "other" && !CONSUMED_RECORDS.has(r.QQRID)) unknown.add(r.QQRID);

    // ブロック番号を持たない記録（`3018` 等）は計画ノードにはできない
    const block = numOrUndefined(r.QQQDTN);
    if (block === undefined) continue;

    const nodes = blockMap.get(block) ?? [];
    const node: PlanNode = {
      id: `${block}-${nodes.length}`,
      kind,
      category: categoryOf(kind),
      recordType: r.QQRID,
      label: labelOf(kind, r),
      attributes: attributesOf(r)
    };
    const table = tableOf(r);
    if (table) node.table = table;
    const index = indexOf(r);
    if (index) node.index = index;
    const totalRows = numOrUndefined(r.QQTOTR);
    if (totalRows !== undefined) node.totalRows = totalRows;
    const estimatedRows = numOrUndefined(r.QQREST);
    if (estimatedRows !== undefined) node.estimatedRows = estimatedRows;
    const estimatedMs = numOrUndefined(r.QQEPT);
    if (estimatedMs !== undefined) node.estimatedMs = estimatedMs;
    const reasonCode = trimOrUndefined(r.QQRCOD);
    if (reasonCode !== undefined) node.reasonCode = reasonCode;
    nodes.push(node);
    blockMap.set(block, nodes);

    // 索引助言は `3020` かつ `QQIDXA='Y'` のときだけ。**表と助言キーが揃って初めて意味を持つ**
    if (r.QQRID === RECORD_INDEX_ADVICE && trimOrUndefined(r.QQIDXA) === "Y") {
      const keyColumns = trimOrUndefined(r.QQIDXD);
      if (table && keyColumns) {
        const item: IndexAdvice = {
          table,
          keyColumns,
          createStatement: buildCreateIndexStatement(table, keyColumns, advice.length + 1)
        };
        if (reasonCode !== undefined) item.reasonCode = reasonCode;
        if (totalRows !== undefined) item.totalRows = totalRows;
        advice.push(item);
      }
    }
  }

  const blocks: PlanBlock[] = [...blockMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, nodes]) => ({ number, nodes }));

  const allNodes = blocks.flatMap((b) => b.nodes);
  const tables = [...new Set(allNodes.filter((n) => n.table).map((n) => `${n.table?.schema}.${n.table?.name}`))];
  const indexes = [...new Set(allNodes.filter((n) => n.index).map((n) => n.index?.name ?? ""))].filter((s) => s !== "");
  const estimates = allNodes.map((n) => n.estimatedMs).filter((v): v is number => v !== undefined);

  const summary: PlanSummary = {
    nodeCount: allNodes.length,
    stepCount: allNodes.filter((n) => n.category === "step").length,
    blockCount: blocks.length,
    tables,
    indexes,
    adviceCount: advice.length
  };
  if (estimates.length > 0) summary.maxEstimatedMs = Math.max(...estimates);
  if (meta.elapsedMs !== undefined) summary.elapsedMs = meta.elapsedMs;

  const plan: QueryPlan = {
    statement,
    captured: meta.captured,
    at: meta.at,
    blocks,
    advice,
    summary,
    unknownRecordTypes: [...unknown].sort((a, b) => a - b)
  };
  if (job !== undefined) plan.job = job;
  return plan;
}

/** 比較用に空白を潰す（改行・連続空白の違いで一致を落とさない） */
function normalizeStatement(s: string): string {
  return s.replace(/\s+/gu, " ").trim().toUpperCase();
}

/**
 * ダンプ表から**対象の文の記録だけ**を選ぶ。
 *
 * DB モニターは**ジョブ全体**を採るので、`STRDBMON` / `ENDDBMON` の `CALL` など
 * 対象外の記録が必ず混ざる。そこで 2 段で選ぶ:
 *
 * 1. `QQ1000` が対象の文と一致する記録の `QQUCNT`
 * 2. 一致が無ければ、**計画記録（`QQQDTN` を持つもの）が最も多い `QQUCNT`**
 *
 * 2 段目が要るのは、**長い文で `QQ1000` が切り詰められる**ことがあるため
 * （列幅の上限に当たる）。前方一致も見て、それでも駄目なら件数で決める。
 *
 * **どれも選べなければ空配列を返す**——空の計画を「成功」として返さないため、
 * 呼び出し側がそうと分かるようにする。
 */
export function pickStatementRecords(records: MonitorRecord[], sql: string): MonitorRecord[] {
  const groups = groupByStatement(records);
  if (groups.size === 0) return [];
  const want = normalizeStatement(sql);

  // 1 段目: 完全一致 → 前方一致（切り詰め対策）
  for (const exact of [true, false]) {
    for (const [, list] of groups) {
      const hit = list.some((r) => {
        const text = normalizeStatement(r.QQ1000 ?? "");
        if (text === "") return false;
        return exact ? text === want : want.startsWith(text) && text.length >= 20;
      });
      if (hit) return list;
    }
  }

  // 2 段目: 計画記録が最も多い群。**同数なら先に現れたほうを採る**（決定的にする）
  let best: MonitorRecord[] = [];
  let bestCount = 0;
  for (const [, list] of groups) {
    const count = list.filter((r) => r.QQQDTN !== null).length;
    if (count > bestCount) {
      best = list;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : [];
}

/**
 * 同じダンプ表に複数の文が入っているとき、`QQUCNT` ごとに分ける。
 * 一覧（プランキャッシュ）で使う——**2 段目の `DUMP_PLAN_CACHE` を呼ばずに済ませる**ため
 * （`design.md` 判断 A5）。
 */
export function groupByStatement(records: MonitorRecord[]): Map<number, MonitorRecord[]> {
  const out = new Map<number, MonitorRecord[]>();
  for (const r of records) {
    if (r.QQUCNT === null) continue;
    const list = out.get(r.QQUCNT) ?? [];
    list.push(r);
    out.set(r.QQUCNT, list);
  }
  return out;
}
