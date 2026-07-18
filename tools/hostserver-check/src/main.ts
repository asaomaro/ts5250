/**
 * 実機の IBM i ホストサーバーに対して signon 認証を確かめる手動チェック。
 *
 * 自動テストにはしない——実機・実アカウントを要し、誤ったパスワードで繰り返すと
 * プロファイルが無効化されうるため（QMAXSIGN）。
 *
 * 使い方:
 *   AS400_HOST=pub400.com AS400_USER=xxx AS400_PASSWORD=yyy \
 *     npm run check -w @as400web/hostserver-check -- --tls
 *
 * パスワードは環境変数からのみ受け取る（引数はプロセス一覧に見えるため）。
 */
import { signon, resolveServicePort, Tn5250Error } from "@as400web/core";

const host = process.env["AS400_HOST"] ?? process.env["PUB400_HOST"] ?? "pub400.com";
const user = process.env["AS400_USER"] ?? process.env["PUB400_USER"];
const password = process.env["AS400_PASSWORD"] ?? process.env["PUB400_PASSWORD"];

const useTls = process.argv.includes("--tls");
const useMapper = process.argv.includes("--resolve-port");

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!user || !password) {
  fail(
    "AS400_USER と AS400_PASSWORD（または PUB400_USER / PUB400_PASSWORD）を環境変数で指定してください"
  );
}

async function main(): Promise<void> {
  process.stdout.write(`host=${host} tls=${useTls} user=${user}\n`);

  if (useMapper) {
    // TLS では "-s" 付きのサービス名で問い合わせる（signon 内部と同じ条件で表示する）
    const port = await resolveServicePort(host, "signon", { tls: useTls });
    process.stdout.write(`port mapper: as-signon${useTls ? "-s" : ""} -> ${port}\n`);
  }

  const result = await signon({
    host,
    user: user as string,
    password: password as string,
    tls: useTls,
    resolvePort: useMapper
  });

  process.stdout.write(
    [
      "認証成功",
      `  server version   : ${result.info.version}`,
      `  datastream level : ${result.info.datastreamLevel}`,
      `  password level   : ${result.info.passwordLevel}`,
      `  job name         : ${result.info.jobName ?? "(なし)"}`,
      `  server CCSID     : ${result.serverCcsid ?? "(なし)"}`,
      ""
    ].join("\n")
  );
}

main().catch((e: unknown) => {
  if (e instanceof Tn5250Error) {
    fail(`認証に失敗しました [${e.code}] ${e.message}`);
  }
  fail(`予期しないエラー: ${String(e)}`);
});
