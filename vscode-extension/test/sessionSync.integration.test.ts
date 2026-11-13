import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ServiceManager } from "../src/serviceManager.js";
import { syncSession } from "../src/sessionSync.js";

/** 実サーバーを起動し、許可が信頼設定として保存・再同期されることを確認する。IBM i へは接続しない。 */
describe("VSCode の PC コマンド設定の同期", () => {
  it("拡張専用 profiles を初期化し、同じセッションへ有効・無効を反映する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vscode-pc-command-"));
    const profilesPath = join(dir, "profiles.json");
    const root = resolve(__dirname, "../..");
    const manager = new ServiceManager({
      lockFilePath: join(dir, "service.json"),
      serverMainPath: join(root, "packages/server/dist/main.js"),
      webRootPath: join(root, "packages/web-ui/dist"),
      connectionsPath: join(dir, "connections.json"), profilesPath,
      secretKeyFilePath: join(dir, ".env"), windowId: "pc-command-test"
    });
    const { port } = await manager.acquire();
    try {
      const opts = {
        port, mappingFilePath: join(dir, "sessionRefs.json"),
        systemMappingFilePath: join(dir, "serverSystemRefs.json")
      };
      const input = {
        documentUri: "file:///test.ts5250emu", name: "test", host: "TESTHOST",
        ccsid: 930, katakanaVariant: "katakana-ex" as const, user: "TESTUSER",
        password: "test-password-only", deviceName: "TESTDEV", screenSize: "27x132" as const,
        enhanced: true, allowPcCommand: true, keepAlive: true, deviceNameRetry: true, associatedPrinter: "PRT_TEST", pcCommand: { allow: ["prog:notepad"], timeoutMs: 5000 }
      };
      const ref = await syncSession(input, opts);
      expect(ref).toMatch(/^srv:/);
      const list = async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions-config`);
        expect(res.ok).toBe(true);
        return await res.json() as { editable: boolean; sessions: { ref: string; pcCommand?: { enabled: boolean }; deviceName?: string }[] };
      };
      // 印刷先は公開 API に載らないため、サーバーが保存した実体でも照合する。
      const stored = (ref: string) => (JSON.parse(readFileSync(profilesPath, "utf8")) as { sessions: Record<string, unknown>[] }).sessions.find((s) => `srv:${String(s.id)}` === ref);
      const enabled = await list();
      expect(enabled.editable).toBe(true);
      expect(enabled.sessions).toHaveLength(1);
      expect(stored(ref)).toMatchObject({ pcCommand: { enabled: true, allow: ["prog:notepad"], timeoutMs: 5000 }, enhanced: true, keepAlive: true, deviceNameRetry: true, associatedPrinter: "PRT_TEST", deviceName: "TESTDEV", screenSize: "27x132", katakanaVariant: "katakana-ex" });
      const saved = readFileSync(profilesPath, "utf8");
      expect(saved).not.toContain(input.password);
      expect(JSON.parse(saved).systems).toHaveLength(1);
      expect(await syncSession({ ...input, host: "OTHERHOST", allowPcCommand: false, pcCommand: {}, associatedPrinter: "", keepAlive: false, deviceNameRetry: false, enhanced: false }, opts)).toBe(ref);
      const disabled = await list();
      expect(disabled.sessions).toHaveLength(1);
      expect(disabled.sessions[0]?.pcCommand).toEqual({ enabled: false });
      expect(stored(ref)).toMatchObject({ enhanced: false, keepAlive: false, deviceNameRetry: false });
      expect(disabled.sessions[0]).not.toHaveProperty("associatedPrinter");
      const pdfDir = join(dir, "pdf");
      mkdirSync(pdfDir);
      const printerInput = { ...input, app: "printer" as const, documentUri: "file:///printer.ts5250prt", name: "printer", printer: { autoPdfDir: pdfDir, autoPrint: "PRT_TEST" } };
      const printerRef = await syncSession(printerInput, opts);
      const withPrinter = await list();
      expect(withPrinter.sessions.some((s) => s.ref === printerRef)).toBe(true);
      const printer = stored(printerRef);
      expect(printer).toMatchObject({ sessionType: "printer", printer: { autoPdfDir: pdfDir, autoPrint: "PRT_TEST" }, keepAlive: true, deviceNameRetry: true });
      expect(printer).not.toHaveProperty("pcCommand");
      await syncSession({ ...printerInput, printer: {} }, opts);
      expect(stored(printerRef)).toMatchObject({ printer: {} });
      const ref3270 = await syncSession({ ...input, terminal: "3270", documentUri: "file:///mainframe.ts5250emu", name: "mainframe" }, opts);
      const mainframe = stored(ref3270);
      expect(mainframe).toMatchObject({ terminal: "3270", keepAlive: true });
      expect(mainframe).not.toHaveProperty("pcCommand");
      expect(mainframe).not.toHaveProperty("associatedPrinter");
      expect(JSON.parse(readFileSync(profilesPath, "utf8")).systems).toHaveLength(3);
      const twinRef = await syncSession({ ...input, documentUri: "file:///other/test.ts5250emu", host: "SECONDHOST" }, opts);
      expect(twinRef).not.toBe(ref);
      expect(stored(twinRef)?.system).not.toBe(stored(ref)?.system);
      const { password, ...withoutPassword } = input;
      void password;
      await syncSession(withoutPassword, opts);
      const systems = (JSON.parse(readFileSync(profilesPath, "utf8")) as { systems: { id: string; signon?: unknown }[] }).systems;
      expect(systems.find((s) => s.id === stored(ref)?.system)?.signon).toBeUndefined();
      expect(systems.find((s) => s.id === stored(twinRef)?.system)?.signon).toBeDefined();
      // 全タブを閉じてサービスが再起動しても、保存済みの profiles と参照を再利用する。
      await manager.release();
      const restarted = await manager.acquire();
      expect(await syncSession(input, { ...opts, port: restarted.port })).toBe(ref);
    } finally {
      await manager.release();
    }
  }, 30_000);
});
