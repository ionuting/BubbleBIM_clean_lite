/**
 * AppCleanLite — BubbleBIM Clean with cloud auth + per-user projects.
 *
 * Flow: Auth → Project hub → Clean editor (appProfile="clean")
 * Persistence: FastAPI + JWT via api.cloud.ts
 */

import { useEffect, useState } from 'react';
import { BubbleGraphPanel } from '@/components/bubble-graph/BubbleGraphPanel';
import { AuthScreen } from '@/components/auth/AuthScreen';
import { ProjectHub } from '@/components/auth/ProjectHub';
import { SupportPanel } from '@/components/auth/SupportPanel';
import { LibraryEditorLauncher } from '@/components/norms/LibraryEditorLauncher';
import { Toaster } from '@/components/ui/toast';
import {
  clearSession,
  fetchMe,
  getActiveProjectId,
  getUser,
  type AuthUser,
} from '@/lib/auth';
import { fetchSupportUnreadCount } from '@/lib/support';

type Phase = 'boot' | 'auth' | 'hub' | 'editor';

export function AppCleanLite() {
  const [phase, setPhase] = useState<Phase>('boot');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [projectKey, setProjectKey] = useState(0);
  const [showSupport, setShowSupport] = useState(false);
  const [supportUnread, setSupportUnread] = useState(0);

  useEffect(() => {
    if (!user || phase === 'auth' || phase === 'boot') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const n = await fetchSupportUnreadCount();
        if (!cancelled) setSupportUnread(n);
      } catch { /* offline */ }
    };
    void poll();
    const iv = setInterval(() => { void poll(); }, 30000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [user, phase]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const existing = getUser();
      if (!existing) {
        if (!cancelled) setPhase('auth');
        return;
      }
      const me = await fetchMe();
      if (cancelled) return;
      if (!me) {
        setPhase('auth');
        return;
      }
      setUser(me);
      if (getActiveProjectId()) {
        setPhase('editor');
      } else {
        setPhase('hub');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (phase === 'boot') {
    return (
      <div className="ac-shell" style={{
        position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0f1419', color: '#94a3b8', fontSize: 14,
      }}>
        Loading…
      </div>
    );
  }

  if (phase === 'auth' || !user) {
    return (
      <>
        <AuthScreen
          onAuthenticated={(u) => {
            setUser(u);
            setPhase('hub');
          }}
        />
        <Toaster />
      </>
    );
  }

  if (phase === 'hub') {
    return (
      <>
        <ProjectHub
          user={user}
          onOpenProject={() => {
            setProjectKey((k) => k + 1);
            setPhase('editor');
          }}
          onLogout={() => {
            setUser(null);
            setPhase('auth');
          }}
        />
        <Toaster />
      </>
    );
  }

  return (
    <div className="w-screen h-screen overflow-hidden ac-shell">
      <BubbleGraphPanel
        key={projectKey}
        visible={true}
        onClose={() => setPhase('hub')}
        appProfile="clean"
        cloudAccount={{
          username: user.username,
          onProjects: () => setPhase('hub'),
          onSupport: () => setShowSupport(true),
          supportUnreadCount: supportUnread,
          onSignOut: () => {
            clearSession();
            setUser(null);
            setPhase('auth');
          },
        }}
      />
      <LibraryEditorLauncher />
      {showSupport && (
        <SupportPanel
          user={user}
          onClose={() => {
            setShowSupport(false);
            void fetchSupportUnreadCount().then(setSupportUnread);
          }}
          onUnreadChange={setSupportUnread}
        />
      )}
      <Toaster />
    </div>
  );
}

export default AppCleanLite;
