import { describe, it, expect } from "vitest";
import { sortEntries, isIfsSortKey } from "../src/composables/ifsSort.js";
import type { IfsEntry } from "../src/ifsApi.js";

/**
 * IFS 一覧の並べ替え。**フォルダは先**・サーバー順は触らない・名前は自然順・同点は名前の昇順、が要点
 */
const e = (name: string, over: Partial<IfsEntry> = {}): IfsEntry => ({
  name,
  isDirectory: false,
  isSymlink: false,
  size: 100,
  modifiedAt: 1_700_000_000_000,
  restartId: 1,
  ...over
});
const names = (xs: readonly IfsEntry[]): string[] => xs.map((x) => x.name);

describe("sortEntries", () => {
  it("server は並べ替えない（元の配列は変えず、新しい配列を返す）", () => {
    const src = [e("b"), e("a")];
    const out = sortEntries(src, "server", "desc");
    expect(names(out)).toEqual(["b", "a"]);
    expect(out).not.toBe(src);
  });

  it("名前は自然順（file2 が file10 の前）で、大文字小文字を区別しない", () => {
    const out = sortEntries([e("file10"), e("File2"), e("file1")], "name", "asc");
    expect(names(out)).toEqual(["file1", "File2", "file10"]);
  });

  it("降順にしても**フォルダが先**（降順でフォルダが末尾へ流れない）", () => {
    const src = [e("a.txt"), e("zdir", { isDirectory: true }), e("b.txt"), e("adir", { isDirectory: true })];
    expect(names(sortEntries(src, "name", "asc"))).toEqual(["adir", "zdir", "a.txt", "b.txt"]);
    expect(names(sortEntries(src, "name", "desc"))).toEqual(["zdir", "adir", "b.txt", "a.txt"]);
  });

  it("サイズは昇順・降順。同じサイズは名前の昇順（降順でも）", () => {
    const src = [e("b", { size: 5 }), e("a", { size: 5 }), e("big", { size: 900 }), e("small", { size: 1 })];
    expect(names(sortEntries(src, "size", "asc"))).toEqual(["small", "a", "b", "big"]);
    expect(names(sortEntries(src, "size", "desc"))).toEqual(["big", "a", "b", "small"]);
  });

  it("**フォルダ同士はサイズで並べず、名前で並べる**（フォルダのサイズに意味は無い）", () => {
    const src = [e("d2", { isDirectory: true, size: 1 }), e("d1", { isDirectory: true, size: 999 })];
    expect(names(sortEntries(src, "size", "asc"))).toEqual(["d1", "d2"]);
    expect(names(sortEntries(src, "size", "desc"))).toEqual(["d1", "d2"]);
  });

  it("更新日時は古い順・新しい順。同時刻は名前の昇順", () => {
    const src = [e("new", { modifiedAt: 300 }), e("old", { modifiedAt: 100 }), e("b", { modifiedAt: 200 }), e("a", { modifiedAt: 200 })];
    expect(names(sortEntries(src, "modified", "asc"))).toEqual(["old", "a", "b", "new"]);
    expect(names(sortEntries(src, "modified", "desc"))).toEqual(["new", "a", "b", "old"]);
  });

  it("フォルダの更新日時でも並べる", () => {
    const src = [e("d1", { isDirectory: true, modifiedAt: 2 }), e("d2", { isDirectory: true, modifiedAt: 1 })];
    expect(names(sortEntries(src, "modified", "asc"))).toEqual(["d2", "d1"]);
  });

  it("空の配列・1 件でも壊れない", () => {
    expect(sortEntries([], "name", "asc")).toEqual([]);
    expect(names(sortEntries([e("a")], "size", "desc"))).toEqual(["a"]);
  });
});

describe("isIfsSortKey", () => {
  it("知っているキーだけ通す（保存値は書き換えられうる）", () => {
    for (const k of ["server", "name", "size", "modified"]) expect(isIfsSortKey(k)).toBe(true);
    for (const k of ["", "NAME", "owner", undefined, 1, null]) expect(isIfsSortKey(k)).toBe(false);
  });
});
