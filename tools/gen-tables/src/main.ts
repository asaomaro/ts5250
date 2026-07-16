import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUcm } from "./ucm.js";
import { emitSbcsTable } from "./emit-sbcs.js";
import { emitStatefulTable } from "./emit-stateful.js";

const here = dirname(fileURLToPath(import.meta.url)); // tools/gen-tables/dist
const toolRoot = join(here, "..");
const repoRoot = join(toolRoot, "..", "..");
const outDir = join(repoRoot, "packages", "core", "src", "codec", "tables");

/** SBCS 生成対象 */
const SBCS_TARGETS = [
  { file: "ibm-37_P100-1999.ucm", ccsid: 37, exportName: "ibm37", out: "ibm37.ts" },
  // 273: ドイツ語/オーストリア。PUB400 の QCCSID がこれ。37 と variant 文字が異なる
  // （'@'=0xB5・'§'=0x7C。37 は '@'=0x7C）ため、37 で繋ぐと '@' 入りのパスワードが化ける。
  { file: "ibm-273_P100-1995.ucm", ccsid: 273, exportName: "ibm273", out: "ibm273.ts" }
] as const;

/** DBCS（EBCDIC_STATEFUL）生成対象 */
const DBCS_TARGETS = [
  { file: "ibm-930_P120-1999.ucm", ccsid: 930, exportName: "ibm930", out: "ibm930.ts" },
  { file: "ibm-939_P120-1999.ucm", ccsid: 939, exportName: "ibm939", out: "ibm939.ts" },
  { file: "ibm-1399_P110-2003.ucm", ccsid: 1399, exportName: "ibm1399", out: "ibm1399.ts" }
] as const;

mkdirSync(outDir, { recursive: true });
for (const t of SBCS_TARGETS) {
  const ucm = parseUcm(readFileSync(join(toolRoot, "ucm", t.file), "utf8"));
  writeFileSync(join(outDir, t.out), emitSbcsTable(ucm, { ccsid: t.ccsid, exportName: t.exportName, sourceFile: t.file }));
  process.stderr.write(`generated ${t.out} (SBCS, ${ucm.entries.length} mappings)\n`);
}
for (const t of DBCS_TARGETS) {
  const ucm = parseUcm(readFileSync(join(toolRoot, "ucm", t.file), "utf8"));
  writeFileSync(join(outDir, t.out), emitStatefulTable(ucm, { ccsid: t.ccsid, exportName: t.exportName, sourceFile: t.file }));
  process.stderr.write(`generated ${t.out} (DBCS, ${ucm.entries.length} mappings)\n`);
}
