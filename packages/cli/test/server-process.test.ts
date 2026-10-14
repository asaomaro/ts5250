import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchArgs } from "../src/server-process.js";

describe("launchArgs（start.sh と同じ決め）", () => {
  it("--port はサーバー本体の --http に直す", () => {
    const d = mkdtempSync(join(tmpdir(), "t5-"));
    expect(launchArgs(d, ["--port", "4000"]).app).toEqual(["--http", "4000"]);
  });

  it("あるファイルだけを渡す（.env → --env-file、profiles.local.json 優先）", () => {
    const d = mkdtempSync(join(tmpdir(), "t5-"));
    expect(launchArgs(d, [])).toEqual({ node: [], app: [] });
    writeFileSync(join(d, ".env"), "");
    writeFileSync(join(d, "profiles.json"), "{}");
    expect(launchArgs(d, [])).toEqual({ node: ["--env-file=.env"], app: ["--profiles", "profiles.json"] });
    writeFileSync(join(d, "profiles.local.json"), "{}");
    expect(launchArgs(d, []).app).toEqual(["--profiles", "profiles.local.json"]);
  });

  it("--profiles を明示したら自動検出で足さない", () => {
    const d = mkdtempSync(join(tmpdir(), "t5-"));
    writeFileSync(join(d, "profiles.local.json"), "{}");
    expect(launchArgs(d, ["--profiles", "x.json"]).app).toEqual(["--profiles", "x.json"]);
  });
});
