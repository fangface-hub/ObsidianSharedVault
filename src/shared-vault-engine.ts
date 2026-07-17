import DiffMatchPatch from "diff-match-patch";
import { MarkdownView, Notice, TFile, normalizePath } from "obsidian";
import * as Y from "yjs";
import { SharedVaultConflictModal } from "./shared-vault-modals";
import type SharedVaultPlugin from "./shared-vault-plugin";
import type {
    ApplyOperationResult,
    ApplyPendingOpsResult,
    CacheState,
    CachedDocument,
    ConflictResolution,
    OperationFile,
    SnapshotFile,
    YjsOperation
} from "./shared-vault-types";
import {
    base64ToBytes,
    base64ToText,
    bytesToBase64,
    getYTextContent,
    legacySafeFileName,
    safeFileName,
    safeMkdir,
    textToBase64
} from "./shared-vault-utils";

export class SharedVaultEngine {
  private readonly dmp = new DiffMatchPatch();
  private readonly suppressWrites = new Set<string>();
  private readonly cacheRoot: string;
  private readonly docRoot: string;
  private readonly statePath: string;
  private readonly operationCacheDir: string;
  private readonly snapshotDir: string;

  static getNodeCacheRoot(plugin: SharedVaultPlugin, vaultId: string, nodeId: string): string {
    return normalizePath(`${plugin.app.vault.configDir}/cache/${vaultId}/${nodeId}`);
  }

  static getCacheRoot(plugin: SharedVaultPlugin, vaultId: string, nodeId: string, userId: string): string {
    return normalizePath(`${SharedVaultEngine.getNodeCacheRoot(plugin, vaultId, nodeId)}/${userId}`);
  }

  constructor(
    private readonly plugin: SharedVaultPlugin,
    private readonly vaultId: string,
    private readonly nodeId: string,
    private readonly userId: string,
    operationCacheDir: string,
    snapshotDir: string
  ) {
    this.cacheRoot = SharedVaultEngine.getCacheRoot(this.plugin, this.vaultId, this.nodeId, this.userId);
    this.docRoot = normalizePath(`${this.cacheRoot}/docs`);
    this.statePath = normalizePath(`${this.cacheRoot}/state.json`);
    this.operationCacheDir = normalizePath(operationCacheDir);
    this.snapshotDir = normalizePath(snapshotDir);
  }

  async initialize(): Promise<void> {
    await safeMkdir(this.plugin, this.operationCacheDir);
    await safeMkdir(this.plugin, this.snapshotDir);
  }

  async handleLocalModify(file: TFile): Promise<void> {
    if (this.suppressWrites.has(file.path) || file.extension !== "md") {
      return;
    }

    const currentText = await this.readCurrentMarkdownText(file);
    const document = await this.loadDocument(file.path);

    if (!document) {
      const ydoc = this.createDocFromText(currentText);
      await this.saveDocument(file.path, ydoc);

      const bootstrapUpdate = Y.encodeStateAsUpdate(ydoc);
      if (bootstrapUpdate.length === 0) {
        return;
      }

      const operationFile: OperationFile = {
        id: this.createOperationId(),
        node: this.nodeId,
        user: this.userId,
        timestamp: Date.now(),
        ops: [
          {
            type: "yjs-update",
            path: file.path,
            update: bytesToBase64(bootstrapUpdate)
          }
        ]
      };

      await this.writeOperationFile(operationFile);
      await this.markProcessed(operationFile.id);
      return;
    }

    const ydoc = this.createDocFromState(document.stateBase64);
    const ytext = ydoc.getText("content");
    const cachedText = getYTextContent(ydoc);
    const previousText = this.getDocumentVaultText(document, cachedText);

    if (cachedText !== previousText) {
      await this.initializeDocument(file.path, currentText);
      new Notice("Shared vault cache was out of sync for this file and has been realigned. Please repeat the edit if needed.");
      return;
    }

    if (previousText === currentText) {
      return;
    }

    const diffs = this.dmp.diff_main(previousText, currentText);
    this.dmp.diff_cleanupEfficiency(diffs);

    const updates: Uint8Array[] = [];
    const onUpdate = (update: Uint8Array): void => {
      updates.push(update);
    };

    ydoc.on("update", onUpdate);
    Y.transact(ydoc, () => {
      let cursor = 0;

      for (const [operation, text] of diffs) {
        if (operation === 0) {
          cursor += text.length;
          continue;
        }

        if (operation === -1) {
          ytext.delete(cursor, text.length);
          continue;
        }

        ytext.insert(cursor, text);
        cursor += text.length;
      }
    }, this.nodeId);
    ydoc.off("update", onUpdate);

    const mergedUpdate = updates.length === 0 ? undefined : Y.mergeUpdates(updates);
    await this.saveDocument(file.path, ydoc, currentText);

    if (!mergedUpdate || mergedUpdate.length === 0) {
      return;
    }

    const operationFile: OperationFile = {
      id: this.createOperationId(),
      node: this.nodeId,
      user: this.userId,
      timestamp: Date.now(),
      ops: [
        {
          type: "yjs-update",
          path: file.path,
          update: bytesToBase64(mergedUpdate)
        }
      ]
    };

    await this.writeOperationFile(operationFile);
    await this.markProcessed(operationFile.id);
  }

