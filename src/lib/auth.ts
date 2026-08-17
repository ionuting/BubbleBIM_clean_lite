/**
 * Auth session for BubbleBIM Clean (cloud).
 * Token + user + active project id in localStorage.
 */

const TOKEN_KEY = 'bbim_auth_token';
const USER_KEY = 'bbim_auth_user';
const PROJECT_KEY = 'bbim_active_project_id';

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) || '/api';

export interface AuthUser {
  id: string;
  username: string;
  role: 'user' | 'admin';
  active: boolean;
  createdAt?: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  ownerUsername?: string;
}

function apiRoot(): string {
  return API_BASE.replace(/\/$/, '');
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function getActiveProjectId(): string | null {
  return localStorage.getItem(PROJECT_KEY);
}

export function setActiveProjectId(id: string | null): void {
  if (id) localStorage.setItem(PROJECT_KEY, id);
  else localStorage.removeItem(PROJECT_KEY);
}

export function setSession(token: string, user: AuthUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(PROJECT_KEY);
}

export function authHeaders(json = true): HeadersInit {
  const token = getToken();
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.detail || body.message || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${apiRoot()}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  setSession(data.token, data.user);
  return data.user as AuthUser;
}

export async function register(username: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${apiRoot()}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  setSession(data.token, data.user);
  return data.user as AuthUser;
}

export async function fetchMe(): Promise<AuthUser | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetch(`${apiRoot()}/auth/me`, { headers: authHeaders(false) });
  if (!res.ok) {
    clearSession();
    return null;
  }
  const user = (await res.json()) as AuthUser;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const res = await fetch(`${apiRoot()}/projects`, { headers: authHeaders(false) });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  return data.projects as ProjectMeta[];
}

export async function createProject(name: string, data?: Record<string, unknown>): Promise<ProjectMeta> {
  const res = await fetch(`${apiRoot()}/projects`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name, data }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const body = await res.json();
  return body.project as ProjectMeta;
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`${apiRoot()}/projects/${id}`, {
    method: 'DELETE',
    headers: authHeaders(false),
  });
  if (!res.ok) throw new Error(await parseError(res));
}

export async function adminListUsers(): Promise<AuthUser[]> {
  const res = await fetch(`${apiRoot()}/admin/users`, { headers: authHeaders(false) });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  return data.users as AuthUser[];
}

export async function adminCreateUser(
  username: string,
  password: string,
  role: 'user' | 'admin' = 'user',
): Promise<AuthUser> {
  const res = await fetch(`${apiRoot()}/admin/users`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ username, password, role }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  return data.user as AuthUser;
}

export async function adminUpdateUser(
  id: string,
  patch: { active?: boolean; role?: 'user' | 'admin'; password?: string },
): Promise<AuthUser> {
  const res = await fetch(`${apiRoot()}/admin/users/${id}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  return data.user as AuthUser;
}

export async function adminListProjects(): Promise<ProjectMeta[]> {
  const res = await fetch(`${apiRoot()}/admin/projects`, { headers: authHeaders(false) });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  return data.projects as ProjectMeta[];
}
