import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

try {
  await writeFile(new URL("../.dev.vars", import.meta.url),
    `BOT_TOKEN="replace-with-token-from-BotFather"\nWEBHOOK_SECRET="${randomBytes(32).toString("hex")}"\n`,
    { flag: "wx", mode: 0o600 });
  console.log("Создан .dev.vars. WEBHOOK_SECRET сгенерирован. Вставь токен BotFather в BOT_TOKEN.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log(".dev.vars уже существует. Его содержимое сохранено.");
}
