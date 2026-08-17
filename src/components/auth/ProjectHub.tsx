/**
 * ProjectHub — list / create own projects; admin user management.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  adminCreateUser,
  adminListProjects,
  adminListUsers,
  adminUpdateUser,
  clearSession,
  createProject,
  deleteProject,
  listProjects,
  setActiveProjectId,
  type AuthUser,
  type ProjectMeta,
} from '@/lib/auth';
import { fetchSupportUnreadCount } from '@/lib/support';
import { SupportPanel } from '@/components/auth/SupportPanel';

interface ProjectHubProps {
  user: AuthUser;
  onOpenProject: (projectId: string) => void;
  onLogout: () => void;
}

export function ProjectHub({ user, onOpenProject, onLogout }: ProjectHubProps) {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [allProjects, setAllProjects] = useState<ProjectMeta[]>([]);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [tab, setTab] = useState<'mine' | 'admin-users' | 'admin-projects' | 'support'>('mine');
  const [newName, setNewName] = useState('Untitled');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adminUser, setAdminUser] = useState('');
  const [adminPass, setAdminPass] = useState('');
  const [showSupport, setShowSupport] = useState(false);
  const [supportUnread, setSupportUnread] = useState(0);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setProjects(await listProjects());
      if (user.role === 'admin') {
        setUsers(await adminListUsers());
        setAllProjects(await adminListProjects());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [user.role]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
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
  }, [user.id]);

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await createProject(newName.trim() || 'Untitled');
      setActiveProjectId(p.id);
      onOpenProject(p.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = (id: string) => {
    setActiveProjectId(id);
    onOpenProject(id);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this project permanently?')) return;
    setBusy(true);
    try {
      await deleteProject(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateUser = async () => {
    setBusy(true);
    setError(null);
    try {
      await adminCreateUser(adminUser.trim(), adminPass, 'user');
      setAdminUser('');
      setAdminPass('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create user failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="ac-shell"
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'linear-gradient(160deg, #0f1419 0%, #1a2332 55%, #0d3d3a 100%)',
        color: '#e8eef5', overflow: 'auto',
      }}
    >
      <div style={{ maxWidth: 880, margin: '0 auto', padding: '40px 20px 60px' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 28 }}>
          <div>
            <div style={{ fontSize: 28, color: '#2dd4bf' }}>⬡</div>
            <h1 style={{ margin: '8px 0 4px', fontSize: 24, fontWeight: 700 }}>Your projects</h1>
            <p style={{ margin: 0, opacity: 0.65, fontSize: 13 }}>
              Signed in as <strong>{user.username}</strong>
              {user.role === 'admin' ? ' · admin' : ''}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <button
              type="button"
              onClick={() => setShowSupport(true)}
              style={{ ...ghostBtn, position: 'relative' }}
            >
              {user.role === 'admin' ? 'Support inbox' : 'Contact admin'}
              {supportUnread > 0 && (
                <span style={{
                  position: 'absolute', top: -4, right: -4,
                  background: '#ef4444', color: '#fff', fontSize: 10, fontWeight: 700,
                  minWidth: 18, height: 18, borderRadius: 9,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {supportUnread > 99 ? '99+' : supportUnread}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => { clearSession(); onLogout(); }}
              style={ghostBtn}
            >
              Sign out
            </button>
          </div>
        </header>

        {user.role === 'admin' && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
            {([
              ['mine', 'My projects'],
              ['admin-users', 'Users'],
              ['admin-projects', 'All projects'],
              ['support', 'Support inbox'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  if (id === 'support') setShowSupport(true);
                  else setTab(id);
                }}
                style={{
                  ...ghostBtn,
                  background: tab === id ? 'rgba(45,212,191,0.2)' : 'transparent',
                  borderColor: tab === id ? '#2dd4bf' : 'rgba(255,255,255,0.15)',
                  position: 'relative',
                }}
              >
                {label}
                {id === 'support' && supportUnread > 0 && (
                  <span style={{
                    marginLeft: 6, background: '#ef4444', color: '#fff',
                    fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
                  }}>
                    {supportUnread}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div style={{ marginBottom: 16, padding: 12, borderRadius: 8, background: 'rgba(239,68,68,0.15)', color: '#fca5a5', fontSize: 13 }}>
            {error}
          </div>
        )}

        {tab === 'mine' && user.role !== 'admin' && (
          <div style={{ marginBottom: 20 }}>
            <button type="button" onClick={() => setShowSupport(true)} style={primaryBtn}>
              Contact admin
              {supportUnread > 0 ? ` (${supportUnread} new)` : ''}
            </button>
          </div>
        )}

        {tab === 'mine' && (
          <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New project name"
                style={inputStyle}
              />
              <button type="button" disabled={busy} onClick={handleCreate} style={primaryBtn}>
                + New project
              </button>
            </div>

            <div style={{ display: 'grid', gap: 10 }}>
              {projects.length === 0 && (
                <p style={{ opacity: 0.55, fontSize: 14 }}>No projects yet. Create one to start.</p>
              )}
              {projects.map((p) => (
                <div key={p.id} style={cardStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{p.name}</div>
                    <div style={{ fontSize: 12, opacity: 0.55, marginTop: 4 }}>
                      Updated {new Date(p.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  <button type="button" onClick={() => handleOpen(p.id)} style={primaryBtn}>Open</button>
                  <button type="button" onClick={() => handleDelete(p.id)} style={ghostBtn}>Delete</button>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'admin-users' && user.role === 'admin' && (
          <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
              <input value={adminUser} onChange={(e) => setAdminUser(e.target.value)} placeholder="Username" style={inputStyle} />
              <input value={adminPass} onChange={(e) => setAdminPass(e.target.value)} placeholder="Password" type="password" style={inputStyle} />
              <button type="button" disabled={busy} onClick={handleCreateUser} style={primaryBtn}>Create user</button>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {users.map((u) => (
                <div key={u.id} style={cardStyle}>
                  <div style={{ flex: 1 }}>
                    <strong>{u.username}</strong>
                    <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.6 }}>{u.role}{u.active ? '' : ' · disabled'}</span>
                  </div>
                  {u.id !== user.id && (
                    <button
                      type="button"
                      style={ghostBtn}
                      onClick={async () => {
                        await adminUpdateUser(u.id, { active: !u.active });
                        await refresh();
                      }}
                    >
                      {u.active ? 'Disable' : 'Enable'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'admin-projects' && user.role === 'admin' && (
          <div style={{ display: 'grid', gap: 8 }}>
            {allProjects.map((p) => (
              <div key={p.id} style={cardStyle}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: 12, opacity: 0.55 }}>Owner: {p.ownerUsername ?? p.userId}</div>
                </div>
                <button type="button" onClick={() => handleOpen(p.id)} style={primaryBtn}>Open</button>
              </div>
            ))}
          </div>
        )}
      </div>

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
    </div>
  );
}

const inputStyle: CSSProperties = {
  flex: 1, minWidth: 160, padding: '10px 12px', borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(0,0,0,0.25)', color: '#f1f5f9', fontSize: 14,
};

const primaryBtn: CSSProperties = {
  padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
  border: 'none', background: '#14b8a6', color: '#042f2e', fontWeight: 700, fontSize: 13,
};

const ghostBtn: CSSProperties = {
  padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
  border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: '#cbd5e1', fontSize: 13,
};

const cardStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  padding: '14px 16px', borderRadius: 12,
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
};
