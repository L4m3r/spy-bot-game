if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(process.env.BOT_TOKEN ?? "")) {
  console.error("Вставь настоящий токен BotFather в BOT_TOKEN в файле .dev.vars.");
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{32,256}$/.test(process.env.WEBHOOK_SECRET ?? "") || process.env.WEBHOOK_SECRET.includes("replace-")) {
  console.error("WEBHOOK_SECRET должен быть случайным секретом длиной 32–256 символов (буквы, цифры, _ и -).");
  process.exit(1);
}
console.log("Переменные настроены. Их значения не выводятся.");
