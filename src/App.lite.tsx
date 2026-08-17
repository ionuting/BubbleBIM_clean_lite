import { useState, useEffect } from 'react';
import { BubbleGraphPanel } from './components/bubble-graph/BubbleGraphPanel';
import { Toaster } from './components/ui/toast';
import { FeedbackButton } from './components/FeedbackModal';
import { WelcomeScreen } from './components/WelcomeScreen';
import { buildDefaultProjectNodes, DEFAULT_PROJECT_AXES } from './lib/storeys/defaultProject';

/** localStorage key used by api.lite.ts */
const LS_KEY = 'bubblebim_lite_graph';

export function App() {
  const [visible, setVisible] = useState(true);
  /** null = not yet decided (checking localStorage), true = show welcome, false = show editor */
  const [showWelcome, setShowWelcome] = useState<boolean | null>(null);
  const [exampleLoading, setExampleLoading] = useState(false);

  // Show welcome screen only when there is no saved project in localStorage
  useEffect(() => {
    const saved = localStorage.getItem(LS_KEY);
    setShowWelcome(!saved);
  }, []);

  const handleLoadExample = async () => {
    setExampleLoading(true);
    try {
      const base = import.meta.env.BASE_URL ?? '/';
      const url = base.endsWith('/') ? `${base}example-project.bbim` : `${base}/example-project.bbim`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const file = await res.json();
      // BbimFile → GraphData format expected by api.lite.ts
      const graphData = {
        nodes:           file.model?.nodes           ?? file.nodes           ?? [],
        edges:           file.model?.edges           ?? file.edges           ?? [],
        buildingAxes:    file.model?.buildingAxes    ?? file.buildingAxes    ?? { xValues: [], yValues: [] },
        activeStoreyId:  file.model?.activeStoreyId  ?? file.activeStoreyId  ?? null,
        projectName:     file.projectName            ?? 'My Building',
        worldLocation:   file.model?.worldLocation,
        globeInstances:  file.model?.globeInstances  ?? [],
        composerShapes:  file.model?.composerShapes  ?? [],
      };
      localStorage.setItem(LS_KEY, JSON.stringify(graphData));
    } catch (err) {
      console.warn('Could not load example project:', err);
      // Proceed anyway — panel will start empty
    }
    setExampleLoading(false);
    setShowWelcome(false);
  };

  const handleNewProject = () => {
    // Seed the default storeys (Infrastructure / First / Second / Last floor)
    // so a new project opens ready to model.
    const { nodes, activeStoreyId } = buildDefaultProjectNodes();
    const graphData = {
      nodes, edges: [],
      buildingAxes: DEFAULT_PROJECT_AXES,
      activeStoreyId,
      projectName: 'My Building',
      globeInstances: [],
      composerShapes: [],
    };
    localStorage.setItem(LS_KEY, JSON.stringify(graphData));
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
    <div className="w-screen h-screen">
      {!visible && (
        <div className="flex items-center justify-center h-screen w-screen bg-background">
          <button
            className="px-6 py-3 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition"
            onClick={() => setVisible(true)}
          >
            Open BubbleGraph Editor
          </button>
        </div>
      )}
      {visible && <BubbleGraphPanel visible={visible} onClose={() => setVisible(false)} />}
      <Toaster />
      <FeedbackButton />
    </div>
  );
}

export default App;
