import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { candidateFontPaths, pickMonoFace, findMonoCjkFont } from "../src/pdf-font.js";

/**
 * PDF に埋め込む等幅 CJK フォントの探索。
 *
 * **Windows でパスが `C:\\usr\\share\\fonts\\…` になって必ず失敗していた**
 * （Linux のパスを 1 本焼き込んでいたため。利用者の報告）。
 *
 * 候補のファイル名だけを環境ごとに持ち、**どの書体かは実物に聞く**（`.ttc` は
 * 複数の書体を束ねていて、等幅なのは一部だけ）。ここではその 2 点を固定する。
 */
describe("候補の置き場", () => {
  it("Windows では `%WINDIR%\\Fonts` を見る（`/usr/share` を見に行かない）", () => {
    const spy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const paths = candidateFontPaths({ WINDIR: "D:\\Windows" } as NodeJS.ProcessEnv);
      expect(paths.some((p) => p.includes("D:\\Windows") && p.includes("Fonts"))).toBe(true);
      expect(paths.some((p) => p.startsWith("/usr/share"))).toBe(false);
      // 日本語 Windows に必ずある MS ゴシックを含む
      expect(paths.some((p) => p.toLowerCase().includes("msgothic.ttc"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("Windows で `%WINDIR%` が無ければ `C:\\Windows` に落とす", () => {
    const spy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(candidateFontPaths({} as NodeJS.ProcessEnv)[0]).toContain("C:\\Windows");
    } finally {
      spy.mockRestore();
    }
  });

  /** 「自分だけにインストール」したフォントはユーザー側に入る */
  it("Windows では `%LOCALAPPDATA%` 側も見る", () => {
    const spy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const paths = candidateFontPaths({
        WINDIR: "C:\\Windows",
        LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local"
      } as NodeJS.ProcessEnv);
      expect(paths.some((p) => p.includes("AppData"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("Windows 以外は従来どおり Noto を見る", () => {
    const spy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      expect(candidateFontPaths({} as NodeJS.ProcessEnv)[0]).toBe(
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
      );
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * 面の選択は**実物のフォントで**確かめる。CI にフォントが無い環境もあるので、
 * 無ければ飛ばす（あるときだけ厳密に見る）。
 */
const NOTO = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";

describe("等幅の面を選ぶ", () => {
  it.skipIf(!existsSync(NOTO))("`.ttc` から等幅の面を選ぶ（プロポーショナルを選ばない）", () => {
    const hit = pickMonoFace(NOTO);
    expect(hit?.path).toBe(NOTO);
    // 同じ `.ttc` に `NotoSansCJKjp-Regular`（プロポーショナル）も入っている
    expect(hit?.face).toMatch(/Mono/u);
  });

  it.skipIf(!existsSync(NOTO))("見つかったフォントを返す", () => {
    expect(findMonoCjkFont()?.face).toMatch(/Mono/u);
  });

  it("開けないファイルで落ちない（次の候補へ進める）", () => {
    expect(pickMonoFace("/no/such/font.ttc")).toBeUndefined();
  });

  it("候補が 1 つも無ければ undefined（呼び出し側は Courier へ）", () => {
    const spy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(findMonoCjkFont({ WINDIR: "/no/such/dir" } as NodeJS.ProcessEnv)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
