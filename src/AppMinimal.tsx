/**
 * AppMinimal — BubbleGraph + OpenGeometry 3D only.
 *
 * Same layout as the full app (top bar, sidebar, canvas, properties panel)
 * but with only Storeys and 3D Models in the sidebar.
 * The 3D Models section opens an OpenGeometry tab directly — no engine selector.
 *
 * Data persisted to localStorage via api.lite (no FastAPI backend required).
 *
 * On first visit (empty localStorage) a WelcomeScreen is shown so the user
 * can either open the bundled "My Building" example or start from scratch.
 */

import { useState, useEffect } from 'react';
import { BubbleGraphPanel } from '@/components/bubble-graph/BubbleGraphPanel';
import { WelcomeScreen } from '@/components/WelcomeScreen';
import { Toaster } from '@/components/ui/toast';
import { LibraryEditorLauncher } from '@/components/norms/LibraryEditorLauncher';
import { buildDefaultProjectNodes, DEFAULT_PROJECT_AXES } from '@/lib/storeys/defaultProject';

/** localStorage key used by api.lite.ts */
const LS_KEY = 'bubblebim_lite_graph';

export function AppMinimal() {
  /** null = still checking localStorage (avoids flicker), true/false = decision made */
  const [showWelcome, setShowWelcome] = useState<boolean | null>(null);
  const [exampleLoading, setExampleLoading] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(LS_KEY);
    setShowWelcome(!saved);
  }, []);

  const handleLoadExample = async () => {
    setExampleLoading(true);
    try {
      const base = import.meta.env.BASE_URL ?? './';
      const url = base.replace(/\/?$/, '/') + 'example-project.bbim';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const file = await res.json();
      // BbimFile → GraphData format expected by api.lite.ts
      const graphData = {
        nodes:          file.model?.nodes          ?? file.nodes          ?? [],
        edges:          file.model?.edges          ?? file.edges          ?? [],
        buildingAxes:   file.model?.buildingAxes   ?? file.buildingAxes   ?? { xValues: [], yValues: [] },
        activeStoreyId: file.model?.activeStoreyId ?? file.activeStoreyId ?? null,
        projectName:    file.projectName           ?? 'My Building',
        worldLocation:  file.model?.worldLocation,
        globeInstances: file.model?.globeInstances ?? [],
        composerShapes: file.model?.composerShapes ?? [],
      };
      localStorage.setItem(LS_KEY, JSON.stringify(graphData));
    } catch (err) {
      console.warn('Could not load example project:', err);
    }
    setExampleLoading(false);
    setShowWelcome(false);
  };

  const handleNewProject = () => {
    const { nodes, activeStoreyId } = buildDefaultProjectNodes();
    localStorage.setItem(LS_KEY, JSON.stringify({
      nodes, edges: [],
      buildingAxes: DEFAULT_PROJECT_AXES,
      activeStoreyId,
      projectName: 'My Building',
      globeInstances: [], composerShapes: [],
    }));
    setShowWelcome(false);
  };

  // Still checking localStorage — render nothing to avoid flicker
  if (showWelcome === null) return null;

  if (showWelcome) {
    return (
      <>
        <WelcomeScreen
          onLoadExample={handleLoadExample}
          onNewProject={handleNewProject}
          loading={exampleLoading}
        />
        <Toaster />
      </>
    );
  }

  return (
    <div className="w-screen h-screen overflow-hidden">
      <BubbleGraphPanel visible={true} onClose={() => {}} appProfile="minimal" />
      <LibraryEditorLauncher />
    </div>
  );
}

export default AppMinimal;


