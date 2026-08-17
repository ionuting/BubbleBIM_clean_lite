/**
 * SupportPanel — direct messaging between user and admin (text + screenshots).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  fetchAttachmentBlobUrl,
  fetchMySupportThread,
  fetchSupportMessages,
  fetchSupportThreads,
  isImageMime,
  sendSupportMessage,
  type AuthUser,
  type SupportMessage,
  type SupportThread,
} from '@/lib/support';

interface SupportPanelProps {
  user: AuthUser;
  onClose: () => void;
  /** Admin: open a specific thread */
  initialThreadId?: string | null;
  onUnreadChange?: (count: number) => void;
}

export function SupportPanel({
  user,
  onClose,
  initialThreadId = null,
  onUnreadChange,
}: SupportPanelProps) {
  const isAdmin = user.role === 'admin';
  const [threads, setThreads] = useState<SupportThread[]>([]);
  const [activeThread, setActiveThread] = useState<SupportThread | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadThread = useCallback(async (threadId: string) => {
    const data = await fetchSupportMessages(threadId);
    setActiveThread(data.thread);
    setMessages(data.messages);
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      if (isAdmin) {
        const list = await fetchSupportThreads();
        setThreads(list);
        const tid = activeThread?.id ?? initialThreadId ?? list[0]?.id;
        if (tid) await loadThread(tid);
      } else {
        const data = await fetchMySupportThread();
        setActiveThread(data.thread);
        setMessages(data.messages);
        onUnreadChange?.(0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    }
  }, [isAdmin, activeThread?.id, initialThreadId, loadThread, onUnreadChange]);

  useEffect(() => {
    void refresh();
    const iv = setInterval(() => { void refresh(); }, 25000);
    return () => clearInterval(iv);
  }, [refresh]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Load image previews for attachments
  useEffect(() => {
    const toLoad = messages.flatMap((m) =>
      m.attachments.filter((a) => isImageMime(a.mimeType) && !previewUrls[a.id]),
    );
    if (toLoad.length === 0) return;
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const a of toLoad) {
        try {
          next[a.id] = await fetchAttachmentBlobUrl(a.id);
        } catch { /* skip */ }
      }
      if (!cancelled && Object.keys(next).length) {
        setPreviewUrls((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, previewUrls]);

  useEffect(() => () => {
    Object.values(previewUrls).forEach((u) => URL.revokeObjectURL(u));
  }, [previewUrls]);

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const added: File[] = [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) added.push(new File([f], `paste-${Date.now()}.png`, { type: f.type }));
      }
    }
    if (added.length) {
      e.preventDefault();
      setFiles((prev) => [...prev, ...added].slice(0, 5));
    }
  };

  const handleSend = async () => {
    if (!activeThread) return;
    if (!text.trim() && files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const msg = await sendSupportMessage(activeThread.id, text.trim(), files);
      setMessages((prev) => [...prev, msg]);
      setText('');
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (isAdmin) {
        const list = await fetchSupportThreads();
        setThreads(list);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setBusy(false);
    }
  };

  const selectThread = async (t: SupportThread) => {
    setBusy(true);
    try {
      await loadThread(t.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlayStyle} onClick={onClose} role="presentation">
      <div
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
        onPaste={handlePaste}
        role="dialog"
        aria-label="Support messages"
      >
        <header style={headerStyle}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
              {isAdmin ? 'Support inbox' : 'Contact admin'}
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.65 }}>
              {isAdmin && activeThread
                ? `Conversation with ${activeThread.username ?? activeThread.userId}`
                : 'Send a message or attach a screenshot (Ctrl+V paste)'}
            </p>
          </div>
          <button type="button" onClick={onClose} style={closeBtn} aria-label="Close">✕</button>
        </header>

        {error && (
          <div style={errorStyle}>{error}</div>
        )}

        <div style={bodyStyle}>
          {isAdmin && (
            <aside style={threadListStyle}>
              {threads.length === 0 && (
                <p style={{ fontSize: 12, opacity: 0.5, padding: 8 }}>No conversations yet.</p>
              )}
              {threads.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => void selectThread(t)}
                  style={{
                    ...threadItemStyle,
                    background: activeThread?.id === t.id ? 'rgba(45,212,191,0.15)' : 'transparent',
                    borderColor: activeThread?.id === t.id ? '#2dd4bf' : 'transparent',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{t.username ?? t.userId}</div>
                  <div style={{ fontSize: 11, opacity: 0.55, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.lastMessagePreview || '—'}
                  </div>
                  {(t.unreadCount ?? 0) > 0 && (
                    <span style={badgeStyle}>{t.unreadCount}</span>
                  )}
                </button>
              ))}
            </aside>
          )}

          <div style={chatStyle}>
            <div ref={scrollRef} style={messagesStyle}>
              {messages.length === 0 && (
                <p style={{ textAlign: 'center', opacity: 0.45, fontSize: 13, marginTop: 40 }}>
                  No messages yet. Describe your issue or attach a screenshot.
                </p>
              )}
              {messages.map((m) => {
                const mine = m.senderId === user.id;
                return (
                  <div key={m.id} style={{ ...bubbleRow, justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                    <div style={{ ...bubbleStyle, ...(mine ? bubbleMine : bubbleOther) }}>
                      <div style={{ fontSize: 10, opacity: 0.65, marginBottom: 4 }}>
                        {mine ? 'You' : m.senderUsername}
                        {' · '}
                        {new Date(m.createdAt).toLocaleString()}
                      </div>
                      {m.body && <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{m.body}</div>}
                      {m.attachments.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: m.body ? 8 : 0 }}>
                          {m.attachments.map((a) => (
                            <AttachmentView key={a.id} attachment={a} previewUrl={previewUrls[a.id]} />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {files.length > 0 && (
              <div style={pendingFilesStyle}>
                {files.map((f, i) => (
                  <span key={`${f.name}-${i}`} style={pendingChip}>
                    {f.name}
                    <button type="button" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} style={chipRemove}>×</button>
                  </span>
                ))}
              </div>
            )}

            <div style={composerStyle}>
              <button
                type="button"
                title="Attach screenshot or image"
                onClick={() => fileInputRef.current?.click()}
                style={attachBtn}
              >
                📎
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,application/pdf"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  setFiles((prev) => [...prev, ...picked].slice(0, 5));
                }}
              />
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Write a message… (paste screenshot with Ctrl+V)"
                rows={2}
                style={textareaStyle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <button type="button" disabled={busy} onClick={() => void handleSend()} style={sendBtn}>
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AttachmentView({
  attachment,
  previewUrl,
}: {
  attachment: { id: string; filename: string; mimeType: string };
  previewUrl?: string;
}) {
  const [url, setUrl] = useState(previewUrl ?? '');
  useEffect(() => {
    if (previewUrl) setUrl(previewUrl);
    else if (isImageMime(attachment.mimeType)) {
      fetchAttachmentBlobUrl(attachment.id).then(setUrl).catch(() => {});
    }
    return () => {
      if (url && !previewUrl) URL.revokeObjectURL(url);
    };
  }, [attachment.id, attachment.mimeType, previewUrl, url]);

  if (isImageMime(attachment.mimeType) && url) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer">
        <img src={url} alt={attachment.filename} style={{ maxWidth: 220, maxHeight: 160, borderRadius: 6, display: 'block' }} />
      </a>
    );
  }
  return (
    <a
      href="#"
      onClick={async (e) => {
        e.preventDefault();
        const u = await fetchAttachmentBlobUrl(attachment.id);
        window.open(u, '_blank');
      }}
      style={{ fontSize: 12, color: '#5eead4' }}
    >
      📄 {attachment.filename}
    </a>
  );
}

const overlayStyle: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 500,
  background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 16,
};

const panelStyle: CSSProperties = {
  width: '100%', maxWidth: 720, maxHeight: 'min(88vh, 720px)',
  background: '#1a2332', color: '#e8eef5', borderRadius: 14,
  border: '1px solid rgba(255,255,255,0.12)', display: 'flex', flexDirection: 'column',
  overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
};

const headerStyle: CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
  padding: '16px 18px', borderBottom: '1px solid rgba(255,255,255,0.1)',
};

const closeBtn: CSSProperties = {
  background: 'transparent', border: 'none', color: '#94a3b8', fontSize: 18, cursor: 'pointer', padding: 4,
};

const errorStyle: CSSProperties = {
  margin: '0 16px', padding: 10, borderRadius: 8,
  background: 'rgba(239,68,68,0.15)', color: '#fca5a5', fontSize: 13,
};

const bodyStyle: CSSProperties = {
  display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden',
};

const threadListStyle: CSSProperties = {
  width: 200, flexShrink: 0, overflowY: 'auto',
  borderRight: '1px solid rgba(255,255,255,0.08)', padding: 8,
};

const threadItemStyle: CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', padding: '10px 10px',
  marginBottom: 4, borderRadius: 8, border: '1px solid transparent',
  background: 'transparent', color: '#e8eef5', cursor: 'pointer', position: 'relative',
};

const badgeStyle: CSSProperties = {
  position: 'absolute', top: 8, right: 8,
  background: '#ef4444', color: '#fff', fontSize: 10, fontWeight: 700,
  minWidth: 18, height: 18, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const chatStyle: CSSProperties = {
  flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0,
};

const messagesStyle: CSSProperties = {
  flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10,
};

const bubbleRow: CSSProperties = { display: 'flex' };

const bubbleStyle: CSSProperties = {
  maxWidth: '85%', padding: '10px 12px', borderRadius: 10,
};

const bubbleMine: CSSProperties = {
  background: 'rgba(20,184,166,0.22)', border: '1px solid rgba(45,212,191,0.35)',
};

const bubbleOther: CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
};

const pendingFilesStyle: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 16px 8px',
};

const pendingChip: CSSProperties = {
  fontSize: 11, padding: '4px 8px', borderRadius: 6,
  background: 'rgba(255,255,255,0.08)', display: 'inline-flex', alignItems: 'center', gap: 4,
};

const chipRemove: CSSProperties = {
  background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: 0, fontSize: 14,
};

const composerStyle: CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'flex-end', padding: '12px 16px',
  borderTop: '1px solid rgba(255,255,255,0.1)',
};

const attachBtn: CSSProperties = {
  padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)',
  background: 'transparent', cursor: 'pointer', fontSize: 16, flexShrink: 0,
};

const textareaStyle: CSSProperties = {
  flex: 1, resize: 'none', padding: '10px 12px', borderRadius: 8, fontSize: 14,
  border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(0,0,0,0.25)', color: '#f1f5f9',
  fontFamily: 'inherit',
};

const sendBtn: CSSProperties = {
  padding: '10px 16px', borderRadius: 8, border: 'none',
  background: '#14b8a6', color: '#042f2e', fontWeight: 700, fontSize: 13, cursor: 'pointer', flexShrink: 0,
};
