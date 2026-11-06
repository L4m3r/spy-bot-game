import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { ROOM_TTL_MS, type Command, type Result } from "./model";
import { rpcData } from "./rpc";

export const CREATION_WINDOW_MS = 60 * 60 * 1000;
export const MAX_CREATIONS = 10;

interface ActiveRoom {
  code: string;
  expiresAt: number;
  membershipId: number;
  owner: boolean;
  pending?: Command;
  closing?: Command;
  leaving?: Command;
}
interface LimitsState {
  ownerId: number;
  active?: ActiveRoom;
  creations: number[];
  lastUpdateId: number;
  lastRequestAt: number;
  recoveryAttempts?: number;
}

export class UserLimits extends DurableObject<Env> {
  private busy = false;
  private waiters: Array<() => void> = [];

  // Serialize this user's requests across RPCs, but never call back from a
  // room. Persisted phases, rather than this in-memory mutex, survive eviction.
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

  private pending(state: LimitsState): boolean {
    return !!(state.active?.pending || state.active?.closing || state.active?.leaving);
  }

  private async save(state: LimitsState): Promise<void> {
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(state.recoveryAttempts ?? 0, 6));
    const deadline = (this.pending(state) || state.recoveryAttempts) ? Date.now() + delay : state.active?.expiresAt ?? state.lastRequestAt + ROOM_TTL_MS;
    const desired = Math.max(Date.now() + 1000, deadline);
    // The recovery alarm must be committed together with the durable intent.
    await this.ctx.storage.transaction(async txn => {
      await txn.put("limits", state);
      const current = await txn.getAlarm();
      if (current === null || desired < current) await txn.setAlarm(desired);
    });
  }

  private prune(state: LimitsState): void {
    state.creations = state.creations.filter(time => time > Date.now() - CREATION_WINDOW_MS);
  }

  private async status(state: LimitsState) {
    const active = state.active!;
    return rpcData(this.env.ROOMS.getByName(active.code).membershipStatus(state.ownerId, active.membershipId));
  }

  private async recover(state: LimitsState): Promise<void> {
    if (!state.active) return;
    if (state.active.closing || state.active.leaving) {
      await this.finishExit(state);
    } else if (state.active.pending) {
      await this.finishEntry(state);
    } else {
      const status = await this.status(state);
      if (status) Object.assign(state.active, status);
      else state.active = undefined;
      state.recoveryAttempts = 0;
      await this.save(state);
    }
  }

  private async finishEntry(state: LimitsState): Promise<Result> {
    const active = state.active!;
    const command = active.pending!;
    // The RPC may have committed even if its response was lost. Read first;
    // never free a reservation on a transport exception or a cached deadline.
    let status = await this.status(state);
    if (!status && command.validUntil! > Date.now()) {
      const result = await rpcData(this.env.ROOMS.getByName(active.code).dispatch(command));
      if (result.error) {
        state.active = undefined;
        await this.save(state);
        return result;
      }
      status = await this.status(state);
    }
    if (status) {
      state.active = { code: active.code, membershipId: active.membershipId, ...status };
    } else {
      // Entry RPCs carry the original absolute deadline. After it expires,
      // even an in-flight late entry cannot acquire a second membership.
      state.active = undefined;
    }
    state.recoveryAttempts = 0;
    await this.save(state);
    return status ? {} : { error: "Комната закрыта или устарела. Отправь /game или открой другое приглашение." };
  }

  private async finishExit(state: LimitsState): Promise<Result> {
    const active = state.active!;
    const command = active.closing ?? active.leaving!;
    const result = await rpcData(this.env.ROOMS.getByName(active.code).dispatch(command));
    const status = await this.status(state);
    if (!status) state.active = undefined;
    else {
      Object.assign(active, status);
      active.closing = undefined;
      active.leaving = undefined;
    }
    state.recoveryAttempts = 0;
    await this.save(state);
    // A repeated exit after a lost response finds the room/member gone.
    return status ? result : { message: command.action === "close" ? "Комната закрыта. Для новой игры отправь /game." : "Ты вышел из комнаты. Для новой игры отправь /game." };
  }

  async dispatch(command: Command): Promise<Result> {
    return this.serial(async () => {
      const state = await this.ctx.storage.get<LimitsState>("limits") ?? {
        ownerId: command.actor.id, creations: [], lastUpdateId: -1, lastRequestAt: Date.now(),
      };
      if (state.ownerId !== command.actor.id) throw new Error("UserLimits owner mismatch");
      this.prune(state);
      await this.recover(state);
      // Delayed Telegram retries must not join again, leave a newer membership,
      // or recreate a room after the original operation has finished.
      if (command.updateId <= state.lastUpdateId) return {};
      state.lastUpdateId = command.updateId;
      state.lastRequestAt = Date.now();

      const active = state.active;
      if (command.action === "create" || command.action === "join") {
        if (active) {
          if (command.action === "join" && command.code !== active.code) {
            await this.save(state);
            return { error: "Ты уже в другой комнате. /game — показать её, /leave — выйти перед вступлением в новую." };
          }
          // /game is a recovery entry point for hosts AND guests. Always send
          // a fresh lobby instead of relying on an earlier Telegram message.
          const result = await rpcData(this.env.ROOMS.getByName(active.code).dispatch({ ...command, code: active.code, action: "show", membershipId: active.membershipId }));
          await this.save(state);
          return result;
        }
        if (command.action === "create") {
          if (state.creations.length >= MAX_CREATIONS) {
            const minutes = Math.max(1, Math.ceil((state.creations[0] + CREATION_WINDOW_MS - Date.now()) / 60_000));
            await this.save(state);
            return { error: `Можно создать максимум ${MAX_CREATIONS} новых комнат за час. Попробуй через ${minutes} мин.` };
          }
          state.creations.push(Date.now());
        }
        const validUntil = Date.now() + ROOM_TTL_MS;
        state.active = {
          code: command.code, expiresAt: validUntil, owner: command.action === "create", membershipId: command.updateId,
          pending: { ...command, membershipId: command.updateId, validUntil },
        };
        await this.save(state);
        return this.finishEntry(state);
      }

      if (!active || (command.code && command.code !== active.code)) {
        await this.save(state);
        return { error: command.code ? "Ты не в этой комнате. Подключись по приглашению." : "У тебя нет активной комнаты. /game — создать игру." };
      }
      const routed = { ...command, code: active.code, membershipId: active.membershipId };
      if (command.action === "leave" && active.owner) {
        await this.save(state);
        return { message: "Ты организатор. Чтобы выйти, нужно закрыть комнату для всех. Закрыть?", confirmCloseCode: active.code };
      }
      if (command.action === "close" && !active.owner) {
        await this.save(state);
        return { error: "Это действие доступно только организатору." };
      }
      if (command.action === "leave" || command.action === "close") {
        if (command.action === "leave") active.leaving = routed;
        else active.closing = routed;
        await this.save(state);
        return this.finishExit(state);
      }
      // Save the watermark after the room response so a failed normal action
      // can be retried. The room deduplicates its own effects.
      const result = await rpcData(this.env.ROOMS.getByName(active.code).dispatch(routed));
      await this.save(state);
      return result;
    });
  }

  async alarm(): Promise<void> {
    return this.serial(async () => {
      const state = await this.ctx.storage.get<LimitsState>("limits");
      if (!state) return;
      this.prune(state);
      try {
        await this.recover(state);
        state.recoveryAttempts = 0;
      } catch {
        // Built-in alarm retries are bounded. Keep durable work and schedule
        // another attempt ourselves, including during a longer room outage.
        state.recoveryAttempts = (state.recoveryAttempts ?? 0) + 1;
        console.error("Room membership recovery deferred.");
        await this.save(state);
        return;
      }
      if (!state.active && !state.creations.length && state.lastRequestAt + ROOM_TTL_MS <= Date.now()) {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
      } else await this.save(state);
    });
  }
}
