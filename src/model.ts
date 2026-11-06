export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 12;
export const LOCATIONS = [
  "Больница", "Школа", "Аэропорт", "Ресторан", "Отель", "Банк",
  "Космическая станция", "Подводная лодка", "Пиратский корабль",
  "Цирк", "Театр", "Киностудия", "Музей", "Зоопарк", "Пляж",
  "Горнолыжный курорт", "Полицейский участок", "Пожарная станция",
  "Супермаркет", "Поезд", "Университет", "Библиотека", "Ферма", "Завод",
] as const;

export interface Player { id: number; name: string }
export interface Member extends Player { membershipId: number }
export interface Round {
  number: number;
  location: string;
  spyId: number;
  playerIds: number[];
  membershipIds: Record<string, number>;
  delivery: Record<string, "pending" | "sent" | "failed">;
}
export interface Job {
  id: string;
  version: number;
  kind: "lobby" | "card" | "notice";
  chatId: number;
  membershipId?: number;
  newMessage?: boolean;
  roundNumber?: number;
  text?: string;
  attempts: number;
  nextAt: number;
}
export interface RoomState {
  schemaVersion: 2;
  creationDeadline: number;
  code: string;
  username: string;
  ownerId: number;
  members: Member[];
  // Completed or rejected entries are fenced until room expiry, independently
  // of the bounded update cache. Delayed RPCs cannot undo these decisions.
  membershipFences: Record<string, number>;
  expiresAt: number;
  round?: Round;
  processed: number[];
  lobbyMessages: Record<string, number>;
  jobs: Job[];
  jobSequence: number;
}
export type Action = "create" | "join" | "refresh" | "show" | "leave" | "deal" | "retry" | "confirm" | "close";
export interface Command {
  action: Action;
  code: string;
  actor: Player;
  updateId: number;
  username: string;
  expectedRound?: number;
  membershipId?: number;
  validUntil?: number;
}
export interface Result { error?: string; message?: string; confirmCloseCode?: string }

// Rejection sampling avoids modulo bias when choosing the spy and location.
export function randomIndex(length: number): number {
  const limit = Math.floor(0x100000000 / length) * length;
  const value = new Uint32Array(1);
  do { crypto.getRandomValues(value); } while (value[0] >= limit);
  return value[0] % length;
}

export function enqueue(state: RoomState, job: Omit<Job, "version" | "attempts" | "nextAt">): void {
  state.jobs = state.jobs.filter(existing => existing.id !== job.id);
  state.jobs.push({ ...job, version: ++state.jobSequence, attempts: 0, nextAt: Date.now() });
}

export function enqueueLobbies(state: RoomState): void {
  for (const player of state.members) {
    enqueue(state, { id: `lobby:${player.id}`, kind: "lobby", chatId: player.id, membershipId: player.membershipId });
  }
}

export function enqueueCard(state: RoomState, id: number): void {
  const round = state.round!;
  if (!state.members.some(player => player.id === id && player.membershipId === round.membershipIds[id])) return;
  round.delivery[id] = "pending";
  enqueue(state, {
    id: `card:${round.number}:${id}`, kind: "card", chatId: id, roundNumber: round.number, membershipId: round.membershipIds[id],
    text: id === round.spyId
      ? `Раунд ${round.number}\n\n🕵️ Ты — шпион.\nВыясни, где находятся остальные.\n\nОбсуждение и обвинения — голосом.`
      : `Раунд ${round.number}\n\n📍 Локация: ${round.location}\nТы не шпион.\n\nНайди шпиона, не выдав локацию слишком явно.`,
  });
}

export function cardJobsPending(state: RoomState): boolean {
  return state.jobs.some(job => job.kind === "card");
}
