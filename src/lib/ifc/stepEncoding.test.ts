import { describe, expect, it } from 'vitest';
import { addQuantityFormula, encodeStepUnicode } from './stepEncoding';

describe('STEP strings', () => {
  it('escapes Romanian diacritics as UTF-16 and leaves ASCII alone', () => {
    expect(encodeStepUnicode("#1=IFCCOLUMN('g',#5,'Stâlp prispă 1',$);"))
      .toBe("#1=IFCCOLUMN('g',#5,'St\\X2\\00E2\\X0\\lp prisp\\X2\\0103\\X0\\ 1',$);");
    expect(encodeStepUnicode("'Șindrilă'")).toBe("'\\X2\\0218\\X0\\indril\\X2\\0103\\X0\\'");
    expect(encodeStepUnicode('plain ascii')).toBe('plain ascii');
  });

  it('writes a run of characters as one escape, and astral ones with \\X4\\', () => {
    expect(encodeStepUnicode('ăâ')).toBe('\\X2\\01030\\X0\\'.replace('01030', '010300E2'));
    expect(encodeStepUnicode('a😀b')).toBe('a\\X4\\0001F600\\X0\\b');
  });

  it('is decoded back by web-ifc, the engine the viewers use', async () => {
    const WebIFC = await import('web-ifc');
    const { createRequire } = await import('node:module');
    const path = await import('node:path');
    const api = new WebIFC.IfcAPI();
    api.SetWasmPath(path.dirname(createRequire(import.meta.url).resolve('web-ifc')) + '/', true);
    await api.Init();
    const { buildIfcModel } = await import('./buildIfcModel');
    const storey = { id: 'st', type: 'storey', name: 'Parter și pod', x: 0, y: 0, z: 0, properties: { bottomElevation: 0, topElevation: 2800, axesX: [0, 5000], axesY: [0, 4000] } };
    const { content } = buildIfcModel([storey] as never, [], 'Casă');
    expect(/[^\x00-\x7F]/.test(content)).toBe(false);
    const model = api.OpenModel(new TextEncoder().encode(content));
    const ids = api.GetLineIDsWithType(model, WebIFC.IFCBUILDINGSTOREY);
    expect(api.GetLine(model, ids.get(0)).Name.value).toBe('Parter și pod');
    api.CloseModel(model);
  }, 60000);
});

describe('IFC4 quantities', () => {
  const text = [
    "#10=IFCQUANTITYLENGTH('Perimeter',$,$,3.6);",
    "#11=IFCQUANTITYAREA('A, with comma',$,$,0.45);",
    "#12=IFCQUANTITYVOLUME('V',$,$,1.,$);",
    "#13=IFCWALL('g',#5,'W',$,$,#1,#2,'t',.NOTDEFINED.);",
  ].join('\n');

  it('adds the unset Formula to four-attribute quantities only', () => {
    const out = addQuantityFormula(text, 'IFC4').split('\n');
    expect(out[0]).toBe("#10=IFCQUANTITYLENGTH('Perimeter',$,$,3.6,$);");
    expect(out[1]).toBe("#11=IFCQUANTITYAREA('A, with comma',$,$,0.45,$);");
    expect(out[2]).toBe("#12=IFCQUANTITYVOLUME('V',$,$,1.,$);");
    expect(out[3]).toBe("#13=IFCWALL('g',#5,'W',$,$,#1,#2,'t',.NOTDEFINED.);");
  });

  it('leaves IFC2X3, which has no Formula, as it is', () => {
    expect(addQuantityFormula(text, 'IFC2X3')).toBe(text);
  });
});
