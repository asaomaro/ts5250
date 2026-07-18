/**
 * 実機の IBM i で CL コマンドを実行する手動チェック。
 *
 * 使い方:
 *   AS400_USER=xxx AS400_PASSWORD=yyy \
 *     npm run cmd -w @as400web/hostserver-check -- --tls "DSPLIB LIB(QGPL)"
 */
import { CommandConnection, describeMessage, Tn5250Error } from "@as400web/core";

const host = process.env["AS400_HOST"] ?? process.env["PUB400_HOST"] ?? "pub400.com";
const user = process.env["AS400_USER"] ?? process.env["PUB400_USER"];
const password = process.env["AS400_PASSWORD"] ?? process.env["PUB400_PASSWORD"];
const useTls = process.argv.includes("--tls");
const commands = process.argv.slice(2).filter((a) => !a.startsWith("--"));

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
if (!user || !password) fail("AS400_USER / AS400_PASSWORD を環境変数で指定してください");

async function main(): Promise<void> {
  const conn = await CommandConnection.connect({
    host,
    user: user as string,
    password: password as string,
    tls: useTls
  });
  try {
    process.stdout.write(
      `host=${host} tls=${useTls} ${conn.info.version} ` +
        `ccsid=${conn.info.ccsid} dsLevel=${conn.info.datastreamLevel}\n\n`
    );
    for (const cmd of commands.length > 0 ? commands : ["CHGJOB CCSID(273)"]) {
      const r = await conn.run(cmd);
      process.stdout.write(
        `${r.success ? "成功" : "失敗"}  rc=0x${r.returnCode.toString(16)}  ${cmd}\n`
      );
      for (const m of r.messages) process.stdout.write(`    ${describeMessage(m)}\n`);
    }
  } finally {
    conn.close();
  }
}

main().catch((e: unknown) => {
  if (e instanceof Tn5250Error) fail(`[${e.code}] ${e.message}`);
  fail(`予期しないエラー: ${String(e)}`);
});
