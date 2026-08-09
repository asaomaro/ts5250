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

/**
 * ノード詳細パネルに出す 1 項目。
 *
 * `group` は ACS の詳細ダイアログと同じ**節見出し**。未指定は先頭の節に入る。
 * **名前を与えた項目と、生の列名のままの項目を混ぜない**ため——
 * 「モニターの記録（列名のまま）」の節に落ちているものは、**こちらが意味を
 * 確かめていない列**だと分かるようにしている（AGENTS.md「名前を与えるのは実測した種別のみ」）。
 */
export interface PlanAttribute {
  label: string;
  value: string;
  group?: string;
  /**
   * **こちらが意味を確かめていない列**（ラベルが列名そのもの）。
   *
   * 画面には出すが、**保存や MCP の応答からは落とす**ための印。
   * 全列を持つと計画 1 件で 110KB になり、履歴 20 件 × 保存 20 件で
   * localStorage の容量（おおむね 5MB）に届く。文字列の節名で判定すると
   * 表示の都合で節名を変えたときに黙って壊れるので、真偽値で持つ。
   */
  raw?: boolean;
  /**
   * 元のモニター列名。**論理名を出しても列の ID は残す**——
   * ACS の出力や IBM の資料と突き合わせるときに要る。
   */
  column?: string;
}

/** 属性の節。ACS の詳細ダイアログの区切りに合わせる */
export const ATTR_GROUP_TABLE = "表・索引";
export const ATTR_GROUP_ESTIMATE = "見積もり";
export const ATTR_GROUP_JOIN = "結合";
export const ATTR_GROUP_ADVICE = "索引の助言";
/** 意味を確かめていない列。**捨てずに出すが、名前は与えない** */
export const ATTR_GROUP_RAW = "モニターの全列";

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
  /**
   * `QQJNP` 結合の位置（ダイヤル。**1 起点**）。結合に参加する記録だけが持つ。
   * `0` は「参加していない」の意味で入るので**落とす**（`3007` が 0 を返すのを実測）。
   */
  joinPosition?: number;
  /** `QQC21` 結合方式のコード。**実測で確かめたのは `NL`（ネステッドループ）だけ** */
  joinMethod?: string;
  /**
   * `QVC14` 索引だけで足りたか。**`false` なら表から行を取り直す**
   * ＝ACS が「テーブル・プローブ」として別のオブジェクトに描くもの。
   */
  indexOnly?: boolean;
  /** **値の入っていた列だけ**を並べる。未知種別はここが情報の全て */
  attributes: PlanAttribute[];
}

/**
 * 図に描く**結合の木**。葉は 1 つのダイヤル（`QQJNP` が同じ記録のまとまり）、
 * 内部の節は結合。
 *
 * **左深（left-deep）に組む。** IBM i の結合はダイヤルを 1 から順に重ねていく形で、
 * `QQJNP` がその順位そのもの（2 表で 1・2、3 表で 1・2・3 になるのを実測）。
 * `((ダイヤル1 ⋈ ダイヤル2) ⋈ ダイヤル3)` と読む。
 *
 * **これは推定ではない**——`QQJNP` という 1 列がそのまま順位を持っている。
 * 以前「記録に親子リンクが無い」と結論したのは `QQQDTN` / `QQQDTL` しか見ていなかったため
 * （`design.md` A1 の訂正）。
 */
export type PlanTreeNode =
  | { kind: "dial"; id: string; position: number; nodes: PlanNode[] }
  | {
      kind: "join";
      id: string;
      label: string;
      method?: string;
      left: PlanTreeNode;
      right: PlanTreeNode;
      /** 詳細パネルに出す項目。**ノードと同じように選んで中が見られる** */
      attributes: PlanAttribute[];
    }
  | {
      kind: "op";
      id: string;
      label: string;
      op: PlanTreeOpKind;
      table?: { schema: string; name: string };
      /** 通した行数（`final-select` は `3019` の `QQI7`） */
      rows?: number;
      source: PlanTreeNode;
      /** 詳細パネルに出す項目 */
      attributes: PlanAttribute[];
    };

