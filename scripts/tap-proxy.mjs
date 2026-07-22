/**
 * 5250 中継タップ。**他クライアント（IBM ACS 等）と実機のやり取りを実測するための道具。**
 *
 * エミュレーターの挙動が ACS と違うとき、仕様書だけでは正解の応答形式が分からないことがある
 * （公開されている 5250 の資料には拡張コマンドの応答形式が載っていない）。ホストは形式違いを
 * 「機能チェック」としか言わないので、誤りの方向も分からない。そこで ACS と実機の間にこれを
 * 挟み、実物のバイト列を採る。Query Reply と READ SCREEN EXTENDED(0x64) の正解値はこれで判明した。
 *
 * 使い方:
 *   TARGET=<実機IP> LOG=./tap.log node scripts/tap-proxy.mjs
 *   → ACS のセッションを「このホストの IP / ポート 2323」に向けて操作する
 *
 * ポートの注意:
 * - 5250 telnet（2323 → 実機 23）だけ hex 記録する。
 * - **ホストサーバーポート（449 / 8470-8476）は中身を記録せず中継のみ**。ACS は接続前に
 *   PortMapper(449) へ問い合わせるので、中継しないと MSGSOCK007 で接続できない。
 *   記録しないのは、ここにサインオンの資格情報が流れるため。
 * - 449 は特権ポート。Linux では `sudo sysctl -w net.ipv4.ip_unprivileged_port_start=440`
 *   で開けられる（作業後は 1024 に戻す）。
 *
 * 解析の注意:
 * - telnet のエスケープを**先に解除**すること（末尾の `IAC EOR` を落とし `IAC IAC` → `0xFF`）。
 *   これをしないとレコード長も 0xFF 由来のデータも読み違える。
 * - デコーダーのコマンド表に無いバイトは黙って消える。未知のコマンドは必ず可視化すること。
 * - **記録にはサインオン画面のパスワードが平文で残る。解析が済んだら削除すること。**
 */
import net from "node:net";
import fs from "node:fs";

const TARGET = process.env.TARGET;
if (!TARGET) {
  process.stderr.write("TARGET=<host> を指定してください\n");
  process.exit(1);
}
const log = (s) => process.stderr.write(s + "\n");
const out = fs.createWriteStream(process.env.LOG || "tap.log", { flags: "a" });

/** [待ち受けポート, 転送先ポート, hex 記録するか] */
const MAP = [
  [Number(process.env.TAP_PORT || 2323), 23, true],
  [449, 449, false],
  [8470, 8470, false],
  [8471, 8471, false],
  [8472, 8472, false],
  [8473, 8473, false],
  [8474, 8474, false],
  [8475, 8475, false],
  [8476, 8476, false]
];

let seq = 0;
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

for (const [listenPort, targetPort, capture] of MAP) {
  const server = net.createServer((client) => {
    const tag = `p${listenPort}#${++seq}`;
    const upstream = net.connect(targetPort, TARGET);
    if (capture) out.write(`--- open ${tag} -> ${TARGET}:${targetPort}\n`);
    client.on("data", (d) => {
      if (capture) out.write(`C>S ${tag} len=${d.length}: ${hex(d)}\n`);
      upstream.write(d);
    });
    upstream.on("data", (d) => {
      if (capture) out.write(`S>C ${tag} len=${d.length}: ${hex(d)}\n`);
      client.write(d);
    });
    const bye = () => {
      client.destroy();
      upstream.destroy();
      if (capture) out.write(`--- close ${tag}\n`);
    };
    for (const s of [client, upstream]) {
      s.on("error", bye);
      s.on("close", bye);
    }
  });
  server.on("error", (e) => log(`listen ${listenPort} FAILED: ${e.message}`));
  server.listen(listenPort, "0.0.0.0", () =>
    log(`listening ${listenPort} -> ${TARGET}:${targetPort}${capture ? " (hex capture)" : " (relay only)"}`)
  );
}
