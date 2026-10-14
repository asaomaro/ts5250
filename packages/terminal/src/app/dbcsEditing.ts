/**
 * J（only）・G（pure）・E（either）欄の編集。通常の文字欄・O 欄と違い、欄の中身は「論理の字の並び」で持ち、画面のセルとの対応は
 * 欄の形（SO 字… SI の並びと詰め物）から導く。
 *
 * 規則の出所は web-ui の `ScreenGrid.vue`（`dbcsType`・`jeShapeOf`・`eitherModeSwitch`・`insertBudget` など。実機の ACS のコアで測った結果が
 * コメントに残っている）。そこは Vue のコンポーネント内にあり純関数として取り出せないので、端末版は**同じ規則を小さく書き起こした**
 * （`20261014-terminal-ui` decisions D21。二重化なので web-ui 側が変わったら追従が要る）。
 *
 * 対応する範囲（1 行に収まる欄だけ）:
 * - J: SO・全角の字・空き（NUL の組）・SI。空き 2 桁ごとに全角 1 字。半角の空白は全角空白にして打つ（ACS の `convertSBCSCharToDBCS`）
 * - G: SO/SI なし。全角空白で詰める
 * - E: 最初の字で半角か全角かが決まり、混ぜられない。全角の状態は J と同じ並び（SI が最後の桁の `full`、中身の直後の `compact`）
 * 未対応（値を変えずに知らせる）: 複数の行にまたがる欄
 */
import type { Field, ScreenSnapshot } from "@ts5250/tn5250";
import { posOfOffset, offsetOfPos } from "@ts5250/tn5250/edit/fieldSlices";
import { rejectReason, SO_MARK, SI_MARK, DEAD_MARK, isWideForDbcs } from "@ts5250/tn5250/edit/fieldValidate";
import type { EditEnv, EditOutcome } from "./editing.js";

export const MSG_EITHER_DBCS_MODE = "この項目は全角で入力中です（半角にするには項目の先頭で打ってください）";
export const MSG_EITHER_SBCS_MODE = "この項目は半角で入力中です（全角にするには項目の先頭で打ってください）";

const WIDE_SPACE = "　";
const NUL = "\u0000";

/** J・G・E のうち端末版が編集できる欄か（1 行に収まるもの）。複数行の欄は呼び出し側が未対応にする */
export const isJeg = (f: Field): boolean => f.dbcsType === "only" || f.dbcsType === "pure" || f.dbcsType === "either";

interface Model {
  /** 論理の字（半角の E は 1 字 1 バイト、それ以外は全角 1 字 2 バイト）。末尾の空きは含まない */
  chars: string[];
  /** 全角を 1 単位（2 桁）で持つか。半角の状態の E だけ false */
  wide: boolean;
  /** SO・SI の桁を持つか（G と半角の E は持たない） */
  shifted: boolean;
  shape: "full" | "compact" | "open";
  /** 上書きで入れられる字数 */
  capOverwrite: number;
  /** 挿入で入れられる字数（compact の E は最後の桁を空きに数えない。ACS `reserveRoomForInsert`） */
  capInsert: number;
  eitherOn: boolean;
  /** open の E が「中身を全部消したあと」の欄か */
  erased?: boolean;
}

type Loaded = { ok: true; m: Model } | { ok: false; note: string };

const MSG_UNSUPPORTED_JEG = "この欄の編集は未対応です（複数行にまたがる欄・SI の無い全角の E）";

