"use client";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createClientId(): string {
  const cryptoObject = globalThis.crypto;

  if (typeof cryptoObject?.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }

  if (typeof cryptoObject?.getRandomValues === "function") {
    const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
    return bytesToHex(bytes);
  }

  return `fallback-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}
