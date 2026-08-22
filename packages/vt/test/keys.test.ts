import { describe, it, expect } from "vitest";
import { encodeKey, encodePaste, encodeMouse } from "../src/input/keys.js";
import { defaultModes } from "../src/screen/modes.js";

const dec = new TextDecoder();
const s = (b: Uint8Array): string => dec.decode(b).replace(/\x1b/gu, "<E>");
const m = (over: Partial<ReturnType<typeof defaultModes>> = {}) => ({ ...defaultModes(), ...over });

describe("文字と制御", () => {
  it("普通の文字はそのまま", () => {
    expect(s(encodeKey({ text: "a" }, m()))).toBe("a");
  });

  it("IME の確定でまとめて来る文字列も通る", () => {
    expect(s(encodeKey({ text: "こんにちは" }, m()))).toBe("こんにちは");
  });

  it("Shift_JIS を選べばそちらで送る", () => {
    expect([...encodeKey({ text: "あ" }, m(), "shift_jis")]).toEqual([0x82, 0xa0]);
  });

  it("Ctrl+文字は C0 になる", () => {
    expect([...encodeKey({ text: "c", ctrl: true }, m())]).toEqual([0x03]);
    expect([...encodeKey({ text: "a", ctrl: true }, m())]).toEqual([0x01]);
    expect([...encodeKey({ text: "z", ctrl: true }, m())]).toEqual([0x1a]);
  });

  it("**Ctrl+Space は NUL**（シェルで使う）", () => {
    expect([...encodeKey({ text: " ", ctrl: true }, m())]).toEqual([0x00]);
  });

  it("Ctrl+記号（[ \\ ] ^ _）", () => {
    expect([...encodeKey({ text: "[", ctrl: true }, m())]).toEqual([0x1b]);
    expect([...encodeKey({ text: "\\", ctrl: true }, m())]).toEqual([0x1c]);
    expect([...encodeKey({ text: "_", ctrl: true }, m())]).toEqual([0x1f]);
  });

  it("**Alt は ESC 前置**", () => {
    expect(s(encodeKey({ text: "b", alt: true }, m()))).toBe("<E>b");
  });
});

describe("編集キー", () => {
  it("Enter は CR、Tab は HT", () => {
    expect([...encodeKey({ key: "Enter" }, m())]).toEqual([0x0d]);
    expect([...encodeKey({ key: "Tab" }, m())]).toEqual([0x09]);
  });

  it("**Shift+Tab は CBT**（`ESC[Z`）", () => {
    expect(s(encodeKey({ key: "Tab", shift: true }, m()))).toBe("<E>[Z");
  });

  it("Backspace は既定で DEL、指定すれば BS", () => {
    expect([...encodeKey({ key: "Backspace" }, m())]).toEqual([0x7f]);
    expect([...encodeKey({ key: "Backspace", backspaceSendsBackspace: true }, m())]).toEqual([0x08]);
  });

  it("Insert / Delete / PageUp / PageDown は `~` 形", () => {
    expect(s(encodeKey({ key: "Insert" }, m()))).toBe("<E>[2~");
    expect(s(encodeKey({ key: "Delete" }, m()))).toBe("<E>[3~");
    expect(s(encodeKey({ key: "PageUp" }, m()))).toBe("<E>[5~");
    expect(s(encodeKey({ key: "PageDown" }, m()))).toBe("<E>[6~");
  });
});

describe("カーソルキー（DECCKM）", () => {
  it("通常は `ESC [ A`", () => {
    expect(s(encodeKey({ key: "ArrowUp" }, m()))).toBe("<E>[A");
    expect(s(encodeKey({ key: "ArrowLeft" }, m()))).toBe("<E>[D");
  });

  it("**application 様式では `ESC O A`**（vi / less が要求する）", () => {
    const app = m({ applicationCursorKeys: true });
    expect(s(encodeKey({ key: "ArrowUp" }, app))).toBe("<E>OA");
    expect(s(encodeKey({ key: "Home" }, app))).toBe("<E>OH");
  });

  it("修飾つきは番号つきの長い形（application でも同じ）", () => {
    expect(s(encodeKey({ key: "ArrowUp", ctrl: true }, m()))).toBe("<E>[1;5A");
    expect(s(encodeKey({ key: "ArrowUp", shift: true }, m()))).toBe("<E>[1;2A");
    expect(s(encodeKey({ key: "ArrowUp", alt: true }, m()))).toBe("<E>[1;3A");
    expect(s(encodeKey({ key: "ArrowUp", ctrl: true, shift: true }, m()))).toBe("<E>[1;6A");
    expect(s(encodeKey({ key: "ArrowUp", ctrl: true }, m({ applicationCursorKeys: true }))))
      .toBe("<E>[1;5A");
  });
});

