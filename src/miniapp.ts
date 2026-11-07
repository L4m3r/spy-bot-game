import type { Env } from "./env";
import { getIdentity, roomCode } from "./identity";
import { LOCATIONS, type Action, type Player } from "./model";
import { rpcData } from "./rpc";

const AUTH_MAX_AGE = 60 * 60;
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const encoder = new TextEncoder();

async function authenticate(request: Request, token: string): Promise<Player | null> {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("tma ") || authorization.length > 16_384) return null;
  const params = new URLSearchParams(authorization.slice(4));
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return null;
  const hash = params.get("hash") ?? "";
  const authDate = Number(params.get("auth_date"));
  const age = Date.now() / 1000 - authDate;
  if (!/^[a-f0-9]{64}$/i.test(hash) || !Number.isSafeInteger(authDate) || age < -30 || age > AUTH_MAX_AGE) return null;
  params.delete("hash");
  const data = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("\n");
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", baseKey, encoder.encode(token));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signature = Uint8Array.from(hash.match(/../g)!, value => parseInt(value, 16));
  if (!await crypto.subtle.verify("HMAC", key, signature, encoder.encode(data))) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "null");
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot || typeof user.first_name !== "string") return null;
    return { id: user.id, name: [user.first_name, typeof user.last_name === "string" ? user.last_name : ""].filter(Boolean).join(" ").replace(/[\r\n]/g, " ").slice(0, 48) || "Игрок" };
  } catch { return null; }
}

export async function miniAppFetch(request: Request, env: Env): Promise<Response> {
  try {
    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) return json({ error: "Приложение временно недоступно." }, 503);
    const url = new URL(request.url);
    const routes: Record<string, string> = { state: "GET", invitation: "GET", card: "GET", action: "POST" };
    const route = url.pathname.slice("/api/miniapp/".length);
    if (!Object.hasOwn(routes, route)) return json({ error: "Не найдено." }, 404);
    if (request.method !== routes[route]) return json({ error: "Метод не поддерживается." }, 405);
    if (request.headers.has("Origin") && request.headers.get("Origin") !== url.origin) return json({ error: "Запрос отклонён." }, 403);
    const actor = await authenticate(request, env.BOT_TOKEN);
    if (!actor) return json({ error: "Открой Mini App заново из Telegram." }, 401);
    const user = env.USER_LIMITS.getByName(String(actor.id));
    if (route === "state") {
      const identity = await getIdentity(env.BOT_TOKEN);
      return json({ user: actor, botUsername: identity.username, locations: LOCATIONS, serverTime: Date.now(), room: await rpcData(user.miniAppState(actor.id)) });
    }
    const code = url.searchParams.get("code") ?? "";
    if (route === "invitation" || route === "card") {
      if (!/^[a-f0-9]{24}$/.test(code)) return json({ error: "Приглашение недействительно." }, 400);
      if (route === "invitation") {
        const invitation = await rpcData(env.ROOMS.getByName(code).miniAppInvitation());
        return invitation ? json({ invitation }) : json({ error: "Комната закрыта или устарела." }, 404);
      }
      const round = Number(url.searchParams.get("round"));
      if (!Number.isSafeInteger(round) || round < 1) return json({ error: "Раунд недействителен." }, 400);
      const card = await rpcData(user.miniAppCard(actor.id, code, round));
      return card ? json({ card }) : json({ error: "Карточка недоступна. Обнови комнату: возможно, начался другой раунд." }, 409);
    }
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "Нужен JSON." }, 415);
    // Read with a hard bound even when Content-Length is absent or inaccurate.
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) { await reader.cancel(); return json({ error: "Запрос слишком большой." }, 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let body;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json({ error: "Некорректный запрос." }, 400); }
    const actions: Action[] = ["create", "join", "deal", "leave", "close"];
    if (!body || !actions.includes(body.action) || typeof body.requestId !== "string"
      || !/^\d{13}:[a-f0-9-]{36}$/.test(body.requestId)) return json({ error: "Некорректное действие." }, 400);
    const requestAt = Number(body.requestId.split(":")[0]);
    if (requestAt < Date.now() - 300_000 || requestAt > Date.now() + 30_000) return json({ error: "Действие устарело. Обнови комнату." }, 409);
    if (body.action !== "create" && (typeof body.code !== "string" || !/^[a-f0-9]{24}$/.test(body.code))) return json({ error: "Приглашение недействительно." }, 400);
    if (body.action === "deal" && (!Number.isSafeInteger(body.expectedRound) || body.expectedRound < 0)) return json({ error: "Обнови текущий раунд." }, 400);
    const identity = await getIdentity(env.BOT_TOKEN);
    const result = await rpcData(user.dispatch({
      actor, username: identity.username!, action: body.action, code: body.action === "create" ? await roomCode(env.WEBHOOK_SECRET, actor.id, requestAt) : body.code,
      updateId: requestAt, requestId: body.requestId, channel: "miniapp", expectedRound: body.expectedRound,
      miniAppUrl: new URL("/miniapp/", request.url).href,
    }));
    if (result.error) return json({ error: result.error }, 409);
    if (result.confirmCloseCode) return json({ error: "Организатор должен закрыть комнату для всех участников." }, 409);
    const room = await rpcData(user.miniAppState(actor.id));
    // A lost response can leave an incomplete operation without a cached
    // result. Reconcile the actual room instead of reporting phantom success.
    if ((body.action === "create" && !room) || (body.action === "join" && room?.code !== body.code)
      || (body.action === "deal" && (!room || room.code !== body.code || room.round <= body.expectedRound))) {
      return json({ error: "Действие не завершено. Обнови комнату и попробуй ещё раз." }, 409);
    }
    return json({ room, message: result.message });
  } catch {
    // Do not log signed initData, bot tokens, private cards or RPC errors.
    return json({ error: "Не удалось связаться с сервером. Попробуй ещё раз." }, 503);
  }
}
