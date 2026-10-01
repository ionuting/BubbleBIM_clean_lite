import { describe, expect, it } from 'vitest';
import { productsByColour, readIndexedColours } from './indexedColours';
import { colourPerBody } from './ifcFragments';

/**
 * A wall with two face sets of its own (one red, one mostly blue), an
 * axis representation that must not count, and a door whose body is a
 * mapped item — its type's representation — written over two lines.
 */
const IFC = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('0abc',$,'Wall',$,$,$,#10,$,$);
#10=IFCPRODUCTDEFINITIONSHAPE($,$,(#11,#12));
#11=IFCSHAPEREPRESENTATION(#99,'Axis','Curve2D',(#50));
#12=IFCSHAPEREPRESENTATION(#99,'Body','Tessellation',(#20,#21,#22));
#20=IFCTRIANGULATEDFACESET(#90,$,.T.,((1,2,3)),$);
#21=IFCPOLYGONALFACESET(#90,.T.,(#80),$);
#22=IFCEXTRUDEDAREASOLID(#91,$,#92,1.);
#30=IFCINDEXEDCOLOURMAP(#20,1.,#31,(1));
#31=IFCCOLOURRGBLIST(((1.,0.,0.)));
#32=IFCINDEXEDCOLOURMAP(#21,0.5,#33,(1,2,2,2));
#33=IFCCOLOURRGBLIST(((1.,1.,1.),(0.,0.,1.)));
#2=IFCDOOR('0def',$,'Door;with;semicolons',$,$,$,
  #40,$,$,$,$,$,$);
#40=IFCPRODUCTDEFINITIONSHAPE($,$,(#41));
#41=IFCSHAPEREPRESENTATION(#99,'Body','MappedRepresentation',(#42));
#42=IFCMAPPEDITEM(#43,#98);
#43=IFCREPRESENTATIONMAP(#97,#44);
#44=IFCSHAPEREPRESENTATION(#99,'Body','Tessellation',(#45));
#45=IFCTRIANGULATEDFACESET(#90,$,.T.,((1,2,3)),$);
#46=IFCINDEXEDCOLOURMAP(#45,1.,#47,(1));
#47=IFCCOLOURRGBLIST(((0.5,0.25,0.)));
#3=IFCSLAB('0ghi',$,'Slab',$,$,$,#60,$,$);
#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#61=IFCSHAPEREPRESENTATION(#99,'Body','SweptSolid',(#62));
#62=IFCEXTRUDEDAREASOLID(#91,$,#92,1.);
ENDSEC;
END-ISO-10303-21;`;

describe('readIndexedColours', () => {
  it('pairs every body item with its map colour, in representation order', () => {
    const m = readIndexedColours(IFC);
    expect(m.get(1)).toEqual([
      { item: 20, colour: { rgb: [1, 0, 0], opacity: 1 } },
      // Three faces of four are blue: the colour on the most faces wins.
      { item: 21, colour: { rgb: [0, 0, 1], opacity: 0.5 } },
      { item: 22, colour: null },
    ]);
  });

  it('follows a mapped item to the representation it maps, across a wrapped line', () => {
    expect(readIndexedColours(IFC).get(2)).toEqual([{ item: 45, colour: { rgb: [0.5, 0.25, 0], opacity: 1 } }]);
  });

  it('leaves out products no map colours, and files with no maps at all', () => {
    expect(readIndexedColours(IFC).has(3)).toBe(false);
    expect(readIndexedColours(IFC.replace(/IFCINDEXEDCOLOURMAP/g, 'IFCSOMETHINGELSE')).size).toBe(0);
  });
});

describe('colourPerBody', () => {
  const red = { rgb: [1, 0, 0] as [number, number, number], opacity: 1 };
  const blue = { rgb: [0, 0, 1] as [number, number, number], opacity: 1 };

  it('pairs by position when the counts agree', () => {
    expect(colourPerBody([{ item: 1, colour: red }, { item: 2, colour: null }], 2)).toEqual([red, null]);
  });

  it('colours every body when the counts differ but the colour is one', () => {
    expect(colourPerBody([{ item: 1, colour: red }, { item: 2, colour: { ...red } }], 3)).toEqual([red, red, red]);
  });

  it('colours nothing when the counts differ and the colours do', () => {
    expect(colourPerBody([{ item: 1, colour: red }, { item: 2, colour: blue }], 3)).toEqual([null, null, null]);
    expect(colourPerBody([{ item: 1, colour: red }, { item: 2, colour: null }], 3)).toEqual([null, null, null]);
    expect(colourPerBody(undefined, 2)).toEqual([null, null]);
  });
});

describe('productsByColour', () => {
  it('groups products by the colour most of their bodies have', () => {
    const groups = productsByColour(readIndexedColours(IFC));
    const byId = new Map(groups.flatMap((g) => g.ids.map((id) => [id, g.colour] as const)));
    // The wall's two coloured bodies tie; the first seen wins.
    expect(byId.get(1)).toEqual({ rgb: [1, 0, 0], opacity: 1 });
    expect(byId.get(2)).toEqual({ rgb: [0.5, 0.25, 0], opacity: 1 });
    expect(byId.has(3)).toBe(false);
  });
});
