import { useState } from 'react';
import { BubbleGraphPanel } from './components/bubble-graph/BubbleGraphPanel';
import { Toaster } from './components/ui/toast';

export function App() {
  const [visible, setVisible] = useState(true);

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
    </div>
  );
}

export default App;
