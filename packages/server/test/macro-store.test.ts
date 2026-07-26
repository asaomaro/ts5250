import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { MacroStore, toPublic } from "../src/macro-store.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import type { AuthUser } from "../src/auth.js";
import type { CreateMacroBody } from "../src/macro-types.js";

const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
const alice: AuthUser = { username: "alice", role: "user" };
const bob: AuthUser = { username: "bob", role: "user" };
const admin: AuthUser = { username: "root", role: "admin" };

/** 実在しうる資格情報は使わない（AGENTS.md のセキュリティ規約） */
const DUMMY_SECRET = "dummy-secret-value";

function tmpFile(name: string, content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "macro-"));
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(content), "utf8");
  return p;
}

function signonMacro(name = "サインオン"): CreateMacroBody {
  return {
    name,
    steps: [
      {
        screen: {
          rows: 24,
          cols: 80,
          targets: [
            { field: 0, row: 6, col: 53, len: 10 },
            { field: 1, row: 7, col: 53, len: 10 }
          ]
        },
        fields: [{ field: 0, value: "USER" }],
        plainSecrets: [{ field: 1, value: DUMMY_SECRET }],
        key: "Enter",
        cursor: { row: 6, col: 53 }
      }
    ]
  };
}

describe("MacroStore: CRUD と所有者", () => {
  it("作成すると所有者が付き、一覧に出る", () => {
    const store = new MacroStore([], crypto);
    const created = store.create(signonMacro(), alice, 1000);
    expect(created.owner).toBe("alice");
    expect(created.id).toMatch(/^m-/);
    expect(store.list(alice)).toHaveLength(1);
  });

  it("他人のマクロは一覧に出ず、get / remove も拒否される", () => {
    const store = new MacroStore([], crypto);
    const m = store.create(signonMacro(), alice, 1000);
    expect(store.list(bob)).toHaveLength(0);
    expect(() => store.get(m.id, bob)).toThrow(/forbidden/i);
    expect(() => store.remove(m.id, bob)).toThrow(/forbidden/i);
  });

  it("admin は他人のマクロも引ける（assertOwner の既定）", () => {
    const store = new MacroStore([], crypto);
    const m = store.create(signonMacro(), alice, 1000);
    expect(store.get(m.id, admin).id).toBe(m.id);
  });

  it("認証オフ（user 未定義）では owner を持たず、誰でも引ける", () => {
    const store = new MacroStore([], crypto);
    const m = store.create(signonMacro(), undefined, 1000);
    expect(m.owner).toBeUndefined();
    expect(store.get(m.id, undefined).id).toBe(m.id);
  });

  it("改名は名前と updatedAt だけを変え、ステップは保つ", () => {
    const store = new MacroStore([], crypto);
    const m = store.create(signonMacro(), alice, 1000);
    const renamed = store.rename(m.id, { name: "新しい名前" }, alice, 2000);
    expect(renamed.name).toBe("新しい名前");
    expect(renamed.updatedAt).toBe(2000);
    expect(renamed.createdAt).toBe(1000);
    expect(renamed.steps).toHaveLength(1);
    expect(renamed.hasSecret).toBe(true);
  });

  it("削除すると引けなくなる（秘密も一緒に消える）", () => {
    const store = new MacroStore([], crypto);
    const m = store.create(signonMacro(), alice, 1000);
    store.remove(m.id, alice);
    expect(() => store.get(m.id, alice)).toThrow(/not found/i);
    expect(store.list(alice)).toHaveLength(0);
  });

  it("ステップ 0 件のマクロは作れない（空マクロを作らない）", () => {
    const store = new MacroStore([], crypto);
    expect(() => store.create({ name: "空", steps: [] }, alice, 1000)).toThrow();
  });

  it("owner を本文で指定しても無視される（なりすまし防止）", () => {
    const store = new MacroStore([], crypto);
    const body = { ...signonMacro(), owner: "bob" };
    // .strict() なので余計なキーは弾かれる＝そもそも owner を渡す口が無い
    expect(() => store.create(body, alice, 1000)).toThrow();
  });
});