describe("機能キー", () => {
  it("**F1〜F4 は SS3**（`ESC O P`〜`ESC O S`）", () => {
    expect(s(encodeKey({ key: "F1" }, m()))).toBe("<E>OP");
    expect(s(encodeKey({ key: "F4" }, m()))).toBe("<E>OS");
  });

  it("F5 以降は `~` 形。**番号は歯抜け**（16 / 22 / 27 / 30 は無い）", () => {
    expect(s(encodeKey({ key: "F5" }, m()))).toBe("<E>[15~");
    expect(s(encodeKey({ key: "F6" }, m()))).toBe("<E>[17~");
    expect(s(encodeKey({ key: "F11" }, m()))).toBe("<E>[23~");
    expect(s(encodeKey({ key: "F12" }, m()))).toBe("<E>[24~");
  });

  it("修飾つき", () => {
    expect(s(encodeKey({ key: "F1", shift: true }, m()))).toBe("<E>[1;2P");
    expect(s(encodeKey({ key: "F5", ctrl: true }, m()))).toBe("<E>[15;5~");
  });
});

describe("キーパッド（DECKPAM）", () => {
  it("通常は素の文字", () => {
    expect(s(encodeKey({ key: "Keypad7" }, m()))).toBe("7");
    expect([...encodeKey({ key: "KeypadEnter" }, m())]).toEqual([0x0d]);
  });

  it("application 様式では `ESC O <x>`", () => {
    const app = m({ applicationKeypad: true });
    expect(s(encodeKey({ key: "Keypad7" }, app))).toBe("<E>Ow");
    expect(s(encodeKey({ key: "KeypadEnter" }, app))).toBe("<E>OM");
    expect(s(encodeKey({ key: "KeypadPlus" }, app))).toBe("<E>Ok");
  });
});

describe("未対応のキーで例外にしない", () => {
  it("空の打鍵は空を返す", () => {
    expect(encodeKey({}, m()).length).toBe(0);
    expect(encodeKey({ text: "" }, m()).length).toBe(0);
  });
});

describe("貼り付け", () => {
  it("既定では素のまま（改行は CR に寄せる）", () => {
    expect(s(encodePaste("a\r\nb\nc", m()))).toBe("a\rb\rc");
  });

  it("**`?2004` が有効なら包む**（シェルの補完や自動字下げに食わせない）", () => {
    expect(s(encodePaste("ls", m({ bracketedPaste: true })))).toBe("<E>[200~ls<E>[201~");
  });
});

describe("マウス", () => {
  it("報告が切れていれば何も送らない", () => {
    expect(encodeMouse({ button: "left", row: 0, col: 0, kind: "down" }, m()).length).toBe(0);
  });

  it("SGR 拡張（`?1006`）は**桁数の上限が無い**", () => {
    const modes = m({ mouse: "click", mouseEncoding: "sgr" });
    expect(s(encodeMouse({ button: "left", row: 9, col: 299, kind: "down" }, modes)))
      .toBe("<E>[<0;300;10M");
    expect(s(encodeMouse({ button: "left", row: 9, col: 299, kind: "up" }, modes)))
      .toBe("<E>[<0;300;10m");
  });

  it("x10 形式は 223 桁を超えたら**送らない**（黙って化けさせない）", () => {
    const modes = m({ mouse: "click", mouseEncoding: "x10" });
    expect(encodeMouse({ button: "left", row: 0, col: 5, kind: "down" }, modes).length).toBe(6);
    expect(encodeMouse({ button: "left", row: 0, col: 300, kind: "down" }, modes).length).toBe(0);
  });

  it("ホイールと修飾", () => {
    const modes = m({ mouse: "click", mouseEncoding: "sgr" });
    expect(s(encodeMouse({ button: "wheelUp", row: 0, col: 0, kind: "down" }, modes)))
      .toBe("<E>[<64;1;1M");
    expect(s(encodeMouse({ button: "left", row: 0, col: 0, kind: "down", ctrl: true }, modes)))
      .toBe("<E>[<16;1;1M");
  });

  it("`click` では移動を送らない。`drag` なら送る", () => {
    const click = m({ mouse: "click", mouseEncoding: "sgr" });
    const drag = m({ mouse: "drag", mouseEncoding: "sgr" });
    expect(encodeMouse({ button: "left", row: 1, col: 1, kind: "move" }, click).length).toBe(0);
    expect(s(encodeMouse({ button: "left", row: 1, col: 1, kind: "move" }, drag)))
      .toBe("<E>[<32;2;2M");
  });
});
