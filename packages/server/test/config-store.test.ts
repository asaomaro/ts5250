import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import type { AuthUser } from "../src/auth.js";

const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
const alice: AuthUser = { username: "alice", role: "user" };
const bob: AuthUser = { username: "bob", role: "user" };
const admin: AuthUser = { username: "root", role: "admin" };

function tmpFile(name: string, content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(content), "utf8");
  return p;
}

const LEGACY_PROFILES = {
  profiles: [
    {
      name: "pub400",
      host: "pub400.com",
      tls: true,
      ccsid: 939,
      screenSize: "24x80",
      deviceName: "WEBEMU01",
      signon: { user: "USER", passwordEnc: "v1:a:b:c" }
    },
    {
      name: "pub400-printer",
      host: "pub400.com",
      sessionType: "printer",
      tls: true,
      deviceName: "PRT",
      printer: { autoPdfDir: "/var/spool/out" }
    }
  ]
};

describe("ConfigStore: 旧形式の読み込み（移行）", () => {
  it("旧 profiles.json を読み、システムとセッションに分解する", () => {
    const store = ServerConfigStore.fromFile(tmpFile("profiles.json", LEGACY_PROFILES), crypto);
    expect(store.listSystems(admin)).toHaveLength(1);
    expect(store.listSessions(admin)).toHaveLength(2);
  });

  it("**読み込みだけではファイルを書き換えない**", () => {
    const path = tmpFile("profiles.json", LEGACY_PROFILES);
    const before = readFileSync(path, "utf8");
    ServerConfigStore.fromFile(path, crypto);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("save() を明示的に呼んだときだけ新形式で書き出す", async () => {
    const path = tmpFile("profiles.json", LEGACY_PROFILES);
    const store = ServerConfigStore.fromFile(path, crypto);
    await store.save();
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after).toHaveProperty("systems");
    expect(after).toHaveProperty("sessions");
    expect(after).not.toHaveProperty("profiles");
  });

  it("新形式もそのまま読める", () => {
    const path = tmpFile("profiles.json", {
      systems: [{ id: "sys", name: "sys", host: "h" }],
      sessions: [{ id: "a", name: "a", system: "sys", sessionType: "display" }]
    });
    const store = ServerConfigStore.fromFile(path, crypto);
    expect(store.listSessions(admin)).toHaveLength(1);
  });

  it("平文 signon.password は起動時に弾く", () => {
    const path = tmpFile("profiles.json", {
      profiles: [{ name: "a", host: "h", signon: { user: "U", password: "plain" } }]
    });
    expect(() => ServerConfigStore.fromFile(path, crypto)).toThrow(/平文/);
  });

  it("個人設定のファイルが無ければ空で開始する", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const store = PersonalConfigStore.fromFile(join(dir, "connections.json"), crypto);
    expect(store.listSystems(alice)).toEqual([]);
  });
});

describe("ConfigStore: 参照の整合性", () => {
  it("存在しないシステムを指すセッションがあれば起動を止める", () => {
    const path = tmpFile("profiles.json", {
      systems: [{ id: "sys", name: "sys", host: "h" }],
      sessions: [{ id: "a", name: "a", system: "ghost", sessionType: "display" }]
    });
    expect(() => ServerConfigStore.fromFile(path, crypto)).toThrow(/missing system ghost/);
  });
});

describe("信頼境界: 個人設定に printer を入れられない（1 層目）", () => {
  let store: PersonalConfigStore;
  beforeEach(() => {
    store = new PersonalConfigStore(
      { systems: [{ id: "s-1", name: "sys", host: "h", owner: "alice" }], sessions: [] },
      crypto
    );
  });

  it("printer を含む入力は弾かれる", () => {
    expect(() =>
      store.addSession(
        {
          name: "p",
          system: "s-1",
          sessionType: "printer",
          printer: { autoPdfDir: "/etc" }
        },
        alice
      )
    ).toThrow();
  });

  it("printer を含まなければ通る", () => {
    const s = store.addSession({ name: "p", system: "s-1", sessionType: "printer" }, alice);
    expect(s.name).toBe("p");
    expect(s).not.toHaveProperty("printer");
  });

  it("サーバー設定では printer を持てる", () => {
    const srv = new ServerConfigStore(
      { systems: [{ id: "sys", name: "sys", host: "h" }], sessions: [] },
      crypto
    );
    const s = srv.addSession(
      { name: "p", system: "sys", sessionType: "printer", printer: { autoPdfDir: "/var/spool/out" } },
      admin
    );
    expect(s.name).toBe("p");
  });
});

