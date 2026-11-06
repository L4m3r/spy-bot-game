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

  private async erase(closedUntil = 0): Promise<void> {
    // Block an already dispatched creation from resurrecting a closed room.
    // Only the deadline is retained; room contents are removed immediately.
    await this.ctx.storage.transaction(async txn => {
      await txn.delete(["room", "closedUntil"]);
      await txn.deleteAlarm();
      if (closedUntil > Date.now()) {
        await txn.put("closedUntil", closedUntil);
        await txn.setAlarm(closedUntil);
      }
    });
  }

  private async save(state: RoomState): Promise<void> {
    await this.ctx.storage.transaction(async txn => {
      await txn.put("room", state);
      if (!this.alarmRunning) {
        const next = Math.min(state.expiresAt, ...state.jobs.map(job => job.nextAt));
        const desired = Math.max(Date.now() + 50, next);
        const current = await txn.getAlarm();
        // Keep an earlier wake-up; the running alarm drains concurrent work.
        if (current === null || desired < current) await txn.setAlarm(desired);
      }
    });
  }

  // Only storage mutations are serialized. Telegram network calls run outside
  // this section, so a slow API request does not block room membership changes.
  private locked<T>(fn: (state: RoomState | undefined) => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(async () => {
      let state = await this.ctx.storage.get<RoomState>("room");
      // Old rooms can contain unindexed memberships in several rooms. Retire
      // them on first access instead of silently carrying that invariant over.
      if (state && state.schemaVersion !== 2) { await this.erase(); state = undefined; }
      return fn(state);
    });
  }

  // Read-only membership checks never extend TTL or recreate missing rooms.
  async membershipStatus(userId: number, membershipId: number): Promise<{ expiresAt: number; owner: boolean } | undefined> {
    return this.locked(async state => {
      if (!state) return undefined;
      if (state.expiresAt <= Date.now()) { await this.erase(); return undefined; }
      if (!state.members.some(player => player.id === userId && player.membershipId === membershipId)) return undefined;
      return { expiresAt: state.expiresAt, owner: state.ownerId === userId };
    });
  }

  async dispatch(command: Command): Promise<Result> {
    return this.locked(async state => {
      const now = Date.now();
      let created = false;
      if (state && state.expiresAt <= now) {
        await this.erase();
        state = undefined;
      }
      if (!state) {
        if (command.action !== "create") return { error: "Комната закрыта или устарела. Создай новую через /game." };
        const closedUntil = await this.ctx.storage.get<number>("closedUntil");
        if (!command.membershipId || !command.validUntil || command.validUntil <= now || (closedUntil ?? 0) > now) {
          return { error: "Комната закрыта или устарела. Создай новую через /game." };
        }
        state = {
          schemaVersion: 2, creationDeadline: command.validUntil,
          code: command.code, username: command.username, ownerId: command.actor.id,
          members: [{ ...command.actor, membershipId: command.membershipId }], membershipFences: {}, expiresAt: now + ROOM_TTL_MS,
          processed: [], lobbyMessages: {}, jobs: [], jobSequence: 0,
        };
        created = true;
      }
      const owner = command.actor.id === state.ownerId;
      const currentMember = state.members.find(player => player.id === command.actor.id);
      const member = currentMember?.membershipId === command.membershipId && command.membershipId !== undefined;
      if (["deal", "retry", "confirm", "close", "create"].includes(command.action) && !owner) {
        return { error: "Это действие доступно только организатору." };
      }
      if (["join", "create"].includes(command.action)) {
        if (member && !created) return {};
        if (!command.membershipId || !command.validUntil || command.validUntil <= now ||
            command.membershipId <= (state.membershipFences[command.actor.id] ?? -1) || (currentMember && !member)) {
          if (command.membershipId !== undefined) {
            state.membershipFences[command.actor.id] = Math.max(state.membershipFences[command.actor.id] ?? -1, command.membershipId);
            await this.save(state);
          }
          return { error: "Это приглашение уже обработано. Открой его заново или отправь /game." };
        }
      } else if (command.action === "leave") {
        if (owner) return { error: "Организатор может закрыть комнату." };
        if (command.membershipId === undefined || (currentMember && !member)) return { error: "Это действие от старого участия в комнате." };
        if (!currentMember && (state.membershipFences[command.actor.id] ?? -1) >= command.membershipId) return {};
        // Fence even a repeated/cancelled departure before looking at processed
        // updates. The bounded cache cannot protect membership transitions.
        state.membershipFences[command.actor.id] = Math.max(state.membershipFences[command.actor.id] ?? -1, command.membershipId);
        state.members = state.members.filter(player => player.id !== command.actor.id);
        state.jobs = state.jobs.filter(job => job.chatId !== command.actor.id);
        delete state.lobbyMessages[command.actor.id];
        enqueueLobbies(state);
        state.expiresAt = now + ROOM_TTL_MS;
        await this.save(state);
        return {};
      } else if (!member) {
        return { error: "Ты не в этой комнате. Подключись по приглашению." };
      }
      if (state.processed.includes(command.updateId)) return {};
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
            if (state.members.length >= MAX_PLAYERS) {
              // Rejection must also be durable: another copy of this RPC may
              // arrive after a seat opens and the user has joined elsewhere.
              state.membershipFences[command.actor.id] = command.membershipId!;
              await this.save(state);
              return { error: `Комната заполнена: максимум ${MAX_PLAYERS} игроков.` };
            }
            state.members.push({ ...command.actor, membershipId: command.membershipId! });
          }
          enqueueLobbies(state);
          break;
        case "refresh":
          enqueue(state, { id: `lobby:${command.actor.id}`, kind: "lobby", chatId: command.actor.id, membershipId: command.membershipId });
          break;
        case "show":
          // Keep this delivery separate from coalesced lobby edits, so a
          // concurrent membership change cannot turn it back into an edit.
          enqueue(state, { id: `show:${command.updateId}`, kind: "lobby", chatId: command.actor.id, newMessage: true, membershipId: command.membershipId });
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
            playerIds: state.members.map(player => player.id),
            membershipIds: Object.fromEntries(state.members.map(player => [player.id, player.membershipId])), delivery: {},
          };
          // Cards are persisted before any Telegram side effect.
          for (const id of state.round.playerIds) enqueueCard(state, id);
          enqueueLobbies(state);
          break;
        }
        case "retry": {
          if (!state.round || cardJobsPending(state)) return { error: "Сейчас нет завершённой раздачи для повтора." };
          const failed = state.round.playerIds.filter(id => state.round!.delivery[id] === "failed" && state.members.some(player => player.id === id && player.membershipId === state.round!.membershipIds[id]));
          if (!failed.length) return { error: "Все карточки уже отправлены." };
          for (const id of failed) enqueueCard(state, id);
          enqueueLobbies(state);
          break;
        }
        case "close":
          await this.erase(state.creationDeadline);
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
          if (!state) {
            const closedUntil = await this.ctx.storage.get<number>("closedUntil");
            if (closedUntil && closedUntil <= Date.now()) await this.erase();
            return undefined;
          }
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
          if (work.job.kind === "lobby" && messageId && state.members.some(player => player.id === work.job.chatId && player.membershipId === work.job.membershipId)) {
            state.lobbyMessages[work.job.chatId] = messageId;
          }
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