/** 欄のセルから編集の模型を組む */
function load(f: Field, snap: ScreenSnapshot, env: EditEnv): Loaded {
  if (f.length > snap.cols - f.col + 1) return { ok: false, note: MSG_UNSUPPORTED_JEG };
  const row = snap.cells[f.row - 1];
  const cells = Array.from({ length: f.length }, (_, i) => row?.[f.col - 1 + i]);
  const hasSo = cells[0]?.kind === "so";
  const wideChars: string[] = [];
  const halfChars: string[] = [];
  let siAt = -1;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (!c) continue;
    if (c.kind === "si") {
      if (siAt < 0) siAt = i;
      continue;
    }
    if (c.kind === "so" || c.kind === "dbcs-tail") continue;
    if (c.kind === "dbcs-lead") {
      wideChars.push(c.char);
      halfChars.push(c.char);
      continue;
    }
    // 空き（ホストが書かなかった桁。生バイトを持たない空白）
    const free = c.kind === "sbcs" && c.char === " " && c.rawByte === undefined;
    halfChars.push(free ? NUL : c.char);
  }
  const trimNul = (a: string[]): string[] => {
    const out = [...a];
    while (out.length > 0 && out[out.length - 1] === NUL) out.pop();
    return out;
  };
  const L = f.length;
  if (f.dbcsType === "pure") {
    const cap = Math.floor(L / 2);
    return { ok: true, m: { chars: wideChars, wide: true, shifted: false, shape: "full", capOverwrite: cap, capInsert: cap, eitherOn: true } };
  }
  const full = Math.floor((L - 2) / 2);
  if (f.dbcsType === "only") {
    return { ok: true, m: { chars: wideChars, wide: true, shifted: true, shape: "full", capOverwrite: full, capInsert: full, eitherOn: true } };
  }
  // E: 全角の状態は、先頭が SO か、字があれば先頭の字の種類。空なら画面の中で切り替えた状態か、コアが持つ状態
  const first = halfChars.find((c) => c !== NUL && c !== " ");
  const switched = env.eitherMemory?.get(f.index);
  const eitherOn = hasSo || (first !== undefined ? isWideForDbcs(first) : (switched ?? f.eitherDbcsOn === true));
  if (!eitherOn) {
    const chars = trimNul(halfChars);
    return { ok: true, m: { chars, wide: false, shifted: false, shape: "full", capOverwrite: L, capInsert: L, eitherOn: false } };
  }
  // SI の無い全角の E（open）: compact の E を中身の中から消したあとの形（ACS は SI を足さない）
  const open = (hasSo && siAt < 0) || (wideChars.length === 0 && env.jeErased?.has(f.index) === true);
  const shape = open ? "open" : hasSo && siAt >= 0 && siAt !== L - 1 ? "compact" : "full";
  const capInsert = shape === "full" ? full : Math.floor((L - 3) / 2);
  const erased = env.jeErased?.has(f.index) === true;
  return { ok: true, m: { chars: wideChars, wide: true, shifted: true, shape, capOverwrite: full, capInsert, eitherOn: true, ...(erased ? { erased } : {}) } };
}

/** 論理の字の並び → `setField` へ渡す値（J・全角の E は SO…SI の印入り。空きは NUL の組） */
function compose(f: Field, m: Model): string {
  const n = m.chars.length;
  if (n === 0) return "";
  const body = m.chars.join("");
  if (!m.wide) return m.chars.map((c) => (c === NUL ? DEAD_MARK : c)).join("");
  if (!m.shifted) return body + WIDE_SPACE.repeat(Math.max(0, m.capOverwrite - n));
  // SI の無い E: 消したあとの 2 字目以降は新しい `SO 字… SI` の組（実機の ACS）。それまでは SI を付けない
  if (m.shape === "open") return m.erased === true && n >= 2 ? SO_MARK + m.chars[0] + SO_MARK + m.chars.slice(1).join("") + SI_MARK : SO_MARK + body;
  if (m.shape === "compact") return SO_MARK + body + SI_MARK;
  return SO_MARK + body + DEAD_MARK.repeat(Math.max(0, f.length - 2 - 2 * n)) + SI_MARK;
}

/** 論理位置（字の添字）→ 欄の中の桁 */
const offsetOfIdx = (m: Model, idx: number): number => (m.wide ? (m.shifted ? 1 : 0) + 2 * idx : idx);

/** 欄の中の桁 → 論理位置（字の添字）。SO の桁は先頭、全角の後半は同じ字 */
function idxOfOffset(m: Model, off: number): number {
  if (!m.wide) return off;
  return Math.max(0, Math.floor((off - (m.shifted ? 1 : 0)) / 2));
}

const fail = (note?: string): EditOutcome => (note === undefined ? { ok: false } : { ok: false, note });

function done(f: Field, m: Model, idx: number, env: EditEnv, extra: Partial<Extract<EditOutcome, { ok: true }>> = {}): EditOutcome {
  const cursor = posOfOffset(f, Math.min(offsetOfIdx(m, idx), f.length), env.cols, env.rows);
  return { ok: true, value: compose(f, m), cursor, ...extra };
}

function setup(f: Field, snap: ScreenSnapshot, pos: { row: number; col: number }, env: EditEnv): { m: Model; idx: number } | EditOutcome {
  const l = load(f, snap, env);
  if (!l.ok) return fail(l.note);
  const off = offsetOfPos(f, pos.row, pos.col, env.cols, env.rows);
  if (off === undefined) return fail("ここには入力できません");
  return { m: l.m, idx: idxOfOffset(l.m, off) };
}

const isOutcome = (x: { m: Model; idx: number } | EditOutcome): x is EditOutcome => "ok" in x;

