/**
 * AuthScreen — Login / Register for BubbleBIM Clean cloud.
 */

import { useState, type CSSProperties, type FormEvent } from 'react';
import { login, register, type AuthUser } from '@/lib/auth';

interface AuthScreenProps {
  onAuthenticated: (user: AuthUser) => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = mode === 'login'
        ? await login(username.trim(), password)
        : await register(username.trim(), password);
      onAuthenticated(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="ac-shell"
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(160deg, #0f1419 0%, #1a2332 55%, #0d3d3a 100%)',
        padding: 24,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: '100%', maxWidth: 380,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 16, padding: '32px 28px',
          backdropFilter: 'blur(12px)',
          color: '#e8eef5',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 36, lineHeight: 1, color: '#2dd4bf' }}>⬡</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: '10px 0 4px', letterSpacing: '-0.02em' }}>
            BubbleBIM Clean
          </h1>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.65 }}>
            {mode === 'login' ? 'Sign in to your projects' : 'Create an account'}
          </p>
        </div>

        <label style={{ display: 'block', fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
          minLength={3}
          style={inputStyle}
        />

        <label style={{ display: 'block', fontSize: 12, opacity: 0.7, margin: '14px 0 6px' }}>Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          required
          minLength={6}
          style={inputStyle}
        />

        {error && (
          <div style={{
            marginTop: 14, padding: '10px 12px', borderRadius: 8,
            background: 'rgba(239,68,68,0.15)', color: '#fca5a5', fontSize: 13,
          }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          style={{
            width: '100%', marginTop: 20, padding: '12px 16px',
            border: 'none', borderRadius: 10, cursor: busy ? 'wait' : 'pointer',
            background: '#14b8a6', color: '#042f2e', fontWeight: 700, fontSize: 14,
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        <button
          type="button"
          onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}
          style={{
            width: '100%', marginTop: 12, padding: 8,
            border: 'none', background: 'transparent', color: '#94a3b8',
            fontSize: 13, cursor: 'pointer', textDecoration: 'underline',
          }}
        >
          {mode === 'login' ? 'Need an account? Register' : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '11px 12px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.15)',
  background: 'rgba(0,0,0,0.25)',
  color: '#f1f5f9',
  fontSize: 14,
  outline: 'none',
};
