import { PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import { DEFAULT_SETTINGS } from "./shared-vault-config";
import type SharedVaultPlugin from "./shared-vault-plugin";
import type { SharedVaultSettingKey, SharedVaultSettings } from "./shared-vault-types";

export class SharedVaultSettingTab extends PluginSettingTab {
  private draftSettings: SharedVaultSettings | null = null;

  constructor(app: SharedVaultPlugin["app"], private readonly plugin: SharedVaultPlugin) {
    super(app, plugin);
  }

  display(): void {
    this.draftSettings = { ...this.plugin.settings };
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("User ID")
      .setDesc("Identifier written to shared operation metadata.")
      .addText((text) => {
        text
          .setPlaceholder("Shared user")
          .setValue(this.getDraftSettings().userId)
          .onChange((value) => {
            this.getDraftSettings().userId = value.trim() || DEFAULT_SETTINGS.userId;
          });
      });

    new Setting(containerEl)
      .setName("Auto sync interval")
      .setDesc("Interval in seconds for rescanning operation-cache.")
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.autoSyncIntervalSec))
          .setValue(String(this.getDraftSettings().autoSyncIntervalSec))
          .onChange((value) => {
            const parsed = Number.parseInt(value, 10);
            this.getDraftSettings().autoSyncIntervalSec = Number.isFinite(parsed) && parsed > 0
              ? parsed
              : DEFAULT_SETTINGS.autoSyncIntervalSec;
          });
      });

    new Setting(containerEl)
      .setName("Cache ttl days")
      .setDesc("Number of days before inactive nodes are evicted.")
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.cacheTtlDays))
          .setValue(String(this.getDraftSettings().cacheTtlDays))
          .onChange((value) => {
            const parsed = Number.parseInt(value, 10);
            this.getDraftSettings().cacheTtlDays = Number.isFinite(parsed) && parsed > 0
              ? parsed
              : DEFAULT_SETTINGS.cacheTtlDays;
          });
      });
  }

  hide(): void {
    const draftSettings = this.draftSettings;
    this.draftSettings = null;

    if (draftSettings && !this.areSettingsEqual(draftSettings, this.plugin.settings)) {
      this.plugin.settings = draftSettings;
      void this.plugin.saveSettings();
    }

    super.hide();
  }

  getSettingDefinitions(): SettingDefinitionItem<SharedVaultSettingKey>[] {
    return [
      {
        name: "User ID",
        desc: "Identifier written to shared operation metadata.",
        control: {
          type: "text",
          key: "userId",
          placeholder: "Shared user",
          defaultValue: DEFAULT_SETTINGS.userId,
          validate: (value) => value.trim().length > 0 ? undefined : "User ID is required."
        }
      },
      {
        name: "Auto sync interval",
        desc: "Interval in seconds for rescanning operation-cache.",
        control: {
          type: "number",
          key: "autoSyncIntervalSec",
          placeholder: String(DEFAULT_SETTINGS.autoSyncIntervalSec),
          defaultValue: DEFAULT_SETTINGS.autoSyncIntervalSec,
          min: 1,
          validate: (value) => Number.isFinite(value) && value > 0 ? undefined : "Enter a value greater than 0."
        }
      },
      {
        name: "Cache ttl days",
        desc: "Number of days before inactive nodes are evicted.",
        control: {
          type: "number",
          key: "cacheTtlDays",
          placeholder: String(DEFAULT_SETTINGS.cacheTtlDays),
          defaultValue: DEFAULT_SETTINGS.cacheTtlDays,
          min: 1,
          validate: (value) => Number.isFinite(value) && value > 0 ? undefined : "Enter a value greater than 0."
        }
      }
    ];
  }

  override getControlValue(key: SharedVaultSettingKey): unknown {
    return this.getDraftSettings()[key];
  }

  override setControlValue(key: SharedVaultSettingKey, value: unknown): void | Promise<void> {
    if (key === "userId") {
      this.getDraftSettings().userId = String(value).trim() || DEFAULT_SETTINGS.userId;
      return undefined;
    }

    if (key === "autoSyncIntervalSec") {
      const numericValue = typeof value === "number" ? value : Number(value);
      this.getDraftSettings().autoSyncIntervalSec = Number.isFinite(numericValue) && numericValue > 0
        ? numericValue
        : DEFAULT_SETTINGS.autoSyncIntervalSec;
      return undefined;
    }

    if (key === "cacheTtlDays") {
      const numericValue = typeof value === "number" ? value : Number(value);
      this.getDraftSettings().cacheTtlDays = Number.isFinite(numericValue) && numericValue > 0
        ? numericValue
        : DEFAULT_SETTINGS.cacheTtlDays;
      return undefined;
    }

    return undefined;
  }

  private getDraftSettings(): SharedVaultSettings {
    this.draftSettings ??= { ...this.plugin.settings };
    return this.draftSettings;
  }

  private areSettingsEqual(left: SharedVaultSettings, right: SharedVaultSettings): boolean {
    return left.userId === right.userId
      && left.autoSyncIntervalSec === right.autoSyncIntervalSec
      && left.cacheTtlDays === right.cacheTtlDays
      && left.operationCacheDir === right.operationCacheDir
      && left.snapshotDir === right.snapshotDir;
  }
}
