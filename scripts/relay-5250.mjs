// **5250 の中継（記録用）。ACS のコア（`scripts/acs-probe.mjs`）や当 PJ を実機との間に挟み、両方向の生バイトを記録する。**
//
// `tap-proxy.mjs`（IBM ACS の GUI 用。ホストサーバーのポート 449・8470〜8476 も中継する）と違い、**5250 の telnet（23）だけ**を中継する——
// 待ち受けポートを自由に選べ（特権ポートが要らない）、ACS のコアや診断スクリプトの測定に向く。`20260921-g-field-sosi` で G の欄のワイヤを採るのに使った。
//
// 実行（実機のアドレスは `.env` の値を環境変数越しに渡す。値を画面に出さない）:
//   TARGET_HOST=<実機> RELAY_PORT=32323 RELAY_LOG=./relay.log node scripts/relay-5250.mjs
//   AS400_HOST=127.0.0.1 PROBE_PORT=32323 node --env-file=.env --env-file=.env.verify scripts/acs-probe.mjs <手順ファイル>
//   （`.env` の `AS400_HOST` を `--env-file` で読ませる形なら:
//     node --env-file=.env -e 'process.env.TARGET_HOST=process.env.AS400_HOST; process.env.RELAY_PORT="32323"; process.env.RELAY_LOG="./relay.log"; await import("./scripts/relay-5250.mjs")' --input-type=module ）
//
// 記録: 1 行 1 パケット。`C>H <hex>` がクライアント→ホスト、`H>C <hex>` がホスト→クライアント。**telnet のバイト列そのまま**（IAC のエスケープを解く前）。
// 解析の注意は `tap-proxy.mjs` と同じ（末尾の `IAC EOR`〔`ff ef`〕を落とし `IAC IAC` を `ff` に戻す。1 パケットが複数のレコードや、レコードの一部のことがある）。
//
// ⚠ **記録にはサインオンのパスワードが平文で残る。解析が済んだら必ず消す**（`shred -u`）。リポジトリに入れない。
import net from "node:net";
import fs from "node:fs";

const TARGET = process.env.TARGET_HOST;
const PORT = Number(process.env.RELAY_PORT ?? 32323);
const LOG = process.env.RELAY_LOG;
if (!TARGET || !LOG) {
  process.stderr.write("TARGET_HOST と RELAY_LOG が要ります\n");
  process.exit(2);
}
// 記録にはパスワードが平文で残るので、**作る権限は本人だけ**（0600。既定の umask だと他の利用者から読める）。`*.log` にすると `.gitignore` の除外に合う
const out = fs.createWriteStream(LOG, { flags: "a", mode: 0o600 });
net
  .createServer((c) => {
    const s = net.connect(23, TARGET);
    c.on("data", (d) => {
      out.write(`C>H ${d.toString("hex")}\n`);
      s.write(d);
    });
    s.on("data", (d) => {
      out.write(`H>C ${d.toString("hex")}\n`);
      c.write(d);
    });
    c.on("close", () => s.end());
    s.on("close", () => c.end());
    c.on("error", () => s.destroy());
    s.on("error", () => c.destroy());
  })
  .listen(PORT, "127.0.0.1", () => process.stderr.write(`relay up: 127.0.0.1:${PORT} -> :23\n`));
