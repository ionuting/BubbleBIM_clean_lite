# BubbleBIM — Strategic Digitalization Partnership Response

**Document purpose:** This paper explains how **BubbleBIM** (BubbleGraph BIM platform), built on a **relational graph data model**, can address the requirements and contribution areas described in the *Invitation To Market Dialogue About A Strategic Digitalization Partnership*.

**Audience:** Contractor leadership, digital strategy, IT architecture, project delivery, and procurement teams evaluating strategic digitalization partners.

**Language:** English  
**Version:** 1.1  
**Date:** June 2026

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Understanding the Invitation](#2-understanding-the-invitation)
3. [BubbleBIM Platform Overview](#3-bubblebim-platform-overview)
4. [Relational Database Foundation](#4-relational-database-foundation)
5. [Contribution Area 1 — Digital Strategy and Transformation](#5-contribution-area-1--digital-strategy-and-transformation)
6. [Contribution Area 2 — Portfolio Management, Prioritization, and Benefit Realization](#6-contribution-area-2--portfolio-management-prioritization-and-benefit-realization)
7. [Contribution Area 3 — Organization, Work Processes, and Change Capacity](#7-contribution-area-3--organization-work-processes-and-change-capacity)
8. [Contribution Area 4 — Technology Architecture, Data Foundation, and Artificial Intelligence](#8-contribution-area-4--technology-architecture-data-foundation-and-artificial-intelligence)
9. [Contribution Area 5 — Project-Near Digitalization, Collaboration, and Specialized Solutions](#9-contribution-area-5--project-near-digitalization-collaboration-and-specialized-solutions)
10. [Alignment with the Contractor’s Existing Digital Foundation](#10-alignment-with-the-contractors-existing-digital-foundation)
11. [Industry Understanding and Reference Experience](#11-industry-understanding-and-reference-experience)
12. [Proposed Approach and Collaboration Model](#12-proposed-approach-and-collaboration-model)
13. [Delivery in Practice — From Recommendation to Lasting Effect](#13-delivery-in-practice--from-recommendation-to-lasting-effect)
14. [Gap Analysis and Roadmap](#14-gap-analysis-and-roadmap)
15. [Complementary Field Operations and Digital Workplace Platform](#15-complementary-field-operations-and-digital-workplace-platform)
16. [Conclusion](#16-conclusion)

---

## 1. Executive Summary

The invitation describes a **project-intensive contractor** entering a new business and digital strategy phase. The company seeks partners who can move beyond advice and deliver **measurable value** across:

- Digital strategy linked to business outcomes  
- Prioritized portfolio management and benefit realization  
- Organizational change and process adoption  
- Technology architecture, data foundations, analytics, automation, and AI  
- **Project-near** digital solutions for delivery, collaboration, and efficiency  

**BubbleBIM** is a construction-oriented BIM platform whose core design principle is that **building information lives in a relational graph** — nodes (building elements, spaces, axes, metadata) connected by typed edges (structural relationships, containment, connectivity). This is not a drawing tool with attached metadata; it is a **data-first model** from which 3D geometry, 2D drawings, quantities, and analytics are **derived**.

BubbleBIM directly supports the contractor’s ambition to:

| Contractor need (from invitation) | BubbleBIM response |
|-----------------------------------|-------------------|
| Strengthen project execution and productivity | Single relational model → 3D, plans, sections, BOQ from one source |
| Data-driven decision support | Queryable graph + quantity takeoff + exportable datasets |
| Flexibility in technology choices | Open formats (IFC, JSON, CSV, STEP library assets), modular viewers |
| Project-near digitalization | Floor plans, technical drawings, site-relevant quantities (F3/deviz) |
| AI and automation | LLM-assisted IFC import, natural-language graph queries (Ollama) |
| Safe, practical technology adoption | Desktop, web, and lite demo deployments; incremental rollout |
| **Office and site operations** | SharePoint-native field platform: asset tracking, fleet GPS, HR, planning, offline mobile |
| **Microsoft 365 alignment** | Azure AD SSO, Graph calendar/mail, SharePoint lists as operational data store |
| **Infrastructure / rail-adjacent work** | Weekly crew orders, geo-located sites, qualification matrices, module logistics |

The response covers a **dual-layer digital delivery portfolio**:

1. **BubbleBIM** — relational BIM model, drawings, quantities, design-construction interface  
2. **Field Operations Platform** — production-ready M365-native application for assets, fleet, workplace, HR, and weekly crew planning on site  

Together these address the invitation’s full scope from **design model** through **site execution**, without requiring the contractor to replace its existing Microsoft 365 core.

BubbleBIM and the field operations platform are positioned as **specialized layers** within the contractor’s broader digital ecosystem (Microsoft 365, data warehouse, existing PM tools), not as replacements for the entire IT landscape.

---

## 2. Understanding the Invitation

### 2.1 Context

The contractor:

- Operates in **construction and infrastructure** with high operational complexity  
- Already has a digital foundation: project management tools, **Microsoft 365**, internal development, cloud solutions, and a **data warehouse** for business insight  
- Needs a **holistic assessment** of system landscape, data flows, work processes, and governance  
- Wants partners who combine **strategic advisory**, **technology depth**, and **documented implementation ability**  
- Runs a **Request for Digital Transformation** process — between RFI and RFP — to identify environments that create **real change**, not only recommendations  

### 2.2 Five Contribution Areas (from the PDF)

The invitation asks suppliers to contribute in one or more of:

1. **Digital strategy and transformation** — connect business strategy, digital ambitions, and technology to clear business value  
2. **Portfolio management, prioritization, and benefit realization** — prioritize, manage, and follow up initiatives from idea to realized effect  
3. **Organization, work processes, and change capacity** — strengthen digital maturity and operational adoption  
4. **Technology architecture, data foundation, and artificial intelligence** — system landscape, data, insight, analytics, automation, decision support  
5. **Project-near digitalization, collaboration, and specialized solutions** — concrete solutions for project management, collaboration, and efficiency  

### 2.3 What Suppliers Must Demonstrate

- Documented **industry understanding** (construction/infrastructure, project-intensive complexity)  
- **Reference experience** with comparable transformation work  
- **Approach and collaboration model**  
- **Team, capacity, and continuity**  
- **Ability to deliver in practice** — recommendations → deliverables → implementation → lasting effects  

The sections below map BubbleBIM to each of these expectations.

---

## 3. BubbleBIM Platform Overview

### 3.1 Vision

BubbleBIM (internally “BubbleGraph BIM”) is designed as a **full BIM platform** inspired by ArchiCAD and Revit, where:

1. A **relational node–edge graph** is the authoritative project model  
2. **3D parametric geometry** is generated from graph data (Babylon.js, Three.js, OpenGeometry WASM, WebIFC)  
3. **2D orthographic views** (floor plans, sections, elevations) are derived from the same model  
4. **Drawing sheets** compose viewports for construction documentation  
5. **Metadata and quantities** are queried from the graph and linked to norm catalogs  
6. **Project packages** (`.bbim`) portableize model, views, symbols, and configuration  

### 3.2 Deployment Modes

| Mode | Description | Use case |
|------|-------------|----------|
| **Full web + API** | React frontend + FastAPI backend | Project office, cloud (Render.com) |
| **Electron desktop** | Bundled app with local Python API | Offline site/office, Windows/macOS/Linux |
| **WinForms + WebView2** | .NET 8 shell | Enterprise Windows desktop |
| **Lite / minimal builds** | Static demo without backend | Training, marketing, GitHub Pages |

This supports the contractor’s need to **pilot without “piloting into the ditch”** — start with lite/demo, expand to desktop, then connect to warehouse and M365.

### 3.3 Coordinate System and Standards

BubbleBIM uses industry-standard BIM coordinates (mm):

- **X** → East (plan horizontal)  
- **Y** → North (plan horizontal)  
- **Z** → Up (elevation)  

Node types map to IFC-equivalent entities (`storey`, `wall`, `column`, `beam`, `slab`, `foundation`, `window`, `door`, `room`, `ax`, `shell`, `covering`), enabling interoperability with existing BIM workflows and IFC import pipelines.

---

## 4. Relational Database Foundation

This section addresses the core requirement: **how a relational database schema enables the contractor’s digital ambitions**.

### 4.1 Why a Relational Graph (Not Files and Drawings)

Construction projects are inherently **relational**:

- A wall **connects** two grid axes  
- A beam **spans** between columns  
- A window **belongs to** a wall and a storey  
- A room **is bounded by** walls  
- Quantities **aggregate** elements by type, material, storey, and norm article  

Traditional CAD stores geometry in files; BubbleBIM stores **entities and relationships** in a graph that can be queried, versioned, exported, and synchronized with enterprise systems.

### 4.2 Logical Schema (Relational Graph Model)

#### Node table equivalent — `BubbleNode`

Each building entity is a node:

| Field | Type | Purpose |
|-------|------|---------|
| `id` | STRING (PK) | Unique identifier |
| `type` | STRING (indexed) | BIM entity type (`wall`, `column`, `storey`, …) |
| `name` | STRING | Human-readable label |
| `x`, `y` | DOUBLE | Canvas/plan position (derived; see ax-index architecture) |
| `parentId` | STRING | Containment (e.g. storey → elements) |
| `properties` | JSON/STRING | Parametric attributes (dimensions, materials, types, formulas) |

**Cypher definition (LadyBugDB target schema):**

```cypher
CREATE NODE TABLE BubbleNode(
  id STRING PRIMARY KEY,
  type STRING,
  x DOUBLE,
  y DOUBLE,
  parentId STRING,
  properties STRING
)
```

#### Relationship table equivalent — `CONNECTED`

Edges express structural and logical relationships:

| Field | Type | Purpose |
|-------|------|---------|
| `id` | STRING (PK) | Edge identifier |
| `from` | NODE → BubbleNode | Source node |
| `to` | NODE → BubbleNode | Target node |
| `edge_type` | STRING | Semantic type (`wall-connection`, containment, etc.) |

```cypher
CREATE REL TABLE CONNECTED(
  FROM BubbleNode TO BubbleNode,
  id STRING PRIMARY KEY,
  edge_type STRING
)
```

#### Supplementary relational structures

| Structure | Storage | Purpose |
|-----------|---------|---------|
| `buildingAxes` | `{ xValues[], yValues[] }` in mm | Global grid — all spatial indexing references this |
| `activeStoreyId` | STRING | Current working level |
| `worldLocation` | Geo coordinates | Globe/site context (Cesium integration) |
| View tabs / sheets | View state in project file | Drawing composition metadata |
| Norm catalog | JSON + TypeScript rules | BOQ article definitions and BIM→norm mappings |
| Symbol registry | Per-type 2D symbol definitions | Plan representation standards |
| Material config | YAML (`materials.yaml`) | Cut/seen line weights, hatches, fills |

### 4.3 Ax-Index Spatial Architecture (Foundational Contract)

A critical relational rule: **plan position is determined by index into sorted coordinate tables**, not by storing arbitrary coordinates on each node.

- Each `ax` (grid axis) node carries `gridX`, `gridY` indices  
- Storey nodes hold `axesX[]` and `axesY[]` in millimetres  
- Walls, columns, and beams resolve geometry by **joining** node properties to axis tables  

This mirrors how enterprise GIS and BIM systems separate **topology** from **geometry** — enabling:

- Consistent grid-based coordination across disciplines  
- Parametric updates when grid spacing changes  
- Reliable quantity and footprint calculations  

### 4.4 Current Runtime vs Target Architecture

| Aspect | Current implementation | Target / roadmap |
|--------|------------------------|------------------|
| Primary persistence | JSON file (`bubble_graph.json`) via FastAPI | LadyBugDB embedded databases |
| Query language | Python filtering + API search endpoints | Cypher on LadyBugDB |
| Project package | JSON `.bbim` (model + views + symbols) | ZIP `.bbim` with `graph.ladybugdb` + `views.ladybugdb` + assets |
| Migration path | One-time LadyBugDB → JSON migration exists | Re-enable LadyBugDB as authoritative store |

**Important for the contractor:** The **relational model is fully defined and operational** today. The storage engine can evolve from JSON to LadyBugDB (or PostgreSQL graph extension, or sync to the data warehouse) **without changing the domain schema** — a key flexibility the invitation asks for.

### 4.5 Relational Model → Enterprise Data Warehouse

The graph schema maps cleanly to dimensional models for the contractor’s existing **data warehouse**:

| Graph entity | Warehouse fact/dimension | Example metrics |
|--------------|-------------------------|-----------------|
| `storey` | Dim_Storey | Level, elevation range |
| `wall`, `slab`, `beam` | Fact_Elements | Count, length, area, volume by material |
| `room` | Dim_Space | Net area, function |
| Norm mapping → F3 rows | Fact_Quantities | BOQ lines by chapter, category, floor |
| Project metadata | Dim_Project | Name, date, location |

Export paths already implemented or straightforward:

- **JSON** — full graph via `/api/graph/load` or `.bbim` file  
- **CSV** — F3 quantity lists (UTF-8 BOM for Excel RO)  
- **IFC** — import functional; export roadmap  
- **REST API** — all graph CRUD, search, stats, backup/restore  

This satisfies the invitation’s need to **assess data flow holistically** and connect project data to business insight.

---

## 5. Contribution Area 1 — Digital Strategy and Transformation

### 5.1 Requirement (from PDF)

> Connect business strategy, digital ambitions, and technology choices to clear business value.

### 5.2 How BubbleBIM Delivers

BubbleBIM embodies a **clear strategic thesis** for construction digitalization:

> **One relational building model → many derived outputs → measurable productivity gains.**

| Strategic ambition | BubbleBIM mechanism | Business value |
|--------------------|---------------------|----------------|
| Better project delivery | Single source of truth for geometry + metadata | Fewer inconsistencies between plan, model, and BOQ |
| Productivity on site and in office | 2D plans, sections, sheets generated from model | Less redrawing; faster design iterations |
| Competitiveness through data | Graph queryable; quantities linked to norm catalogs | Faster tendering and cost control |
| Safe AI adoption | Local LLM (Ollama) for IFC→graph and NL queries | No mandatory cloud AI; data stays on-premises |
| Technology flexibility | Modular viewers, open IFC, portable `.bbim` | Avoid vendor lock-in; integrate with M365/warehouse |

### 5.3 Transformation Narrative for the Contractor

BubbleBIM supports a **phased transformation** aligned with the invitation’s caution against failed pilots:

| Phase | Scope | Risk |
|-------|-------|------|
| **Phase 0 — Assess** | Map existing PM tools, M365, warehouse schemas to BubbleBIM graph model | Low — read-only integration design |
| **Phase 1 — Pilot** | One representative project (e.g. confined masonry residential) with graph authoring + F3 export | Low — desktop/local deployment |
| **Phase 2 — Scale** | IFC import from design partners; symbol standards; sheet output | Medium — process change |
| **Phase 3 — Integrate** | Sync graph exports to data warehouse; Power BI dashboards; Teams document links | Medium — IT governance |
| **Phase 4 — Automate** | AI-assisted model checks, automated BOQ diff on revisions | Higher — requires mature data governance |

BubbleBIM is the **technology anchor** for phases 1–2 and the **data producer** for phases 3–4.

---

## 6. Contribution Area 2 — Portfolio Management, Prioritization, and Benefit Realization

### 6.1 Requirement (from PDF)

> Ensure digital initiatives are prioritized, managed, and followed up from idea to realized effect.

### 6.2 How BubbleBIM Delivers

While neither platform is a portfolio management tool (like Microsoft Project or Primavera), together they enable **benefit tracking** for digital initiatives across design and field operations:

#### Measurable KPIs enabled by the combined platform

| KPI | Measurement source | Platform |
|-----|-------------------|----------|
| Model elements per project | `/api/graph/stats` — node counts by type | BubbleBIM |
| BOQ generation time | Manual Excel vs automated takeoff + F3 CSV | BubbleBIM |
| Drawing production time | Sheet composer vs manual CAD assembly | BubbleBIM |
| Revision impact | Graph diff between `.bbim` backups | BubbleBIM |
| Data completeness | % walls with material, % typed openings | BubbleBIM |
| IFC reuse rate | Elements imported vs authored | BubbleBIM |
| Asset hand-out audit time | QR scan vs paper sign-out logs | Field platform |
| Fleet fuel / km reporting | Manual logbooks vs GPS trip reports | Field platform |
| Qualification compliance | Spreadsheet vs expiry dashboard | Field platform |
| Service task completion rate | Service queue → PDF report | Field platform |
| Equipment utilization | Loan frequency / idle assets in activity log | Field platform |
| Payroll preparation time | Manual collection vs timesheet CSV export | Field platform |

#### Prioritization framework

| Initiative | Effort | Impact | Readiness |
|------------|--------|--------|-----------|
| Automated BOQ from model | Medium | **High** | **Implemented** (BubbleBIM) |
| QR asset traceability on site | Low | **High** | **Implemented** (field platform) |
| Fleet GPS + fuel KPIs | Low | Medium | **Implemented** (field platform) |
| HR qualifications compliance | Medium | **High** | **Implemented** (field platform) |
| Weekly crew planning with geo orders | Medium | **High** | **Implemented** (field platform) |
| Standardized 2D symbols per type | Low | Medium | **Implemented** (BubbleBIM) |
| IFC import from designers | Medium | High | **Implemented** (BubbleBIM) |
| M365 workplace integration | Medium | **High** | **Implemented** (field platform) |
| Warehouse integration (both layers) | Medium | High | Schema ready; connector to build |
| BIM ↔ field operations link | Medium | High | Roadmap |
| Full IFC export | Medium | Medium | Roadmap (BubbleBIM) |
| Safety / permit backend | Medium | High | UI prototype (field platform) |

This gives the contractor a **concrete benefit realization matrix** tied to working software, not slideware.

---

## 7. Contribution Area 3 — Organization, Work Processes, and Change Capacity

### 7.1 Requirement (from PDF)

> Strengthen digital maturity and ensure solutions are adopted with operational competence and capacity.

### 7.2 How BubbleBIM Supports Adoption

#### Role-based workflows (supported by platform design)

| Role | BubbleBIM workflow | Competence needed |
|------|-------------------|-------------------|
| **BIM coordinator** | Graph authoring, grid setup, IFC import/commit | Medium — graph + BIM concepts |
| **Architect / designer** | Floor plan editing, wall drawing, openings | Low–medium — familiar 2D CAD patterns |
| **Estimator / QS** | Quantities panel → F3 export | Low — review CSV in Excel |
| **Site / field engineer** | QR hand-out, service tasks, mobile offline | Low — scan and confirm |
| **Fleet manager** | Live GPS map, trip reports, fuel KPIs | Low — dashboard review |
| **HR / compliance** | Qualifications matrix, timesheet export, leave approvals | Medium — M365 familiar |
| **Warehouse / material manager** | Equipment registry, multi-scan hand-out, service queue | Low–medium |
| **IT / digital** | API, SharePoint provisioning, backups, warehouse ETL | Medium — REST/JSON + M365 admin |

#### Process alignment

| Work process | Traditional | With combined platform |
|--------------|-------------|------------------------|
| Quantity survey | Manual takeoff from PDF | Auto-derived from BubbleBIM graph + norm rules |
| Plan coordination | Separate CAD files | Derived from same model as 3D |
| Design revision | Redraw + retakeoff | Graph update → regenerate views + BOQ |
| Tool hand-out on site | Paper sign-out log | QR scan with offline sync + audit trail |
| Fleet cost control | Driver logbooks | GPS trips, fuel, CO₂ KPIs |
| Crew weekly planning | Whiteboard + phone calls | Geo orders, role slots, qualification matching |
| Compliance tracking | Spreadsheets | Certifications matrix with expiry alerts |
| Tender documentation | Scattered files | `.bbim` package + SharePoint project folder |
| Symbol standards | Per-drawing CAD blocks | Global per-type symbol registry |
| Service documentation | Paper checklists | ISO inspection PDFs + digital service reports |

#### Change management enablers

- **Lite demo build** — BubbleBIM training without backend complexity  
- **Production trace-tool mode** — field platform subset hiding unfinished modules  
- **Incremental adoption** — start with QR tracking only, or quantities only, or either layer independently  
- **Romanian-language UI elements** — BubbleBIM norms/F3 columns; field platform bilingual toggle  
- **Offline-first asset ops** — field hand-out works without connectivity; sync on reconnect  
- **M365 familiarity** — field users already in Outlook/SharePoint; no new login paradigm  

---

## 8. Contribution Area 4 — Technology Architecture, Data Foundation, and Artificial Intelligence

### 8.1 Requirement (from PDF)

> Strengthen system landscape, data foundation, insight and analytics, automation, and decision support.

### 8.2 Technology Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Contractor Digital Ecosystem                  │
├──────────────┬──────────────┬──────────────┬────────────────────┤
│ Microsoft 365│ PM Tools     │ Data Warehouse│ BubbleBIM         │
│ (Teams, SP)  │ (scheduling) │ (BI, sharing) │ (project model)   │
└──────┬───────┴──────┬───────┴──────┬───────┴─────────┬──────────┘
       │              │              │                  │
       └──────────────┴──────────────┴──────────────────┘
                              │
                    ETL / API / File exchange
                              │
              ┌───────────────▼───────────────┐
              │   BubbleBIM Relational Graph   │
              │   nodes + edges + properties   │
              └───────────────┬───────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   3D Viewers           2D Drawings          Quantities/F3
   (Babylon, Three,     (plans, sections,    (norm catalogs,
    WebIFC, OpenGeo)     elevations, sheets)   CSV export)
```

#### Layer stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, TypeScript 5, Vite 5, Tailwind 4, Zustand |
| 3D engines | Babylon.js, Three.js (Ara3D), WebIFC/That Open, OpenGeometry WASM |
| 2D | SVG React viewers, drawing engine, annotation layer |
| Backend | FastAPI (Python), Pydantic, optional Shapely, ezdxf |
| Graph store | JSON (current) → LadyBugDB (target) |
| AI | Ollama (local LLM — phi3 default) |
| Desktop | Electron, .NET WinForms + WebView2 |
| Cloud | Render.com (API + static frontend) |

### 8.3 Data Foundation

#### Authoritative data objects

| Object | Format | Mutability | Sync target |
|--------|--------|------------|-------------|
| Building graph | JSON / LadyBugDB | Read/write | Warehouse fact tables |
| Element library | YAML + STEP/GLB assets | Admin-managed | Asset catalog dimension |
| Norm catalog | JSON (importable from ODS) | Versioned (`deviz-zidarie-confinata-1`) | BOQ master data |
| Material visuals | YAML | Configurable | Drawing standards |
| 2D symbols | SVG graph definitions | Per-type registry | Documentation standards |
| Project package | `.bbim` JSON | Snapshot | SharePoint project folder |

#### API surface (decision support and automation)

| Endpoint group | Capability |
|----------------|------------|
| `/api/graph/*` | Load, save, search, stats, backup, restore |
| `/api/ifc/*` | Upload, parse storey, commit graph, 2D plan extraction |
| `/api/library/*` | Element catalogs, object upload, DXF→symbol conversion |
| `/api/chat` | Natural language graph queries + Ollama |
| `/api/geometry/*` | Wall footprints (Shapely) |
| `/api/material-config` | Visual standards read/write |

### 8.4 Artificial Intelligence

| AI capability | Status | Safety model |
|---------------|--------|--------------|
| NL graph queries (RO/EN) | **Live** — regex intents + Ollama fallback | Local inference; no data leaves premises |
| IFC → BubbleGraph conversion | **Live** — LLM parametrize after Python parse | Optional; human review before commit |
| Chat assistant in UI | **Live** — ChatPanel with Ollama status | Disabled in lite demo |
| Automated BOQ | **Live** — rule-based, auditable | — |
| Inventory-aware chat assistant | — | **Live** — Ollama + equipment context |
| Cloud LLM (Azure OpenAI, etc.) | Not implemented | Can be added behind enterprise gateway |

The invitation emphasizes turning AI into **practical value safely** — BubbleBIM’s default local-Ollama approach aligns with contractor data governance, especially for unreleased project models.

### 8.5 Analytics and Decision Support

Derived analytics without additional tooling:

- Element counts and type breakdown (`/api/graph/stats`)  
- Quantity aggregation by storey, chapter, category (F3 table)  
- Detail CSV with per-node breakdown for audit  
- Graph search for compliance checks (e.g. all walls without material)  

With warehouse integration (roadmap):

- Power BI dashboards on exported graph facts  
- Cross-project benchmarks (m² wall per project, opening density)  
- Trend analysis on revision backups  

---

## 9. Contribution Area 5 — Project-Near Digitalization, Collaboration, and Specialized Solutions

### 9.1 Requirement (from PDF)

> Identify and scale concrete solutions for better project management, collaboration, and efficiency.

### 9.2 Project-Near Features (Implemented)

#### A. Relational BIM authoring

- Visual graph editor with node palette (`BubbleGraphPanel`)  
- Grid-based spatial indexing (ax nodes)  
- Parametric properties with formula support (`formulaUtils.ts`)  
- Auto-save (10s) and periodic backup (5 min)  

#### B. Multi-viewer project environment

Single model, multiple synchronized views:

| View | Purpose | Site/office relevance |
|------|---------|----------------------|
| Graph editor | Model topology | BIM coordination |
| 3D model | Spatial verification | Design review, clash awareness |
| Floor plan | Construction layout | **Site execution** |
| Section / elevation | Vertical coordination | Structure/envelope |
| IFC plan / tiles | Designer model overlay | Design-construction interface |
| Sheet composer | Drawing deliverables | **Tender and construction docs** |
| Globe / terrain | Site context | Infrastructure projects |
| Composer (RoomX) | Space planning | Fit-out, programming |

#### C. IFC interoperability

- **Import:** Upload IFC → parse storey → optional AI graph generation → commit to project  
- **2D from IFC:** Backend plan extraction for overlay views  
- **Client-side IFC:** WebIFC viewer with rig/deformation system for live model inspection  
- **Export:** Roadmap (currently stub); import path is production-ready  

#### D. Quantity takeoff and Romanian BOQ (F3)

Purpose-built for **project cost control** in the contractor’s market:

- Norm catalog imported from `DEVIZ PE CATEGORII.ods` (29 articles, 12 categories — confined masonry case)  
- Mapping rules: BIM node types → norm articles (walls → Porotherm, columns → stalpișori, beams → centuri, rooms → finishes, windows → sills)  
- Measures: length, area (gross/net), volume, count, opening area, formulas  
- **F3 CSV export** (UTF-8 BOM) — ready for Excel and downstream ERP  
- UI: Quantities panel in explorer with row→node highlighting  

This is a **specialized, project-near solution** that directly reduces estimator workload.

#### E. Symbol standards and technical drawings

- Window/door configurators with Symbol Studio (template-first, parametric 2D symbols)  
- Global per-type symbol application in floor plans  
- Technical drawings viewer with hatches, annotations, material-driven line weights  
- DXF symbol import pipeline for organization-specific standards  

#### F. Offline and field use

- **BIMx-style export:** Self-contained HTML + JS 3D viewer ZIP  
- **Electron desktop:** Full offline with local API  
- **Lite build:** Static demo for training/kiosks  

### 9.3 Collaboration (Current and Roadmap)

| Capability | BubbleBIM | Field Operations Platform |
|------------|-----------|----------------------------|
| Single-user model authoring | **Live** | — |
| Project file exchange (`.bbim`) | **Live** | — |
| REST API for third-party tools | **Live** | SharePoint REST (PnP) |
| Task comments, @mentions, attachments | Roadmap | **Live** |
| Task delegation and multi-assignee | Roadmap | **Live** |
| Shared team calendar | Roadmap | **Live** (Outlook via Graph) |
| Email notifications for operational events | — | **Live** (Graph Mail.Send) |
| Real-time multi-user model editing | Roadmap | — |
| Role-based module visibility (17 roles) | Roadmap | **Live** (Azure AD app roles) |

Collaboration on the **operations side** is production-ready through Microsoft 365: SharePoint lists for shared state, Graph for calendar and mail, Azure AD for SSO and granular RBAC. BubbleBIM collaboration remains **file- and API-based** today, with model-level real-time sync on the roadmap.

Field and office staff collaborate through a **unified workplace module**: Miro-style task canvas, mechanic week planner, service queue, manager team sidebar, and bilingual UI (English / local language toggle).

---

## 10. Alignment with the Contractor’s Existing Digital Foundation

The invitation states the contractor already has:

| Existing asset | BubbleBIM relationship | Field Operations Platform relationship |
|----------------|------------------------|--------------------------------------|
| **Project management tools** | Produces BOQ, drawings, model data for PM cost/schedule | Weekly orders, tasks, time entries link to field work |
| **Microsoft 365** | `.bbim`, CSV, SVG exports to SharePoint | **Native tenant integration** — SharePoint Online as primary data store |
| **Internal development** | Open REST API + JSON schema | SharePoint list schema + provisioning scripts |
| **Cloud solutions** | Render.com deployment | Static SPA on Render + SharePoint backend |
| **Data warehouse** | Graph exports → star schema | List exports (timesheets CSV, fleet KPIs) → fact tables |
| **Other supporting systems** | IFC import from designers | Traccar GPS, Ollama LLM, Outlook calendar sync |

### 10.1 Microsoft 365 as Operational Backbone

The field operations platform is architected as **SharePoint-native with no custom application database**:

```
┌─────────────────────────────────────────────────────────────────┐
│  Clients: Web SPA │ Electron Desktop │ Capacitor iOS/Android   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
    IndexedDB          MSAL Auth         Fleet GPS API
    (offline cache)   (Azure AD)       (open-source tracker)
         │                 │                 │
         └────────┬────────┴────────┬────────┘
                  │                 │
           SharePoint REST      Microsoft Graph
           (lists, libraries)  (Calendar, Mail, Users)
                  │                 │
                  └────────┬────────┘
                           │
                  SharePoint Online Tenant
                  (~30+ provisioned lists + document libraries)
```

This directly leverages the contractor’s stated **Microsoft 365 digital core** — inheriting tenant audit trails, permissions, and compliance without standing up a separate operational database.

**Identity model:** Azure AD authentication (MSAL) + ~17 granular app roles (field operator, mechanic, planner, HR, fleet manager, safety coordinator, subcontractor, viewer, etc.) with SharePoint list-level authorization.

BubbleBIM **complements** the existing landscape on the **design-quantity** axis; the field platform **complements** it on the **site-operations** axis. Together they cover the invitation’s “office, on site, and in production” scope.

---

## 11. Industry Understanding and Reference Experience

### 11.1 Construction and Infrastructure Relevance

BubbleBIM addresses patterns common in **project-intensive construction**:

| Industry challenge | BubbleBIM | Field Operations Platform |
|--------------------|-----------|----------------------------|
| Complex multi-storey structures | Storey containers, grid axes | Weekly orders per site/week |
| Infrastructure site context | Cesium globe, terrain | Geo orders, fleet GPS, weather overlay |
| Design-construction information loss | IFC import → relational graph | Service reports, inspection PDFs |
| Local BOQ / deviz practice | Romanian F3 export | — |
| Production-near processes | Floor plans, wall footprints | QR hand-out, crew role planning |
| Tool/plant accountability | — | Loan history, activity log, offline sync |
| Workforce compliance | — | Qualifications matrix, certifications, expiry alerts |
| Value chain collaboration | Portable `.bbim`, open API | SharePoint shared lists, task @mentions, Outlook sync |

### 11.2 Documented Delivery Examples (Platform Capabilities)

| Deliverable | Evidence |
|-------------|----------|
| Confined masonry BOQ automation | BubbleBIM quantity takeoff, F3 CSV export, norm catalog tests |
| Multi-viewer BIM environment | 15+ viewer tab types, 3D/2D/sheet pipeline |
| IFC ingestion pipeline | Python parser, LLM-assisted graph commit |
| SharePoint-native field operations | 30+ provisioned lists, one-click tenant setup |
| QR asset tracking with offline sync | IndexedDB queue, multi-scan hand-out, loan audit |
| Fleet GPS live map + historical reports | Open GPS stack integration, fuel/CO₂ KPIs |
| HR qualifications matrix + payroll CSV | Expiry rules, exam scheduling, timesheet export |
| ISO inspection + service report PDFs | Paper-form digitization, pdf-lib output |
| Weekly geo-located crew planning | Role slots, qualification matching, weather map |
| M365 integration (SSO, calendar, mail) | Azure AD MSAL, Graph API automation |
| Multi-surface deployment | Web, Electron desktop, Capacitor mobile |

### 11.3 Lessons Learned (Embedded in Architecture)

- **Graph-first, not CAD-first** — avoids duplicate geometry across views  
- **Incremental storage migration** — JSON today, LadyBugDB tomorrow; schema stable  
- **Optional AI** — local Ollama; never blocks core workflows  
- **Lite builds for adoption** — reduce training barrier  
- **Honest capability boundaries** — IFC export and multi-user flagged as roadmap, not oversold  

---

## 12. Proposed Approach and Collaboration Model

### 12.1 Engagement Model

| Stage | Activities | Contractor involvement |
|-------|------------|------------------------|
| **Discovery (4–6 weeks)** | Map processes, data flows, warehouse schema, pilot project selection | Digital lead + project manager + QS |
| **Pilot (8–12 weeks)** | Deploy BubbleBIM on one project; IFC import; F3 export; symbol standards | BIM coordinator + site engineer |
| **Scale (3–6 months)** | Warehouse connector, M365 folder structure, training program | IT + department heads |
| **Operate (ongoing)** | Support, catalog updates, norm imports, feature roadmap | Digital governance board |

### 12.2 Team and Continuity

| Role | Responsibility |
|------|----------------|
| Product architect | Graph schema, integration design, roadmap |
| BIM specialist | Workflow design, norm mapping, symbol standards |
| Full-stack developer | Frontend viewers, API, deployment |
| Data engineer | Warehouse ETL, backup governance |
| Change manager | Training, adoption metrics, process documentation |

### 12.3 Governance

- Graph schema and norm catalog versioned in Git  
- Project backups with timestamp labels (`/api/graph/backup`)  
- Material and symbol configs auditable via YAML/JSON diffs  
- AI usage policy: local-first; cloud opt-in per project  

---

## 13. Delivery in Practice — From Recommendation to Lasting Effect

The invitation asks for contributors who **do more than advise**. BubbleBIM delivery chain:

```
Recommendation          →  Working software     →  Measured outcome
─────────────────────────────────────────────────────────────────────
"Use relational BIM"  →  Graph editor live    →  Single model source
"Automate BOQ"          →  F3 export live       →  Hours saved per tender
"Standardize symbols"   →  Symbol Studio live   →  Consistent plan docs
"Import designer IFC"   →  IFC pipeline live    →  Less redraw
"Connect to warehouse"  →  ETL connector        →  Portfolio analytics
"Track assets on site"  →  QR platform live     →  Audit trail + less loss
"Plan weekly crews"     →  Geo orders live        →  Right skills on site
"Fleet visibility"      →  GPS dashboard live     →  Fuel/km accountability
```

### Concrete deliverables per phase

| Phase | Deliverables |
|-------|-------------|
| Pilot | BubbleBIM on one project (`.bbim`, F3 CSV); field platform SharePoint provisioning; QR labels for pilot plant; trained planners + warehouse staff |
| Scale | Warehouse sync (graph + SharePoint lists); M365 project folder template; symbol standards; fleet GPS rollout |
| Operate | Quarterly norm catalog updates; qualification expiry monitoring; backup policy; cross-layer KPI dashboard; support SLA |

---

## 14. Gap Analysis and Roadmap

Honest assessment strengthens trust in a market dialogue process.

| Requirement area | Current status | Roadmap |
|------------------|----------------|---------|
| Relational graph authoring | **Complete** | LadyBugDB reactivation |
| 3D/2D/multi-viewer | **Complete** | Performance optimization |
| IFC import | **Complete** | Enhanced opening detection |
| IFC export (STEP) | Stub | Full export pipeline |
| BOQ / F3 quantities | **Complete** (Romanian deviz) | Expand catalog categories |
| Symbol configurator | **Complete** (Phase 1) | Bbox control points, auto-defaults |
| AI (local) | **Complete** | Enterprise LLM gateway option |
| Multi-user collaboration | Not started (BubbleBIM) | **Live** (SharePoint shared lists, task comments) |
| M365 native integration | Partial (file export) | **Live** (SharePoint + Graph + Azure AD) |
| SSO / RBAC / audit | Not started (BubbleBIM) | **Live** (Azure AD app roles + SharePoint permissions) |
| `.bbim` as ZIP + embedded DB | JSON only | ZIP packaging |

| SSO / RBAC / audit | Not started (BubbleBIM) | **Live** (Azure AD app roles + SharePoint permissions) |
| `.bbim` as ZIP + embedded DB | JSON only | ZIP packaging |
| Data warehouse connector | Schema ready (both platforms) | ETL from graph JSON + SharePoint list exports |
| Field asset tracking (QR/barcode) | — | **Complete** |
| Fleet GPS / telemetry | — | **Complete** |
| Offline mobile field ops | Lite/offline 3D export | **Complete** (IndexedDB + sync queue) |
| HR / qualifications matrix | — | **Complete** |
| Weekly crew / order planning | — | **Complete** |
| ISO inspections / service PDFs | — | **Complete** |
| Safety incidents / work permits | — | UI prototype |
| Cross-project analytics dashboard | Roadmap | UI prototype |
| BIM ↔ operations platform link | Not started | Geocoded orders + equipment IDs as join keys |

None of these gaps invalidate the combined offering as a **project-near digital platform**; they define the **integration and enterprise scale** work for a strategic partnership — especially linking BubbleBIM project models to field operations data.

---

## 15. Complementary Field Operations and Digital Workplace Platform

Alongside BubbleBIM’s relational BIM model, a **production-ready field operations platform** addresses the invitation’s emphasis on productivity **on site, in the office, and in production**. It is built as a **Microsoft 365-native application** — SharePoint Online lists and document libraries as the operational data store, Azure AD for identity, and Microsoft Graph for calendar, mail, and directory services.

This platform does not duplicate BubbleBIM’s geometry or quantity engine; it covers the **operational layer** that project-intensive contractors need daily: tools, plant, modules, fleet, crew, compliance, and workplace coordination.

### 15.1 Domain and Use Cases

**Primary domain:** Construction and infrastructure field operations — crew scheduling, geo-located work orders, specialized equipment and modular asset logistics, workshop service, fleet telemetry, and employee compliance.

| Use case | Maturity |
|----------|----------|
| Track tools, small plant, and modular assets via QR/barcode | Production-ready |
| Hand-out / hand-in of assets with loan history and audit trail | Production-ready |
| Schedule and complete maintenance/service jobs (workshop + field) | Production-ready |
| Personal workplace: tasks, calendar, time entries, leave, certifications | Production-ready |
| Weekly crew/order planning with infrastructure-specific roles | Production-ready |
| Fleet live GPS, trips, alerts, fuel/CO₂ KPIs | Production-ready |
| HR: employees, qualifications matrix, timesheet export, leave/requests | Production-ready |
| ISO-style equipment inspections with PDF output | Production-ready |
| Mechanic service reports mirroring official paper forms | Production-ready |
| Protective clothing inventory and loans | Production-ready |
| Document library for norms/essential docs with role-based access | Production-ready |
| Project portfolio dashboard | UI prototype |
| Safety incidents & work permits | UI prototype |
| Cross-project analytics dashboard | UI prototype |
| GPS-verified timesheet punch-in | Planned |
| BIM / 3D model integration | Via BubbleBIM (separate layer) |

**Target users:** Field operators, mechanics, warehouse/material managers, planners, project managers, HR, safety coordinators, fleet managers, subcontractors, and read-only viewers — supported by granular Azure AD app roles (~17 roles) with three-tier permission levels for traceability operations.

### 15.2 Asset and Material Tracking

#### Equipment registry

- Categories: unique items (UNIK), multi-quantity (MULTI), and consumables (SALGSVARE)  
- Attributes: status, condition, location (warehouse/shelf), assignment, serial/barcode, service dates (annual inspection, calibration, hours-based service)  
- **QR/barcode workflow:** Auto-generated codes; print labels; single-scan detail; **multi-scan** bulk hand-out or bulk label printing  
- **Hand-out / hand-in:** Person assignment, quantity for multi-items, notes; full loan history; email alerts on custodian changes  
- **Service task lifecycle:** Create, assign, prioritize, schedule, sign-in/start, complete with labor hours and parts cost; **fix-or-buy** heuristic (sales price vs. repair cost)  
- **Activity log:** Immutable audit trail per equipment action  
- **File attachments:** Per-asset SharePoint folders (photos, documents, service records)  
- **CSV import:** Bulk load from legacy exports with column mapping  
- **Outlook calendar sync:** Service due dates pushed to personal calendars via Microsoft Graph  

#### Modular assets and workwear

- Parallel registry for modular plant/wagons with identical loan, service, file, and QR workflows  
- Separate protective-clothing inventory with loan history and ODS spreadsheet import  
- **Offline mode:** IndexedDB (Dexie.js) cache + action queue for hand-out/hand-in/status changes; delta sync on reconnect  

### 15.3 Fleet GPS and Telemetry

- Integration with **open-source GPS tracking server** (self-hosted; commercial telematics device support documented)  
- **Live map (Leaflet):** Vehicle positions, trails, filters by type/department/fuel/status  
- **KPI strip:** Distance today, fuel consumption, CO₂ estimate, unacknowledged alerts  
- **Reports:** Trips, stops, alerts, daily summaries, bar charts; configurable history window  
- Supplementary metadata in SharePoint lists (vehicles, trips, alerts, fuel log) linked to tracker IMEI and optional equipment ID  
- HTTPS proxy layer for production mobile access (avoids mixed-content/CORS issues)  

### 15.4 Digital Workplace

A personal and team coordination environment integrated with operational data:

| Feature | Description |
|---------|-------------|
| **Task canvas** | Miro-style infinite board; Eisenhower urgency/importance; tags; assignees, watchers, recurrence, delegation |
| **Task collaboration** | Comments with @mentions, attachments, activity history, structured completion feedback |
| **Service integration** | Service tasks from equipment appear in inbox; distribute to mechanics with travel + intervention estimates; sync to canvas and Outlook |
| **Mechanic week planner** | Drag-and-drop scheduling by mechanic and hour; overlap detection; chief-mechanic overview |
| **Calendar** | Embedded Outlook events via Graph; create/delete events; automated service-task-to-calendar |
| **Time tracking** | Manual time entries linked to tasks/orders (SharePoint-backed) |
| **Leave & HR requests** | Submit/track leave; vacation, sick leave, course, equipment requests with HR response thread |
| **Certifications** | Upload PDFs, expiry badges (valid / expiring / expired); rail, machinery, first aid, safety, driver types |
| **Service reports & inspections** | In-workflow completion forms; ISO inspection wizard from task context |
| **Team views** | Manager team calendar, delegated-task sidebar, service queue/archive |

### 15.5 Planning and Crew Orders

Infrastructure-oriented weekly planning:

- **Weekly orders:** SharePoint-backed orders with week number, **geo-located site** (lat/lng), daily schedule (per-day start/end/shifts), notes  
- **Role slots:** Predefined crew roles (foreman, welders, track technicians, drivers, wagon/tool IDs) with color-coded assignment UI  
- **Drag-and-drop staffing:** Assign qualified team members from library sidebar; save and apply team templates  
- **Qualification matching:** Per-member boolean flags (safety/rail competence codes) for availability filtering  
- **Map view:** Leaflet map of order locations with **weather overlay** at job sites  
- **Week-range filtering** on planning canvas  

This directly supports **production-near processes** and **collaboration across the value chain** described in the invitation.

### 15.6 HR Module

| Capability | Detail |
|------------|--------|
| Employee directory | Azure AD users enriched with internal profile (internal number, department, job title) |
| Qualifications matrix | Per-employee × qualification grid; 0–4 competence scores; expiry coloring (90-day rule); event tracking; PDF per qualification |
| Exam scheduling | Email notification + auto-created follow-up task |
| Timesheets (HR view) | Filter all users’ entries; **CSV export for payroll** |
| Leave approvals | Pending queue with approve/reject |
| Certifications dashboard | Organization-wide expiry monitoring |
| Communications | Email templates with placeholders; questionnaire builder/responder; composer via Graph |
| Onboarding | Resource request form workflow |

### 15.7 Documents and Compliance

- SharePoint document library browser for essential documents and normatives  
- Folder-level **role-based access control** (admin-configurable)  
- **ISO equipment inspections:** Multi-step wizard → PDF output (pdf-lib / html2canvas)  
- **Service report PDFs:** Multiple form templates mirroring official paper checklists (electrical, small equipment, calibration, safety/wheel measurement)  
- **Audit trail:** SharePoint versioning + immutable activity logs on assets  

### 15.8 Administration and Deployment

- **One-click SharePoint provisioning:** Creates 30+ lists/libraries with schema, sets role permissions, seeds employee profiles, creates per-asset folder structures  
- **Multi-surface deployment** from a single React 18 / TypeScript / Vite codebase:  
  - Web SPA (desktop browser)  
  - Electron desktop installer (Windows)  
  - Capacitor 6 native shells (Android and iOS)  
- **Field mobile features:** Bottom navigation, native QR scanning (ML Kit + web fallback), camera for asset photos, offline sync, adjustable UI scale, hardware back-button handling  
- **Build modes:** Full (all modules) vs. production subset (trace tool + fleet + workplace + HR + docs)  
- **Internal app distribution:** Firebase App Distribution for field tester APK/IPA  

### 15.9 Artificial Intelligence and Automation

| Capability | Detail |
|------------|--------|
| **Embedded assistant** | Ollama-compatible LLM (local or cloud via HTTPS tunnel); streaming responses; **live inventory context** injected into prompts; bilingual |
| **Email automation** | Graph Mail.Send: urgent service tasks, custodian changes, task status, qualification exams, feedback |
| **Calendar automation** | Service due alerts → Outlook events; delegated tasks → calendar invites |
| **Field memory** | SharePoint-backed autocomplete for last-used form values per scope |
| **Fix-or-buy heuristic** | Service cost vs. asset sales price for repair/replace decisions |

### 15.10 SharePoint Operational Data Model

No custom application database — all persistent operational data in **SharePoint Online**:

| Domain | SharePoint list purpose |
|--------|-------------------------|
| Operations | Orders, week assignments, user tasks, task activity/comments/feedback, time entries, leave/HR requests |
| Assets | Equipment, modules, workwear, loan histories, service tasks, reservations, activity logs |
| Compliance | Audit reports, service reports, certifications, qualification records, employee events |
| HR comms | Email templates, questionnaires, responses, onboarding requests |
| Fleet | Vehicles, trips, alerts, fuel log |
| System | Field memory, feedback, employee profiles, document folder access rules |

**Document libraries:** Per-equipment/module/employee/task folder stores; shared norms library.

**Local client cache (offline):** IndexedDB mirrors for equipment/workwear, Azure AD directory cache, offline action queues, sync metadata with TTL.

### 15.11 Integration with BubbleBIM

The two platforms form a **contractor digital stack** with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Contractor Digital Stack                         │
├──────────────────────────────┬──────────────────────────────────────┤
│  BubbleBIM (Design Layer)    │  Field Ops Platform (Execution Layer) │
│  ─────────────────────────   │  ────────────────────────────────────  │
│  Relational graph model      │  SharePoint operational lists         │
│  3D / 2D / sheets            │  QR asset tracking                    │
│  IFC import                  │  Fleet GPS                            │
│  F3 / BOQ quantities         │  Crew planning + geo orders           │
│  Symbol standards            │  HR / qualifications                  │
│  LadyBugDB / JSON            │  Workplace tasks + Outlook sync         │
└──────────────────────────────┴──────────────────────────────────────┘
                              │
                    Shared integration points
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
   SharePoint            Data Warehouse        Microsoft 365
   (project files,       (graph facts +        (Azure AD, Teams,
    CSV exports)          list exports)         Graph, Outlook)
```

**Near-term join keys for linking layers:**

| BubbleBIM entity | Field platform entity | Link mechanism |
|------------------|----------------------|----------------|
| Project / site location | Weekly order (lat/lng) | Geocoded site reference |
| Equipment type in BOQ | Physical equipment record | Shared equipment ID / barcode |
| Storey / zone | Order daily schedule | Project + week number metadata |
| Norm article quantities | Timesheet / task hours | Project code in custom fields |
| `.bbim` project file | SharePoint project folder | Document library path |

### 15.12 Maturity Summary

| Category | Status |
|----------|--------|
| Asset/module/workwear tracking + offline | **Production-ready** |
| Service workflows + mechanic planner | **Production-ready** |
| Fleet GPS + reports | **Production-ready** |
| Workplace tasks + Outlook sync | **Production-ready** |
| HR core + qualifications + payroll CSV | **Production-ready** |
| Inspections / service PDFs | **Production-ready** |
| SharePoint provisioning + M365 integration | **Production-ready** |
| Multi-surface deployment (web/desktop/mobile) | **Production-ready** |
| Safety backend, project portfolio, enterprise analytics | UI prototype / roadmap |
| BubbleBIM ↔ field platform deep link | Roadmap |

---

## 16. Conclusion

The *Invitation To Market Dialogue* seeks partners who understand that digitalization in construction is **about project delivery, productivity, and competitiveness** — not technology for its own sake.

**The combined offering meets this intent** by providing:

1. **BubbleBIM** — a **relational graph database model** as the authoritative project data structure; derived 3D, plans, sections, sheets, and quantities; Romanian F3/deviz takeoff; IFC import; practical local AI  
2. **Field Operations Platform** — a **SharePoint-native, production-ready** application for asset traceability, fleet GPS, crew planning, HR/compliance, digital workplace, and offline mobile — directly leveraging the contractor’s **Microsoft 365 core**  
3. **Dual-layer integration path** — graph JSON + SharePoint list exports → data warehouse; project files in SharePoint; Azure AD SSO and RBAC across both layers  
4. **Phased adoption** — lite demo / trace-tool subset → pilot project → warehouse analytics → deep BIM–operations linking  
5. **Honest gap disclosure** — safety analytics, cross-project dashboards, and real-time BIM collaboration on roadmap; field operations and M365 integration largely **delivered today**  

Together, BubbleBIM and the field operations platform cover the invitation’s full arc: **insight and foresight in the model**, **execution and traceability on site**, and **structured data** flowing into the contractor’s existing data warehouse and Microsoft 365 ecosystem — turning technology into practical value in the office, on site, and in production.

---

## Appendix A — Relational Entity Reference

| Node type | IFC equivalent | Key properties | Typical edges |
|-----------|---------------|----------------|---------------|
| `storey` | IfcBuildingStorey | bottomElevation, topElevation, axesX, axesY | → children via parentId |
| `ax` | IfcGridAxis | gridX, gridY, axNodeIndex | ← walls, columns |
| `wall` | IfcWall | wall_type, material, thickness | → ax endpoints |
| `column` | IfcColumn | section, material, height | → ax |
| `beam` | IfcBeam | beam_section, material | → columns/ax |
| `slab` | IfcSlab | thickness, material | → boundary |
| `foundation` | IfcFooting | dimensions, material | → ax |
| `window` | IfcWindow | window_type, opening, sill_height | → wall (inline or node) |
| `door` | IfcDoor | door_type, swing | → wall |
| `room` | IfcSpace | function, area | → bounding walls |
| `shell` | IfcRoof | contour, slope | → edges |
| `covering` | IfcCovering | material, type | → shell/slab |

## Appendix B — F3 Export Column Schema

| Column | Description |
|--------|-------------|
| Nr. crt. | Row number |
| Simbol | Norm article symbol |
| Denumire | Description |
| UM | Unit of measure |
| Cantitate | Computed quantity |
| Capitol | BOQ chapter |
| Categorie | BOQ category |
| Etaj | Storey label |

## Appendix C — Key Repository Paths

| Component | Path |
|-----------|------|
| Graph store (backend) | `backend/main.py`, `backend/bubble_graph.json` |
| Frontend state | `src/store/index.ts` |
| Project file format | `src/lib/projectFile.ts` |
| Quantity engine | `src/lib/quantityTakeoff/` |
| Norm catalogs | `src/lib/norms/` |
| Architecture vision | `.github/copilot-instructions.md` |
| IFC pipeline | `backend/ifc_parser.py` |
| API client | `src/lib/api.ts` |

## Appendix D — Field Operations Platform Stack and SharePoint Lists

### Technology stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, TypeScript, Vite, styled-components / CSS modules |
| Maps | Leaflet, OpenStreetMap tiles, weather overlay on planning map |
| Offline | Dexie.js / IndexedDB |
| M365 integration | @pnp/sp (SharePoint REST), @azure/msal-react, Microsoft Graph |
| Mobile | Capacitor 6 (Android/iOS), native QR (ML Kit), camera |
| Desktop | Electron |
| PDF generation | pdf-lib, html2canvas |
| Fleet | Open-source GPS server REST API (self-hosted) |
| AI assistant | Ollama-compatible LLM (local or tunneled HTTPS) |
| Hosting | Static SPA (e.g. Render.com) + SharePoint Online tenant |

### Representative SharePoint lists

| List | Purpose |
|------|---------|
| Orders | Weekly geo-located work orders |
| WeekAssignments | Crew role slots per order/day |
| UserTasks | Workplace task canvas items |
| TaskActivity / TaskComments / TaskFeedback | Collaboration audit |
| TimeEntries | Hours linked to tasks/orders |
| Equipment / Modules / Workwear | Asset registries |
| LoanHistory (×3) | Hand-out/hand-in audit per asset type |
| ServiceTasks | Workshop and field maintenance jobs |
| ActivityLog | Immutable per-asset action trail |
| Vehicles / Trips / Alerts / FuelLog | Fleet telemetry metadata |
| QualificationRecords / Certifications | Compliance tracking |
| EmployeeProfiles | Business attributes beyond Azure AD |
| EmailTemplates / Questionnaires | HR communications |
| FieldMemory | Form autocomplete persistence |
| DocFolderAccess | Role-based document library rules |

### Export formats (field platform)

| Format | Use |
|--------|-----|
| CSV | Equipment bulk import, HR timesheets for payroll |
| PDF | ISO inspections, service reports, qualification documents |
| SharePoint list views | Ad-hoc reporting, Power BI connector input |

---

*This document was prepared to support structured dialogue under the Request for Digital Transformation process described in the invitation PDF. It reflects the BubbleBIM codebase and complementary field operations platform capabilities as of June 2026.*
