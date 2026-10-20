import { DurableObject } from "cloudflare:workers";
import { Api, GrammyError } from "grammy";
import type { Env } from "./env";
import {
  cardJobsPending, enqueue, enqueueCard, enqueueLobbies, LOCATIONS,
  MAX_PLAYERS, MIN_PLAYERS, randomIndex, ROOM_TTL_MS,
  type Command, type Job, type Result, type RoomState,
} from "./model";
import { lobbyView } from "./view";

export class GameRoom extends DurableObject<Env> {
  private readonly api: Api;
  private alarmRunning = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.api = new Api(env.BOT_TOKEN, { timeoutSeconds: 15 });
    // Do not create room data or extend TTL here: alarms also run the constructor.
  }

  private async erase(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  private async save(state: RoomState): Promise<void> {
    await this.ctx.storage.put("room", state);
    if (!this.alarmRunning) {
      const next = Math.min(state.expiresAt, ...state.jobs.map(job => job.nextAt));
      const desired = Math.max(Date.now() + 50, next);
      const current = await this.ctx.storage.getAlarm();
      // Keep an earlier wake-up, rather than repeatedly moving a pending alarm
      // forward while concurrent commands update the lobby.
      if (current === null || desired < current) {
        await this.ctx.storage.setAlarm(desired);
      }
    }
  }

  // Only storage mutations are serialized. Telegram network calls run outside
  // this section, so a slow API request does not block room membership changes.
  private locked<T>(fn: (state: RoomState | undefined) => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(async () => fn(await this.ctx.storage.get<RoomState>("room")));
  }

  // UserLimits cleanup must read the real deadline without extending it.
  async activeUntil(ownerId: number): Promise<number> {
    return this.locked(async state => {
      if (!state) return 0;
      if (state.expiresAt <= Date.now()) { await this.erase(); return 0; }
      if (state.ownerId !== ownerId) throw new Error("Room owner mismatch");
      return state.expiresAt;
    });
  }

  async resume(command: Command): Promise<number> {
    return this.locked(async state => {
      if (!state) return 0;
      if (state.expiresAt <= Date.now()) { await this.erase(); return 0; }
      if (state.ownerId !== command.actor.id) throw new Error("Room owner mismatch");
      if (!state.processed.includes(command.updateId)) {
        enqueue(state, { id: `lobby:${command.actor.id}`, kind: "lobby", chatId: command.actor.id });
        state.expiresAt = Date.now() + ROOM_TTL_MS;
        state.processed = [...state.processed.slice(-255), command.updateId];
        await this.save(state);
      }
      return state.expiresAt;
    });
  }

  async dispatch(command: Command): Promise<Result> {
    return this.locked(async state => {
      const now = Date.now();
      if (state && state.expiresAt <= now) {
        await this.erase();
        state = undefined;
      }
      if (!state) {
        if (command.action !== "create") return { error: "Комната закрыта или устарела. Создай новую через /game." };
        state = {
          code: command.code, username: command.username, ownerId: command.actor.id,
          members: [command.actor], expiresAt: now + ROOM_TTL_MS,
          processed: [], lobbyMessages: {}, jobs: [], jobSequence: 0,
        };
      }
      if (state.processed.includes(command.updateId)) {
        await this.save(state);
        return {};
      }
      const owner = command.actor.id === state.ownerId;
      const member = state.members.some(player => player.id === command.actor.id);
      if (["deal", "retry", "confirm", "close", "create"].includes(command.action) && !owner) {
        return { error: "Это действие доступно только организатору." };
      }
      if (!["join", "create"].includes(command.action) && !member) {
        return { error: "Ты не в этой комнате. Подключись по приглашению." };
      }
      const roundNumber = state.round?.number ?? 0;
      if (["deal", "retry", "confirm"].includes(command.action) && command.expectedRound !== roundNumber) {
        return { error: "Эта кнопка от старого раунда. Нажми «Обновить» в комнате." };
      }
      switch (command.action) {
        case "create":
          enqueueLobbies(state);
          break;
        case "join":
          if (!member) {
            if (state.members.length >= MAX_PLAYERS) return { error: `Комната заполнена: максимум ${MAX_PLAYERS} игроков.` };
            state.members.push(command.actor);
          }
          enqueueLobbies(state);
          break;
        case "refresh":
          enqueue(state, { id: `lobby:${command.actor.id}`, kind: "lobby", chatId: command.actor.id });
          break;
        case "show":
          // Keep this delivery separate from coalesced lobby edits, so a
          // concurrent membership change cannot turn it back into an edit.
          enqueue(state, { id: `show:${command.updateId}`, kind: "lobby", chatId: command.actor.id, newMessage: true });
          break;
        case "leave":
          if (owner) return { error: "Организатор может закрыть комнату." };
          state.members = state.members.filter(player => player.id !== command.actor.id);
          state.jobs = state.jobs.filter(job => job.kind !== "lobby" || job.chatId !== command.actor.id);
          delete state.lobbyMessages[command.actor.id];
          enqueue(state, { id: `left:${command.updateId}`, kind: "notice", chatId: command.actor.id, text: "Ты вышел из комнаты. Вернуться можно по приглашению." });
          enqueueLobbies(state);
          break;
        case "confirm":
          if (!state.round) return { error: "Сначала раздай карточки первого раунда." };
          if (cardJobsPending(state)) return { error: "Дождись завершения текущей раздачи." };
          break;
        case "deal": {
          if (cardJobsPending(state)) return { error: "Дождись завершения текущей раздачи." };
          if (state.members.length < MIN_PLAYERS) return { error: `Нужно хотя бы ${MIN_PLAYERS} игрока.` };
          const locations = LOCATIONS.filter(location => location !== state.round?.location);
          state.round = {
            number: roundNumber + 1, location: locations[randomIndex(locations.length)],
            spyId: state.members[randomIndex(state.members.length)].id,
            playerIds: state.members.map(player => player.id), delivery: {},
          };
          // Cards are persisted before any Telegram side effect.
          for (const id of state.round.playerIds) enqueueCard(state, id);
          enqueueLobbies(state);
          break;
        }
        case "retry": {
          if (!state.round || cardJobsPending(state)) return { error: "Сейчас нет завершённой раздачи для повтора." };
          const failed = state.round.playerIds.filter(id => state.round!.delivery[id] === "failed");
          if (!failed.length) return { error: "Все карточки уже отправлены." };
          for (const id of failed) enqueueCard(state, id);
          enqueueLobbies(state);
          break;
        }
        case "close":
          await this.erase();
          return { message: "Комната закрыта. Для новой игры отправь /game." };
      }
      state.expiresAt = now + ROOM_TTL_MS;
      state.processed = [...state.processed.slice(-255), command.updateId];
      await this.save(state);
      return {};
    });
  }

  private async send(job: Job, state: RoomState): Promise<number | undefined> {
    if (job.kind !== "lobby") {
      const message = await this.api.sendMessage(job.chatId, job.text!, { protect_content: job.kind === "card" });
      return message.message_id;
    }
    const view = lobbyView(state, job.chatId);
    const messageId = job.newMessage ? undefined : state.lobbyMessages[job.chatId];
    if (messageId) {
      try {
        await this.api.editMessageText(job.chatId, messageId, view.text, { reply_markup: view.reply_markup, link_preview_options: { is_disabled: true } });
        return messageId;
      } catch (error) {
        if (!(error instanceof GrammyError) || error.error_code !== 400) throw error;
        if (error.description.includes("message is not modified")) return messageId;
        if (!/message to edit not found|message can't be edited/i.test(error.description)) throw error;
        // The user may have deleted their lobby message. Send a replacement.
      }
    }
    const message = await this.api.sendMessage(job.chatId, view.text, { reply_markup: view.reply_markup, link_preview_options: { is_disabled: true } });
    return message.message_id;
  }

  async alarm(): Promise<void> {
    this.alarmRunning = true;
    try {
      // Limit external API calls per invocation; any remainder gets another alarm.
      for (let index = 0; index < 24; index++) {
        const work = await this.locked(async state => {
          if (!state) return undefined;
          if (state.expiresAt <= Date.now()) { await this.erase(); return undefined; }
          const job = state.jobs.find(candidate => candidate.nextAt <= Date.now());
          if (!job) { await this.save(state); return undefined; }
          job.attempts++;
          await this.save(state);
          return { state, job };
        });
        if (!work) break;
        let messageId: number | undefined;
        let failure: unknown;
        try { messageId = await this.send(work.job, work.state); }
        catch (error) { failure = error; }

        await this.locked(async state => {
          if (!state) return; // A close request must never resurrect the room.
          if (state.expiresAt <= Date.now()) { await this.erase(); return; }
          const job = state.jobs.find(candidate => candidate.id === work.job.id && candidate.version === work.job.version);
          if (work.job.kind === "lobby" && messageId) state.lobbyMessages[work.job.chatId] = messageId;
          if (!job) { await this.save(state); return; }

          const permanent = failure instanceof GrammyError && [400, 401, 403].includes(failure.error_code);
          const done = !failure || permanent || job.attempts >= 5;
          if (done) {
            state.jobs = state.jobs.filter(candidate => candidate !== job);
            if (job.kind === "card" && state.round && state.round.number === job.roundNumber) {
              state.round.delivery[job.chatId] = failure ? "failed" : "sent";
              if (!cardJobsPending(state)) enqueueLobbies(state);
            }
          } else {
            const retryAfter = failure instanceof GrammyError ? failure.parameters.retry_after : undefined;
            job.nextAt = Date.now() + (retryAfter ? retryAfter * 1000 : Math.min(60_000, 1000 * 2 ** job.attempts));
          }
          await this.save(state);
        });
      }
      // Re-read the latest queue under the same lock as dispatch(). Commands
      // arriving during a send are included. Schedule once after the batch;
      // do not arm short wake-ups for a job the current handler is sending.
      await this.locked(async state => {
        this.alarmRunning = false;
        if (!state) return;
        if (state.expiresAt <= Date.now()) { await this.erase(); return; }
        await this.save(state);
      });
    } finally {
      // On failure, let Cloudflare retry the current alarm. Persisted work is
      // recoverable after eviction; this flag is only a scheduling optimization.
      this.alarmRunning = false;
    }
  }
}
