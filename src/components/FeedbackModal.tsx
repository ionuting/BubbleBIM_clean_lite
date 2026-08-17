import React from 'react';
import { Mail } from 'lucide-react';

const FEEDBACK_EMAIL = 'ionut@ciuntucbimstudio.ro';

export function FeedbackButton() {
  const href =
    `mailto:${FEEDBACK_EMAIL}` +
    `?subject=${encodeURIComponent('BubbleBIM Demo — Feedback')}` +
    `&body=${encodeURIComponent('Salut,\n\nAm testat BubbleBIM și aș vrea să îți spun:\n\n')}`;

  return (
    <a
      href={href}
      title={`Send feedback to ${FEEDBACK_EMAIL}`}
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 14px',
        borderRadius: 20,
        background: 'hsl(var(--primary))',
        color: 'hsl(var(--primary-foreground))',
        textDecoration: 'none',
        fontSize: 13,
        fontWeight: 600,
        boxShadow: '0 2px 12px rgba(0,0,0,0.25)',
        cursor: 'pointer',
      }}
    >
      <Mail size={15} />
      Feedback
    </a>
  );
}
