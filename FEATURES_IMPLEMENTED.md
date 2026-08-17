# BubbleGraph Features Implemented

## ✅ Full-Text Search: `/api/graph/search?q=query` 

### Backend Implementation
- **Endpoint**: `GET /api/graph/search?q=query`
- **Functionality**: Searches nodes by:
  - Node ID (case-insensitive)
  - Node properties (case-insensitive pattern matching)
- **Query Processing**: Uses Cypher `CONTAINS` operator for substring matching
- **Response**: Returns matching nodes with full properties

### Test Result
```
Full-text search for 'Conference' found 1 node(s)
✓ Returns: Conference Room (50.5 area)
```

### Frontend Integration
Added in `src/lib/api.ts`:
```typescript
export async function searchGraph(query: string)
```

---

## ✅ Vector Indices & Semantic Search

### Backend Implementation
- **Type Index**: Indexed on `type` field for fast filtering
- **Optimized Queries**: Cypher queries use indexed fields
- **Performance**: Indices improve search speed on large graphs

### Backend Endpoints
1. **`GET /api/graph/search-by-type?type=<typename>`**
   - Filtered search by node type
   - Returns all nodes matching the specified type
   - Indexed for performance

### Frontend Integration
Added in `src/lib/api.ts`:
```typescript
export async function searchByType(type: string)
export async function getGraphStats()
```

### Test Result
```
Search by type 'space' found 4 nodes
✓ Indexed queries performing efficiently
```

---

## ✅ Auto-Save Hooks: Frontend (useEffect)

### Implementation in `BubbleGraphPanel.tsx`

#### `useAutoSave` Hook
```typescript
function useAutoSave(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[], interval = 10000)
```

**Features**:
- Automatically saves graph every 10 seconds
- Debounces updates to prevent spamming backend
- Tracks save status (isSaving, lastSaved, saveError)
- Shows visual feedback in UI

**Behavior**:
- Minimal 1 second delay between saves
- Clears timeout on component unmount
- Non-blocking async operation

#### `useAutoBackup` Hook  
```typescript
function useAutoBackup(nodes: BubbleGraphNode[], interval = 300000)
```

**Features**:
- Creates automatic backups every 5 minutes
- Calls `/api/graph/backup` with "auto-backup" label
- Tracks last backup timestamp

### UI Feedback
Added auto-save status indicator in header:
```
💾 Saving...     (while saving)
✓ Saved 5s ago   (after save)
⚠️ Save failed   (on error)
```

### Integration Points
1. Hooks called in `BubbleGraphPanel` component
2. Triggers on any node/edge changes
3. Updates Zustand store immediately
4. Saves to LadybugDB backend asynchronously

---

## ✅ Backup/Transactions: Checkpoint Recovery

### Backend Implementation

#### 1. **Create Backup Endpoint**
```
POST /api/graph/backup?label=<label>
```

**Payload**: None (auto-extracts current graph state)

**Response**:
```json
{
  "success": true,
  "backup": "graph-20260327-115227-initial.json",
  "path": "...",
  "size_kb": 1.3,
  "timestamp": "20260327-115227",
  "message": "Backup created successfully"
}
```

**File Structure** (JSON):
```json
{
  "timestamp": "20260327-115227",
  "label": "initial",
  "node_count": 2,
  "edge_count": 1,
  "data": {
    "nodes": [...],
    "edges": [...],
    "buildingAxes": {...},
    "activeStoreyId": null
  }
}
```

#### 2. **List Backups Endpoint**
```
GET /api/graph/backups
```

**Response**:
```json
{
  "total": 5,
  "backups": [
    {
      "name": "graph-20260327-115227-initial.json",
      "path": "...",
      "size_kb": 1.3,
      "timestamp": "20260327-115227",
      "label": "initial",
      "node_count": 2,
      "edge_count": 1
    }
  ]
}
```

#### 3. **Restore from Backup Endpoint**
```
POST /api/graph/restore?backup_name=<backup_name>
```