/**
 * 記録そのものではなく、**記録から導いた単項の演算**。
 *
 * - `table-probe`: 索引で当てた行を表から取り直す。`QVC14='N'`（索引だけでは足りない）から導く。
 *   ACS も同じ位置に「テーブル・プローブ」を描く（実機の Visual Explain と突き合わせた）。
 * - `final-select`: 文が返した行。`3019`（文レベルの要約）の `QQI7`。ACS の「最終選択」。
 *
 * **記録のノード（`PlanNode`）と混ぜない。** `recordType` を持たないものを `PlanNode` に
 * 入れると「記録種別は必ず持つ」という約束が崩れる。
 */
export type PlanTreeOpKind = "table-probe" | "final-select";

/** クエリブロック（`QQQDTN` 単位）。UNION などで複数になる */
export interface PlanBlock {
  number: number;
  nodes: PlanNode[];
  /**
   * 結合の木。**ダイヤルが 2 つ以上あるときだけ**付く。
   * 単表の計画では付かない（今までどおり縦に並べる）。
   */
  joinTree?: PlanTreeNode;
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
  /**
   * 結合の位置（ダイヤル）。**結合の木はこの 1 列で決まる**——
   * 2 表で 1・2、3 表で 1・2・3 になるのを実機 7.3 で実測した。
   * 参加しない記録は `0` か null（`3007` が 0 を返す）。
   */
  QQJNP: number | null;
  /** 結合方式。実測は `NL`（ネステッドループ）のみ。**知らないコードに名前を付けない** */
  QQC21: string | null;
  /**
   * 索引のみアクセス（`Y`/`N`）。**`N` なら表から行を取り直す**＝ACS の「テーブル・プローブ」。
   *
   * 同じ結合を `SELECT *` と「索引のキー列だけ」で流して差分を採ったところ、
   * 意味のある違いはこの 1 列だけだった（`N` → `Y`）。実機 7.3 実測。
   */
  QVC14: string | null;
  /** 索引のライブラリ。`QQ1000` の索引名と組で使う */
  QQILNM: string | null;
  /** `3019`（文レベルの要約）が返した行数。**ACS の「最終選択」の数字がこれ** */
  QQI7: number | null;
  /**
   * 読めた**全列**（列名 → 値）。値の入っていた列だけが入る。
   *
   * 上の型付きの欄は**判断に使う列**で、こちらは**見せるための全部**。
   * ACS の詳細ダイアログは 40〜60 項目を出すが、その大半は
   * `QQI3` / `QQIA` / `QVP156` のような**記録種別ごとに意味が変わる列**で、
   * ホストの catalog にも説明が入っていない（実測。名前付きの列にしか
   * `COLUMN_TEXT` が無い）。**意味を確かめていない列に名前を与えない**代わりに、
   * 列名のまま全部出す——値が見えれば ACS と突き合わせられる。
   */
  raw?: Record<string, string | number>;
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
  "QQJOB",
  "QQJNP",
  "QQC21",
  "QVC14",
  "QQILNM",
  "QQI7"
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
/** 索引の使用（IBM: Index used）。**`QQ1000` にアクセスパス名が入る唯一の計画記録** */
const RECORD_INDEX_USED = 3001;
/** クエリ情報（IBM: Generic query information）。**文レベルの設定と環境がここに入る** */
const RECORD_QUERY_INFO = 3014;

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

/**
 * 使った索引。
 *
 * **`3001` は `QQ1000` に実際のアクセスパス名を持つ**（`Q_TESTLIB_M_MENU_MENUCD_00001` のような
 * システム生成の索引名）。`QVINAM` はその索引が載っている**ファイル名**なので、
 * `QVINAM` だけを見ると「索引の使用: M_MENU」と表そのものの名前になってしまう。
 * ACS も `QQILNM` + `QQ1000` を出している——実機の Visual Explain と突き合わせて確かめた。
 *
 * `QQ1000` が空のこともある（QSYS2 の表で実測）ので、そのときは `QVINAM` に落とす。
 */
function indexOf(r: MonitorRecord): { schema?: string; name: string } | undefined {
  const accessPath = r.QQRID === RECORD_INDEX_USED ? trimOrUndefined(r.QQ1000) : undefined;
  const name = accessPath ?? trimOrUndefined(r.QVINAM);
  if (!name) return undefined;
  const schema = trimOrUndefined(accessPath ? (r.QQILNM ?? r.QVILIB) : r.QVILIB);
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

/**
 * **記録種別ごとに意味が確かめられた列**だけの名前。
 *
 * ACS の詳細ダイアログと突き合わせて**値が一意に一致した列だけ**を載せている
 * （2026-08-08。利用者提供の ACS 出力を正解データにした）。
 * 一致が曖昧だったもの（同じ値の列が複数）や、ACS 側が計算している値
 * （`処理された行数の合計 = 反復 × 行数` など）は**入れない**。
 *
 * ⚠ **記録種別で分ける。** 同じ `QQI5` が `3001` では索引の項目数、`3014` では
 * 最適化時間（ミリ秒）だった。一律に名付けると必ず嘘になる。
 */
const NAMED_BY_RECORD: Record<number, Record<string, { label: string; group: string }>> = {
  // 表の走査（ACS「テーブルのスキャン」）
  3000: {
    QQI3: { label: "テーブル・サイズ(バイト)", group: ATTR_GROUP_TABLE }
  },
  // 索引の使用（ACS「索引プローブ」＋「テーブル・プローブ」）
  3001: {
    QQIA: { label: "索引論理ページ・サイズ", group: ATTR_GROUP_TABLE },
    QVP156: { label: "テーブル・サイズ(バイト)", group: ATTR_GROUP_TABLE }
  },
  // クエリ情報（ACS「最終選択」の大半がここ）
  3014: {
    QQI5: { label: "最適化時間(ミリ秒)", group: ATTR_GROUP_ESTIMATE },
    QQC83: { label: "QRO ハッシュ", group: ATTR_GROUP_ESTIMATE },
    QQC81: { label: "最適化ゴール", group: ATTR_GROUP_ESTIMATE },
    QQC103: { label: "QUERY オプション・テーブル", group: ATTR_GROUP_ESTIMATE }
  },
  // 文レベルの要約（ACS「最終選択」の行数）
  3019: {
    QQI7: { label: "返した行数", group: ATTR_GROUP_ESTIMATE }
  }
};

/**
 * 値の入っていた列を属性にする。**未知種別ではここが情報の全て**。
 *
 * 2 段構え:
 * 1. 意味を確かめた列に**日本語の名前**を付けて節に分ける
 * 2. 残りは**列名のまま**「モニターの記録」の節へ——ACS が出している項目の多くは
 *    ここに生の値として入る。名前を与えないのは、記録種別ごとに意味が変わる列で、
 *    ホストの catalog にも説明が無いため（実測）。**捨てるより出す**
 */
function attributesOf(r: MonitorRecord, labels: ReadonlyMap<string, string>): PlanAttribute[] {
  const out: PlanAttribute[] = [];
  /** 名前を与えて出した列。生の列として二重に出さないため控える */
  const named = new Set<string>();
  const push = (label: string, value: string | number | null | undefined, group?: string, column?: string): void => {
    if (value === null || value === undefined) return;
    const s = typeof value === "string" ? value.trim() : String(value);
    if (s === "") return;
    out.push({
      label,
      value: s,
      ...(group !== undefined ? { group } : {}),
      ...(column !== undefined ? { column } : {})
    });
    if (column) named.add(column);
  };
  const table = tableOf(r);
  push("記録種別", r.QQRID, ATTR_GROUP_TABLE, "QQRID");
  push("クエリブロック", r.QQQDTN, ATTR_GROUP_TABLE, "QQQDTN");
  push("表", table ? `${table.schema}/${table.name}` : undefined, ATTR_GROUP_TABLE);
  push("索引", indexOf(r)?.name, ATTR_GROUP_TABLE);
  push("総行数", r.QQTOTR, ATTR_GROUP_TABLE, "QQTOTR");
  push("推定行数", r.QQREST, ATTR_GROUP_ESTIMATE, "QQREST");
  push("推定処理時間(ms)", r.QQEPT, ATTR_GROUP_ESTIMATE, "QQEPT");
  push("理由コード", r.QQRCOD, ATTR_GROUP_ESTIMATE, "QQRCOD");
  // **`0` は「結合に参加していない」**（`3007` で実測）。ダイヤル番号として出さない
  const joined = numOrUndefined(r.QQJNP) !== undefined && r.QQJNP! >= 1;
  push("結合位置", joined ? r.QQJNP : null, ATTR_GROUP_JOIN, "QQJNP");
  // **`QQC21` を「結合方式」と呼べるのは結合に参加する記録だけ。**
  // 記録種別ごとに意味が違う列で、`3019` では `A1`、`3014` では `N` が入る（実測）。
  // 一律に「結合方式」と書くと、結合していない記録に嘘のラベルが付く
  push("結合方式", joined ? r.QQC21 : null, ATTR_GROUP_JOIN, joined ? "QQC21" : undefined);
  push("索引のみアクセス", r.QVC14, ATTR_GROUP_TABLE, "QVC14");
  push("索引助言", r.QQIDXA, ATTR_GROUP_ADVICE, "QQIDXA");
  push("助言キー列", r.QQIDXD, ATTR_GROUP_ADVICE, "QQIDXD");

  // 記録種別ごとに確かめた列
  for (const [column, spec] of Object.entries(NAMED_BY_RECORD[r.QQRID] ?? {})) {
    push(spec.label, r.raw?.[column] ?? null, spec.group, column);
  }

  // **残りも全部出す。** ACS が出している項目の多くはここに入る。
  // ホストの catalog に論理名があればそれを見出しにし、無ければ列名のまま
  for (const [column, value] of Object.entries(r.raw ?? {})) {
    if (named.has(column)) continue;
    push(labels.get(column) ?? column, value, ATTR_GROUP_RAW, column);
    out[out.length - 1]!.raw = true;
  }
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
 * 結合方式のコード → 表示名。
 *
 * **実測で確かめたものだけに名前を付ける**（AGENTS.md「名前付きノードは実測した種別のみ」）。
 * 実機 7.3 で確認できたのは `NL` だけ。それ以外はコードのまま見せて、
 * 「知らないものを知っているふりで名付けない」。
 */
function dedupeByLabel(items: PlanAttribute[]): PlanAttribute[] {
  const seen = new Set<string>();
  return items.filter((a) => (seen.has(a.label) ? false : (seen.add(a.label), true)));
}

function joinLabelOf(method: string | undefined): string {
  if (method === "NL") return "ネステッドループ結合";
  return method ? `結合（${method}）` : "結合";
}

/**
 * ダイヤル（`QQJNP`）から**左深の結合の木**を組む。
 *
 * ダイヤルが 1 つ以下なら木にしない（`undefined` を返す）——結合していない計画で
 * 「結合」の節を出すのは嘘になるし、単表の見え方も変えたくない。
 *
 * **結合方式は「右側のダイヤル」から採る**。IBM i の記録では、そのダイヤルを
 * どう繋いだかがそのダイヤルの記録に載る（両側 `NL` で一致するのを実測しているが、
 * 意味として正しいのは右側）。
 *
 * ⚠ **結合種別（内部/外部）は載せない。** `LEFT OUTER JOIN` を流しても `QQC22` は
 * `IN` のままだった（実測）。書き換えられたのか別の意味なのか確かめられていないので、
 * 「内部結合」と名乗らせると嘘になる。
 */
export function buildJoinTree(
  nodes: PlanNode[],
  blockNumber: number,
  /** `3019` が返した行数（`QQI7`）。あれば「最終選択」を根に載せる */
  rowsReturned?: number,
  /** 文レベルの属性（`3019` ＋ `3014`）。**ACS の「最終選択」の中身** */
  statementAttributes: PlanAttribute[] = []
): PlanTreeNode | undefined {
  const dials = new Map<number, PlanNode[]>();
  for (const n of nodes) {
    if (n.joinPosition === undefined) continue;
    const list = dials.get(n.joinPosition) ?? [];
    list.push(n);
    dials.set(n.joinPosition, list);
  }
  const positions = [...dials.keys()].sort((a, b) => a - b);
  if (positions.length < 2) return undefined;

  const dialOf = (p: number): PlanTreeNode => ({
    kind: "dial",
    id: `${blockNumber}-d${p}`,
    position: p,
    nodes: dials.get(p) ?? []
  });

  /**
   * 索引で当てただけで行が揃わないダイヤル（`indexOnly === false`）。
   * **結合でそのダイヤルが入った直後**に「テーブル・プローブ」を挟む——
   * ネステッドループでは、突き合わせが成立してから内側の行を取りに行くため。
   * 2 表の実機比較では ACS と同じ位置・同じ表になった。
   */
  const probesFor = (position: number): PlanNode[] =>
    (dials.get(position) ?? []).filter((n) => n.indexOnly === false && n.table !== undefined);

  /**
   * **行数は載せない。** ダイヤルの `QQREST` は「1 回の突き合わせで当たる行数」で、
   * プローブを通過する総行数ではない（実測 1・ACS の表示は 8）。
   * 手元の数字と意味が違うものを並べると読み違える。数えられるのは `3019` の返却行数だけ。
   */
  const probeOp = (node: PlanNode, source: PlanTreeNode, seq: string): PlanTreeNode => ({
    kind: "op",
    id: `${blockNumber}-p${seq}`,
    label: `テーブル・プローブ: ${node.table?.name ?? ""}`,
    op: "table-probe",
    ...(node.table ? { table: node.table } : {}),
    source,
    // **導いた根拠を先頭に置く。** なぜこの節があるのかが分からないと、
    // 「記録に無いものが出ている」としか読めない
    attributes: [
      { label: "この節の根拠", value: "索引だけでは列が揃わない（索引のみアクセス = N）" },
      ...node.attributes
    ]
  });

  let tree: PlanTreeNode = dialOf(positions[0]!);
  for (let i = 1; i < positions.length; i++) {
    const right = dialOf(positions[i]!);
    // 方式は右側のダイヤルの記録から。**空文字は「無い」と同じ**に扱う
    const method = (dials.get(positions[i]!) ?? []).map((n) => n.joinMethod).find((m) => m !== undefined);
    const rightTable = (dials.get(positions[i]!) ?? []).map((n) => n.table).find((t) => t !== undefined);
    tree = {
      kind: "join",
      id: `${blockNumber}-j${i}`,
      label: joinLabelOf(method),
      ...(method !== undefined ? { method } : {}),
      left: tree,
      right,
      // **分かっていることだけ**を並べる（結合種別は `QQC22` が当てにならないので出さない）
      attributes: [
        ...(method !== undefined ? [{ label: "結合方式", value: method }] : []),
        { label: "ここまでのダイヤル", value: positions.slice(0, i).join("・") },
        { label: "取り込むダイヤル", value: String(positions[i]) },
        ...(rightTable ? [{ label: "取り込む表", value: `${rightTable.schema}/${rightTable.name}` }] : [])
      ]
    };
    // **最初の結合では外側（ダイヤル 1）のぶんも一緒に**——そこで初めて行が確定する
    const owed = i === 1 ? [positions[0]!, positions[i]!] : [positions[i]!];
    for (const p of owed) {
      for (const [k, node] of probesFor(p).entries()) tree = probeOp(node, tree, `${i}-${p}-${k}`);
    }
  }

  // ACS の「最終選択」。**行数が採れたときだけ**（無い数字を空欄で見せない）
  if (rowsReturned !== undefined) {
    tree = {
      kind: "op",
      id: `${blockNumber}-final`,
      label: "最終選択",
      op: "final-select",
      rows: rowsReturned,
      source: tree,
      // **`3019` の一般の属性は使わない。** 記録種別ごとに列の意味が違い、
      // `QQC21='A1'` を「結合方式」として出してしまう（実測）。意味の分かる 2 つだけ載せる
      // **文レベルの情報をここへ集める。** ACS の「最終選択」も同じ中身。
      // `3014` と `3019` は記録種別・ジョブ・時刻など同じ列を両方持つので、
      // **同じラベルは先に来たものだけ残す**（並べると同じ行が 2 度出る）
      attributes: dedupeByLabel([
        { label: "この節の根拠", value: "記録 3014（クエリ情報）と 3019（文レベルの要約）", group: ATTR_GROUP_ESTIMATE },
        { label: "返した行数", value: String(rowsReturned), group: ATTR_GROUP_ESTIMATE },
        ...statementAttributes
      ])
    };
  }
  return tree;
}

/**
 * モニター記録を 1 つの実行計画に畳む。
 *
 * @param records 1 つの文（同じ `QQUCNT`）に属する記録。**呼び出し側で絞ってから渡す**
 * @param meta 記録からは決まらないもの（採取方法・時刻）。**純関数に時計を持ち込まない**
 */
export function buildQueryPlan(
  records: MonitorRecord[],
  meta: {
    captured: PlanCapture;
    at: string;
    statement?: string;
    elapsedMs?: number;
    /** モニター列 → 論理名（ホストの catalog 由来）。無ければ列名のまま出る */
    columnLabels?: ReadonlyMap<string, string>;
  }
): QueryPlan {
  const labels = meta.columnLabels ?? new Map<string, string>();
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

  /** `3019` が返した行数。ノードにはしないが「最終選択」の数字として使う */
  let rowsReturned: number | undefined;
  /**
   * 文レベルの情報（`3019` と `3014`）。**ACS の「最終選択」はここが中身**——
   * 最適化ゴール・QAQQINI・環境・クライアント情報まで、あの長い一覧の大半は `3014` にある。
   */
  const statementAttributes: PlanAttribute[] = [];

  for (const r of records) {
    // `QQQDTL=0` の `3019` は文レベルの要約。**ノードにしない**（design の実測）
    if (r.QQRID === STATEMENT_SUMMARY_RECORD) {
      rowsReturned = numOrUndefined(r.QQI7) ?? rowsReturned;
      statementAttributes.push(...attributesOf(r, labels));
      continue;
    }
    // `3014`（クエリ情報）は付帯情報のノードにもするが、**最終選択にも載せる**
    if (r.QQRID === RECORD_QUERY_INFO) statementAttributes.push(...attributesOf(r, labels));

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
      attributes: attributesOf(r, labels)
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
    // **`0` は「参加していない」**（`3007` が 0 を返すのを実測）。ダイヤルは 1 起点
    const joinPosition = numOrUndefined(r.QQJNP);
    if (joinPosition !== undefined && joinPosition >= 1) node.joinPosition = joinPosition;
    const joinMethod = trimOrUndefined(r.QQC21);
    if (joinMethod !== undefined) node.joinMethod = joinMethod;
    const indexOnly = trimOrUndefined(r.QVC14);
    if (indexOnly !== undefined) node.indexOnly = indexOnly === "Y";
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
    .map(([number, nodes]) => {
      const block: PlanBlock = { number, nodes };
      // **図に出すステップだけで組む。** 付帯情報（`3014` 等）は木の節にしない
      const joinTree = buildJoinTree(
        nodes.filter((n) => n.category === "step"),
        number,
        rowsReturned,
        statementAttributes
      );
      if (joinTree) block.joinTree = joinTree;
      return block;
    });

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
 * 1. `QQ1000` が対象の文と一致し、**かつ計画記録を持つ** `QQUCNT`
 * 2. 一致が無ければ、**計画記録（`QQQDTN` を持つもの）が最も多い `QQUCNT`**
 *
 * 2 段目が要るのは、**長い文で `QQ1000` が切り詰められる**ことがあるため
 * （列幅の上限に当たる）。前方一致も見て、それでも駄目なら件数で決める。
 *
 * ## 1 段目で「計画記録を持つ群」に限る理由（実機 7.3 で実測）
 *
 * 同じ文のテキストが **`QQUCNT` の違う 2 つの群**に現れる。`STRDBMON` 直後の
 * `QQUCNT=0` は**モニター自身の目印（`3018`）と、これから実行する文の要約（`1000`）**
 * を持つ受け皿で、**計画記録を 1 件も持たない**。実行の記録は別の `QQUCNT`
 * （実測で 3・5・7…）に付く。
 *
 * ```
 * #0 QQUCNT=0 QQRID=3018                     ← STRDBMON の目印
 * #1 QQUCNT=0 QQRID=1000 QQ1000="SELECT …"   ← 文のテキストだけ（計画は無い）
 * #2 QQUCNT=3 QQRID=3000 QQQDTN=1            ← ここからが本体
 * …
 * #8 QQUCNT=3 QQRID=1000 QQ1000="SELECT …"
 * ```
 *
 * 群は**現れた順**に並ぶので `QQUCNT=0` が先に当たる。件数を見ずに「先に一致した群」を
 * 返していたため、**リテラルを含まない文はことごとく空の計画になっていた**
 * （`SELECT * FROM TESTLIB.M_MENUTR T1 INNER JOIN …` で再現）。
 * リテラルを含む文が無事だったのは、ホストが `WHERE X = 'QSYS2'` を `?` に置き換えて
 * 記録する（値は `3010` に入る）ので**テキストが一致せず 2 段目に落ちていた**だけ
 * ——つまり偶然で、`QSYS2` を対象にした検証文ばかり試していて気づけなかった。
 *
 * 計画記録を持たない群を飛ばしても**他人の計画を掴むことにはならない**——
 * `capturePlan` はモニターの窓の中で対象の文と `ENDDBMON` の `CALL` しか流さず、
 * 計画記録が付くのは対象の文だけだから（`QQUCNT=0` の受け皿と 2 群だけになるのを実測）。
 *
 * **どれも選べなければ空配列を返す**——空の計画を「成功」として返さないため、
 * 呼び出し側がそうと分かるようにする。
 */
export function pickStatementRecords(records: MonitorRecord[], sql: string): MonitorRecord[] {
  const groups = groupByStatement(records);
  if (groups.size === 0) return [];
  const want = normalizeStatement(sql);

  /** 計画記録（ブロック番号を持つもの）の数。**0 の群は答えになり得ない** */
  const planCount = (list: MonitorRecord[]): number => list.filter((r) => r.QQQDTN !== null).length;

  // 1 段目: 文が一致する群のうち**計画記録を持つもの**。完全一致 → 前方一致（切り詰め対策）。
  // 同点なら先に現れたほうを採る（決定的にする）
  for (const exact of [true, false]) {
    let best: MonitorRecord[] = [];
    let bestCount = 0;
    for (const [, list] of groups) {
      const count = planCount(list);
      // **計画記録を持たない群は、文が一致しても選ばない**（下の注記）
      if (count === 0 || count <= bestCount) continue;
      const hit = list.some((r) => {
        const text = normalizeStatement(r.QQ1000 ?? "");
        if (text === "") return false;
        return exact ? text === want : want.startsWith(text) && text.length >= 20;
      });
      if (hit) {
        best = list;
        bestCount = count;
      }
    }
    if (bestCount > 0) return best;
  }

  // 2 段目: 計画記録が最も多い群。**同数なら先に現れたほうを採る**（決定的にする）
  let best: MonitorRecord[] = [];
  let bestCount = 0;
  for (const [, list] of groups) {
    const count = planCount(list);
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
/**
 * 計画記録を持つ**すべての**文の組を、実行順（`QQUCNT` の昇順）で返す。
 *
 * **手続きの `CALL` は中のカーソルごとに別の組になる。** 実機で `DYNAMIC RESULT SETS 2`
 * の手続きを採ったときの実測:
 *
 * ```
 * QQUCNT=0 計画記録 0 件  CALL TESTLIB.SQLDEMORS2()          ← 受け皿（計画は無い）
 * QQUCNT=3 計画記録 7 件  DECLARE C1 CURSOR … ORDER BY ID
 * QQUCNT=4 計画記録 4 件  DECLARE C2 CURSOR … COUNT(*)
 * ```
 *
 * `pickStatementRecords` は 1 組しか返さないので、**2 本目以降が見えない**。
 * 画面で選ばせるにはここで全部返す。
 *
 * **計画記録を持たない組は落とす**（`pickStatementRecords` と同じ規則）——
 * `QQUCNT=0` の受け皿を「中身の無い計画」として並べても選ぶ意味が無い。
 */
export function pickAllStatements(records: MonitorRecord[]): MonitorRecord[][] {
  const groups = groupByStatement(records);
  const kept: { key: number; list: MonitorRecord[] }[] = [];
  for (const [key, list] of groups) {
    if (!list.some((r) => r.QQQDTN !== null)) continue;
    kept.push({ key, list });
  }
  // **実行順に並べる**（現れた順ではない）。画面の選択が呼び出しの順と揃うように
  kept.sort((a, b) => a.key - b.key);
  return kept.map((x) => x.list);
}

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
