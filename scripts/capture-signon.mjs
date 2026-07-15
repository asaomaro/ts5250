// PUB400 のサインオン画面データストリームを採取して JSONL trace に保存する（T7）。
// 使い方: node scripts/capture-signon.mjs [出力パス]
// 注意: サインオンは行わない（資格情報不要・送信データに秘匿情報は含まれない）ため maskTx: false。
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { TcpTransport, TelnetLayer, TraceRecorder, bytesToHex } from "@as400web/core";

const host = process.env.PUB400_HOST ?? "pub400.com";
const port = Number(process.env.PUB400_PORT ?? 23);
const out = process.argv[2] ?? "packages/core/test/fixtures/pub400-signon.jsonl";
const log = (s) => process.stderr.write(s + "\n");

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, "");
const rec = new TraceRecorder((l) => appendFileSync(out, l + "\n"), { maskTx: false });

const inner = await TcpTransport.connect({ host, port });
log(`connected to ${host}:${port}`);

/** 生バイトを trace しつつ委譲する Transport ラッパ */
const tracing = {
  send(d) {
    rec.tx(d);
    inner.send(d);
  },
  close() {
    inner.close();
  },
  onData(fn) {
    inner.onData((d) => {
      rec.rx(d);
      fn(d);
    });
  },
  onClose(fn) {
    inner.onClose(fn);
  },
  onError(fn) {
    inner.onError(fn);
  }
};

const telnet = new TelnetLayer(tracing, {
  terminalType: "IBM-3179-2",
  deviceName: process.env.PUB400_DEVNAME
});

let records = 0;
let idleTimer;
const done = new Promise((resolve) => {
  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(resolve, 3000); // 3 秒受信が止まったら完了
  };
  telnet.onRecord((r) => {
    records++;
    log(`record #${records}: ${r.length} bytes, head=${bytesToHex(r.slice(0, 16))}`);
    arm();
  });
  telnet.onClose((reason) => {
    log(`closed: ${reason}`);
    resolve();
  });
  setTimeout(resolve, 20000); // 全体上限 20 秒
  arm();
});

await done;
telnet.close();
log(`saved ${records} records to ${out}`);
process.exit(0);
