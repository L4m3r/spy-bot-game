import { createInterface } from "node:readline/promises";

const botToken = process.env.BOT_TOKEN;
const secret = process.env.WEBHOOK_SECRET;
if (!botToken || !secret || botToken.includes("replace-") || secret.includes("replace-")) {
  console.error("Заполни BOT_TOKEN и WEBHOOK_SECRET в .dev.vars. Секреты не нужно отправлять в чат.");
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  console.error("WEBHOOK_SECRET должен содержать 1–256 символов A–Z, a–z, 0–9, _ или -.");
  process.exit(1);
}
const terminal = createInterface({ input: process.stdin, output: process.stdout });
let workerUrl = process.argv[2];
try {
  workerUrl ||= await terminal.question("HTTPS-адрес Worker (например https://spy-telegram-bot.example.workers.dev): ");
} finally { terminal.close(); }
let url;
try {
  url = new URL(workerUrl.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
} catch {
  console.error("Нужен корневой HTTPS-адрес Worker без пути, параметров и пароля.");
  process.exit(1);
}

async function telegram(method, payload = {}) {
  // Do not print network errors: they can contain the bot token in the URL.
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed`);
  return data.result;
}

try {
  const health = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(20_000) });
  if (!health.ok || !(await health.json()).ok) throw new Error("Worker is unavailable");
  // A mismatched deployed secret would silently prevent updates from arriving.
  const probe = await fetch(new URL("/webhook", url), {
    method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ update_id: 0 }), signal: AbortSignal.timeout(20_000),
  });
  if (!probe.ok) throw new Error("Deployed secrets do not match or Worker is not configured");
  const identity = await telegram("getMe");
  await telegram("setMyCommands", { commands: [
    { command: "game", description: "Открыть или создать комнату" },
    { command: "locations", description: "Все возможные локации" },
    { command: "help", description: "Как играть" },
  ] });
  await telegram("setWebhook", {
    url: new URL("/webhook", url).href,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    max_connections: 10,
    // Keep pending updates; setup should not silently discard user actions.
    drop_pending_updates: false,
  });
  const webhook = await telegram("getWebhookInfo");
  if (webhook.url !== new URL("/webhook", url).href) throw new Error("Webhook verification failed");
  console.log(`Webhook настроен. Открой https://t.me/${identity.username} и отправь /game.`);
} catch (error) {
  console.error("Настройка не завершена. Проверь адрес Worker, секреты в .dev.vars и Cloudflare и доступность Telegram API.");
  // Only our own controlled messages are safe to show.
  if (error instanceof Error && /^(Telegram \w+ failed|Worker is unavailable|Deployed secrets do not match or Worker is not configured|Webhook verification failed)$/.test(error.message)) console.error(error.message);
  process.exitCode = 1;
}
