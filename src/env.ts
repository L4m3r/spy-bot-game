import type { GameRoom } from "./room";
import type { UserLimits } from "./user-limits";

export interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ROOMS: DurableObjectNamespace<GameRoom>;
  USER_LIMITS: DurableObjectNamespace<UserLimits>;
}
