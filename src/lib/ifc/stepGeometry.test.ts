/**
 * Text in, text out: these pin the STEP the writer produces against a small
 * hand-written file, so a change in numbering, referencing or cleanup shows
 * up here before it shows up as a viewer silently dropping an element.
 */
import { describe, expect, it } from 'vitest';
import {
  StepWriter, fileRefs, fillParts, ifcGuid, isReferenced, readEntity, refsIn,
  removeUnreferenced, replaceFillGeometry, voidElements, clipElements,
  type FillSpec, type ClipSpec,
} from './stepGeometry';

/** The skeleton `@ifc-lite/create` writes, down to the ids that matter. */
const HEAD = [
  'ISO-10303-21;', 'HEADER;', "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
  '#5=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,1);',
  '#6=IFCCARTESIANPOINT((0.,0.,0.));',
  '#7=IFCDIRECTION((0.,0.,1.));',
  '#8=IFCDIRECTION((1.,0.,0.));',
  '#9=IFCAXIS2PLACEMENT3D(#6,#7,#8);',
  '#10=IFCLOCALPLACEMENT($,#9);',
  "#11=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#9,$);",
  "#12=IFCGEOMETRICREPRESENTATIONSUBCONTEXT($,'Body',*,*,*,*,#11,$,.MODEL_VIEW.,$);",
];

/** A wall-like host at #30 whose placement is #20. */
const HOST = [
  '#20=IFCLOCALPLACEMENT(#10,#9);',
  '#21=IFCCARTESIANPOINT((0.,0.));',
  '#22=IFCAXIS2PLACEMENT2D(#21,$);',
  '#23=IFCRECTANGLEPROFILEDEF(.AREA.,$,#22,4.,0.2);',
  '#24=IFCCARTESIANPOINT((0.,0.,0.));',
  '#25=IFCAXIS2PLACEMENT3D(#24,$,$);',
  '#26=IFCEXTRUDEDAREASOLID(#23,#25,#7,3.);',
  "#27=IFCSHAPEREPRESENTATION(#12,'Body','SweptSolid',(#26));",
  '#28=IFCPRODUCTDEFINITIONSHAPE($,$,(#27));',
  "#30=IFCWALL('0abc',#5,'Shell',$,'Shell',#20,#28,'sh:ring:0',.NOTDEFINED.);",
];

const file = (...extra: string[]) => [...HEAD, ...HOST, ...extra, 'ENDSEC;', 'END-ISO-10303-21;'].join('\n');
const count = (text: string, type: string) => (text.match(new RegExp(`=${type}\\(`, 'g')) ?? []).length;

describe('ifcGuid', () => {
  it('is 22 characters of the IFC alphabet, starting inside the first byte\'s range', () => {
    for (let i = 0; i < 50; i++) {
      const g = ifcGuid();
      expect(g).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
    }
  });

  it('encodes a known byte pattern deterministically', () => {
    const zeros = ifcGuid((b) => b.fill(0));
    expect(zeros).toBe('0'.repeat(22));
    const ones = ifcGuid((b) => b.fill(255));
    expect(ones).toBe('3$' + '$'.repeat(20));
  });
});

describe('StepWriter', () => {
  it('numbers on from the file\'s last id and appends before ENDSEC', () => {
    const w = new StepWriter(file());
    const id = w.point3([1, 2, 3]);
    expect(id).toBe(31);
    const out = w.apply();
    expect(out).toContain('#31=IFCCARTESIANPOINT((1.,2.,3.));\nENDSEC;');
  });

  it('shares one style per (name, colour, opacity)', () => {
    const w = new StepWriter(file());
    const a = w.style('Glass', { r: 0, g: 0.5, b: 1 }, 0.35);
    const b = w.style('Glass', { r: 0, g: 0.5, b: 1 }, 0.35);
    const c = w.style('Glass', { r: 0, g: 0.5, b: 1 }, 1);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    // Colour #31, rendering #32 pointing at it, with Transparency = 1 − 0.35.
    expect(w.apply()).toContain('#32=IFCSURFACESTYLERENDERING(#31,0.65,');
  });
});

