import type { Plugin } from "obsidian";
import * as Y from "yjs";

export function getYTextContent(ydoc: Y.Doc): string {
  return ydoc.getText("content").toJSON();
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function textToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

export function base64ToText(value: string): string {
  return new TextDecoder().decode(base64ToBytes(value));
}

export function safeFileName(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function legacySafeFileName(path: string): string {
  return encodeURIComponent(path).replace(/%/g, "_");
}

export async function safeMkdir(plugin: Plugin, path: string): Promise<void> {
  const exists = await plugin.app.vault.adapter.exists(path);
  if (!exists) {
    await plugin.app.vault.adapter.mkdir(path);
  }
}

export async function hashText(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);

  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
