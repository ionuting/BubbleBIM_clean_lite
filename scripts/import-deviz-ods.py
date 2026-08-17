#!/usr/bin/env python3
"""
Import norm articles from a LibreOffice DEVIZ PE CATEGORII.ods file
into src/lib/norms/devizZidarieConfinata.json.

Usage:
  python3 scripts/import-deviz-ods.py [path/to/file.ods]

Default input: data/norms/DEVIZ_PE_CATEGORII.ods
"""

from __future__ import annotations

import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ODS = ROOT / "data/norms/DEVIZ_PE_CATEGORII.ods"
OUT_JSON = ROOT / "src/lib/norms/devizZidarieConfinata.json"

NS = {
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
}


def cell_text(cell) -> str:
    parts = []
    for p in cell.findall(".//text:p", NS):
        if p.text:
            parts.append(p.text)
        for child in p:
            if child.tail:
                parts.append(child.tail)
    return "".join(parts).strip()


def row_cells(row) -> list[str]:
    cells = []
    for c in row.findall("table:table-cell", NS):
        repeat = int(c.get("{urn:oasis:names:tc:opendocument:xmlns:table:1.0}number-columns-repeated", "1"))
        t = cell_text(c)
        if repeat > 1 and not t:
            continue
        cells.append(t)
    return cells


def normalize_unit(um: str) -> str:
    return {"M CUB": "mc", "MP": "mp", "KG": "kg", "M": "ml"}.get(um.upper().strip(), um.lower())


def parse_ods(ods_path: Path) -> dict:
    with zipfile.ZipFile(ods_path) as zf:
        content = zf.read("content.xml")
    root = ET.fromstring(content)

    articles = []
    categories: list[str] = []

    for sheet in root.findall(".//table:table", NS):
        rows = sheet.findall("table:table-row", NS)
        categorie = None
        categorie_code = None
        i = 0
        while i < len(rows):
            cells = row_cells(rows[i])
            joined = " ".join(cells)
            if joined.startswith("Categorie:"):
                raw = re.sub(r"\s*\[.*?\]\s*", "", joined.replace("Categorie:", "").strip())
                parts = raw.split(None, 1)
                categorie_code = parts[0]
                categorie = parts[1] if len(parts) > 1 else parts[0]
                if categorie not in categories:
                    categories.append(categorie)
                i += 1
                continue

            if (
                len(cells) >= 5
                and cells[1].isdigit()
                and re.match(r"^[A-Z0-9]", cells[2])
                and cells[3].upper() in ("M CUB", "MP", "KG", "M")
            ):
                symbol = cells[2].strip()
                desc_lines: list[str] = []
                j = i + 1
                while j < len(rows):
                    fc = row_cells(rows[j])
                    if len(fc) >= 2 and fc[1].startswith("Sp.mat"):
                        j += 1
                        continue
                    if len(fc) >= 2 and fc[1].isdigit() and len(fc) >= 4 and re.match(r"^[A-Z0-9]", fc[2]):
                        break
                    if any("Total" in x for x in fc):
                        break
                    if (
                        len(fc) >= 2
                        and fc[1]
                        and not fc[1].startswith("Sp.mat")
                        and not fc[1].replace(".", "").replace(",", "").isdigit()
                    ):
                        desc_lines.append(fc[1])
                    j += 1

                denumire = re.sub(r"\s+", " ", " ".join(desc_lines)).strip() or symbol
                art_id = f"{categorie_code}_{re.sub(r'[^A-Za-z0-9]+', '_', symbol)}"
                articles.append(
                    {
                        "id": art_id,
                        "symbol": symbol,
                        "denumire": denumire,
                        "unit": normalize_unit(cells[3]),
                        "categorie": categorie,
                        "categorie_code": categorie_code,
                        "capitol": "4. Investiție de bază",
                    }
                )
                i = j
                continue
            i += 1

    return {
        "source": ods_path.name,
        "catalogVersion": "deviz-zidarie-confinata-1",
        "categories": categories,
        "articles": articles,
    }


def main() -> None:
    ods_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_ODS
    if not ods_path.exists():
        print(f"Error: file not found: {ods_path}", file=sys.stderr)
        sys.exit(1)

    data = parse_ods(ods_path)
    OUT_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Imported {len(data['articles'])} articles in {len(data['categories'])} categories")
    print(f"Wrote {OUT_JSON}")


if __name__ == "__main__":
    main()