  async applyPendingOps(): Promise<ApplyPendingOpsResult> {
    const processed = new Set((await this.readState()).processedOpIds);
    const listed = await this.plugin.app.vault.adapter.list(this.operationCacheDir);
    const files = listed.files.filter((path) => path.endsWith(".json")).sort();
    let applied = 0;
    let lastAppliedOperationId: string | null = null;

    for (const path of files) {
      const raw = await this.plugin.app.vault.adapter.read(path);
      const operationFile = JSON.parse(raw) as OperationFile;

      if (processed.has(operationFile.id)) {
        continue;
      }

      if (operationFile.node === this.nodeId) {
        await this.markProcessed(operationFile.id);
        continue;
      }

      let touched = false;

      for (const operation of operationFile.ops) {
        const result = await this.applyOperation(operation, operationFile);
        if (result === "deferred") {
          return {
            appliedCount: applied,
            lastAppliedOperationId
          };
        }

        touched = result === "applied" || touched;
      }

      await this.markProcessed(operationFile.id);
      lastAppliedOperationId = operationFile.id;
      applied += touched ? 1 : 0;
    }

    return {
      appliedCount: applied,
      lastAppliedOperationId
    };
  }

  async rebuildLocalCache(): Promise<void> {
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      const content = await this.readCurrentMarkdownText(file);
      await this.initializeDocument(file.path, content);
    }
  }

  async createSnapshot(): Promise<string> {
    const listed = await this.plugin.app.vault.adapter.list(this.docRoot);
    const documents: CachedDocument[] = [];

    for (const path of listed.files.filter((value) => value.endsWith(".json")).sort()) {
      const raw = await this.plugin.app.vault.adapter.read(path);
      documents.push(JSON.parse(raw) as CachedDocument);
    }

    const snapshotId = this.createOperationId();
    const snapshot: SnapshotFile = {
      id: snapshotId,
      createdAt: Date.now(),
      node: this.nodeId,
      user: this.userId,
      documents
    };

    const snapshotPath = normalizePath(`${this.snapshotDir}/${snapshotId}.snapshot.json`);
    await this.plugin.app.vault.adapter.write(snapshotPath, JSON.stringify(snapshot, null, 2));
    return snapshotPath;
  }

  private async applyOperation(operation: YjsOperation, operationFile: OperationFile): Promise<ApplyOperationResult> {
    if (operation.type !== "yjs-update") {
      return "unchanged";
    }

    if (operationFile.node === this.nodeId) {
      return "unchanged";
    }

    const existing = await this.loadDocument(operation.path);
    const seedContent = await this.readVaultText(operation.path);
    const ydoc = existing
      ? this.createDocFromState(existing.stateBase64)
      : this.createDocFromText(seedContent ?? "");
    const cachedContent = getYTextContent(ydoc);
    const lastVaultText = existing
      ? this.getDocumentVaultText(existing, cachedContent)
      : seedContent ?? "";

    Y.applyUpdate(ydoc, base64ToBytes(operation.update));
    const updatedText = getYTextContent(ydoc);

    if (seedContent !== null && seedContent !== lastVaultText && seedContent !== updatedText) {
      const resolution = await this.confirmConflict({
        path: operation.path,
        currentText: seedContent,
        incomingText: updatedText,
        remoteUserId: operationFile.user,
        remoteNodeId: operationFile.node
      });

      if (resolution === "defer") {
        new Notice("Shared operation left pending until the conflict is reviewed.");
        return "deferred";
      }

      if (resolution === "keep-local") {
        await this.initializeDocument(operation.path, seedContent);
        return "unchanged";
      }
    }

    if (seedContent === updatedText) {
      await this.saveDocument(operation.path, ydoc, updatedText);
      return "unchanged";
    }

    await this.writeBackMarkdown(operation.path, updatedText);
    await this.saveDocument(operation.path, ydoc, updatedText);
    return "applied";
  }

  private async confirmConflict(input: {
    path: string;
    currentText: string;
    incomingText: string;
    remoteUserId: string;
    remoteNodeId: string;
  }): Promise<ConflictResolution> {
    return new Promise<ConflictResolution>((resolve) => {
      const modal = new SharedVaultConflictModal(this.plugin, input, resolve);
      modal.open();
    });
  }

  private async writeBackMarkdown(path: string, content: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);

    this.suppressWrites.add(path);
    try {
      if (file instanceof TFile) {
        await this.plugin.app.vault.modify(file, content);
        return;
      }

      await this.plugin.app.vault.create(path, content);
    } finally {
      this.suppressWrites.delete(path);
    }
  }

  private async initializeDocument(path: string, content: string): Promise<void> {
    const ydoc = this.createDocFromText(content);
    await this.saveDocument(path, ydoc);
  }

  private async loadDocument(path: string): Promise<CachedDocument | null> {
    const docPath = this.getDocPath(path);
    const document = await this.readDocumentIfPathMatches(docPath, path);
    if (document) {
      return document;
    }

    const legacyDocPath = this.getLegacyDocPath(path);
    if (legacyDocPath === docPath) {
      return null;
    }

    return this.readDocumentIfPathMatches(legacyDocPath, path);
  }

  private async readDocumentIfPathMatches(docPath: string, path: string): Promise<CachedDocument | null> {
    const exists = await this.plugin.app.vault.adapter.exists(docPath);
    if (!exists) {
      return null;
    }

    const raw = await this.plugin.app.vault.adapter.read(docPath);
    const document = JSON.parse(raw) as CachedDocument;
    return document.path === path ? document : null;
  }

  private async saveDocument(path: string, ydoc: Y.Doc, vaultText = getYTextContent(ydoc)): Promise<void> {
    await this.ensureLocalCacheDirs();
    const data: CachedDocument = {
      path,
      stateBase64: bytesToBase64(Y.encodeStateAsUpdate(ydoc)),
      vaultTextBase64: textToBase64(vaultText)
    };

    await this.plugin.app.vault.adapter.write(this.getDocPath(path), JSON.stringify(data, null, 2));
  }

  private getDocumentVaultText(document: CachedDocument, fallback: string): string {
    return document.vaultTextBase64 ? base64ToText(document.vaultTextBase64) : fallback;
  }

  private createDocFromState(stateBase64: string): Y.Doc {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, base64ToBytes(stateBase64));
    ydoc.getText("content");
    return ydoc;
  }

  private createDocFromText(content: string): Y.Doc {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    if (content.length > 0) {
      ytext.insert(0, content);
    }
    return ydoc;
  }

  private getDocPath(path: string): string {
    return normalizePath(`${this.docRoot}/${safeFileName(path)}.json`);
  }

  private getLegacyDocPath(path: string): string {
    return normalizePath(`${this.docRoot}/${legacySafeFileName(path)}.json`);
  }

  private async readState(): Promise<CacheState> {
    const exists = await this.plugin.app.vault.adapter.exists(this.statePath);
    if (!exists) {
      return { processedOpIds: [] };
    }

    const raw = await this.plugin.app.vault.adapter.read(this.statePath);
    return JSON.parse(raw) as CacheState;
  }

  private async markProcessed(operationId: string): Promise<void> {
    await this.ensureLocalCacheDirs();
    const state = await this.readState();
    if (state.processedOpIds.includes(operationId)) {
      return;
    }

    state.processedOpIds.push(operationId);
    if (state.processedOpIds.length > 5000) {
      state.processedOpIds = state.processedOpIds.slice(-5000);
    }

    await this.plugin.app.vault.adapter.write(this.statePath, JSON.stringify(state, null, 2));
  }

  private async writeOperationFile(operationFile: OperationFile): Promise<void> {
    const path = normalizePath(`${this.operationCacheDir}/${operationFile.id}.json`);
    await this.plugin.app.vault.adapter.write(path, JSON.stringify(operationFile, null, 2));
  }

  private async ensureLocalCacheDirs(): Promise<void> {
    await safeMkdir(this.plugin, normalizePath(`${this.plugin.app.vault.configDir}/cache`));
    await safeMkdir(this.plugin, normalizePath(`${this.plugin.app.vault.configDir}/cache/${this.vaultId}`));
    await safeMkdir(this.plugin, SharedVaultEngine.getNodeCacheRoot(this.plugin, this.vaultId, this.nodeId));
    await safeMkdir(this.plugin, this.cacheRoot);
    await safeMkdir(this.plugin, this.docRoot);
  }

  private async readVaultText(path: string): Promise<string | null> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return null;
    }

    return this.readCurrentMarkdownText(file);
  }

  private async readCurrentMarkdownText(file: TFile): Promise<string> {
    const activeFile = this.plugin.app.workspace.getActiveFile();
    const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);

    if (activeFile?.path === file.path && activeView) {
      return activeView.editor.getValue();
    }

    return this.plugin.app.vault.read(file);
  }

  private createOperationId(): string {
    const now = new Date();
    const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}-${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}${String(now.getUTCSeconds()).padStart(2, "0")}`;
    return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
