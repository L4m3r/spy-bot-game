import { Api } from "grammy";
import type { UserFromGetMe } from "grammy/types";

let botIdentity: { token: string; promise: Promise<UserFromGetMe> } | undefined;

export async function getIdentity(token: string): Promise<UserFromGetMe> {
  if (!botIdentity || botIdentity.token !== token) {
    botIdentity = { token, promise: new Api(token, { timeoutSeconds: 15 }).getMe() };
  }
  try { return await botIdentity.promise; }
  catch (error) { botIdentity = undefined; throw error; }
}

export async function roomCode(secret: string, userId: number, updateId: number, epoch?: string): Promise<string> {
  // Stable across Telegram retries, unpredictable without the server secret.
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${userId}:${updateId}${epoch ? `:${epoch}` : ""}`));
  return Array.from(new Uint8Array(digest).slice(0, 12), byte => byte.toString(16).padStart(2, "0")).join("");
}