describe("ConfigStore: 所有者と認可", () => {
  let store: PersonalConfigStore;
  beforeEach(() => {
    store = new PersonalConfigStore({ systems: [], sessions: [] }, crypto);
    store.addSystem({ name: "alice のシステム", host: "h" }, alice);
  });

  it("追加した本人には見える", () => {
    expect(store.listSystems(alice)).toHaveLength(1);
  });

  it("他人には見えない", () => {
    expect(store.listSystems(bob)).toHaveLength(0);
  });

  it("admin には見える", () => {
    expect(store.listSystems(admin)).toHaveLength(1);
  });

  it("他人は更新できない", () => {
    const id = store.listSystems(alice)[0]!.ref.replace(/^own:/, "");
    expect(() => store.updateSystem(id, { name: "x", host: "h" }, bob)).toThrow(/not the owner/);
  });

  it("所有者は入力から変えられない（なりすまし防止）", () => {
    const id = store.listSystems(alice)[0]!.ref.replace(/^own:/, "");
    const updated = store.updateSystem(id, { name: "n", host: "h", owner: "bob" }, alice);
    expect(updated.owner).toBe("alice");
  });

  it("サーバー設定は一般ユーザーに見えない", () => {
    const srv = new ServerConfigStore(
      { systems: [{ id: "sys", name: "sys", host: "h" }], sessions: [] },
      crypto
    );
    expect(srv.listSystems(alice)).toHaveLength(0);
    expect(srv.listSystems(admin)).toHaveLength(1);
  });
});

describe("ConfigStore: 露出しない情報", () => {
  it("システム一覧は資格情報を返さない（有無だけ）", () => {
    const srv = new ServerConfigStore(
      {
        systems: [
          { id: "sys", name: "sys", host: "h", signon: { user: "USER", passwordEnc: "v1:a:b:c" } }
        ],
        sessions: []
      },
      crypto
    );
    const [pub] = srv.listSystems(admin);
    expect(pub!.autoSignon).toBe(true);
    const json = JSON.stringify(pub);
    expect(json).not.toContain("USER");
    expect(json).not.toContain("v1:a:b:c");
    expect(json).not.toContain("signon");
  });

  it("セッション一覧は printer 出力を返さない", () => {
    const srv = new ServerConfigStore(
      {
        systems: [{ id: "sys", name: "sys", host: "h" }],
        sessions: [
          {
            id: "p",
            name: "p",
            system: "sys",
            sessionType: "printer",
            printer: { autoPdfDir: "/var/spool/out" }
          }
        ]
      },
      crypto
    );
    const json = JSON.stringify(srv.listSessions(admin));
    expect(json).not.toContain("autoPdfDir");
    expect(json).not.toContain("/var/spool/out");
  });
});

describe("ConfigStore: システムの削除", () => {
  it("子セッションが残っていれば削除できない（参照が壊れるため）", () => {
    const srv = new ServerConfigStore(
      {
        systems: [{ id: "sys", name: "sys", host: "h" }],
        sessions: [{ id: "a", name: "a", system: "sys", sessionType: "display" }]
      },
      crypto
    );
    expect(() => srv.removeSystem("sys", admin)).toThrow(/still has 1 session/);
  });

  it("子が無ければ削除できる", () => {
    const srv = new ServerConfigStore(
      { systems: [{ id: "sys", name: "sys", host: "h" }], sessions: [] },
      crypto
    );
    srv.removeSystem("sys", admin);
    expect(srv.listSystems(admin)).toHaveLength(0);
  });
});

/**
 * **システムカラー**（`20260802-tabs-own-system`）。
 *
 * 異なるシステムのタブを並べたときの見分けに使う番号（1〜8）。保存できて、
 * API の露出面（`publicSystem`）にも出ること。**色は資格情報ではない**ので、
 * そのシステムが見える人には見せてよい——見えないと見分けの用を成さない。
 */
describe("システムカラー", () => {
  it("保存され、一覧にも出る", () => {
    const p = tmpFile("connections.json", {
      systems: [{ id: "s1", name: "A", host: "h", owner: "alice", color: 5 }],
      sessions: []
    });
    const store = PersonalConfigStore.fromFile(p, crypto);
    expect(store.listSystems(alice)[0]?.color).toBe(5);
  });

  it("未設定なら出さない（画面側が ref から自動で割り当てる）", () => {
    const p = tmpFile("connections.json", {
      systems: [{ id: "s1", name: "A", host: "h", owner: "alice" }],
      sessions: []
    });
    const store = PersonalConfigStore.fromFile(p, crypto);
    expect(store.listSystems(alice)[0]).not.toHaveProperty("color");
  });

  it("**範囲外は設定として受け付けない**（1〜8 のパレット番号）", () => {
    const p = tmpFile("connections.json", {
      systems: [{ id: "s1", name: "A", host: "h", owner: "alice", color: 9 }],
      sessions: []
    });
    expect(() => PersonalConfigStore.fromFile(p, crypto)).toThrow();
  });

  it("色を足しても資格情報は露出しない（白名簿のまま）", () => {
    const p = tmpFile("connections.json", {
      systems: [
        { id: "s1", name: "A", host: "h", owner: "alice", color: 2, signon: { user: "U", passwordEnv: "SECRET_ENV" } }
      ],
      sessions: []
    });
    const store = PersonalConfigStore.fromFile(p, crypto);
    const pub = store.listSystems(alice)[0]!;
    expect(pub.color).toBe(2);
    expect(pub).not.toHaveProperty("signon");
    expect(JSON.stringify(pub), "資格情報の入口が露出している").not.toContain("SECRET_ENV");
  });
});
