/**
 * Support messaging API — user ↔ admin with attachments.
 */
import { authHeaders, getToken, type AuthUser } from './auth';

const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) || '/api').replace(/\/$/, '');

export interface SupportAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface SupportMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderUsername: string;
  senderRole: 'user' | 'admin';
  body: string;
  createdAt: string;
  attachments: SupportAttachment[];
}

export interface SupportThread {
  id: string;
  userId: string;
  username?: string;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview?: string;
  lastMessageAt?: string;
  unreadCount?: number;
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.detail || body.message || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function fetchSupportUnreadCount(): Promise<number> {
  const res = await fetch(`${API_BASE}/support/unread-count`, {
    headers: authHeaders(false),
  });
  if (!res.ok) return 0;
  const data = await res.json();
  return Number(data.count) || 0;
}

export async function fetchMySupportThread(): Promise<{
  thread: SupportThread;
  messages: SupportMessage[];
}> {
  const res = await fetch(`${API_BASE}/support/thread`, {
    headers: authHeaders(false),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function fetchSupportThreads(): Promise<SupportThread[]> {
  const res = await fetch(`${API_BASE}/support/threads`, {
    headers: authHeaders(false),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  return data.threads as SupportThread[];
}

export async function fetchSupportMessages(threadId: string): Promise<{
  thread: SupportThread;
  messages: SupportMessage[];
}> {
  const res = await fetch(`${API_BASE}/support/threads/${threadId}/messages`, {
    headers: authHeaders(false),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function sendSupportMessage(
  threadId: string,
  body: string,
  files: File[] = [],
): Promise<SupportMessage> {
  const fd = new FormData();
  fd.append('body', body);
  for (const f of files) fd.append('files', f, f.name);
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/support/threads/${threadId}/messages`, {
    method: 'POST',
    headers,
    body: fd,
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  return data.message as SupportMessage;
}

/** Fetch attachment as blob URL (caller should revoke when done). */
export async function fetchAttachmentBlobUrl(attachmentId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/support/attachments/${attachmentId}`, {
    headers: authHeaders(false),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

export type { AuthUser };
