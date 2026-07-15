// trace fixture を WtdApplier に適用して画面をテキストダンプする（開発補助）
// 使い方: node scripts/dump-screen.mjs [trace.jsonl]
import { readFileSync } from "node:fs";
import { parseTraceJsonl } from "../packages/core/dist/trace/trace.js";
import { ReplayTransport } from "../packages/core/dist/trace/replay.js";
import { TelnetLayer } from "../packages/core/dist/telnet/telnet.js";
import { parseRecord } from "../packages/core/dist/protocol/gds.js";
import { applyDataStream } from "../packages/core/dist/protocol/wtd-applier.js";
import { ScreenBuffer } from "../packages/core/dist/screen/buffer.js";
import { codecForCcsid } from "../packages/core/dist/codec/codec.js";

const path = process.argv[2] ?? "packages/core/test/fixtures/pub400-signon.jsonl";
const out = (s) => process.stderr.write(s + "\n");

const entries = parseTraceJsonl(readFileSync(path, "utf8"));
const t = new ReplayTransport(entries);
const telnet = new TelnetLayer(t, { terminalType: "IBM-3179-2" });
const buf = new ScreenBuffer();
const codec = codecForCcsid(37);

telnet.onRecord((rec) => {
  const parsed = parseRecord(rec);
  const result = applyDataStream(parsed.data, buf, codec, (w) => out(`WARN: ${w}`));
  out(`record: opcode=${parsed.opcode} result=${JSON.stringify(result)}`);
});
t.start();

const snap = buf.snapshot("dump", false);
out(`cursor=(${snap.cursor.row},${snap.cursor.col}) fields=${snap.fields.length}`);
for (const f of snap.fields) {
  out(
    `  #${f.index} (${f.row},${f.col}) len=${f.length}` +
      `${f.protected ? " protected" : ""}${f.hidden ? " hidden" : ""}${f.numeric ? " numeric" : ""} value=${JSON.stringify(f.value)}`
  );
}
out("--- screen ---");
snap.cells.forEach((row, i) => {
  out(String(i + 1).padStart(2) + "|" + row.map((c) => c.char).join(""));
});
