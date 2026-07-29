import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import type { AuthUser } from "../src/auth.js";

const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
const alice: AuthUser = { username: "alice", role: "user" };
const bob: AuthUser = { username: "bob", role: "user" };
const admin: AuthUser = { username: "root", role: "admin" };

/** 収集した warn を検査できるようにする */
function collector(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m) => messages.push(m), messages };
}

function build(opts: { badPassword?: boolean; noCrypto?: boolean } = {}) {
  const enc = opts.badPassword ? "v1:zz:zz:zz" : crypto.encrypt("secret");
  const server = new ServerConfigStore(
    {
      systems: [
        {
          id: "pub400.com",
          name: "pub400.com",
          host: "pub400.com",
          tls: true,
          ccsid: 939,
          signon: { user: "USER", passwordEnc: enc }
        },
        { id: "bare", name: "bare", host: "bare.example", tls: false }
      ],
      sessions: [
        {
          id: "pub400",
          name: "pub400",
          system: "pub400.com",
          sessionType: "display",
          deviceName: "WEBEMU01",
          screenSize: "24x80"
        },
        {
          id: "pub400-jp",
          name: "pub400-jp",
          system: "pub400.com",
          sessionType: "display",
          deviceName: "WEBEMUJP",
          screenSize: "27x132",
          ccsid: 1399,
          enhanced: true
        },
        {
          id: "pub400-prt",
          name: "pub400-prt",
          system: "pub400.com",
          sessionType: "printer",
          deviceName: "PRT_TEST",
          screenSize: "24x80",
          printer: { autoPdfDir: "/var/spool/out", pdfFontPath: "/f.ttf" }
        }
      ]
    },
    opts.noCrypto ? undefined : crypto
  );
  const personal = new PersonalConfigStore(
    {
      systems: [{ id: "s-1", name: "私の機", host: "own.example", owner: "alice" }],
      sessions: [
        {
          id: "c-1",
          name: "私のセッション",
          system: "s-1",
          sessionType: "display",
          deviceName: "MYDEV",
          owner: "alice"
        }
      ]
    },
    crypto
  );
  return new ConfigResolver(server, personal);
}

describe("解決: 5 ケース", () => {
  let r: ConfigResolver;
  beforeEach(() => {
    r = build();
  });

  it("session のみ（基本形）— 親システムから資格情報を得る", () => {
    const { warn } = collector();
    const out = r.resolve({ session: "srv:pub400" }, admin, warn);
    expect(out.connect).toMatchObject({
      host: "pub400.com",
      tls: true,
      ccsid: 939,
      deviceName: "WEBEMU01",
      screenSize: "24x80",
      user: "USER",
      password: "secret"
    });
  });

  it("system のみ — 装置名なしで接続する（ホスト採番）", () => {
    const { warn } = collector();
    const out = r.resolve({ system: "srv:pub400.com" }, admin, warn);
    expect(out.connect.host).toBe("pub400.com");
    expect(out.connect.user).toBe("USER");
    expect(out.connect.deviceName).toBeUndefined();
    expect(out.connect.screenSize).toBeUndefined();
  });

  it("両方指定・一致 — 通る", () => {
    const { warn } = collector();
    const out = r.resolve({ system: "srv:pub400.com", session: "srv:pub400" }, admin, warn);
    expect(out.connect.deviceName).toBe("WEBEMU01");
  });

  it("両方指定・不一致 — エラーにする（黙って片方を捨てない）", () => {
    const { warn } = collector();
    expect(() => r.resolve({ system: "srv:bare", session: "srv:pub400" }, admin, warn)).toThrow(
      /does not belong to system/
    );
  });

  it("いずれも無し — エラー", () => {
    const { warn } = collector();
    expect(() => r.resolve({}, admin, warn)).toThrow(/system, session, or host required/);
  });
});

describe("解決: 参照の形式とスコープ", () => {
  it("接頭辞が無い参照は受け付けない（曖昧な解決をしない）", () => {
    const { warn } = collector();
    expect(() => build().resolve({ system: "pub400.com" }, admin, warn)).toThrow(
      /expected srv:<name> or own:<id>/
    );
  });

  it("存在しないシステムは SESSION_NOT_FOUND", () => {
    const { warn } = collector();
    expect(() => build().resolve({ system: "srv:ghost" }, admin, warn)).toThrow(/system ghost not found/);
  });

  it("個人セッションはサーバーシステムを指せない（参照が別ファイルなので解決されない）", () => {
    const { warn } = collector();
    // own: 側に "pub400.com" という id は存在しない
    expect(() => build().resolve({ system: "own:pub400.com" }, alice, warn)).toThrow(/not found/);
  });
});

describe("解決: CCSID の優先順位", () => {
  it("セッションの上書きがシステムの既定に勝つ", () => {
    const { warn } = collector();
    const out = build().resolve({ session: "srv:pub400-jp" }, admin, warn);
    expect(out.connect.ccsid).toBe(1399);
  });

  it("セッションに指定が無ければシステムの既定を使う", () => {
    const { warn } = collector();
    const out = build().resolve({ session: "srv:pub400" }, admin, warn);
    expect(out.connect.ccsid).toBe(939);
  });
});

describe("解決: 種別による扱いの差", () => {
  it("プリンターでは screenSize / enhanced を渡さない", () => {
    const { warn } = collector();
    const out = build().resolve({ session: "srv:pub400-prt" }, admin, warn);
    expect(out.connect.deviceName).toBe("PRT_TEST");
    expect(out.connect.screenSize).toBeUndefined();
    expect(out.connect.enhanced).toBeUndefined();
  });

  it("display では enhanced を渡す", () => {
    const { warn } = collector();
    const out = build().resolve({ session: "srv:pub400-jp" }, admin, warn);
    expect(out.connect.enhanced).toBe(true);
  });
});

