import React, { useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { sendChatMessage, getChatStatus, uploadIFCFile, parseIFCStorey, commitIFCGraph } from '@/lib/api';
import type { IFCParseResponse } from '@/lib/api';
import { useBubbleGraphStore } from '@/store';

// ─── Types ────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  cypher?: string;
  timestamp: Date;
  isError?: boolean;
}

interface ChatPanelProps {
  className?: string;
}

// ─── Simple Markdown renderer (bold, code blocks, bullet lists) ───────────

function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];

  let inCode = false;
  let codeLines: string[] = [];
  let codeLang = '';

  const flushCode = (key: string) => {
    elements.push(
      <pre key={key} className="my-1.5 bg-black/40 border border-border rounded p-2 text-xs overflow-x-auto font-mono text-green-300 whitespace-pre-wrap">
        <span className="text-muted-foreground text-[10px] block mb-1">{codeLang || 'code'}</span>
        {codeLines.join('\n')}
      </pre>,
    );
    codeLines = [];
    codeLang = '';
  };

  lines.forEach((line, i) => {
    if (line.startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeLang = line.slice(3).trim();
      } else {
        inCode = false;
        flushCode(`code-${i}`);
      }
      return;
    }
    if (inCode) {
      codeLines.push(line);
      return;
    }

    // Render inline bold + inline code
    const renderInline = (src: string): React.ReactNode[] => {
      const parts = src.split(/(\*\*.*?\*\*|`[^`]+`)/);
      return parts.map((part, j) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={j}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={j} className="bg-black/30 px-1 rounded text-green-300 text-[11px] font-mono">{part.slice(1, -1)}</code>;
        }
        return <span key={j}>{part}</span>;
      });
    };

    if (line.startsWith('• ') || line.startsWith('- ')) {
      elements.push(
        <div key={i} className="flex items-start gap-1.5 my-0.5">
          <span className="text-muted-foreground mt-0.5">•</span>
          <span>{renderInline(line.slice(2))}</span>
        </div>,
      );
    } else if (line.startsWith('**') && line.endsWith('**')) {
      elements.push(<p key={i} className="font-semibold my-0.5">{line.slice(2, -2)}</p>);
    } else if (line === '') {
      elements.push(<div key={i} className="h-1.5" />);
    } else {
      elements.push(<p key={i} className="my-0.5">{renderInline(line)}</p>);
    }
  });

  if (inCode) flushCode('code-tail');
  return elements;
}

// ─── Message bubble ───────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user';
  return (
    <div className={cn('flex gap-2 mb-3', isUser ? 'flex-row-reverse' : 'flex-row')}>
      {/* Avatar */}
      <div className={cn(
        'flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold mt-0.5',
        isUser
          ? 'bg-primary text-primary-foreground'
          : 'bg-secondary border border-border text-foreground',
      )}>
        {isUser ? 'U' : '🤖'}
      </div>

      {/* Bubble */}
      <div className={cn(
        'max-w-[82%] rounded-lg px-3 py-2 text-sm leading-relaxed',
        isUser
          ? 'bg-primary text-primary-foreground rounded-tr-none'
          : msg.isError
            ? 'bg-red-500/10 border border-red-500/30 text-foreground rounded-tl-none'
            : 'bg-secondary border border-border text-foreground rounded-tl-none',
      )}>
        {isUser
          ? <p>{msg.content}</p>
          : <div className="prose-sm">{renderMarkdown(msg.content)}</div>
        }
        {msg.cypher && !isUser && (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
              🔍 Cypher executat
            </summary>
            <pre className="mt-1 bg-black/40 rounded p-2 text-green-300 font-mono overflow-x-auto whitespace-pre-wrap">
              {msg.cypher}
            </pre>
          </details>
        )}
        <div className={cn('text-[10px] mt-1', isUser ? 'text-primary-foreground/60 text-right' : 'text-muted-foreground')}>
          {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  );
}

// ─── Suggested queries ────────────────────────────────────────────────────

const SUGGESTIONS = [
  'câte noduri sunt în graf?',
  'listează toate storeys',
  'statistici',
  'ajutor',
];

// ─── ChatPanel ────────────────────────────────────────────────────────────

export function ChatPanel({ className }: ChatPanelProps) {
  const [ollamaModel, setOllamaModel] = useState<string | null>(null);
  const loadGraph = useBubbleGraphStore((s) => s.loadGraph);

  useEffect(() => {
    getChatStatus().then((s) => setOllamaModel(s.ollama ? s.model : null)).catch(() => {});
  }, []);

  // ── IFC import state ───────────────────────────────────────────────────
  const ifcInputRef = useRef<HTMLInputElement>(null);
  const [ifcPending, setIfcPending] = useState<IFCParseResponse | null>(null);
  const [ifcLoading, setIfcLoading] = useState(false);

  const handleIFCFile = useCallback(async (file: File) => {
    setIfcLoading(true);
    const uploadMsg: Message = {
      id: `u-ifc-${Date.now()}`, role: 'user',
      content: `📂 Import IFC: **${file.name}** (${(file.size / 1024).toFixed(0)} KB)`,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, uploadMsg]);

    try {
      const { fileKey } = await uploadIFCFile(file);

      const statusMsg: Message = {
        id: `a-ifc-parse-${Date.now()}`, role: 'assistant',
        content: `Fișier încărcat ✓\n\nAnalizez structura IFC și detectez storeys…`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, statusMsg]);

      // First parse without LLM to get storey list
      const quickParse = await parseIFCStorey(fileKey, undefined, 0, false);
      const storeys = quickParse.parsed.allStoreys ?? [];
      const storeyList = storeys.map((s, i) => `${i}: **${s.name}** (${s.elevation_mm >= 0 ? '+' : ''}${s.elevation_mm}mm)`).join('\n');

      const storeyChoiceMsg: Message = {
        id: `a-ifc-storeys-${Date.now()}`, role: 'assistant',
        content:
          `Găsite **${storeys.length} storeys**:\n${storeyList}\n\n` +
          `Parsez **Erdgeschoss** (storey 0) implicit.\n\n` +
          `Trimit datele la LLM (${ollamaModel ?? 'ollama'}) pentru parametrizare…\n\n` +
          `_Poate dura 1-2 minute._`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, storeyChoiceMsg]);

      // Full parse with LLM
      const result = await parseIFCStorey(fileKey, undefined, 0, true);
      setIfcPending(result);

      const parsed = result.parsed;
      const graph  = result.graph;

      let summary = `**IFC parsedat: ${parsed.storey.name}**\n\n`;
      summary += `• Etaj: ${parsed.storey.elevation_mm}mm → ${parsed.storey.elevation_mm + parsed.storey.height_mm}mm\n`;
      summary += `• Pereți: ${parsed.wallCount}\n`;
      summary += `• Deschideri: ${parsed.openingCount}\n`;
      summary += `• Axe X: ${parsed.axesX_mm.join(', ')}mm\n`;
      summary += `• Axe Y: ${parsed.axesY_mm.join(', ')}mm\n\n`;

      if (graph) {
        summary += `**LLM a generat:**\n`;
        summary += `• ${graph.nodes.length} noduri BubbleGraph\n`;
        summary += `• ${graph.edges.length} muchii\n\n`;
        summary += `Vrei să **importezi** aceste noduri în graful curent?\n`;
        summary += `_(Se va crea un backup automat înainte de import)_`;
      } else {
        summary += `⚠️ LLM-ul nu a putut parametriza datele`;
        if (result.llmError) summary += `\nEroare: \`${result.llmError}\``;
        summary += `\n\nPoți importa oricum datele brute sau reîncerca.`;
      }

      setMessages((prev) => [...prev, {
        id: `a-ifc-result-${Date.now()}`, role: 'assistant',
        content: summary, timestamp: new Date(),
        isError: !graph,
      }]);

    } catch (err) {
      setMessages((prev) => [...prev, {
        id: `err-ifc-${Date.now()}`, role: 'assistant',
        content: `Eroare la import IFC:\n\`${err instanceof Error ? err.message : String(err)}\``,
        timestamp: new Date(), isError: true,
      }]);
    } finally {
      setIfcLoading(false);
    }
  }, [ollamaModel]);

  const handleIFCCommit = useCallback(async () => {
    if (!ifcPending?.graph) return;
    setLoading(true);
    try {
      const res = await commitIFCGraph(
        ifcPending.graph.nodes as any,
        ifcPending.graph.edges as any,
      );
      setIfcPending(null);
      setMessages((prev) => [...prev, {
        id: `a-ifc-commit-${Date.now()}`, role: 'assistant',
        content:
          `✅ **Import reușit!**\n\n` +
          `• +${res.addedNodes} noduri adăugate\n` +
          `• +${res.addedEdges} muchii adăugate\n` +
          `• Backup creat: \`${res.backup}\`\n\n` +
          `Apasă **Generează 3D** pentru a vizualiza clădirea importată.`,
        timestamp: new Date(),
      }]);
      // Reload graph from backend
      await loadGraph();
    } catch (err) {
      setMessages((prev) => [...prev, {
        id: `err-commit-${Date.now()}`, role: 'assistant',
        content: `Eroare la salvare: \`${err instanceof Error ? err.message : String(err)}\``,
        timestamp: new Date(), isError: true,
      }]);
    } finally {
      setLoading(false);
    }
  }, [ifcPending, loadGraph]);

  const welcomeContent =
    'Bună! Sunt asistentul BubbleGraph.\n\n' +
    'Pot interoga **baza de date grafică** în limbaj natural.\n\n' +
    'Încearcă: *câte noduri sunt?* sau *statistici*.';

  const [messages, setMessages] = useState<Message[]>([
    { id: 'welcome', role: 'assistant', content: welcomeContent, timestamp: new Date() },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<{ role: string; content: string }[]>([]);

  // Auto-scroll on new message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    // Keep rolling history (last 10 turns)
    historyRef.current = [
      ...historyRef.current.slice(-9),
      { role: 'user', content: trimmed },
    ];

    try {
      const res = await sendChatMessage(trimmed, historyRef.current);
      const botMsg: Message = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: res.reply,
        cypher: res.cypher || undefined,
        timestamp: new Date(),
        isError: res.action === 'error',
      };
      setMessages((prev) => [...prev, botMsg]);
      historyRef.current = [
        ...historyRef.current,
        { role: 'assistant', content: res.reply },
      ];
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: `Eroare de conexiune cu backend-ul.\n\nVerifică că serverul Python rulează pe portul 8000.\n\`${err instanceof Error ? err.message : String(err)}\``,
          timestamp: new Date(),
          isError: true,
        },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [loading]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  return (
    <div className={cn('flex flex-col bg-background text-foreground h-full', className)}>
      {/* Model badge */}
      {ollamaModel && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-secondary/50 flex-shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          <span className="text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">ollama</span>
            {' · '}
            <span className="font-mono text-green-600 dark:text-green-400">{ollamaModel}</span>
            {' · activ pentru întrebări libere'}
          </span>
        </div>
      )}
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-0 min-h-0">
        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}

        {loading && (
          <div className="flex gap-2 mb-3">
            <div className="w-7 h-7 rounded-full bg-secondary border border-border flex items-center justify-center text-xs mt-0.5">🤖</div>
            <div className="bg-secondary border border-border rounded-lg rounded-tl-none px-3 py-2">
              <span className="flex gap-1 items-center">
                <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:300ms]" />
              </span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Suggestions */}
      {messages.length <= 2 && (
        <div className="px-3 pb-2 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              className="text-[11px] px-2.5 py-1 rounded-full border border-border bg-secondary hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => send(s)}
              disabled={loading}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="border-t border-border p-2 flex-shrink-0">
        {/* IFC confirm/cancel bar — shown when LLM result is pending */}
        {ifcPending?.graph && (
          <div className="flex gap-2 mb-2">
            <button
              className="flex-1 bg-green-600 hover:bg-green-500 text-white rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
              onClick={handleIFCCommit}
              disabled={loading}
            >
              ✅ Importă în graf
            </button>
            <button
              className="flex-1 bg-secondary hover:bg-accent border border-border rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setIfcPending(null)}
            >
              ✕ Anulează
            </button>
          </div>
        )}
        <div className="flex gap-2 items-end">
          {/* Hidden IFC file input */}
          <input
            ref={ifcInputRef}
            type="file"
            accept=".ifc"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleIFCFile(file);
              e.target.value = '';
            }}
          />
          {/* IFC import button */}
          <button
            className="flex-shrink-0 bg-secondary border border-border rounded-lg px-2.5 py-2 text-sm hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            title="Import fișier IFC"
            onClick={() => ifcInputRef.current?.click()}
            disabled={loading || ifcLoading}
          >
            📂
          </button>
          <textarea
            ref={inputRef}
            className="flex-1 bg-input border border-border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring/50 min-h-[38px] max-h-[120px] leading-snug"
            placeholder="Întreabă ceva sau scrie Cypher direct… (Enter trimite)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={loading || ifcLoading}
          />
          <button
            className="flex-shrink-0 bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            onClick={() => send(input)}
            disabled={loading || ifcLoading || !input.trim()}
          >
            ↑
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1 px-1">
          Shift+Enter pentru linie nouă · 📂 pentru import IFC
        </p>
      </div>
    </div>
  );
}
