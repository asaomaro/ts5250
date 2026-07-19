import { describe, it, expect } from "vitest";
import {
  migrateProfiles,
  migrateConnections,
  isLegacyProfiles,
  isLegacyConnections,
  type LegacyProfile,
  type LegacyConnection
} from "../src/config-migrate.js";
import { personalSessionSchema, serverSessionSchema } from "../src/config-types.js";

/** 実データ（profiles.local.json）と同じ形。パスワードは暗号文のダミー */
const REAL_DATA: LegacyProfile[] = [
  {
    // sessionType なし＝旧々形式。printer も無いので display に導出される
    name: "pub400",
    host: "pub400.com",
    tls: true,
    ccsid: 939,
    screenSize: "24x80",
    deviceName: "WEBEMU01",
    signon: { user: "USER", passwordEnc: "v1:aa:bb:cc" }
  },
  {
    name: "pub400-27x132",
    host: "pub400.com",
    sessionType: "display",
    tls: true,
    ccsid: 1399,
    screenSize: "27x132",
    deviceName: "WEBEMUJP",
    signon: { user: "USER", passwordEnc: "v1:aa:bb:cc" }
  },
  {
    // signon を持たない。規則 2 で吸収されるべき
    name: "pub400-printer",
    host: "pub400.com",
    sessionType: "printer",
    tls: true,
    ccsid: 1399,
    screenSize: "24x80",
    deviceName: "PRT_TEST",
    printer: { autoPdfDir: "/var/spool/out" }
  }
];

describe("移行: 実データの期待結果（spec B2 の受け入れ基準）", () => {
  it("3 プロファイルが 1 システム + 3 セッションになる", () => {
    const out = migrateProfiles(REAL_DATA);
    expect(out.systems).toHaveLength(1);
    expect(out.sessions).toHaveLength(3);
  });

  it("システムは host を名前にし、資格情報を 1 つだけ持つ", () => {
    const [sys] = migrateProfiles(REAL_DATA).systems;
    expect(sys).toMatchObject({
      id: "pub400.com",
      name: "pub400.com",
      host: "pub400.com",
      tls: true,
      signon: { user: "USER", passwordEnc: "v1:aa:bb:cc" }
    });
  });

  it("資格情報を持たない pub400-printer も同じシステムに属する（規則 2）", () => {
    const out = migrateProfiles(REAL_DATA);
    const printer = out.sessions.find((s) => s.name === "pub400-printer");
    expect(printer?.system).toBe(out.systems[0]!.id);
  });

  it("セッション名は元の設定名を引き継ぐ", () => {
    const names = migrateProfiles(REAL_DATA).sessions.map((s) => s.name);
    expect(names).toEqual(["pub400", "pub400-27x132", "pub400-printer"]);
  });

  it("セッションが装置名・画面サイズ・CCSID 上書きを保つ", () => {
    const out = migrateProfiles(REAL_DATA);
    expect(out.sessions[1]).toMatchObject({
      deviceName: "WEBEMUJP",
      screenSize: "27x132",
      ccsid: 1399,
      sessionType: "display"
    });
  });

  it("sessionType 未指定は display に導出される", () => {
    expect(migrateProfiles(REAL_DATA).sessions[0]!.sessionType).toBe("display");
  });

  it("printer 出力はプリンターセッションにだけ残る", () => {
    const out = migrateProfiles(REAL_DATA);
    expect(out.sessions[2]!.printer).toEqual({ autoPdfDir: "/var/spool/out" });
    expect(out.sessions[0]!.printer).toBeUndefined();
    expect(out.sessions[1]!.printer).toBeUndefined();
  });

  it("移行結果が新スキーマを満たす", () => {
    for (const s of migrateProfiles(REAL_DATA).sessions) {
      expect(serverSessionSchema.safeParse(s).success).toBe(true);
    }
  });
});

describe("移行: 規則 1（資格情報ありの束ね）", () => {
  it("同じ接続先・同じユーザーなら 1 システムにまとまる", () => {
    const out = migrateProfiles([
      { name: "a", host: "h", tls: true, signon: { user: "U" } },
      { name: "b", host: "h", tls: true, signon: { user: "U" } }
    ]);
    expect(out.systems).toHaveLength(1);
  });

  it("同じ接続先でもユーザーが違えば別システムになる", () => {
    const out = migrateProfiles([
      { name: "a", host: "h", signon: { user: "U1" } },
      { name: "b", host: "h", signon: { user: "U2" } }
    ]);
    expect(out.systems).toHaveLength(2);
    expect(out.systems.map((s) => s.name).sort()).toEqual(["h (U1)", "h (U2)"]);
  });

  it("tls や port が違えば別システムになる（平文と TLS を混ぜない）", () => {
    const out = migrateProfiles([
      { name: "a", host: "h", tls: true, signon: { user: "U" } },
      { name: "b", host: "h", tls: false, signon: { user: "U" } }
    ]);
    expect(out.systems).toHaveLength(2);
  });
});

