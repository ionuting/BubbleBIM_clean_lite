/**
 * Agent skills catalog — indexed by Codegraph for discovery via symbol search.
 *
 * Canonical skill bodies live in `.cursor/skills/<name>/SKILL.md`.
 * Cursor loads those automatically; this registry helps codegraph_explore
 * and grep find the right workflow without reading all markdown.
 */

export interface AgentSkillEntry {
  /** Skill folder name (matches SKILL.md frontmatter `name`) */
  id: string;
  /** Relative path from repo root */
  skillPath: string;
  /** When to invoke — keywords for humans and agents */
  triggers: string[];
  /** One-line summary */
  summary: string;
}

/** Minimum package + extended skills for BubbleBIM-Standalone */
export const AGENT_SKILLS: readonly AgentSkillEntry[] = [
  {
    id: 'bubblebim-deploy',
    skillPath: '.cursor/skills/bubblebim-deploy/SKILL.md',
    triggers: ['deploy', 'cloud', 'hetzner', 'redeploy', 'production', 'docker', 'bbim.ciuntucbimstudio.ro'],
    summary: 'Build clean-lite, rsync to Hetzner, docker compose, post-deploy checks, cloud admin users',
  },
  {
    id: 'bubblebim-coordinates',
    skillPath: '.cursor/skills/bubblebim-coordinates/SKILL.md',
    triggers: ['ax', 'axesX', 'axesY', 'mm', 'getAxRealPos', 'footprint', 'wall join', 'elevation', 'Three.js mapping'],
    summary: 'BIM coordinate contract — mm, ax grid, storey bands, scene mapping; read before geometry edits',
  },
  {
    id: 'bubblebim-build-variants',
    skillPath: '.cursor/skills/bubblebim-build-variants/SKILL.md',
    triggers: ['build', 'dev:clean', 'vite', 'clean lite', 'api.cloud', 'stub', 'AppProfile'],
    summary: 'Full vs clean vs lite vs minimal — which command, API alias, and 3D engine to touch',
  },
  {
    id: 'bubblebim-node-library',
    skillPath: '.cursor/skills/bubblebim-node-library/SKILL.md',
    triggers: ['nodeLibrary.json', 'new node type', 'PropertiesPanel', 'smartKeys', 'wall_layers', 'covering_layers'],
    summary: 'Add/change graph node types — defaults, inspector, ogBimMapper, layer presets',
  },
  {
    id: 'bubblebim-roof',
    skillPath: '.cursor/skills/bubblebim-roof/SKILL.md',
    triggers: ['roof', 'framing', 'rafter', 'hip', 'dormer', 'skylight', 'generate_level', 'solveRoof'],
    summary: 'Parametric roof solver, framing timber, envelope, UX generate complete roof',
  },
  {
    id: 'bubblebim-window-door',
    skillPath: '.cursor/skills/bubblebim-window-door/SKILL.md',
    triggers: ['window_type', 'door_type', 'elementLibrary', 'library.yaml', 'IFC opening'],
    summary: 'Dual catalog sync — elementLibrary.ts + backend/library YAML + assets',
  },
  {
    id: 'bubblebim-support-auth',
    skillPath: '.cursor/skills/bubblebim-support-auth/SKILL.md',
    triggers: ['auth', 'JWT', 'admin', 'support', 'users', 'login', 'ProjectHub'],
    summary: 'Cloud auth, admin users, support messaging, api.cloud.ts',
  },
] as const;

export function findAgentSkill(query: string): AgentSkillEntry | undefined {
  const q = query.toLowerCase();
  return AGENT_SKILLS.find(
    (s) =>
      s.id.includes(q) ||
      s.summary.toLowerCase().includes(q) ||
      s.triggers.some((t) => t.toLowerCase().includes(q) || q.includes(t.toLowerCase())),
  );
}

/** Primary 3D path for Clean / cloud production */
export const CLEAN_3D_PIPELINE = {
  viewer: 'src/components/views/OpenGeoViewer.tsx',
  mapper: 'src/lib/ogBimMapper.ts',
  geometry: 'src/lib/bimGeometry.ts',
} as const;

/** Production deploy entrypoint */
export const CLOUD_DEPLOY = {
  script: 'deploy/deploy.sh',
  output: 'dist-clean-lite',
  url: 'https://bbim.ciuntucbimstudio.ro',
} as const;
