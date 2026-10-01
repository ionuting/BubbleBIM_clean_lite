/**
 * tapirClient.ts — transport for ArchiCAD's JSON API and the Tapir add-on.
 *
 * ArchiCAD serves plain HTTP on 127.0.0.1:19723 once a project is open; there is
 * no SDK to install and no authentication. Tapir's own commands ride the
 * official channel via `API.ExecuteAddOnCommand` under the `TapirCommand`
 * namespace, so both kinds of call go through the same POST.
 *
 * Verified against ArchiCAD 29 build 3000 with Tapir 1.5.8. The add-on must be
 * present in `Add-Ons/` — without it the base API answers but every
 * `TapirCommand` fails.
 */

export const DEFAULT_TAPIR_URL = 'http://127.0.0.1:19723';

/** An ArchiCAD element reference, as every command expects and returns it. */
export interface ElementId { elementId: { guid: string } }

/** One input item's fate: created, or refused with ArchiCAD's own reason. */
export interface CreateOutcome {
  guid: string | null;
  code?: number;
  message?: string;
}

/**
 * `APIERR_BADDATABASE`. A window or door is created together with its Main
 * Marker sub-element, and that marker lives on the floor plan, so
 * `ACAPI_Element_CreateExt` refuses the whole create when the current database
 * is anything else — the 3D window, a section, a layout. Walls, columns, beams
 * and slabs carry no marker, which is why they create happily from 3D and only
 * openings fail.
 *
 * Confirmed against ArchiCAD 29 / Tapir 1.5.8: identical payloads that failed
 * with the 3D window active succeeded immediately after `ChangeWindow` to
 * FloorPlan. Tapir 1.5.8 does not switch on its own (a later version does), so
 * this bridge switches around the opening calls itself.
 */
export const BAD_DATABASE = -2130313110;

/** The window kinds `ChangeWindow` understands that this bridge uses. */
export type WindowType = 'FloorPlan' | '3DModel' | string;

export class TapirError extends Error {
  constructor(public command: string, message: string, public code?: number) {
    super(`${command}: ${message}`);
    this.name = 'TapirError';
  }
}

/** Raised when nothing answers on the port — almost always "ArchiCAD isn't open". */
export class TapirUnreachable extends Error {
  constructor(url: string, cause: unknown) {
    super(
      `Could not reach ArchiCAD at ${url}. Start ArchiCAD and open a project `
      + `(the API server only answers once a project window exists). Cause: ${cause}`,
    );
    this.name = 'TapirUnreachable';
  }
}

export class TapirClient {
  constructor(private url: string = DEFAULT_TAPIR_URL) {}

  /** An official Graphisoft command (the `API.*` namespace). */
  async call(command: string, parameters: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, parameters }),
      });
    } catch (err) {
      throw new TapirUnreachable(this.url, err);
    }
    if (!res.ok) throw new TapirError(command, `HTTP ${res.status}`);

    const body = await res.json() as {
      succeeded?: boolean;
      result?: Record<string, unknown>;
      error?: { code?: number; message?: string };
    };
    if (!body.succeeded) {
      throw new TapirError(command, body.error?.message ?? 'command failed', body.error?.code);
    }
    return body.result ?? {};
  }

  /** A Tapir add-on command, unwrapped from its `addOnCommandResponse` envelope. */
  async tapir<T = Record<string, unknown>>(
    name: string,
    parameters: Record<string, unknown> = {},
  ): Promise<T> {
    const result = await this.call('API.ExecuteAddOnCommand', {
      addOnCommandId: { commandNamespace: 'TapirCommand', commandName: name },
      addOnCommandParameters: parameters,
    });
    return (result.addOnCommandResponse ?? {}) as T;
  }

  // ── The calls this bridge actually needs ──────────────────────────────────

  async productInfo(): Promise<{ version: number; buildNumber: number; languageCode: string }> {
    return await this.call('API.GetProductInfo') as never;
  }

  async addOnVersion(): Promise<string> {
    const r = await this.tapir<{ version?: string }>('GetAddOnVersion');
    return r.version ?? 'unknown';
  }

  async projectInfo(): Promise<{ isUntitled: boolean; isTeamwork: boolean; projectPath?: string }> {
    return await this.tapir('GetProjectInfo');
  }

  async elementsByType(elementType: string): Promise<ElementId[]> {
    const r = await this.tapir<{ elements?: ElementId[] }>('GetElementsByType', { elementType });
    return r.elements ?? [];
  }

  async deleteElements(elements: ElementId[]): Promise<void> {
    if (elements.length === 0) return;
    await this.tapir('DeleteElements', { elements });
  }

  /**
   * Run a create command and return one entry per input item: its GUID, or null
   * if ArchiCAD refused that particular element.
   *
   * Order matches the input array — verified against ArchiCAD 29 by creating
   * three walls at distinct coordinates and reading each GUID's geometry back.
   * Opening placement depends on it, since windows reference their host wall by
   * position in the walls array.
   *
   * The command as a whole reports `succeeded` even when individual items fail,
   * and a failed item comes back without an `elementId` — so per-item nulls are
   * a normal outcome, not a parse error.
   */
  async create(command: string, arrayKey: string, items: unknown[]): Promise<CreateOutcome[]> {
    if (items.length === 0) return [];
    type Entry = Partial<ElementId> & { error?: { code?: number; message?: string } };
    const r = await this.tapir<{ elements?: Entry[] }>(command, { [arrayKey]: items });
    const elements = r.elements ?? [];
    return items.map((_, i) => {
      const guid = elements[i]?.elementId?.guid;
      if (guid) return { guid };
      const err = elements[i]?.error;
      return { guid: null, code: err?.code, message: err?.message ?? 'no response for this item' };
    });
  }

  /**
   * 3D bounding boxes, in input order. Used to check that what ArchiCAD built
   * is the size we asked for — some commands silently substitute the tool's
   * own composite and ignore the thickness in the payload.
   */
  async boundingBoxes(elements: ElementId[]): Promise<({ zMin: number; zMax: number } | null)[]> {
    if (elements.length === 0) return [];
    const r = await this.call('API.Get3DBoundingBoxes', { elements }) as {
      boundingBoxes3D?: { boundingBox3D?: { zMin: number; zMax: number } }[];
    };
    return elements.map((_, i) => r.boundingBoxes3D?.[i]?.boundingBox3D ?? null);
  }

  /** Which window is current — the thing `BAD_DATABASE` is really complaining about. */
  async currentWindowType(): Promise<WindowType> {
    const r = await this.tapir<{ currentWindowType?: string }>('GetCurrentWindowType');
    return r.currentWindowType ?? 'unknown';
  }

  /** Bring a window to the front, which also makes it the current database. */
  async changeWindow(windowType: WindowType): Promise<void> {
    await this.tapir('ChangeWindow', { windowType });
  }

  async setStories(stories: unknown[]): Promise<void> {
    if (stories.length === 0) return;
    await this.tapir('SetStories', { stories });
  }
}
