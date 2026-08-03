/**
 * HLLAPI の ASCII ニーモニック（`@` 接頭辞）を解析する——**純関数だけ**。
 *
 * 出典は **SunLink SNA 3270 9.1 EHLLAPI Programmer's Manual** の 3.5 ASCII Mnemonics
 * （`20260803-hllapi-bridge` の research F4 で PDF を直読み）。
 *
 * ## 5250 に無いキーは黙って捨てない
 *
 * ニーモニックの表は **3270 由来**で、`PA1`〜`PA3`（`@x`/`@y`/`@z`）のように
 * **5250 に存在しないキー**が含まれる。ts5250 の AID キーは
 * `Enter` / `F1`〜`F24` / `PageUp` / `PageDown` / `Clear` / `Help` / `Print` / `SysReq` / `Attn`
 * （`mcp-tools.ts` の `AID_KEYS`）。
 *
 * **写せないものは `unsupported` として返し、呼び出し側が `HRC.UNDEFINED_COMBINATION`(20) で断る。**
 * 黙って無視すると「送ったつもりで送られていない」になり、自動化の失敗として最悪の形。
 */

/** 解析した 1 要素 */
export type KeyStroke =
  /** 普通の文字（そのまま入力する） */
  | { kind: "text"; text: string }
  /** AID キー（ホストへ送る） */
  | { kind: "aid"; key: AidKey }
  /** 画面内の移動・編集（ホストへ送らない。こちら側で処理する） */
  | { kind: "local"; action: LocalAction }
  /** 写せないニーモニック（`rc=20` で断る） */
  | { kind: "unsupported"; mnemonic: string };

/** ts5250 が受け付ける AID キー（`mcp-tools.ts` の `AID_KEYS` と一致させる） */
export type AidKey =
  | "Enter" | "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8" | "F9" | "F10" | "F11" | "F12"
  | "F13" | "F14" | "F15" | "F16" | "F17" | "F18" | "F19" | "F20" | "F21" | "F22" | "F23" | "F24"
  | "PageUp" | "PageDown" | "Clear" | "Help" | "Print" | "SysReq" | "Attn";

/** ホストへ送らない操作 */
export type LocalAction =
  | "tab"
  | "backtab"
  | "home"
  | "up"
  | "down"
  | "left"
  | "right"
  | "eraseEof"
  | "eraseInput"
  | "delete"
  | "backspace"
  | "newline"
  | "reset";

/** 1 文字のニーモニック → AID キー（research F4 の表 3-3 / 3-4） */
const AID_BY_CHAR: Record<string, AidKey> = {
  E: "Enter",
  C: "Clear",
  P: "Print",
  // PF1〜PF9
  "1": "F1", "2": "F2", "3": "F3", "4": "F4", "5": "F5", "6": "F6", "7": "F7", "8": "F8", "9": "F9",
  // PF10〜PF24
  a: "F10", b: "F11", c: "F12", d: "F13", e: "F14", f: "F15", g: "F16", h: "F17",
  i: "F18", j: "F19", k: "F20", l: "F21", m: "F22", n: "F23", o: "F24"
};

/** 1 文字のニーモニック → ローカル操作 */
const LOCAL_BY_CHAR: Record<string, LocalAction> = {
  T: "tab",
  B: "backtab",
  "0": "home",
  U: "up",
  V: "down",
  L: "left",
  Z: "right",
  F: "eraseEof",
  D: "delete",
  "<": "backspace",
  N: "newline",
  R: "reset"
};

/**
 * 2 文字目が `A`（Attention）／`S`（Shift）の複合ニーモニック。
 * research F4 の表 3-5。**5250 に写せるのは一部だけ**。
 */
const COMPOUND: Record<string, KeyStroke> = {
  "@A@H": { kind: "aid", key: "SysReq" },
  "@A@Q": { kind: "aid", key: "Attn" },
  "@A@F": { kind: "local", action: "eraseInput" }
};

/**
 * ニーモニック列を解析する。
 *
 * `"ABC@E"` → text("ABC") ＋ aid(Enter)。**普通の文字はそのまま**。
 * `"@@"` は文字の `@`（表 3-3）。
 *
 * **知らないニーモニックは `unsupported` として残す**（捨てない）。
 */
export function parseMnemonics(input: string): KeyStroke[] {
  const out: KeyStroke[] = [];
  let text = "";
  const flush = (): void => {
    if (text !== "") {
      out.push({ kind: "text", text });
      text = "";
    }
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch !== "@") {
      text += ch;
      i += 1;
      continue;
    }
    const next = input[i + 1];
    if (next === undefined) {
      // 末尾の裸の `@`。**捨てずに未対応として残す**
      flush();
      out.push({ kind: "unsupported", mnemonic: "@" });
      i += 1;
      continue;
    }
    if (next === "@") {
      text += "@";
      i += 2;
      continue;
    }
    // 複合（`@A@H` 等）は 4 文字
    if ((next === "A" || next === "S") && input[i + 2] === "@") {
      const key = input.slice(i, i + 4);
      flush();
      out.push(COMPOUND[key] ?? { kind: "unsupported", mnemonic: key });
      i += 4;
      continue;
    }
    const aid = AID_BY_CHAR[next];
    if (aid) {
      flush();
      out.push({ kind: "aid", key: aid });
      i += 2;
      continue;
    }
    const local = LOCAL_BY_CHAR[next];
    if (local) {
      flush();
      out.push({ kind: "local", action: local });
      i += 2;
      continue;
    }
    // `@x`/`@y`/`@z`（PA1〜PA3）等、**5250 に無いキーはここへ落ちる**
    flush();
    out.push({ kind: "unsupported", mnemonic: `@${next}` });
    i += 2;
  }
  flush();
  return out;
}

/** 解析結果に写せないものが含まれるか（`rc=20` の判定） */
export function hasUnsupported(strokes: readonly KeyStroke[]): boolean {
  return strokes.some((s) => s.kind === "unsupported");
}