describe("移行: 規則 2 / 3（資格情報なしの行き先）", () => {
  it("同じ接続先のシステムがちょうど 1 つなら、そこに属する（規則 2）", () => {
    const out = migrateProfiles([
      { name: "a", host: "h", signon: { user: "U" } },
      { name: "b", host: "h" }
    ]);
    expect(out.systems).toHaveLength(1);
    expect(out.sessions[1]!.system).toBe(out.systems[0]!.id);
  });

  it("同じ接続先のシステムが 2 つ以上なら、別システムに分ける（規則 3）", () => {
    const warnings: string[] = [];
    const out = migrateProfiles(
      [
        { name: "a", host: "h", signon: { user: "U1" } },
        { name: "b", host: "h", signon: { user: "U2" } },
        { name: "c", host: "h" }
      ],
      (m) => warnings.push(m)
    );
    expect(out.systems).toHaveLength(3);
    const c = out.sessions.find((s) => s.name === "c")!;
    const cSystem = out.systems.find((s) => s.id === c.system)!;
    expect(cSystem.signon).toBeUndefined();
    expect(warnings.join("\n")).toContain("資格情報なしのシステムとして分けます");
  });

  it("資格情報つきが 0 個なら、資格情報なしのシステムを作る（規則 3）", () => {
    const out = migrateProfiles([{ name: "a", host: "h" }]);
    expect(out.systems).toHaveLength(1);
    expect(out.systems[0]!.signon).toBeUndefined();
    expect(out.systems[0]!.name).toBe("h");
  });

  it("資格情報なしが複数あっても、接続先が同じなら 1 システムにまとまる", () => {
    const out = migrateProfiles([
      { name: "a", host: "h" },
      { name: "b", host: "h" }
    ]);
    expect(out.systems).toHaveLength(1);
  });
});

describe("移行: 暗号とデッドフィールド", () => {
  it("passwordEnc を再暗号化せずそのまま移す", () => {
    const out = migrateProfiles([
      { name: "a", host: "h", signon: { user: "U", passwordEnc: "v1:iv:tag:ct" } }
    ]);
    expect(out.systems[0]!.signon?.passwordEnc).toBe("v1:iv:tag:ct");
  });

  it("passwordEnv も引き継ぐ（passwordEnc が無いとき）", () => {
    const out = migrateProfiles([
      { name: "a", host: "h", signon: { user: "U", passwordEnv: "PW" } }
    ]);
    expect(out.systems[0]!.signon?.passwordEnv).toBe("PW");
  });

  it("個人設定の secretEnc も再暗号化せず移る", () => {
    const out = migrateConnections([
      {
        id: "c-1",
        name: "n",
        host: "h",
        sessionType: "display",
        autoSignon: true,
        signonUser: "U",
        secretEnc: "v1:iv:tag:ct"
      }
    ]);
    expect(out.systems[0]!.signon?.passwordEnc).toBe("v1:iv:tag:ct");
  });

  it("lastConnectedAt は落とす（呼び出し元の無いデッドフィールド）", () => {
    const out = migrateConnections([
      { id: "c-1", name: "n", host: "h", sessionType: "display", lastConnectedAt: 12345 }
    ]);
    expect(JSON.stringify(out)).not.toContain("lastConnectedAt");
  });
});

describe("移行: 個人設定", () => {
  const conns: LegacyConnection[] = [
    {
      id: "c-1",
      owner: "alice",
      name: "自分の pub400",
      host: "pub400.com",
      tls: true,
      ccsid: 939,
      deviceName: "DEV1",
      sessionType: "display",
      autoSignon: true,
      signonUser: "USER",
      secretEnc: "v1:a:b:c"
    },
    {
      id: "c-2",
      owner: "alice",
      name: "プリンター",
      host: "pub400.com",
      tls: true,
      sessionType: "printer",
      deviceName: "PRT1"
    }
  ];

  it("既存の id を保つ（既存の参照が壊れない）", () => {
    const out = migrateConnections(conns);
    expect(out.sessions.map((s) => s.id)).toEqual(["c-1", "c-2"]);
  });

  it("所有者をシステムにも引き継ぐ", () => {
    const out = migrateConnections(conns);
    expect(out.systems[0]!.owner).toBe("alice");
    expect(out.sessions[0]!.owner).toBe("alice");
  });

  it("autoSignon が明示 false なら資格情報なしとして扱う", () => {
    const out = migrateConnections([
      { id: "c-1", name: "n", host: "h", sessionType: "display", autoSignon: false, signonUser: "U" }
    ]);
    expect(out.systems[0]!.signon).toBeUndefined();
  });

  it("移行結果が個人セッションスキーマを満たし、printer を持たない", () => {
    for (const s of migrateConnections(conns).sessions) {
      expect(personalSessionSchema.safeParse(s).success).toBe(true);
      expect(s).not.toHaveProperty("printer");
    }
  });
});

describe("信頼境界: 個人セッションは printer を持てない（1 層目）", () => {
  it("printer を与えると parse が失敗する", () => {
    const withPrinter = {
      id: "c-1",
      name: "n",
      system: "s-1",
      sessionType: "printer",
      printer: { autoPdfDir: "/etc" }
    };
    expect(personalSessionSchema.safeParse(withPrinter).success).toBe(false);
  });

  it("サーバーセッションは printer を持てる", () => {
    const withPrinter = {
      id: "p",
      name: "n",
      system: "sys",
      sessionType: "printer",
      printer: { autoPdfDir: "/var/spool/out" }
    };
    expect(serverSessionSchema.safeParse(withPrinter).success).toBe(true);
  });
});

describe("旧形式の判定", () => {
  it("profiles 配列があれば旧形式", () => {
    expect(isLegacyProfiles({ profiles: [] })).toBe(true);
    expect(isLegacyProfiles({ systems: [], sessions: [] })).toBe(false);
    expect(isLegacyProfiles(null)).toBe(false);
  });

  it("connections 配列があれば旧形式", () => {
    expect(isLegacyConnections({ connections: [] })).toBe(true);
    expect(isLegacyConnections({ systems: [], sessions: [] })).toBe(false);
  });
});
