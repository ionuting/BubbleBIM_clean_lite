/**
 * gameStore — the state layer the gamification roadmap calls "Phase 0".
 *
 * Deliberately small: a master `playful` toggle every game surface must
 * respect (off = no HUDs, no pulses, nothing), which questline the HUD shows,
 * and a bounded log of milestone events so later phases (XP, badges) have a
 * history to read instead of inventing their own. Persisted in localStorage,
 * per browser, like QuestPanel's collapse state — it is about the person, not
 * the project, so it does not belong in `.bbim`.
 */
import { create } from 'zustand';

export type QuestlineId = 'first_building' | 'economist';

export interface GameEvent {
  /** e.g. `quest.first_building.roof`, `scenario.created`, `budget.met` */
  kind: string;
  at: string;
}

interface GameStore {
  playful: boolean;
  questline: QuestlineId;
  events: GameEvent[];
  setPlayful: (on: boolean) => void;
  setQuestline: (q: QuestlineId) => void;
  /** Record a milestone once — the same kind is never logged twice. */
  record: (kind: string) => void;
}

const KEY = 'bb.game.v1';
const MAX_EVENTS = 200;

function load(): Pick<GameStore, 'playful' | 'questline' | 'events'> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (raw) {
      const p = JSON.parse(raw) as Partial<GameStore>;
      return {
        playful: p.playful !== false,
        questline: p.questline === 'economist' ? 'economist' : 'first_building',
        events: Array.isArray(p.events) ? p.events.slice(-MAX_EVENTS) : [],
      };
    }
  } catch { /* a private window or blocked storage just means defaults */ }
  return { playful: true, questline: 'first_building', events: [] };
}

function save(s: Pick<GameStore, 'playful' | 'questline' | 'events'>): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}

export const useGame = create<GameStore>()((set, get) => ({
  ...load(),
  setPlayful: (on) => {
    set({ playful: on });
    save(get());
  },
  setQuestline: (q) => {
    set({ questline: q });
    save(get());
  },
  record: (kind) => {
    if (get().events.some((e) => e.kind === kind)) return;
    set((s) => ({ events: [...s.events, { kind, at: new Date().toISOString() }].slice(-MAX_EVENTS) }));
    save(get());
  },
}));
