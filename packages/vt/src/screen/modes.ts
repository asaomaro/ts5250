/**
 * 端末のモード。**打鍵の符号化（`input/keys.ts`）と描画の両方が見る**ので、
 * 画面バッファとは別に持つ。
 */
export type MouseMode = "off" | "click" | "drag" | "any";
export type MouseEncoding = "x10" | "sgr";

export interface VtModes {
  /** `DECCKM`(?1) カーソルキーが `ESC O A` になる */
  applicationCursorKeys: boolean;
  /** `DECKPAM`/`DECKPNM`(`ESC =` / `ESC >`) キーパッドが application になる */
  applicationKeypad: boolean;
  /** `DECOM`(?6) 原点をスクロール領域の上端にする */
  origin: boolean;
  /** `DECAWM`(?7) 自動折返し。**既定 ON** */
  autoWrap: boolean;
  /** `DECTCEM`(?25) カーソルを表示する。**既定 ON** */
  cursorVisible: boolean;
  /** `DECSCNM`(?5) 画面全体の白黒反転 */
  reverseVideo: boolean;
  /** `IRM`(4) 挿入モード（既存の文字を押し出す） */
  insert: boolean;
  /** `LNM`(20) `LF` で行頭へも動く */
  newLine: boolean;
  /** `?2004` 貼り付けを `ESC[200~` … `ESC[201~` で包む */
  bracketedPaste: boolean;
  /** マウス報告（`?1000` / `?1002` / `?1003`） */
  mouse: MouseMode;
  /** マウス報告の書式（`?1006` で SGR 拡張） */
  mouseEncoding: MouseEncoding;
  /** `?1` の DECCKM とは別に、`?3`(DECCOLM) で 132 桁を要求されたか */
  columns132: boolean;
}

export function defaultModes(): VtModes {
  return {
    applicationCursorKeys: false,
    applicationKeypad: false,
    origin: false,
    autoWrap: true,
    cursorVisible: true,
    reverseVideo: false,
    insert: false,
    newLine: false,
    bracketedPaste: false,
    mouse: "off",
    mouseEncoding: "x10",
    columns132: false
  };
}
