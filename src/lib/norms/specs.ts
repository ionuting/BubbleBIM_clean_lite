/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * specs.ts — SPECIFICAȚIILE: deciziile de material și de finisaj pe care un
 * scenariu le poate roti, independent de sistemul structural.
 *
 * DE CE ÎNCĂ O DIMENSIUNE
 * -----------------------
 * Sistemul structural spune CUM se construiește peretele: zidărie, montanți,
 * panou. Nu spune din CE cărămidă, cu ce tencuială sau cu ce termoizolație —
 * iar tocmai astea sunt deciziile pe care un simulator de cost trebuie să le
 * poată compara. Sunt ortogonale: o casă din zidărie confinată poate avea
 * BCA sau Porotherm, vată sau polistiren, în orice combinație.
 *
 * CUM SE ADAUGĂ FĂRĂ SĂ RUPĂ NIMIC
 * ---------------------------------
 * Opțiunea IMPLICITĂ a unui grup nu are reguli proprii: ea E maparea care
 * există deja. Grupul doar declară ce articole produce implicitul
 * (`defaultArticles`). Când e aleasă altă opțiune se întâmplă două lucruri:
 *
 *   1. articolele implicitului sunt SCOASE din deviz (`suppressedArticles`);
 *   2. mapările care poartă `spec = grup:opțiune` devin candidate
 *      (`findMappingRules`).
 *
 * Aşa o alternativă se adaugă scriind rânduri noi în Markdown, fără să atingi
 * niciun rând existent — și fără să miște amprenta regulilor de ancoră.
 *
 * REZOLVARE
 * ---------
 * Ca la sistemul structural, cea mai specifică alegere câștigă:
 *
 *     node.properties.spec_<grup>   →  cel mai specific
 *     alegerea proiectului/scenariului
 *     opțiunea implicită a grupului →  implicit
 *
 * Pur: fără store, fără React.
 */
import type { BubbleGraphNode } from '@/store';
import type { LibrarySpecGroup } from './library/types';
import { getActiveCatalog } from './catalog';

/** Alegerile în vigoare: id de grup → id de opțiune. */
export type SpecSelection = Record<string, string>;

/** Prefixul proprietății de nod care suprascrie alegerea de proiect. */
export const SPEC_PROPERTY_PREFIX = 'spec_';

export const specPropertyKey = (groupId: string): string => `${SPEC_PROPERTY_PREFIX}${groupId}`;

/** Grupurile declarate de catalogul activ. */
export function specGroups(): LibrarySpecGroup[] {
  return getActiveCatalog().specGroups ?? [];
}

export function specGroup(groupId: string): LibrarySpecGroup | undefined {
  return specGroups().find((g) => g.id === groupId);
}

/** Grupurile care se pot suprascrie pe un tip de nod. */
export function specGroupsFor(nodeType: string): LibrarySpecGroup[] {
  return specGroups().filter((g) => g.appliesTo.includes(nodeType));
}

/** Eticheta unei opțiuni, sau id-ul ei dacă grupul nu o declară. */
export function specOptionLabel(groupId: string, optionId: string): string {
  return specGroup(groupId)?.options.find((o) => o.id === optionId)?.label ?? optionId;
}

/**
 * Normalizează o selecție venită din afară (fișier salvat, scenariu importat):
 * păstrează doar grupurile care există și opțiunile pe care le declară. Un id
 * necunoscut e IGNORAT, nu propagat — la fel ca la sistemul structural, o
 * greșeală de tastare nu are voie să inventeze o a șaptea opțiune.
 */
export function parseSpecSelection(value: unknown): SpecSelection {
  if (!value || typeof value !== 'object') return {};
  const out: SpecSelection = {};
  for (const g of specGroups()) {
    const raw = (value as Record<string, unknown>)[g.id];
    if (typeof raw !== 'string') continue;
    if (g.options.some((o) => o.id === raw)) out[g.id] = raw;
  }
  return out;
}

/** Selecția completă: implicitul fiecărui grup, cu alegerile de proiect peste. */
export function defaultSpecSelection(): SpecSelection {
  const out: SpecSelection = {};
  for (const g of specGroups()) out[g.id] = g.defaultOption;
  return out;
}

/**
 * Alegerile în vigoare pentru UN element: implicitul grupului, alegerea de
 * proiect peste el, iar peste toate proprietatea proprie a nodului.
 *
 * Doar grupurile aplicabile tipului nodului sunt luate în seamă, deci o cameră
 * nu „moștenește" alegerea de cărămidă și nu produce zidărie din senin.
 */
export function resolveSpecs(
  node: BubbleGraphNode | undefined,
  projectSpecs: SpecSelection | undefined,
): SpecSelection {
  const out: SpecSelection = {};
  const groups = node ? specGroupsFor(node.type) : specGroups();
  for (const g of groups) {
    const own = node?.properties?.[specPropertyKey(g.id)];
    const chosen = typeof own === 'string' && g.options.some((o) => o.id === own)
      ? own
      : projectSpecs?.[g.id];
    out[g.id] = chosen && g.options.some((o) => o.id === chosen) ? chosen : g.defaultOption;
  }
  return out;
}

/**
 * Articolele care NU trebuie să mai apară, fiindcă grupul lor a plecat de la
 * opțiunea implicită. Gol când totul e pe implicit, deci un proiect care n-a
 * ales nimic se decontează exact ca înainte de existența specificațiilor.
 */
export function suppressedArticles(specs: SpecSelection | undefined): Set<string> {
  const out = new Set<string>();
  if (!specs) return out;
  for (const g of specGroups()) {
    const chosen = specs[g.id];
    if (!chosen || chosen === g.defaultOption) continue;
    for (const a of g.defaultArticles) out.add(a);
  }
  return out;
}

/**
 * Materialul pe care îl pune în operă o selecție — cheia pe care o citește
 * configurația de materiale ca să deseneze.
 *
 * Ăsta e podul dintre DEVIZ și REPREZENTARE: o bandă de înălțime care alege
 * `faianta:standard` trebuie să arate a faianță în 3D fără ca utilizatorul să
 * mai seteze materialul a doua oară, de mână, riscând să nu fie de acord cu ce
 * se decontează.
 *
 * Se citesc DOAR alegerile explicite primite, niciodată implicitele grupurilor:
 * altfel fiecare cameră din fiecare proiect ar căpăta dintr-odată culoarea
 * tencuielii, iar o funcție de aspect n-are voie să repicteze modele existente.
 * Când mai multe opțiuni declară un material, câștigă prima în ordinea în care
 * grupurile sunt scrise în librărie.
 */
export function specMaterial(specs: SpecSelection | undefined): string | undefined {
  if (!specs) return undefined;
  for (const g of specGroups()) {
    const chosen = specs[g.id];
    if (!chosen) continue;
    const mat = g.options.find((o) => o.id === chosen)?.material;
    if (mat) return mat;
  }
  return undefined;
}

/** True când selecția e alta decât implicitul pe cel puțin un grup. */
export function hasNonDefaultSpec(specs: SpecSelection | undefined): boolean {
  if (!specs) return false;
  return specGroups().some((g) => specs[g.id] && specs[g.id] !== g.defaultOption);
}

/** Doar alegerile care se abat de la implicit — ce merită salvat sau afișat. */
export function nonDefaultSpecs(specs: SpecSelection | undefined): SpecSelection {
  const out: SpecSelection = {};
  if (!specs) return out;
  for (const g of specGroups()) {
    if (specs[g.id] && specs[g.id] !== g.defaultOption) out[g.id] = specs[g.id];
  }
  return out;
}
