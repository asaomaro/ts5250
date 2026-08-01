import type { ScreenColor } from "./types.js";

export interface AttrProps {
  color: ScreenColor;
  reverse: boolean;
  underline: boolean;
  blink: boolean;
  columnSeparator: boolean;
  nonDisplay: boolean;
}

const G = "green" as const;
const W = "white" as const;
const R = "red" as const;
const T = "turquoise" as const;
const Y = "yellow" as const;
const P = "pink" as const;
const B = "blue" as const;

function a(
  color: ScreenColor,
  opts: Partial<Omit<AttrProps, "color">> = {}
): AttrProps {
  return {
    color,
    reverse: opts.reverse ?? false,
    underline: opts.underline ?? false,
    blink: opts.blink ?? false,
    columnSeparator: opts.columnSeparator ?? false,
    nonDisplay: opts.nonDisplay ?? false
  };
}

/**
 * 属性バイト 0x20–0x3F のデコード表（SC30-3533 の表示属性。SEU 等の行内カラー切替の実体）。
 * インデックス = 属性バイト - 0x20。
 */
const ATTR_TABLE: readonly AttrProps[] = [
  /* 0x20 */ a(G),
  /* 0x21 */ a(G, { reverse: true }),
  /* 0x22 */ a(W),
  /* 0x23 */ a(W, { reverse: true }),
  /* 0x24 */ a(G, { underline: true }),
  /* 0x25 */ a(G, { underline: true, reverse: true }),
  /* 0x26 */ a(W, { underline: true }),
  /* 0x27 */ a(G, { nonDisplay: true }),
  /* 0x28 */ a(R),
  /* 0x29 */ a(R, { reverse: true }),
  /* 0x2A */ a(R, { blink: true }),
  /* 0x2B */ a(R, { reverse: true, blink: true }),
  /* 0x2C */ a(R, { underline: true }),
  /* 0x2D */ a(R, { underline: true, reverse: true }),
  /* 0x2E */ a(R, { underline: true, blink: true }),
  /* 0x2F */ a(R, { nonDisplay: true }),
  /* 0x30 */ a(T, { columnSeparator: true }),
  /* 0x31 */ a(T, { columnSeparator: true, reverse: true }),
  /* 0x32 */ a(Y, { columnSeparator: true }),
  /* 0x33 */ a(Y, { columnSeparator: true, reverse: true }),
  /* 0x34 */ a(T, { underline: true }),
  /* 0x35 */ a(T, { underline: true, reverse: true }),
  /* 0x36 */ a(Y, { underline: true }),
  /* 0x37 */ a(Y, { nonDisplay: true }),
  /* 0x38 */ a(P),
  /* 0x39 */ a(P, { reverse: true }),
  /* 0x3A */ a(B),
  /* 0x3B */ a(B, { reverse: true }),
  /* 0x3C */ a(P, { underline: true }),
  /* 0x3D */ a(P, { underline: true, reverse: true }),
  /* 0x3E */ a(B, { underline: true }),
  /* 0x3F */ a(B, { nonDisplay: true })
];

/** 既定属性（画面クリア直後・属性バイト前の領域）= 0x20 通常緑 */
export const DEFAULT_ATTR: AttrProps = ATTR_TABLE[0] as AttrProps;

export function decodeAttribute(byte: number): AttrProps {
  const props = ATTR_TABLE[byte - 0x20];
  return props ?? DEFAULT_ATTR;
}
