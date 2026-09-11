/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * anchorReattachments.ts — the mappings that moved to a different node ON
 * PURPOSE, since the migration anchor was frozen.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The anchor tests (`catalogCompiled.fidelity.test.ts`,
 * `library/migration.test.ts`) assert that every rule the original hardcoded
 * catalogue had still exists, unchanged, in the compiled library. That is what
 * catches an ACCIDENTAL loss — a renamed column quietly emptying the deviz.
 *
 * But a mapping can also be wrong and need moving, and then the anchor has to
 * be told, in one place a reader will find, rather than the test being loosened
 * until it stops catching anything. Each entry below is checked in BOTH
 * directions: the old attachment may be gone, and the article MUST exist at its
 * new home. A typo in the move therefore still fails the build.
 *
 * Prices and articles are NOT re-attachable — those anchors stay absolute.
 */

export interface AnchorReattachment {
  /** Where the anchor had it: `nodeType/elementTypeId`. */
  from: string;
  normId: string;
  /** Where it lives now, same shape. */
  to: string;
  /** Why it moved — the reason a future reader needs, not the mechanics. */
  reason: string;
}

export const ANCHOR_REATTACHMENTS: readonly AnchorReattachment[] = [
  // 2026-09-09. The façade was measured on every ROOM as perimeter × height,
  // so interior rooms produced exterior envelope: six rooms of a 140 m² house
  // yielded 307 m² of insulation, render and exterior paint. The envelope is
  // the `shell` contour, and now it is measured there — once, on the outline
  // the building actually has. Interior plaster and interior paint stay on the
  // rooms, where perimeter × height is the right reading.
  {
    from: 'room/*', normId: '0012_00107A011_02', to: 'shell/envelope',
    reason: 'termoizolația de fațadă se ia pe conturul clădirii, nu pe fiecare cameră',
  },
  {
    from: 'room/*', normId: '0011_CF06B1_82', to: 'shell/envelope',
    reason: 'tencuiala exterioară se ia pe conturul clădirii, nu pe fiecare cameră',
  },
  {
    from: 'room/*', normId: '0013_CN11A_02', to: 'shell/envelope',
    reason: 'vopsitoria exterioară se ia pe conturul clădirii, nu pe fiecare cameră',
  },
];

/** normIds re-attached away from a given `nodeType/elementTypeId`. */
export function reattachedFrom(ruleKey: string): Set<string> {
  return new Set(ANCHOR_REATTACHMENTS.filter((r) => r.from === ruleKey).map((r) => r.normId));
}
