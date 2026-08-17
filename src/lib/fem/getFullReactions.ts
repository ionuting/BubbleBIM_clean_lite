/**
 * getFullReactions.ts — reactions computed the textbook way: R = K·U − F at
 * every restrained DOF, using the SAME global stiffness assembly
 * `@awatif/components`'s own solver uses.
 *
 * Why not just call `@awatif/components`'s own `getReactions`? It rebuilds
 * nodal forces by summing each element's `internalForces` entry — and
 * `getPositionsAndForces` explicitly skips populating that map for 3-node
 * shell elements (its own comment: "Internal forces are frame-only; shell
 * (3-node) elements get no entry"). A model with walls/slabs would silently
 * under-report reactions at every support a shell — not a frame member —
 * connects to (verified empirically: a wall+slab box under self-weight came
 * back ~55% short of vertical equilibrium through their `getReactions`).
 *
 * This re-solves for the full 6-DOF-per-node displacement vector (not just
 * the translation triple `getPositionsAndForces` returns) and reads
 * reactions straight off the stiffness matrix, so it's correct for any
 * element mix. It duplicates that function's ~10-line free-DOF solve — an
 * accepted redundancy for a dev/spike tool, not worth forking the package
 * over.
 */

import { index, subset, sparse, lup, lusolve, flatten } from 'mathjs';
import { getGlobalStiffnessMatrix } from '@awatif/components/analysis/l-solver/helpers/getGlobalStiffnessMatrix';
import type { FemNodes, FemElements, FemElementPropsMap, FemSupports, FemLoads } from './buildFemModel';

export type FemReactions = Map<number, [number, number, number, number, number, number]>;

export function getFullReactions(
  nodes: FemNodes,
  elements: FemElements,
  elementsProps: FemElementPropsMap,
  supports: FemSupports,
  loads: FemLoads,
): FemReactions {
  const dof = nodes.length * 6;
  const K = getGlobalStiffnessMatrix(nodes, elements, elementsProps, dof);

  const restrainedInd = new Set<number>();
  supports.forEach((support, nodeIdx) => {
    support.forEach((fixed, d) => { if (fixed) restrainedInd.add(nodeIdx * 6 + d); });
  });
  const freeInd = Array.from({ length: dof }, (_, i) => i).filter((i) => !restrainedInd.has(i));

  const appliedForces = new Array(dof).fill(0);
  loads.forEach((l, nodeIdx) => { for (let d = 0; d < 6; d++) appliedForces[nodeIdx * 6 + d] = l[d]; });

  const forcesFree = subset(appliedForces, index(freeInd));
  const stiffnessesFree = subset(K, index(freeInd, freeInd));
  const lu = lup(sparse(stiffnessesFree));
  const deformationFree = lusolve(lu, forcesFree);
  const U = subset(Array(dof).fill(0), index(freeInd), flatten(deformationFree)) as number[];

  const reactions: FemReactions = new Map();
  supports.forEach((support, nodeIdx) => {
    const r: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
    for (let d = 0; d < 6; d++) {
      if (!support[d]) continue;
      const row = nodeIdx * 6 + d;
      let ku = 0;
      for (let j = 0; j < dof; j++) ku += K[row][j] * U[j];
      r[d] = ku - appliedForces[row];
    }
    reactions.set(nodeIdx, r);
  });
  return reactions;
}
