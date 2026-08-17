import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import {
  type SymbolTemplate,
  compileTemplate,
  defaultEditsFor,
} from '@/lib/symbolTemplates';
import {
  renderSymbolSVGString,
  type SymRenderParams,
} from '@/lib/svgSymbolStore';

export interface TemplatePickerProps {
  templates: SymbolTemplate[];
  selectedId: string;
  onSelect: (template: SymbolTemplate) => void;
  elementType: 'window' | 'door';
  typeKey: string;
  params: SymRenderParams;
}

const THUMB_W = 140;
const THUMB_H = 80;

export function TemplatePicker({
  templates,
  selectedId,
  onSelect,
  elementType,
  typeKey,
  params,
}: TemplatePickerProps) {
  const edits = defaultEditsFor(elementType);

  const thumbs = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of templates) {
      const def = compileTemplate(t.build, typeKey, t.name, edits, elementType);
      map.set(t.id, renderSymbolSVGString(def, params, THUMB_W, THUMB_H));
    }
    return map;
  }, [templates, typeKey, edits, elementType, params]);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {templates.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onSelect(t)}
          className={cn(
            'flex flex-col rounded-lg border p-2 text-left transition-colors hover:bg-gray-50',
            selectedId === t.id
              ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-300'
              : 'border-gray-200',
          )}
        >
          <div
            className="rounded border border-gray-100 overflow-hidden mb-1.5 bg-gray-50"
            dangerouslySetInnerHTML={{ __html: thumbs.get(t.id) ?? '' }}
          />
          <span className="text-xs font-medium text-gray-800">{t.name}</span>
          <span className="text-[10px] text-gray-400 leading-tight mt-0.5">{t.description}</span>
        </button>
      ))}
    </div>
  );
}