/** 1 文字を打つ（MSG_NO_ROOM・MSG_BY_REASON は呼び出し側から受ける——editing.ts との循環を避ける） */
export function jegType(
  f: Field, snap: ScreenSnapshot, pos: { row: number; col: number }, raw: string, env: EditEnv,
  msgs: { noRoom: string; byReason: (why: NonNullable<ReturnType<typeof rejectReason>>) => string }
): EditOutcome {
  const s = setup(f, snap, pos, env);
  if (isOutcome(s)) return s;
  const { m } = s;
  let { idx } = s;
  // 打鍵の半角空白は、J・G と全角の E では全角空白にする（ACS `convertSBCSCharToDBCS`）
  const ch = raw === " " && m.wide && (f.dbcsType !== "either" || m.eitherOn) ? WIDE_SPACE : raw;
  const why = rejectReason(f, ch, { sbcsOnly: env.sbcsOnly });
  if (why) {
    // E は種類の違う字を理由つきで断る（先頭なら切り替える）ので、型の検査の前に半角・全角の切り替えを見る
    if (f.dbcsType !== "either") return fail(msgs.byReason(why));
  }
  const wide = isWideForDbcs(ch);
  if (f.dbcsType === "either" && m.eitherOn !== wide) {
    if (idx !== 0) return fail(m.eitherOn ? MSG_EITHER_DBCS_MODE : MSG_EITHER_SBCS_MODE);
    // 先頭なら欄を空にして切り替える
    m.chars = [];
    m.eitherOn = wide;
    m.wide = wide;
    m.shifted = wide;
    m.shape = "full";
    m.capOverwrite = wide ? Math.floor((f.length - 2) / 2) : f.length;
    m.capInsert = m.capOverwrite;
    env.eitherMemory?.set(f.index, wide);
  } else if (why) return fail(msgs.byReason(why));
  const gap = m.wide ? WIDE_SPACE : NUL;
  if (env.insertMode) {
    if (idx >= m.capOverwrite) return fail(msgs.noRoom);
    idx = Math.min(idx, m.chars.length);
    // 末尾の全角空白は空きに数える（ACS `reserveRoomForInsert`。ホストが 4040 で埋めた欄への挿入）。カーソルより後ろの分だけ
    while (m.chars.length + 1 > m.capInsert && m.chars.length > idx && m.chars[m.chars.length - 1] === WIDE_SPACE) m.chars.pop();
    if (m.chars.length + 1 > m.capInsert) return fail(msgs.noRoom);
    m.chars.splice(idx, 0, ch);
  } else {
    if (idx >= m.capOverwrite) return fail(msgs.noRoom);
    while (m.chars.length < idx) m.chars.push(gap);
    m.chars[idx] = ch;
  }
  const filled = idx + 1 === m.capOverwrite;
  return done(f, m, idx + 1, env, filled ? { filled } : {});
}

export function jegDelete(f: Field, snap: ScreenSnapshot, pos: { row: number; col: number }, env: EditEnv): EditOutcome {
  const s = setup(f, snap, pos, env);
  if (isOutcome(s)) return s;
  const { m, idx } = s;
  if (idx < m.chars.length) m.chars.splice(idx, 1);
  return done(f, m, idx, env);
}

export function jegBackspace(f: Field, snap: ScreenSnapshot, pos: { row: number; col: number }, env: EditEnv): EditOutcome {
  const s = setup(f, snap, pos, env);
  if (isOutcome(s)) return s;
  const { m, idx } = s;
  if (idx <= 0) return fail();
  const at = Math.min(idx, m.chars.length);
  if (idx - 1 < m.chars.length) m.chars.splice(idx - 1, 1);
  return done(f, m, Math.min(idx - 1, at), env);
}

export function jegExit(f: Field, snap: ScreenSnapshot, pos: { row: number; col: number }, env: EditEnv): EditOutcome {
  const s = setup(f, snap, pos, env);
  if (isOutcome(s)) return s;
  const { m, idx } = s;
  const before = m.chars.length;
  m.chars.length = Math.min(idx, m.chars.length);
  // 全角の E で SI が中身の直後（compact）なら、カーソルが SI より前の消去は SI も消す（ACS の 1 桁の内側の消去）
  if (f.dbcsType === "either" && m.wide && m.shape === "compact" && idx <= before) {
    m.shape = "open";
    if (m.chars.length === 0) {
      env.jeErased?.add(f.index);
      env.eitherMemory?.set(f.index, true);
      m.erased = true;
    }
  } else if (f.dbcsType === "either" && m.wide && m.chars.length === 0) {
    env.eitherMemory?.set(f.index, true);
  }
  return done(f, m, idx, env);
}
