/**
 * 端末から届いた列 → キー事象。**純関数**（時間切れは呼び出し側が持つ: ESC 単独は `flush()` で確定する）。
 *
 * 届き方は端末で違う（research F9b: Home/End が `ESC[1~`/`ESC[4~` か `ESC[H`/`ESC[F` か、Shift+Enter・Ctrl+Enter は
 * Enter と区別できない、F13〜F24 は端末が出さず Shift+F1〜F12 で代用）。ここでは両方の形を受ける。
 */
export type KeyName =
  | "Enter" | "Tab" | "BackTab" | "Backspace" | "Delete" | "Insert" | "Escape"
  | "Home" | "End" | "PageUp" | "PageDown" | "Up" | "Down" | "Left" | "Right"
  | `F${number}`;

export type KeyEvent =
  | { kind: "key"; name: KeyName; shift: boolean; ctrl: boolean; alt: boolean }
  | { kind: "char"; ch: string; ctrl: boolean; alt: boolean };

const CSI_FINAL: Record<string, KeyName> = {
  A: "Up", B: "Down", C: "Right", D: "Left", H: "Home", F: "End", Z: "BackTab",
  P: "F1", Q: "F2", R: "F3", S: "F4"
};
const TILDE: Record<number, KeyName> = {
  1: "Home", 2: "Insert", 3: "Delete", 4: "End", 5: "PageUp", 6: "PageDown", 7: "Home", 8: "End",
  11: "F1", 12: "F2", 13: "F3", 14: "F4", 15: "F5", 17: "F6", 18: "F7", 19: "F8", 20: "F9",
  21: "F10", 23: "F11", 24: "F12"
};
const SS3: Record<string, KeyName> = {
  A: "Up", B: "Down", C: "Right", D: "Left", H: "Home", F: "End", P: "F1", Q: "F2", R: "F3", S: "F4"
};

const key = (name: KeyName, m = 0): KeyEvent => ({
  kind: "key", name, shift: (m & 1) !== 0, alt: (m & 2) !== 0, ctrl: (m & 4) !== 0
});

export class KeyDecoder {
  private buf = "";
  private pasting = false;
  private paste = "";

  /** 届いた列を渡す。完結したキーを返し、途中の列は次の `feed` / `flush` まで持つ */
  feed(chunk: string): KeyEvent[] {
    this.buf += chunk;
    const out: KeyEvent[] = [];
    for (;;) {
      if (this.pasting) {
        const end = this.buf.indexOf("\x1b[201~");
        if (end < 0) {
          // 終端までを貯める（終端が割れて届いても落とさない）
          this.paste += this.buf;
          this.buf = "";
          return out;
        }
        this.paste += this.buf.slice(0, end);
        this.buf = this.buf.slice(end + 6);
        this.pasting = false;
        for (const ch of this.paste.replace(/\r\n?|\n/g, " ")) out.push({ kind: "char", ch, ctrl: false, alt: false });
        this.paste = "";
        continue;
      }
      if (this.buf === "") return out;
      const r = this.one();
      if (r === "more") return out;
      out.push(...r);
    }
  }

  /** ESC 単独など、続きが来ないと判断したときに呼ぶ（呼び出し側の時間切れ） */
  flush(): KeyEvent[] {
    if (this.buf === "\x1b") {
      this.buf = "";
      return [key("Escape")];
    }
    if (this.buf !== "" && !this.pasting) {
      // 完結しなかった列は文字として捨てずに ESC を確定し、残りを再解釈する
      const rest = this.buf.slice(1);
      this.buf = "";
      return [key("Escape"), ...this.feed(rest)];
    }
    return [];
  }

  /** バッファの先頭から 1 つ解釈する。`more` は続きが必要 */
  private one(): KeyEvent[] | "more" {
    const b = this.buf;
    const c = b[0]!;
    if (c === "\x1b") {
      if (b.length === 1) return "more";
      if (b.startsWith("\x1b[200~")) {
        this.buf = b.slice(6);
        this.pasting = true;
        return [];
      }
      if (b[1] === "[") {
        const m = /^\x1b\[([0-9;:]*)([\x40-\x7e])/.exec(b);
        if (!m) return b.length > 24 ? this.drop(1) : "more";
        this.buf = b.slice(m[0].length);
        const params = m[1]!.split(";").map((s) => Number(s.split(":")[0] || 0));
        const mods = params.length >= 2 ? Math.max(0, (params[1] ?? 1) - 1) : 0;
        if (m[2] === "~") {
          const name = TILDE[params[0] ?? 0];
          return name ? [key(name, mods)] : [];
        }
        const name = CSI_FINAL[m[2]!];
        if (!name) return []; // マウス・応答など未対応の列は黙って捨てる
        // BackTab は Shift+Tab
        return name === "BackTab" ? [key("BackTab", 1)] : [key(name, mods)];
      }
      if (b[1] === "O") {
        if (b.length < 3) return "more";
        this.buf = b.slice(3);
        const name = SS3[b[2]!];
        return name ? [key(name)] : [];
      }
      // ESC + 文字 = Alt+文字
      const ch = [...b.slice(1)][0]!;
      this.buf = b.slice(1 + ch.length);
      return [{ kind: "char", ch, ctrl: false, alt: true }];
    }
    const ch = [...b][0]!;
    this.buf = b.slice(ch.length);
    if (ch === "\r" || ch === "\n") return [key("Enter")];
    if (ch === "\t") return [key("Tab")];
    if (ch === "\x7f" || ch === "\b") return [key("Backspace")];
    if (ch < " ") {
      // Ctrl+文字（0x01〜0x1a は a〜z、0x1d は ]、0x1c は \、0x00 は Space）
      const map: Record<number, string> = { 0: " ", 0x1c: "\\", 0x1d: "]", 0x1e: "^", 0x1f: "_" };
      const code = ch.charCodeAt(0);
      const base = map[code] ?? String.fromCharCode(code + 0x60);
      return [{ kind: "char", ch: base, ctrl: true, alt: false }];
    }
    return [{ kind: "char", ch, ctrl: false, alt: false }];
  }

  private drop(n: number): KeyEvent[] {
    this.buf = this.buf.slice(n);
    return [];
  }
}
