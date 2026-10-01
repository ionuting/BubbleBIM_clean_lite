/**
 * ErrorBoundary — keeps one broken view from taking the whole app with it.
 *
 * React unmounts the ENTIRE tree when a render or lifecycle throws and nothing
 * catches it. In a single-root app like this one that means a white screen and a
 * lost session: the graph is still in memory, but there is no longer anything on
 * screen to save it from. A boundary around each view turns that into a panel
 * with a message and a retry, with the tab bar and the graph editor still alive.
 *
 * It catches render, lifecycle and constructor errors — NOT errors thrown from
 * event handlers, promises, or `requestAnimationFrame` callbacks, which is most
 * of what a 3D viewer does. `installGlobalErrorReporting` covers those: it can
 * neither unmount nor recover anything, but it does mean the error reaches the
 * console with a marker instead of being swallowed.
 */

import React from 'react';

interface Props {
  children: React.ReactNode;
  /** Shown above the message, e.g. the view's label. */
  label?: string;
  /**
   * Changing this resets the boundary. Pass the tab id so switching away and
   * back gives the view a fresh try without a reload.
   */
  resetKey?: string | number;
  /** Called once per caught error, for logging or telemetry. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface State {
  error: Error | null;
  info: React.ErrorInfo | null;
  /** Bumped by Retry so children remount rather than re-render in place. */
  attempt: number;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, info: null });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // The component stack is the useful half — it names the view that broke.
    console.error(`[ErrorBoundary] ${this.props.label ?? 'view'} crashed:`, error, info.componentStack);
    this.setState({ info });
    this.props.onError?.(error, info);
  }

  private retry = () => {
    this.setState((s) => ({ error: null, info: null, attempt: s.attempt + 1 }));
  };

  render() {
    const { error, info, attempt } = this.state;
    if (!error) return <React.Fragment key={attempt}>{this.props.children}</React.Fragment>;

    return (
      <div className="w-full h-full overflow-auto flex items-center justify-center p-6 bg-background">
        <div className="max-w-xl w-full rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <div className="text-sm font-semibold text-destructive mb-1">
            {this.props.label ? `${this.props.label} — eroare` : 'Eroare în această vedere'}
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Vederea s-a oprit, dar modelul și celelalte file sunt intacte. Încearcă din nou;
            dacă se repetă, treci pe altă filă și spune ce ai făcut înainte.
          </p>
          <pre className="text-[11px] whitespace-pre-wrap break-words bg-background/60 border border-border rounded p-2 max-h-48 overflow-auto mb-3">
            {error.message || String(error)}
            {info?.componentStack ? `\n${info.componentStack.split('\n').slice(0, 6).join('\n')}` : ''}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={this.retry}
              className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Încearcă din nou
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1.5 text-xs rounded border border-border hover:bg-muted"
            >
              Reîncarcă aplicația
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/**
 * Report what a boundary cannot catch.
 *
 * A 3D viewer does nearly all its work in event handlers, `requestAnimationFrame`
 * and promises. An error there does not reach a boundary — but an unhandled
 * promise rejection is exactly the kind of thing that leaves a scene half-built
 * and the next render throwing. Marking them makes that sequence readable.
 */
export function installGlobalErrorReporting(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandled rejection]', e.reason);
  });
  window.addEventListener('error', (e) => {
    if (e.error) console.error('[uncaught]', e.error);
  });
}
