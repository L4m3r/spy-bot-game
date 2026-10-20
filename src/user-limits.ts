import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { ROOM_TTL_MS, type Command, type Result } from "./model";
import { rpcData } from "./rpc";

export const CREATION_WINDOW_MS = 60 * 60 * 1000;
export const MAX_CREATIONS = 10;

interface ActiveRoom {
  code: string;
  expiresAt: number;
  // Persist before calling GameRoom: an interrupted RPC can be resumed.
  pending?: Command;
  closing?: Command;
}

interface LimitsState {
  ownerId: number;
  active?: ActiveRoom;
  creations: number[];
  lastUpdateId: number;
  lastRequestAt: number;
}

interface OpenResult { code?: string; reused?: boolean; error?: string }

export class UserLimits extends DurableObject<Env> {
  private busy = false;
  private waiters: Array<() => void> = [];

  // Serialize this user's operations, including room RPCs. No room calls back
  // into UserLimits, so there is no cycle. Avoid a 30s blockConcurrencyWhile
  // section across network calls; the durable reservation handles restarts.
  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) await new Promise<void>(resolve => { this.waiters.push(resolve); });
    else this.busy = true;
    try { return await fn(); }
    finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.busy = false;
    }
  }

  private async save(state: LimitsState): Promise<void> {
    await this.ctx.storage.put("limits", state);
    const deadline = state.active?.expiresAt ?? state.lastRequestAt + ROOM_TTL_MS;
    const desired = Math.max(Date.now() + 1000, deadline);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || desired < current) await this.ctx.storage.setAlarm(desired);
  }

  private prune(state: LimitsState): void {
    state.creations = state.creations.filter(time => time > Date.now() - CREATION_WINDOW_MS);
  }

  async open(command: Command): Promise<OpenResult> {
    return this.serial(async () => {
      const now = Date.now();
      const state = await this.ctx.storage.get<LimitsState>("limits") ?? {
        ownerId: command.actor.id, creations: [], lastUpdateId: -1, lastRequestAt: now,
      };
      if (state.ownerId !== command.actor.id) throw new Error("UserLimits owner mismatch");
      this.prune(state);

      if (state.active?.closing) await this.finishClose(state, state.active.closing);

      if (state.active) {
        const active = state.active;
        const room = this.env.ROOMS.getByName(active.code);
        // Atomically check existence and refresh the lobby, without creating
        // missing rooms. An expired/deleted reference is safe to discard.
        const expiresAt = await rpcData(room.resume({ ...command, code: active.code }));
        if (expiresAt) {
          const reused = active.pending?.updateId !== command.updateId;
          state.active = { code: active.code, expiresAt };
          state.lastUpdateId = Math.max(state.lastUpdateId, command.updateId);
          state.lastRequestAt = now;
          await this.save(state);
          return { code: active.code, reused };
        }
        // A pending creation may have failed before reaching GameRoom. Retry
        // its original command, even when the next /game has a new update_id.
        if (active.pending && active.expiresAt > now) {
          return this.finishCreation(state, active.pending, command);
        }
        state.active = undefined;
      }

      // Telegram update_id increases. Keep a high-water mark for 24h after
      // use so a delayed retry cannot resurrect an already closed game.
      if (command.updateId <= state.lastUpdateId) {
        await this.save(state);
        return { error: "Комната этой команды уже закрыта. Для новой игры отправь /game ещё раз." };
      }
      state.lastUpdateId = command.updateId;
      state.lastRequestAt = now;
      if (state.creations.length >= MAX_CREATIONS) {
        const minutes = Math.max(1, Math.ceil((state.creations[0] + CREATION_WINDOW_MS - now) / 60_000));
        await this.save(state);
        return { error: `Можно создать максимум ${MAX_CREATIONS} новых комнат за час. Попробуй через ${minutes} мин.` };
      }

      state.creations.push(now);
      state.active = { code: command.code, expiresAt: now + ROOM_TTL_MS, pending: structuredClone(command) };
      await this.save(state);
      return this.finishCreation(state, command, command);
    });
  }

  private async finishCreation(state: LimitsState, original: Command, request: Command): Promise<OpenResult> {
    const room = this.env.ROOMS.getByName(original.code);
    const { error } = await rpcData(room.dispatch({ ...original, action: "create" }));
    if (error) {
      state.active = undefined;
      await this.save(state);
      return { error };
    }
    const expiresAt = await rpcData(room.activeUntil(original.actor.id));
    // closeRoom() is serialized here; a new room cannot naturally expire before
    // this reservation's 24h deadline. Do not replay creation after it expires.
    state.active = expiresAt ? { code: original.code, expiresAt } : undefined;
    state.lastUpdateId = Math.max(state.lastUpdateId, request.updateId);
    state.lastRequestAt = Date.now();
    await this.save(state);
    return expiresAt
      ? { code: original.code, reused: original.updateId !== request.updateId }
      : { error: "Комната уже закрыта. Отправь /game ещё раз." };
  }

  async closeRoom(command: Command): Promise<Result> {
    return this.serial(async () => {
      const state = await this.ctx.storage.get<LimitsState>("limits");
      if (state?.active?.code === command.code) {
        // Persist intent before RPC: if its response is lost, /game must
        // finish closing rather than replaying an earlier pending creation.
        state.active.closing = structuredClone(command);
        state.lastUpdateId = Math.max(state.lastUpdateId, command.updateId);
        state.lastRequestAt = Date.now();
        await this.save(state);
      }
      return this.finishClose(state, command);
    });
  }

  private async finishClose(state: LimitsState | undefined, command: Command): Promise<Result> {
    const result = await rpcData(this.env.ROOMS.getByName(command.code).dispatch({ ...command, action: "close" }));
    if (state?.active?.code === command.code) {
      if (!await rpcData(this.env.ROOMS.getByName(command.code).activeUntil(command.actor.id))) {
        state.active = undefined;
      } else {
        state.active.closing = undefined;
      }
      this.prune(state);
      await this.save(state);
    }
    return result;
  }

  async alarm(): Promise<void> {
    return this.serial(async () => {
      const state = await this.ctx.storage.get<LimitsState>("limits");
      if (!state) return;
      this.prune(state);
      if (state.active?.closing) await this.finishClose(state, state.active.closing);
      if (state.active) {
        const expiresAt = await rpcData(this.env.ROOMS.getByName(state.active.code).activeUntil(state.ownerId));
        if (expiresAt) state.active = { code: state.active.code, expiresAt };
        else if (!state.active.pending || state.active.expiresAt <= Date.now()) state.active = undefined;
      }
      if (!state.active && !state.creations.length && state.lastRequestAt + ROOM_TTL_MS <= Date.now()) {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
      } else {
        await this.save(state);
      }
    });
  }
}
