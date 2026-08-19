import { defineConfig } from "vitest/config";

/**
 * **`TN3270_E2E=1` のときはテストファイルを直列に走らせる。**
 *
 * E2E は 1 本ごとに `s3270` の docker コンテナを立てる。vitest は既定でファイルを
 * 並列に走らせるため、E2E の本数が増えるにつれて**`docker run` が詰まり、
 * どれか 1 本が時間切れになる**（当たるファイルは毎回変わった）。
 * テストの中身の問題ではないので、**並列度の方を落とす**。
 *
 * docker を使わない既定の走行はこれまで通り並列のまま。
 */
const e2e = process.env["TN3270_E2E"] === "1";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: !e2e,
    testTimeout: e2e ? 300_000 : 5_000
  }
});