describe('fileRefs / readEntity', () => {
  it('finds the owner history and the Body sub-context', () => {
    expect(fileRefs(file())).toEqual({ ownerHistory: 5, bodyContext: 12 });
  });

  it('reads an entity with its list arguments intact', () => {
    const e = readEntity(file(), 27)!;
    expect(e.type).toBe('IFCSHAPEREPRESENTATION');
    expect(refsIn(e.args[3])).toEqual([26]);
  });

  it('tells a reference from a definition', () => {
    expect(isReferenced(file(), 26)).toBe(true);     // the representation lists it
    expect(isReferenced(file(), 30)).toBe(false);    // nothing points at the wall
    expect(isReferenced('#1=X(#12);\n#12=Y();', 1)).toBe(false);   // #12 is not #1
  });
});

describe('voidElements', () => {
  it('cuts an opening into the host, placed relative to the host', () => {
    const out = voidElements(file(), [{
      hostId: 30, name: 'W1 opening',
      location: [1.5, 0, 0.9], axis: [0, 1, 0], refDirection: [1, 0, 0],
      width: 1.2, height: 1.4, depth: 0.6,
    }]);
    expect(count(out, 'IFCOPENINGELEMENT')).toBe(1);
    expect(count(out, 'IFCRELVOIDSELEMENT')).toBe(1);
    // The relation names the host, and the opening's placement hangs off #20.
    expect(out).toMatch(/IFCRELVOIDSELEMENT\('[^']+',#5,\$,\$,#30,#\d+\)/);
    expect(out).toMatch(/IFCLOCALPLACEMENT\(#20,#\d+\)/);
    // Width across, height up, depth through.
    expect(out).toContain('IFCRECTANGLEPROFILEDEF(.AREA.,$,#');
    expect(out).toMatch(/IFCRECTANGLEPROFILEDEF\(\.AREA\.,\$,#\d+,1\.2,1\.4\)/);
    expect(out).toMatch(/IFCEXTRUDEDAREASOLID\(#\d+,#\d+,#\d+,0\.6\)/);
    expect(out.trim().endsWith('END-ISO-10303-21;')).toBe(true);
  });

  it('skips a host that is not in the file and leaves the text as it was', () => {
    const src = file();
    expect(voidElements(src, [{
      hostId: 999, name: 'x', location: [0, 0, 0], axis: [0, 1, 0], refDirection: [1, 0, 0],
      width: 1, height: 1, depth: 1,
    }])).toBe(src);
  });
});

const WINDOW = [
  '#40=IFCCARTESIANPOINT((0.,0.5));',
  '#41=IFCAXIS2PLACEMENT2D(#40,$);',
  '#42=IFCRECTANGLEPROFILEDEF(.AREA.,$,#41,1.,1.);',
  '#43=IFCCARTESIANPOINT((0.,0.,0.));',
  '#44=IFCAXIS2PLACEMENT3D(#43,$,$);',
  '#45=IFCEXTRUDEDAREASOLID(#42,#44,#7,0.2);',
  "#46=IFCSHAPEREPRESENTATION(#12,'Body','SweptSolid',(#45));",
  '#47=IFCPRODUCTDEFINITIONSHAPE($,$,(#46));',
  '#48=IFCLOCALPLACEMENT(#20,#9);',
  "#50=IFCWINDOW('0win',#5,'W1',$,$,#48,#47,$,1.,1.,.NOTDEFINED.,.SINGLE_PANEL.,$);",
  '#60=IFCCOLOURRGB($,0.2,0.7,0.9);',
  '#61=IFCSURFACESTYLERENDERING(#60,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.5),IFCSPECULAREXPONENT(64.),.NOTDEFINED.);',
  "#62=IFCSURFACESTYLE('window 55%',.BOTH.,(#61));",
  '#63=IFCSTYLEDITEM(#45,(#62),$);',
];

const spec = (over: Partial<FillSpec> = {}): FillSpec => ({
  elementId: 50, kind: 'window', width: 1, height: 1, depth: 0.2, profile: 0.05, double: false,
  frame: { r: 0.2, g: 0.2, b: 0.25 }, panel: { r: 0.1, g: 0.4, b: 0.7 }, panelOpacity: 0.35, ...over,
});

describe('fillParts', () => {
  it('a single window: two stiles, two rails, one pane', () => {
    const parts = fillParts(spec());
    expect(parts.map((p) => p.part)).toEqual(['frame', 'frame', 'frame', 'frame', 'panel']);
    const pane = parts[4].box;
    expect(pane.w).toBeCloseTo(0.9, 9);
    expect(pane.h).toBeCloseTo(0.9, 9);
    expect(pane.depth).toBeCloseTo(0.008, 9);
    expect(pane.z0 + pane.depth / 2).toBeCloseTo(0.1, 9);    // centred in the depth
  });

  it('a double window adds a mullion and splits the glass', () => {
    const parts = fillParts(spec({ double: true, width: 2 }));
    expect(parts.filter((p) => p.part === 'panel')).toHaveLength(2);
    expect(parts.filter((p) => p.part === 'frame')).toHaveLength(5);
  });

  it('a door has no bottom rail and a thick leaf standing on the sill', () => {
    const parts = fillParts(spec({ kind: 'door', height: 2.1 }));
    expect(parts.filter((p) => p.part === 'frame')).toHaveLength(3);
    const leaf = parts.find((p) => p.part === 'panel')!.box;
    expect(leaf.depth).toBeCloseTo(0.04, 9);
    expect(leaf.cy - leaf.h / 2).toBeCloseTo(0, 9);
  });

  it('an opening too small for a frame is one panel, not nothing', () => {
    expect(fillParts(spec({ width: 0.08 }))).toHaveLength(1);
  });
});

describe('replaceFillGeometry', () => {
  it('points the window at its new parts and cleans the old box away', () => {
    const out = replaceFillGeometry(file(...WINDOW), [spec()]);
    const rep = readEntity(out, 46)!;
    expect(refsIn(rep.args[3])).toHaveLength(5);
    expect(refsIn(rep.args[3])).not.toContain(45);
    // The old solid, its profile chain and its styled item are gone…
    for (const id of [40, 41, 42, 43, 44, 45, 63]) expect(readEntity(out, id)).toBeNull();
    // …but the shared axis direction and the window itself are not.
    expect(readEntity(out, 7)).not.toBeNull();
    expect(readEntity(out, 50)!.args[6]).toBe('#47');
    expect(count(out, 'IFCEXTRUDEDAREASOLID')).toBe(1 /* host */ + 5);
  });

  it('styles the frame opaque and the glass translucent', () => {
    const out = replaceFillGeometry(file(...WINDOW), [spec()]);
    expect(out).toContain("IFCSURFACESTYLE('Window frame'");
    expect(out).toContain("IFCSURFACESTYLE('Glass 35%'");
    expect(out).toMatch(/IFCSURFACESTYLERENDERING\(#\d+,0\.65,/);
    expect(count(out, 'IFCSTYLEDITEM')).toBe(5);
  });

  it('leaves an unknown element alone', () => {
    const src = file(...WINDOW);
    expect(replaceFillGeometry(src, [spec({ elementId: 999 })])).toBe(src);
  });
});

describe('removeUnreferenced', () => {
  it('cascades: dropping the solid frees its profile, which frees its placement', () => {
    // Nothing lists the solid now: not the representation, not the styled item.
    const text = file(...WINDOW.filter((l) => !l.startsWith('#63='))).replace('(#45)', '()');
    const out = removeUnreferenced(text, [45, 42, 41, 40, 44, 43]);
    for (const id of [40, 41, 42, 43, 44, 45]) expect(readEntity(out, id)).toBeNull();
  });

  it('keeps what something still points at', () => {
    const out = removeUnreferenced(file(...WINDOW), [45, 42]);
    expect(readEntity(out, 45)).not.toBeNull();   // #46 lists it
    expect(readEntity(out, 42)).not.toBeNull();   // #45 uses it
  });
});

describe('clipElements', () => {
  // The wall stays a swept solid so it can go on hosting openings, so a
  // mitred corner has to arrive as a half-space taken off the body.
  const clip = (over: Partial<ClipSpec> = {}): ClipSpec => ({
    hostId: 30, location: [0.1, 0, 0], normal: [-1, 0, 0], ...over,
  });

  it('wraps the body in a boolean and retypes the representation', () => {
    const out = clipElements(file(), [clip()]);
    expect(count(out, 'IFCPLANE')).toBe(1);
    expect(count(out, 'IFCHALFSPACESOLID')).toBe(1);
    expect(count(out, 'IFCBOOLEANCLIPPINGRESULT')).toBe(1);
    const rep = readEntity(out, 27)!;
    // 'SweptSolid' would tell a reader to expect a swept solid it will not find.
    expect(rep.args[2]).toBe("'CSG'");
    const boolean = refsIn(rep.args[3])[0];
    expect(readEntity(out, boolean)!.type).toBe('IFCBOOLEANCLIPPINGRESULT');
  });

  it('subtracts, and subtracts from the original solid', () => {
    const out = clipElements(file(), [clip()]);
    const b = readEntity(out, refsIn(readEntity(out, 27)!.args[3])[0])!;
    expect(b.args[0]).toBe('.DIFFERENCE.');
    expect(refsIn(b.args[1])[0]).toBe(26);         // the wall's own extrusion
    expect(readEntity(out, refsIn(b.args[2])[0])!.type).toBe('IFCHALFSPACESOLID');
  });

  it('chains a second plane onto the first result', () => {
    const out = clipElements(file(), [clip(), clip({ location: [3.9, 0, 0], normal: [1, 0, 0] })]);
    expect(count(out, 'IFCBOOLEANCLIPPINGRESULT')).toBe(2);
    const outer = readEntity(out, refsIn(readEntity(out, 27)!.args[3])[0])!;
    // The outer boolean's first operand is the inner one, not the raw solid:
    // two clips must compose, not compete.
    expect(readEntity(out, refsIn(outer.args[1])[0])!.type).toBe('IFCBOOLEANCLIPPINGRESULT');
  });

  it('puts the plane where it was asked to, facing the way it was asked to', () => {
    const out = clipElements(file(), [clip({ location: [1.5, 0.25, 0], normal: [0, 1, 0] })]);
    const half = readEntity(out, refsIn(readEntity(out, refsIn(readEntity(out, 27)!.args[3])[0])!.args[2])[0])!;
    const plane = readEntity(out, refsIn(half.args[0])[0])!;
    const axis2 = readEntity(out, refsIn(plane.args[0])[0])!;
    expect(readEntity(out, refsIn(axis2.args[0])[0])!.args[0]).toBe('(1.5,0.25,0.)');
    // The placement's Z is the plane normal — the side that goes.
    expect(readEntity(out, refsIn(axis2.args[1])[0])!.args[0]).toBe('(0.,1.,0.)');
  });

  it('leaves a file with nothing to clip exactly as it was', () => {
    const f = file();
    expect(clipElements(f, [])).toBe(f);
    // A host that is not in the file is skipped, not guessed at.
    expect(clipElements(f, [clip({ hostId: 999 })])).toBe(f);
  });

  it('does not disturb the host itself', () => {
    const out = clipElements(file(), [clip()]);
    expect(readEntity(out, 30)!.args).toEqual(readEntity(file(), 30)!.args);
  });
});
