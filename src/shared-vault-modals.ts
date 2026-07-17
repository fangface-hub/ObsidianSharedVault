import { Modal } from "obsidian";
import { DAY_IN_MS } from "./shared-vault-config";
import type SharedVaultPlugin from "./shared-vault-plugin";
import type { ConflictResolution, NodeListEntry } from "./shared-vault-types";

export class SharedVaultConflictModal extends Modal {
  private resolved = false;

  constructor(
    private readonly plugin: SharedVaultPlugin,
    private readonly input: {
      path: string;
      currentText: string;
      incomingText: string;
      remoteUserId: string;
      remoteNodeId: string;
    },
    private readonly onResolve: (value: ConflictResolution) => void
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("shared-vault-conflict-modal-window");
    this.setTitle(`Shared vault conflict: ${this.input.path}`);
    contentEl.empty();
    contentEl.addClass("shared-vault-conflict-modal");

    contentEl.createEl("p", {
      text: `Incoming changes from ${this.input.remoteUserId} (${this.input.remoteNodeId}) conflict with your current markdown. Review both versions before continuing.`
    });

    const compareGrid = contentEl.createDiv({ cls: "shared-vault-conflict-grid" });
    this.renderPane(compareGrid, "Current local version", this.input.currentText);
    this.renderPane(compareGrid, "Incoming shared version", this.input.incomingText);

    const actions = contentEl.createDiv({ cls: "shared-vault-conflict-actions" });

    const keepButton = actions.createEl("button", { text: "Keep local version" });
    keepButton.addEventListener("click", () => {
      this.finish("keep-local");
    });

    const applyButton = actions.createEl("button", { text: "Apply incoming version" });
    applyButton.addClass("mod-cta");
    applyButton.addEventListener("click", () => {
      this.finish("apply-incoming");
    });

    const deferButton = actions.createEl("button", { text: "Decide later" });
    deferButton.addEventListener("click", () => {
      this.finish("defer");
    });
  }

  onClose(): void {
    this.modalEl.removeClass("shared-vault-conflict-modal-window");
    this.contentEl.empty();
    if (!this.resolved) {
      this.onResolve("defer");
    }
  }

  private renderPane(containerEl: HTMLElement, label: string, value: string): void {
    const pane = containerEl.createDiv({ cls: "shared-vault-conflict-pane" });
    pane.createEl("h3", { text: label });
    const textarea = pane.createEl("textarea", { cls: "shared-vault-conflict-text" });
    textarea.value = value;
    textarea.readOnly = true;
    textarea.spellcheck = false;
  }

  private finish(result: ConflictResolution): void {
    this.resolved = true;
    this.close();
    this.onResolve(result);
  }
}

export class SharedVaultNodeRegistryModal extends Modal {
  constructor(
    private readonly plugin: SharedVaultPlugin,
    private readonly entries: NodeListEntry[],
    private readonly cacheTtlDays: number
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const now = Date.now();
    const ttlMs = this.cacheTtlDays * DAY_IN_MS;
    const activeEntries = this.entries.filter((entry) => now - entry.lastSeen <= ttlMs);

    this.setTitle("Shared node registry");
    this.contentEl.empty();
    this.contentEl.addClass("shared-vault-node-registry-modal");

    this.contentEl.createEl("p", {
      text: `Active nodes: ${activeEntries.length} / ${this.entries.length} (TTL: ${this.cacheTtlDays} day(s))`
    });

    if (this.entries.length === 0) {
      this.contentEl.createEl("p", { text: "No nodes have joined yet." });
      return;
    }

    const table = this.contentEl.createEl("table", { cls: "shared-vault-node-registry-table" });
    const header = table.createTHead().insertRow();
    ["Node", "User", "Status", "Last seen", "Last sync", "Last operation"].forEach((label) => {
      header.createEl("th", { text: label });
    });

    const body = table.createTBody();
    for (const entry of this.entries) {
      const row = body.insertRow();
      const active = now - entry.lastSeen <= ttlMs;

      row.createEl("td", { text: entry.nodeId });
      row.createEl("td", { text: entry.userId });
      row.createEl("td", { text: active ? "Active" : "Expired" });
      row.createEl("td", { text: this.formatTimestamp(entry.lastSeen) });
      row.createEl("td", { text: this.formatTimestamp(entry.lastSyncAt) });
      row.createEl("td", { text: entry.lastAppliedOperationId ?? "-" });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private formatTimestamp(value: number | undefined): string {
    if (!value) {
      return "-";
    }

    return new Date(value).toLocaleString();
  }
}
