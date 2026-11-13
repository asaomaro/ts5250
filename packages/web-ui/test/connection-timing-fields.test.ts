import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import type { SettingsFormValues } from "../src/embed-protocol.js";
import Timing from "../src/components/ConnectionTimingFields.vue";
import SettingsForm from "../src/components/SettingsForm.vue";

describe("接続の保持と TCP 生存確認", () => {
  it("有効時だけ TCP の時間・回数を表示し、秒を ms で保存する", async () => {
    const w = mount(SettingsForm, { props: { app: "emulator", initial: { host: "AS400" } } });
    expect(w.find('[data-setting="intervalMs"]').exists()).toBe(false);
    await w.find('#sf-keepalive').setValue(true);
    await w.find('[data-setting="initialDelayMs"]').setValue('120');
    await w.find('[data-setting="intervalMs"]').setValue('15');
    await w.find('[data-setting="count"]').setValue('8');
    expect(w.emitted('change')?.at(-1)?.[0]).toMatchObject({ keepAliveOptions: { initialDelayMs: 120000, intervalMs: 15000, count: 8 }, connectionHold: 'never' });
    await w.find('[data-setting="connectionHoldMode"]').setValue('limited');
    await w.find('[data-setting="connectionHold"]').setValue('0');
    expect(w.emitted('change')?.at(-1)?.[0]).toMatchObject({ connectionHold: 0 });
    await w.find('[data-setting="count"]').setValue('0');
    expect(w.emitted('change')?.at(-1)?.[0]).toBeUndefined();
  });
  it("保存値を復元し、保持時間は TCP 設定と独立する", async () => {
    const w = mount(SettingsForm, { props: { app: "emulator", initial: { host: "AS400", keepAlive: false, connectionHold: 30, keepAliveOptions: { intervalMs: 10000, count: 12 } } } });
    expect(w.find<HTMLInputElement>('[data-setting="connectionHold"]').element.value).toBe('30');
    await w.find('[data-setting="connectionHoldMode"]').setValue('never');
    expect(w.emitted('change')?.at(-1)?.[0]).toMatchObject({ keepAlive: false, keepAliveOptions: { intervalMs: 10000, count: 12 }, connectionHold: 'never' });
    await w.find('#sf-keepalive').setValue(true);
    expect(w.find<HTMLInputElement>('[data-setting="intervalMs"]').element.value).toBe('10');
  });
  it("プリンターと 3270 には 5250 の再接続保持設定を出さない", () => {
    const cases: { app: "printer" | "emulator"; initial?: SettingsFormValues }[] = [{ app: 'printer' as const }, { app: 'emulator' as const, initial: { host: 'AS400', terminal: '3270' as const } }];
    for (const props of cases) {
      const w = mount(SettingsForm, { props });
      expect(w.find('[data-setting="connectionHoldMode"]').exists()).toBe(false);
    }
    const w = mount(Timing, { props: { enabled: true, options: { intervalMs: 30000, count: 4 } } });
    expect(w.text()).toContain('120 秒');
  });
});
