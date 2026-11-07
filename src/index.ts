import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Update } from "grammy/types";
import type { Env } from "./env";
import { LOCATIONS, type Action, type Command } from "./model";
import { rpcData } from "./rpc";
import { getIdentity } from "./identity";
import { miniAppFetch } from "./miniapp";
export { GameRoom } from "./room";
export { UserLimits } from "./user-limits";

async function makeBot(env: Env, miniAppUrl: string) {
  const identity = await getIdentity(env.BOT_TOKEN);
  const bot = new Bot(env.BOT_TOKEN, { botInfo: identity, client: { timeoutSeconds: 15 } });
  const welcome = "🕵️ Шпион\n\nСоздай комнату и отправь друзьям приглашение. Когда соберётся от 3 до 12 игроков, раздай карточки.\n\nВсе обсуждения, обвинения и угадывание локации — голосом.\n\n/game — текущая или новая комната\n/leave — выйти из комнаты\n/locations — список возможных локаций";
  const createKeyboard = () => new InlineKeyboard().webApp("Открыть Mini App", miniAppUrl).row().text("Создать игру", `create:${Date.now()}`);

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private") {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Открой личный чат с ботом." });
      else if (ctx.message?.text?.startsWith("/")) await ctx.reply("Создай игру в личном чате с ботом.");
      return;
    }
    return next();
  });

  async function dispatch(ctx: Context, action: Action, code: string, expectedRound?: number, expectedMembershipId?: number, buttonCreatedAt?: number) {
    if (!ctx.from) return;
    const command: Command = {
      action, code, expectedRound, expectedMembershipId, buttonCreatedAt, messageDate: ctx.message?.date, updateId: ctx.update.update_id,
      actor: { id: ctx.from.id, name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ").replace(/[\r\n]/g, " ").slice(0, 48) },
      username: identity.username!,
      miniAppUrl,
    };
    const result = await rpcData(env.USER_LIMITS.getByName(String(ctx.from.id)).dispatch(command));
    if (result.error || result.message) {
      await ctx.reply(result.error ?? result.message!, result.confirmCloseCode ? {
        reply_markup: new InlineKeyboard().text("Да, закрыть комнату", `close:${result.confirmCloseCode}:0:${result.confirmMembershipId}`).row().text("Остаться в комнате", `show:${result.confirmCloseCode}:0:${result.confirmMembershipId}`),
      } : undefined);
    }
    return result;
  }

  bot.command("start", async ctx => {
    const match = /^room_([a-f0-9]{24})$/.exec(ctx.match);
    if (match) await dispatch(ctx, "join", match[1]);
    else await ctx.reply(welcome, { reply_markup: createKeyboard() });
  });
  bot.command("help", ctx => ctx.reply(welcome, { reply_markup: createKeyboard() }));
  bot.command("locations", ctx => ctx.reply(`Возможные локации (общий список для всех):\n\n${LOCATIONS.join("\n")}`));
  bot.command("game", async ctx => {
    if (!ctx.from) return;
    await dispatch(ctx, "create", "");
  });
  bot.command("leave", ctx => dispatch(ctx, "leave", "").then(() => undefined));
  bot.callbackQuery("locations", async ctx => {
    try { await ctx.answerCallbackQuery(); } catch { /* The list is still useful after the acknowledgement expires. */ }
    await ctx.reply(`Возможные локации (общий список для всех):\n\n${LOCATIONS.join("\n")}`);
  });
  bot.callbackQuery(/^create(?::([0-9]{13}))?$/, async ctx => {
    try { await ctx.answerCallbackQuery(); } catch { /* An expired acknowledgement must not block the room action. */ }
    await dispatch(ctx, "create", "", undefined, undefined, ctx.match[1] ? Number(ctx.match[1]) : undefined);
  });
  bot.callbackQuery(/^(refresh|show|leave|deal|retry|confirm|close):([a-f0-9]{24})(?::([0-9]{1,9}))?(?::([0-9]{1,16}))?$/, async ctx => {
    // Acknowledge the button immediately; card delivery is done by the room alarm.
    try { await ctx.answerCallbackQuery(); } catch { /* Expired callbacks may still carry a valid room action. */ }
    const message = ctx.callbackQuery.message;
    // Previously sent "current room" prompts used refresh callback data.
    const oldRoomPrompt = message && "text" in message && message.text?.startsWith("У тебя уже есть активная комната:");
    const action: Action = ctx.match[1] === "refresh" && oldRoomPrompt ? "show" : ctx.match[1] as Action;
    const code = ctx.match[2];
    const expectedRound = ctx.match[3] === undefined ? undefined : Number(ctx.match[3]);
    const expectedMembershipId = ctx.match[4] === undefined ? undefined : Number(ctx.match[4]);
    if (expectedMembershipId !== undefined && !Number.isSafeInteger(expectedMembershipId)) return;
    const result = await dispatch(ctx, action, code, expectedRound, expectedMembershipId);
    if (action === "confirm" && result && !result.error && Number.isSafeInteger(result.confirmMembershipId)) {
      await ctx.reply("Закончить текущий раунд и раздать новые карточки?", {
        reply_markup: new InlineKeyboard().text("Да, новый раунд", `deal:${code}:${expectedRound}:${result.confirmMembershipId}`).row().text("Вернуться в комнату", `refresh:${code}:0:${result.confirmMembershipId}`),
      });
    }
  });
  bot.on("callback_query:data", ctx => ctx.answerCallbackQuery({ text: "Эта кнопка устарела. Открой приглашение или отправь /game." }));
  bot.on("message:text", ctx => ctx.reply(welcome, { reply_markup: createKeyboard() }));
  return bot;
}

function equalSecret(actual: string, expected: string): boolean {
  const a = new TextEncoder().encode(actual);
  const b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/miniapp/")) return miniAppFetch(request, env);
    if (path === "/health" && request.method === "GET") return Response.json({ ok: true });
    if (path !== "/webhook") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) return new Response("Bot is not configured", { status: 503 });
    if (!equalSecret(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", env.WEBHOOK_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (Number(request.headers.get("Content-Length")) > 65_536) return new Response("Payload too large", { status: 413 });
    // Bound the stream as well, since Content-Length can be absent or inaccurate.
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65_536) { await reader.cancel(); return new Response("Payload too large", { status: 413 }); }
        chunks.push(value);
      }
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    let update: Update;
    try {
      update = JSON.parse(new TextDecoder().decode(body));
      if (!update || !Number.isSafeInteger(update.update_id)) throw new Error("Invalid update");
    } catch { return new Response("Invalid update", { status: 400 }); }
    if (!("message" in update) && !("callback_query" in update)) return new Response("OK");
    try {
      const bot = await makeBot(env, new URL("/miniapp/", request.url).href);
      await bot.handleUpdate(update);
      return new Response("OK");
    } catch {
      // Never log error objects containing Telegram request URLs or bot tokens.
      console.error("Webhook processing failed; Telegram may retry this update.");
      return new Response("Temporary failure", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
