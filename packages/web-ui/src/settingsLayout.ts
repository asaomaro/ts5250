import type { EmbedAppKind } from "./embed-protocol.js";

/** 設定フォームの欄の束（`SettingsForm.vue`の`<fieldset>`1つ分） */
export type SettingsGroup = "connection" | "signon" | "device" | "watermark";

/**
 * 設定フォームの列ごとの束（`decisions.md` D24）。**縦1列に並べるとemulatorで縦スクロールが出た**ので、
 * 役割で束ねて横へ並べる。`SettingsForm.vue`（並べる側）と`EmbedApp.vue`（列数からカード幅を決める側）が
 * 同じ表を読む——列数を片方にだけ書くと、カードが列に対して狭すぎ／広すぎになる
 */
export function settingsColumnsOf(app: EmbedAppKind): SettingsGroup[][] {
  if (app === "emulator") return [["connection", "signon"], ["device"], ["watermark"]];
  if (app === "printer") return [["connection"], ["signon", "device"]];
  return [["connection"], ["signon"]];
}