describe("MacroStore: 秘密の扱い", () => {
  it("平文は保存されず、暗号文（v1:...）になる", () => {
    const store = new MacroStore([], crypto);
    const pub = store.create(signonMacro(), alice, 1000);
    const rec = store.get(pub.id, alice);
    const enc = rec.steps[0]!.secrets![0]!.secretEnc;
    expect(enc).toMatch(/^v1:/);
    expect(enc).not.toContain(DUMMY_SECRET);
    // 平文が丸ごとどこにも残っていないこと
    expect(JSON.stringify(rec)).not.toContain(DUMMY_SECRET);
  });

  it("API 露出形には secretEnc も平文も含まれず、位置だけが残る", () => {
    const store = new MacroStore([], crypto);
    const pub = store.create(signonMacro(), alice, 1000);
    const json = JSON.stringify(pub);
    expect(json).not.toContain(DUMMY_SECRET);
    expect(json).not.toContain("secretEnc");
    expect(json).not.toContain("v1:");
    expect(pub.hasSecret).toBe(true);
    expect(pub.steps[0]!.secretFields).toEqual([1]);
  });

  it("秘密を持たないマクロは hasSecret=false・secretFields なし", () => {
    const store = new MacroStore([], crypto);
    const pub = store.create(
      {
        name: "メニュー",
        steps: [
          {
            screen: { rows: 24, cols: 80, targets: [{ field: 0, row: 20, col: 8, len: 60 }] },
            fields: [{ field: 0, value: "WRKACTJOB" }],
            key: "Enter",
            cursor: { row: 20, col: 8 }
          }
        ]
      },
      alice,
      1000
    );
    expect(pub.hasSecret).toBe(false);
    expect(pub.steps[0]!.secretFields).toBeUndefined();
  });

  it("鍵が無いと秘密を保存できない（黙って平文で持たない）", () => {
    const store = new MacroStore([], undefined);
    expect(store.canStoreSecrets).toBe(false);
    expect(() => store.create(signonMacro(), alice, 1000)).toThrow(/secret key not configured/i);
  });

  it("鍵が無くても秘密を含まないマクロは保存できる", () => {
    const store = new MacroStore([], undefined);
    const pub = store.create(
      {
        name: "毎回入力する",
        steps: [
          {
            screen: {
              rows: 24,
              cols: 80,
              targets: [{ field: 1, row: 7, col: 53, len: 10 }]
            },
            fields: [],
            promptFields: [1],
            key: "Enter",
            cursor: { row: 7, col: 53 }
          }
        ]
      },
      alice,
      1000
    );
    expect(pub.hasSecret).toBe(false);
    expect(pub.steps[0]!.promptFields).toEqual([1]);
  });
});

describe("MacroStore: resolveSecret（ws 経路）", () => {
  it("所有者なら復号して平文を返す", () => {
    const store = new MacroStore([], crypto);
    const m = store.create(signonMacro(), alice, 1000);
    const plain = store.resolveSecret({ macroId: m.id, step: 0, field: 1 }, alice);
    expect(plain).toBe(DUMMY_SECRET);
  });

  it("他人の macroId を指す参照は拒否される", () => {
    const store = new MacroStore([], crypto);
    const m = store.create(signonMacro(), alice, 1000);
    expect(() => store.resolveSecret({ macroId: m.id, step: 0, field: 1 }, bob)).toThrow(/forbidden/i);
  });

  it("存在しないステップ / 欄は拒否される（空文字にフォールバックしない）", () => {
    const store = new MacroStore([], crypto);
    const m = store.create(signonMacro(), alice, 1000);
    expect(() => store.resolveSecret({ macroId: m.id, step: 9, field: 1 }, alice)).toThrow(/step 9 not found/);
    expect(() => store.resolveSecret({ macroId: m.id, step: 0, field: 0 }, alice)).toThrow(/no secret/);
  });

  it("鍵が入れ替わっていたら復号失敗として拒否する", () => {
    const store = new MacroStore([], crypto);
    const m = store.create(signonMacro(), alice, 1000);
    const rec = store.get(m.id, alice);
    // 同じレコードを別の鍵のストアへ移す＝鍵ローテーション後に復号できない状況
    const other = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
    const moved = new MacroStore([rec], other);
    expect(() => moved.resolveSecret({ macroId: m.id, step: 0, field: 1 }, alice)).toThrow(/failed to decrypt/);
  });

  it("鍵未設定のストアでは解決できない", () => {
    const store = new MacroStore([], crypto);
    const m = store.create(signonMacro(), alice, 1000);
    const rec = store.get(m.id, alice);
    const keyless = new MacroStore([rec], undefined);
    expect(() => keyless.resolveSecret({ macroId: m.id, step: 0, field: 1 }, alice)).toThrow(
      /secret key not configured/i
    );
  });
});

