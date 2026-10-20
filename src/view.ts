import { InlineKeyboard } from "grammy";
import { cardJobsPending, MAX_PLAYERS, type RoomState } from "./model";

export function lobbyView(state: RoomState, userId: number) {
  const owner = userId === state.ownerId;
  const invite = `https://t.me/${state.username}?start=room_${state.code}`;
  const players = state.members.map((player, index) => {
    const waiting = state.round && !state.round.playerIds.includes(player.id);
    return `${index + 1}. ${player.name}${player.id === state.ownerId ? " 👑" : ""}${waiting ? " — со следующего раунда" : ""}`;
  }).join("\n");
  const round = state.round;
  let status = "Когда все соберутся, организатор раздаст карточки.";
  if (round) {
    const values = Object.values(round.delivery);
    const sent = values.filter(value => value === "sent").length;
    const failed = values.filter(value => value === "failed").length;
    status = `Раунд ${round.number}. Карточки отправлены: ${sent} из ${values.length}.`;
    if (cardJobsPending(state)) status += "\nРаздаю карточки…";
    else if (failed) {
      const names = round.playerIds.filter(id => round.delivery[id] === "failed")
        .map(id => state.members.find(player => player.id === id)?.name ?? `игрок ${id}`).join(", ");
      status += owner
        ? `\nНе удалось отправить: ${names}. Можно повторить отправку.`
        : `\nНе удалось отправить: ${failed}. Организатор может повторить отправку.`;
    }
    else status += "\nМожно играть! Обсуждение и обвинения — голосом.";
  }
  const keyboard = new InlineKeyboard();
  if (owner) {
    keyboard.url("Пригласить друзей", `https://t.me/share/url?url=${encodeURIComponent(invite)}&text=${encodeURIComponent("Присоединяйся к игре «Шпион»")}`).row();
    if (!cardJobsPending(state)) {
      if (round && Object.values(round.delivery).includes("failed")) {
        keyboard.text("Повторить неотправленные", `retry:${state.code}:${round.number}`).row();
      }
      keyboard.text(round ? "Следующий раунд" : "Раздать карточки", `${round ? "confirm" : "deal"}:${state.code}:${round?.number ?? 0}`).row();
    }
  }
  keyboard.text("Обновить", `refresh:${state.code}`).text("Локации", "locations").row();
  keyboard.text(owner ? "Закрыть комнату" : "Выйти", `${owner ? "close" : "leave"}:${state.code}`);
  return {
    text: `🕵️ Комната «Шпион»\n\nИгроки: ${state.members.length}/${MAX_PLAYERS}\n${players}\n\n${status}\n\nПриглашение:\n${invite}\n\nКомната удалится через 24 часа после последнего действия в ней.`,
    reply_markup: keyboard,
  };
}
