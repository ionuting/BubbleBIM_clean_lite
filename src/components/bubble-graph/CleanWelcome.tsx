/**
 * CleanWelcome — brand-first entry for BubbleBIM Clean Lite.
 */
interface CleanWelcomeProps {
  onLoadExample: () => void;
  onNewProject: () => void;
  loading?: boolean;
}

const STEPS = [
  { title: 'Axes', desc: 'Define the structural grid' },
  { title: 'Storeys', desc: 'Add floors, then open a plan' },
  { title: 'Model', desc: 'Place elements; verify in 3D' },
];

export function CleanWelcome({ onLoadExample, onNewProject, loading = false }: CleanWelcomeProps) {
  return (
    <div className="bb-welcome ac-shell dark">
      <h1 className="bb-welcome-brand">BubbleBIM</h1>
      <p className="bb-welcome-headline">Parametric BIM — plan first, relations intact</p>
      <p className="bb-welcome-sub">
        Design in floor plans, keep the graph model in sync, verify in OpenGeometry 3D.
      </p>

      <div className="bb-welcome-ctas">
        <button
          type="button"
          className="bb-btn primary"
          disabled={loading}
          onClick={onLoadExample}
          style={{ opacity: loading ? 0.65 : 1 }}
        >
          {loading ? 'Loading…' : 'Open example'}
        </button>
        <button type="button" className="bb-btn" onClick={onNewProject}>
          New project
        </button>
      </div>

      <ol className="bb-welcome-steps">
        {STEPS.map((s) => (
          <li key={s.title}>
            <strong>{s.title}</strong>
            <span>{s.desc}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