describe("信頼境界: printer 出力はサーバー設定由来のみ（5 層目）", () => {
  it("サーバー設定のプリンターセッションからは供給される", () => {
    const { warn } = collector();
    const out = build().resolve({ session: "srv:pub400-prt" }, admin, warn);
    expect(out.printerOutput).toEqual({
      autoPdfDir: "/var/spool/out",
      pdf: { fontPath: "/f.ttf" }
    });
  });

  it("個人設定のセッションからは供給されない", () => {
    const { warn } = collector();
    const out = build().resolve({ session: "own:c-1" }, alice, warn);
    expect(out.printerOutput).toBeUndefined();
  });

  it("システム指定のみでは供給されない（セッションが無いので出力設定も無い）", () => {
    const { warn } = collector();
    const out = build().resolve({ system: "srv:pub400.com" }, admin, warn);
    expect(out.printerOutput).toBeUndefined();
  });
});

describe("解決: 認可", () => {
  it("一般ユーザーはサーバー設定を解決できない", () => {
    const { warn } = collector();
    expect(() => build().resolve({ session: "srv:pub400" }, alice, warn)).toThrow(/admin only/);
  });

  it("所有者は自分の個人設定を解決できる", () => {
    const { warn } = collector();
    const out = build().resolve({ session: "own:c-1" }, alice, warn);
    expect(out.connect.host).toBe("own.example");
  });

  it("他人の個人設定は解決できない", () => {
    const { warn } = collector();
    expect(() => build().resolve({ session: "own:c-1" }, bob, warn)).toThrow(/not the owner/);
  });
});

describe("解決: パスワードの失敗は無言にしない", () => {
  it("復号に失敗したら warn し、自動サインオンなしで続行する", () => {
    const { warn, messages } = collector();
    const out = build({ badPassword: true }).resolve({ session: "srv:pub400" }, admin, warn);
    expect(out.connect.user).toBeUndefined();
    expect(out.connect.password).toBeUndefined();
    expect(messages.join("\n")).toContain("failed to decrypt saved password");
  });

  it("鍵が未設定なら warn する", () => {
    const { warn, messages } = collector();
    const out = build({ noCrypto: true }).resolve({ session: "srv:pub400" }, admin, warn);
    expect(out.connect.user).toBeUndefined();
    expect(messages.join("\n")).toContain("secret key not configured");
  });

  it("passwordEnv が未設定なら明示エラー（気づける形にする）", () => {
    const { warn } = collector();
    const server = new ServerConfigStore(
      {
        systems: [
          { id: "s", name: "s", host: "h", signon: { user: "U", passwordEnv: "NOPE_UNSET_VAR" } }
        ],
        sessions: []
      },
      crypto
    );
    const r = new ConfigResolver(server, undefined);
    expect(() => r.resolve({ system: "srv:s" }, admin, warn)).toThrow(/env NOPE_UNSET_VAR unset/);
  });

  it("資格情報を持たないシステムは自動サインオンなしで解決できる", () => {
    const { warn } = collector();
    const out = build().resolve({ system: "srv:bare" }, admin, warn);
    expect(out.connect.host).toBe("bare.example");
    expect(out.connect.user).toBeUndefined();
  });
});

describe("解決: ストア未配線", () => {
  it("個人設定が無い状態で own: を指すとエラー", () => {
    const { warn } = collector();
    const r = new ConfigResolver(undefined, undefined);
    expect(() => r.resolve({ system: "own:x" }, alice, warn)).toThrow(/connection store not configured/);
  });
});

describe("横断一覧", () => {
  it("admin には両方の保管場所が見える", () => {
    const systems = build().listSystems(admin);
    expect(systems.map((s) => s.ref).sort()).toEqual(["own:s-1", "srv:bare", "srv:pub400.com"]);
  });

  it("一般ユーザーには自分の個人設定だけが見える", () => {
    const systems = build().listSystems(alice);
    expect(systems.map((s) => s.ref)).toEqual(["own:s-1"]);
  });
});

/**
 * アイドルタイムアウト。**分 → ms の変換はここ 1 か所だけ**で行う約束なので、
 * 解決の出口で ms になっていることを直接押さえる（`20260729-session-lifetime-timeout`）。
 */
describe("解決: アイドルタイムアウト", () => {
  const setup = (idleTimeout?: "never" | number) => {
    const personal = new PersonalConfigStore({
      systems: [{ id: "s", name: "s", host: "h", owner: "alice" }],
      sessions: [
        {
          id: "d",
          name: "d",
          system: "s",
          sessionType: "display",
          owner: "alice",
          ...(idleTimeout !== undefined ? { idleTimeout } : {})
        }
      ]
    });
    return new ConfigResolver(undefined, personal);
  };

  it("分を ms にして connect に載せる", () => {
    const r = setup(30).resolve({ session: "own:d" }, alice, collector().warn);
    expect(r.connect.idleTimeoutMs).toBe(30 * 60_000);
  });

  it('"never" はそのまま運ぶ', () => {
    const r = setup("never").resolve({ session: "own:d" }, alice, collector().warn);
    expect(r.connect.idleTimeoutMs).toBe("never");
  });

  it("未設定ならキーごと付かない（サーバー既定に従う）", () => {
    const r = setup().resolve({ session: "own:d" }, alice, collector().warn);
    expect("idleTimeoutMs" in r.connect).toBe(false);
  });
});
