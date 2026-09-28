import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type Settings,
  type SettingsPatch,
} from "../shared/settings";
import { readJson, writeJsonAtomic } from "./jsonFile";

/** Settings live in `<userData>/settings.json`; this is the only writer. */
export class SettingsStore {
  private readonly path: string;
  private current: Settings;
  private readonly listeners = new Set<(s: Settings, prev: Settings) => void>();

  constructor(userDataDir: string) {
    this.path = join(userDataDir, "settings.json");
    this.current = mergeSettings(DEFAULT_SETTINGS, readJson(this.path));
  }

  get(): Settings {
    return this.current;
  }

  update(patch: SettingsPatch): Settings {
    const prev = this.current;
    this.current = mergeSettings(prev, patch);
    writeJsonAtomic(this.path, this.current);
    for (const fn of this.listeners) fn(this.current, prev);
    return this.current;
  }

  onChange(fn: (s: Settings, prev: Settings) => void): void {
    this.listeners.add(fn);
  }
}
