/**
 * 取り込みの**事前検査**。書く前に分かることを、ここで全部やる。
 *
 * ⚠ **巻き戻せない**書き込みなので、「途中で失敗して半分書けた」状態を作らないことが
 * 仕様上の要求である（requirement「1 行も書かずに中止する」）。
 *
 * DDM 経路のときは型・CCSID・バイト長もここで見ていたが、**SQL 経路では見ない**——
 * 挿入先の型と枠は `prepareAndDescribe` の応答（マーカー形式）でサーバーが教えるので、
 * こちらが事前に判定する必要も手段も無い。値が枠に入るかは詰める段（`marker-encode`）で分かり、
 * そこも**全行を詰め終えてから送る**ので「1 行も書かない」保証は保たれる。
 *
 * ここに残すのは**行の中身を見なくても分かること**だけ:
 *
 * - CSV のヘッダーと表の列の突き合わせ
 * - NULL を受け付けない列に NULL が来ていないか
 *
 * この層は純関数で、接続もソケットも触らない。
 */
/**
 * 突き合わせに要るのは**列名と NULL 可否だけ**。
 * 型・長さ・CCSID はサーバーがマーカー形式で教えるのでここでは見ない
 * （DDM 経路の `ColumnLayoutInput` に依存し続けると、退役したモジュールと結びついたままになる）。
 */
export interface UploadColumn {
  name: string;
  nullable: boolean;
}

/**
 * 拒否理由。**判別可能な型で返す**——文字列メッセージだけにすると、
 * UI が行番号や列名を取り出せず「3 行目の TEST1」のような案内を組み立てられない。
 */
export type UploadRejection =
  /** 表にあるが CSV に無い（NULL を受け付けない列だけが問題になる） */
  | { kind: "column-missing"; columns: string[] }
  /** 同じ列が CSV に 2 回以上ある */
  | { kind: "column-duplicated"; columns: string[] }
  /** CSV にあるが表に無い */
  | { kind: "column-unknown"; columns: string[] }
  | { kind: "value-null"; row: number; column: string }
  /** 値を枠に詰められなかった（型・長さ・文字コード）。詰める段から届く */
  | { kind: "value-invalid"; row: number; column: string; reason: string };

export interface PreparedUpload {
  /** 表の実列名を **CSV の並び順**で。INSERT の列リストに使う */
  columns: string[];
  /** 列の並びに合わせ直した値 */
  rows: (string | null)[][];
}

export type PrepareResult =
  | { ok: true; prepared: PreparedUpload }
  | { ok: false; rejections: UploadRejection[]; truncated: boolean };

/** 拒否をいくつまで集めるか。全部返すと 1 万行の CSV で応答が膨れる */
const MAX_REJECTIONS = 100;

export interface PrepareUploadArgs {
  /** 表の列（`QSYS2.SYSCOLUMNS` 由来） */
  columns: readonly UploadColumn[];
  /** CSV のヘッダー */
  header: readonly string[];
  /** CSV のデータ行 */
  rows: readonly (readonly (string | null)[])[];
  /** 空文字を NULL として扱うか（既定 false＝空文字は空文字） */
  emptyAsNull?: boolean;
}

/** 列名の突き合わせは大文字・前後空白を無視する（CSV のヘッダーは人が書くため） */
const norm = (s: string): string => s.trim().toUpperCase();

export function prepareUpload(args: PrepareUploadArgs): PrepareResult {
  const { columns, header, rows, emptyAsNull = false } = args;
  const rejections: UploadRejection[] = [];

  // ---- 1. 列の突き合わせ ----
  const matched: { csvIndex: number; column: UploadColumn }[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  const duplicated: string[] = [];
  for (let i = 0; i < header.length; i++) {
    const col = columns.find((c) => norm(c.name) === norm(header[i]!));
    if (!col) {
      unknown.push(header[i]!.trim());
      continue;
    }
    // **同じ列を 2 回受けない**。放置すると `INSERT INTO t (A, A) VALUES (?, ?)` になり、
    // 事前検査の意味（書く前に止める）が失われてホストまで届く
    if (seen.has(norm(col.name))) {
      if (!duplicated.includes(col.name)) duplicated.push(col.name);
      continue;
    }
    seen.add(norm(col.name));
    matched.push({ csvIndex: i, column: col });
  }
  if (unknown.length > 0) rejections.push({ kind: "column-unknown", columns: unknown });
  if (duplicated.length > 0) rejections.push({ kind: "column-duplicated", columns: duplicated });

  // CSV に無い列は文に含めない＝表の既定値/NULL が入る。
  // **NULL を受け付けない列が CSV に無い**場合だけが問題
  const missing = columns
    .filter((c) => !c.nullable && !seen.has(norm(c.name)))
    .map((c) => c.name);
  if (missing.length > 0) rejections.push({ kind: "column-missing", columns: missing });

  // 構造が崩れていたら行は見ない。**列が対応づかない状態で行を検査しても意味のある指摘にならない**
  if (rejections.length > 0) return { ok: false, rejections, truncated: false };

  // ---- 2. 行を並べ直しつつ NULL 検査 ----
  const outColumns = matched.map((m) => m.column.name);
  const outRows: (string | null)[][] = [];

  for (let r = 0; r < rows.length; r++) {
    const rowNo = r + 1; // **CSV のデータ行番号（ヘッダーを除く 1 始まり）**
    const row = rows[r]!;
    const values: (string | null)[] = [];
    for (const { csvIndex, column } of matched) {
      const raw = csvIndex < row.length ? row[csvIndex]! : null;
      const v = raw === null || (emptyAsNull && raw === "") ? null : raw;
      if (v === null && !column.nullable) {
        rejections.push({ kind: "value-null", row: rowNo, column: column.name });
      }
      values.push(v);
    }
    outRows.push(values);
    if (rejections.length >= MAX_REJECTIONS) {
      return {
        ok: false,
        rejections: rejections.slice(0, MAX_REJECTIONS),
        // **まだ見ていない行が残っているときだけ truncated**
        truncated: rejections.length > MAX_REJECTIONS || r < rows.length - 1
      };
    }
  }

  if (rejections.length > 0) return { ok: false, rejections, truncated: false };
  return { ok: true, prepared: { columns: outColumns, rows: outRows } };
}
