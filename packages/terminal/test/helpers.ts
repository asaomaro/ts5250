import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Session5250, ReplayTransport, parseTraceJsonl } from "@ts5250/tn5250";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "tn5250", "test", "fixtures");

/** tn5250 のフィクスチャ（実機の記録）から、本物の `Session5250` を作る */
export async function sessionFrom(name: string, ccsid?: number): Promise<Session5250> {
  const entries = parseTraceJsonl(readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8"));
  return Session5250.connect({ transport: new ReplayTransport(entries), id: "t", ...(ccsid ? { ccsid } : {}) });
}

/** SGR・CUP・CHA を落として、文字だけにする（行の文字列の検査用） */
export const plain = (s: string): string => s.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "");
