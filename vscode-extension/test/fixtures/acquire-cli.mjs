// テスト専用フィクスチャ。`serviceManager.multiprocess.integration.test.ts`が、
// **本物の別々のOSプロセス**として2つ同時に起動し、同じロックファイルへの
// `acquire()`が実際に競合したときの調停（design.md「振る舞いの詳細」）を確認する。
// 単体プロセス内で2つの`ServiceManager`インスタンスを順に呼ぶだけでは、
// 実プロセス間のファイルI/Oレースは再現できない（`serviceManager.integration.test.ts`の
// 制約。`02-extension-core/test-result.md`「未検証の穴」）。
import { ServiceManager } from "../../dist/serviceManager.js";

const [, , lockFilePath, windowId, serverMainPath, webRootPath, connectionsPath, secretKeyFilePath] = process.argv;

const sm = new ServiceManager({
  lockFilePath,
  serverMainPath,
  webRootPath,
  connectionsPath,
  secretKeyFilePath,
  windowId
});

const result = await sm.acquire();
// 自分がspawnしたサーバー（生きているなら参照カウント経由で使われ続ける）のパイプ等の
// ハンドルは、このCLI自身が終了する妨げにしない——結果を出力したら即座に終了する
// （`unref`しても子は殺されない。独立プロセスとして残り続ける。design.md通りの挙動）
result.child?.unref();
process.stdout.write(
  JSON.stringify({ port: result.port, spawnedChild: result.child !== undefined, childPid: result.child?.pid }) + "\n"
);
process.exit(0);