describe("MacroStore: ファイル入出力", () => {
  it("未作成のファイルは空で開始する（永続化は可能）", () => {
    const dir = mkdtempSync(join(tmpdir(), "macro-"));
    const store = MacroStore.fromFile(join(dir, "macros.json"), crypto);
    expect(store.list(alice)).toHaveLength(0);
    expect(store.persistable).toBe(true);
  });

  it("保存して読み直すと同じ内容になり、平文はファイルに無い", async () => {
    const dir = mkdtempSync(join(tmpdir(), "macro-"));
    const path = join(dir, "macros.json");
    const store = MacroStore.fromFile(path, crypto);
    const created = store.create(signonMacro(), alice, 1000);
    await store.save();

    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(DUMMY_SECRET);
    expect(raw).toContain("secretEnc");

    const reloaded = MacroStore.fromFile(path, crypto);
    const list = reloaded.list(alice);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(created.id);
    expect(reloaded.resolveSecret({ macroId: created.id, step: 0, field: 1 }, alice)).toBe(DUMMY_SECRET);
  });

  it("壊れた JSON は起動を止める（黙って空で開いて上書きしない）", () => {
    const dir = mkdtempSync(join(tmpdir(), "macro-"));
    const path = join(dir, "macros.json");
    writeFileSync(path, "{ broken", "utf8");
    expect(() => MacroStore.fromFile(path, crypto)).toThrow(/failed to read macros/);
  });

  it("スキーマに合わないファイルも起動を止める", () => {
    const path = tmpFile("macros.json", { macros: [{ id: "m-1" }] });
    expect(() => MacroStore.fromFile(path, crypto)).toThrow(/invalid macros\.json/);
  });

  it("ファイル由来でないストアは save() が何もしない", async () => {
    const store = new MacroStore([], crypto);
    expect(store.persistable).toBe(false);
    await expect(store.save()).resolves.toBeUndefined();
  });
});

describe("toPublic", () => {
  it("返した値を書き換えてもストアの実体に届かない（複製して返す）", () => {
    const store = new MacroStore([], crypto);
    const created = store.create(signonMacro(), alice, 1000);

    // 応答を受け取った側が書き換えたつもりでも、保管中のレコードは変わらない
    created.steps[0]!.screen.rows = 99;
    created.steps[0]!.screen.targets[0]!.row = 99;
    created.steps[0]!.fields[0]!.value = "書き換え";
    created.steps[0]!.cursor.row = 99;

    const rec = store.get(created.id, alice);
    expect(rec.steps[0]!.screen.rows).toBe(24);
    expect(rec.steps[0]!.screen.targets[0]!.row).toBe(6);
    expect(rec.steps[0]!.fields[0]!.value).toBe("USER");
    expect(rec.steps[0]!.cursor.row).toBe(6);
  });

  it("incomplete と owner を保ち、秘密の位置だけ返す", () => {
    const pub = toPublic({
      id: "m-1",
      name: "x",
      owner: "alice",
      createdAt: 1,
      updatedAt: 2,
      incomplete: true,
      steps: [
        {
          screen: { rows: 24, cols: 80, targets: [] },
          fields: [],
          secrets: [{ field: 3, secretEnc: "v1:a:b:c" }],
          promptFields: [4],
          key: "F3",
          sysReqText: "2",
          cursor: { row: 1, col: 1 }
        }
      ]
    });
    expect(pub.incomplete).toBe(true);
    expect(pub.owner).toBe("alice");
    expect(pub.hasSecret).toBe(true);
    expect(pub.steps[0]!.secretFields).toEqual([3]);
    expect(pub.steps[0]!.promptFields).toEqual([4]);
    expect(pub.steps[0]!.sysReqText).toBe("2");
    expect(JSON.stringify(pub)).not.toContain("v1:a:b:c");
  });
});
