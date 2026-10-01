/**
 * capabilities.ts — what each edition of the app offers, in one table.
 *
 * Every edition draws the same shell: HUD, navigator, context ribbon,
 * inspector, status bar. An edition does not get a layout of its own, it
 * gets a set of modules; the shell shows a module's entry points only when
 * the edition has it. So a button lives in the same place everywhere, and a
 * module missing from an edition is simply absent, never moved.
 */
export type AppProfile = 'full' | 'minimal' | 'clean';

export interface ShellCapabilities {
  /** UI language of the shell chrome. */
  lang: 'ro' | 'en';
  /** Several 3D engines (IFC Tiles, That Open, B-rep) besides OpenGeometry. */
  engines: boolean;
  /** Plans, sections, elevations, sheets. */
  drawings: boolean;
  /** Quantities, costs, scenarios, dashboard, calculation memo. */
  quantities: boolean;
  /** Structural FEM models. */
  fem: boolean;
  /** Topology analysis, OG 2D views, IFC plan, composer, tables — the lab. */
  lab: boolean;
  /** Site: terrain modeller and world view. */
  site: boolean;
  /** AI chat over the graph. */
  chat: boolean;
  /** Board-game import, symbol configuration. */
  extras: boolean;
  /** Project-level structural system and material specs. */
  projectSpecs: boolean;
}

const ALL: ShellCapabilities = {
  lang: 'ro', engines: true, drawings: true, quantities: true, fem: true, lab: true,
  site: true, chat: true, extras: true, projectSpecs: true,
};

export function capabilitiesFor(profile: AppProfile): ShellCapabilities {
  if (profile === 'minimal') {
    return {
      ...ALL, engines: false, drawings: false, quantities: false, fem: false, lab: false,
      site: false, chat: false, extras: false, projectSpecs: false,
    };
  }
  if (profile === 'clean') {
    return { ...ALL, lang: 'en', engines: false, quantities: false, lab: false, chat: false, extras: false };
  }
  return ALL;
}
