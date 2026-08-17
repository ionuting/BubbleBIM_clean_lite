/**
 * LibraryEditorLauncher.tsx — buton flotant + overlay pentru editorul de librărie.
 *
 * Se montează la nivel de shell (AppMinimal, AppCleanLite) ca să apară în ambele
 * build-uri fără să atingem BubbleGraphPanel. Editorul e cod pur pe surse comune,
 * deci intră neschimbat și în clean-lite.
 */
import { useState } from 'react';
import { LibraryEditor } from './LibraryEditor';

export function LibraryEditorLauncher() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Librărie categorii de lucrări"
        style={{
          position: 'fixed', left: 16, bottom: 16, zIndex: 8000,
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'var(--background)', color: 'var(--foreground)',
          border: '1px solid var(--border)', borderRadius: 999,
          padding: '9px 14px', cursor: 'pointer', font: 'inherit', fontSize: 12.5,
          boxShadow: '0 4px 16px rgba(0,0,0,0.28)',
        }}
      >
        <span aria-hidden style={{ fontSize: 14 }}>📚</span>
        Librărie
      </button>
      {open && <LibraryEditor onClose={() => setOpen(false)} />}
    </>
  );
}

export default LibraryEditorLauncher;