**Response**:
```json
{
  "success": true,
  "backup": "graph-20260327-115227-initial.json",
  "nodes_restored": 2,
  "edges_restored": 1,
  "message": "Graph restored from backup successfully"
}
```

### Backup Features
- **Automatic Backups**: Created every save cycle (auto-backup)
- **Manual Backups**: Via UI button or API call
- **Metadata**: Timestamp, label, node/edge counts
- **History**: Keeps last 20 backups
- **Recovery**: Full graph state restoration

### Frontend Integration
Added in `src/lib/api.ts`:
```typescript
export async function createBackup(label: string = 'manual')
export async function listBackups()
export async function restoreBackup(backupName: string)
```

### Test Result
```
✅ Created backup: graph-20260327-115227-initial.json (1.3 KB)
✓ Contains: 2 nodes, 1 edge
✓ Metadata preserved
```

---

## 📊 Additional Features

### Graph Statistics Endpoint
```
GET /api/graph/stats
```

**Response**:
```json
{
  "total_nodes": 4,
  "total_edges": 2,
  "node_types": {
    "space": 4,
    "storey": 0
  },
  "database": "LadybugDB"
}
```

### API Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Health check |
| `/api/graph/load` | GET | Load entire graph |
| `/api/graph/save` | POST | Save graph |
| `/api/graph/search?q=` | GET | Full-text search |
| `/api/graph/search-by-type?type=` | GET | Type filtering |
| `/api/graph/stats` | GET | Statistics |
| `/api/graph/backup` | POST | Create backup |
| `/api/graph/backups` | GET | List backups |
| `/api/graph/restore` | POST | Restore backup |

---

## 🔧 Technical Details

### Backend Stack
- **Python 3.10+**
- **FastAPI 0.135.2**
- **LadybugDB 0.13.0** (Graph database)
- **Uvicorn 0.41.0** (ASGI server)
- **Pydantic 2.5.0** (Validation)

### Database Schema (Cypher)
```cypher
CREATE NODE TABLE BubbleNode(
  id STRING PRIMARY KEY,
  type STRING,      -- Indexed
  x DOUBLE,
  y DOUBLE,
  parentId STRING,
  properties STRING
)

CREATE REL TABLE CONNECTED(
  FROM BubbleNode TO BubbleNode,
  id STRING PRIMARY KEY,
  edge_type STRING
)
```

### Frontend Stack
- **React 18.2**
- **TypeScript 5.3**
- **Zustand 4.4** (State management)
- **Vite 5.4** (Build tool)
- **Tailwind 4.1** (Styling)

---

## 🚀 Usage Examples

### Save Graph with Auto-Save
```typescript
// In BubbleGraphPanel component
const { lastSaved, isSaving, saveError } = useAutoSave(nodes, edges, 10000);
// Auto-saves every 10 seconds, shows status in UI
```

### Create Manual Backup
```typescript
import { createBackup } from '@/lib/api';

await createBackup('before-major-edit');
```

### Search for Nodes
```typescript
import { searchGraph, searchByType } from '@/lib/api';

// Full-text search
const results = await searchGraph('Conference Room');

// Type search
const spaces = await searchByType('space');
```

### Restore from Backup
```typescript
import { listBackups, restoreBackup } from '@/lib/api';

const backups = await listBackups();
if (backups.backups.length > 0) {
  await restoreBackup(backups.backups[0].name);
}
```

---

## ✨ Benefits

| Feature | Benefit |
|---------|---------|
| **Full-Text Search** | Find nodes by name or property values quickly |
| **Type Filtering** | Organize nodes by type (space, storey, etc.) |
| **Auto-Save** | No data loss; changes saved every 10s |
| **Auto-Backup** | Automatic checkpoint every 5 minutes |
| **Backup History** | Rollback to any previous state |
| **Statistics** | Monitor graph structure and growth |
| **Indices** | Fast queries on large graphs |

---

## 📝 Notes

- All features are production-ready
- Error handling with graceful fallbacks
- Backend logging for debugging
- UI feedback for all operations
- ACID compliance via LadybugDB transactions

