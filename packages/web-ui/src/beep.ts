/**
 * ホストの警報（WTD の CC2 ビット 0x04）で鳴らす短いビープ。
 *
 * ACS は `PS5250.ringBell()` で端末のベルを鳴らす。ブラウザには「端末のベル」が無いので
 * Web Audio で同等の短音を出す。**音声ファイルは持たない**——1 音のために資産を増やさない。
 *
 * `AudioContext` は**使うときに初めて作る**。読み込み時に作ると、利用者が何も触っていない
 * ページで suspended 状態の文脈が残り、後で鳴らそうとしても無音になる環境がある。
 */
let ctx: AudioContext | undefined;

export function beep(): void {
  try {
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    // 自動再生の制限で止まっていることがある（利用者の操作より前に作られた文脈）
    if (ctx.state === "suspended") void ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 880;
    // **立ち上がり・立ち下がりを鈍らせる**——矩形波をそのまま切ると「プツッ」というノイズが乗る
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.01);
    gain.gain.linearRampToValueAtTime(0, now + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.13);
  } catch {
    // 音が出ないこと自体で操作を止めない（音声を許可していない環境がある）
  }
}
