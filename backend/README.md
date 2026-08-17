# BubbleGraph Backend API

Python + FastAPI backend for BubbleGraph visual editor.

## Quick Start

### 1. Install Python (if needed)
- Download from https://www.python.org/downloads/
- Ensure Python 3.10+ is installed

### 2. Setup Virtual Environment

**Windows (PowerShell):**
```powershell
python -m venv venv
.\venv\Scripts\Activate
```

**macOS/Linux:**
```bash
python3 -m venv venv
source venv/bin/activate
```

### 3. Install Dependencies
```bash
pip install -r requirements.txt
```

### 4. Start Backend
```bash
python main.py
```

✅ API will be available at **http://localhost:8000**

---

## API Documentation

**Interactive Docs:** http://localhost:8000/docs

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/graph/load` | Load graph data |
| POST | `/api/graph/save` | Save graph data |
| POST | `/api/graph/backup` | Create backup |
| GET | `/api/graph/backups` | List backups |
| POST | `/api/graph/export-ifc` | Export as IFC |
| POST | `/api/graph/export-svg` | Export as SVG |

---

## Example Usage (Frontend)

```typescript
import { loadGraph, saveGraph } from '@/lib/api';

// Load from backend
const data = await loadGraph();

// Save to backend
await saveGraph({
  nodes: [...],
  edges: [...],
  buildingAxes: { xValues: [], yValues: [] }
});
```

---

## Database

- **Format:** JSON (easily extensible to LadybugDB)
- **Location:** `./graph.db`
- **Backups:** `./backups/`

Automatic backups are created before each save.

---

## Configuration

Edit `.env` to customize:
```env
API_PORT=8000
FRONTEND_URL=http://localhost:3103
DEBUG=True
```

---

## Troubleshooting

**Port 8000 in use?**
```bash
python main.py --port 8001
```

**CORS errors?**
- Ensure frontend is running on port from `CORS_ORIGINS` in `.env`
- Update `.env` if using different port

**Database errors?**
- Delete `graph.db` to start fresh
- Check `backups/` folder for recovery

---

## Future Enhancements

- [ ] LadybugDB integration for Cypher queries
- [ ] WebSocket support for real-time collaboration
- [ ] User authentication
- [ ] Full IFC STEP export (@ifc-lite/create)
- [ ] SVG floor-plan rendering (@ifc-lite/drawing-2d)

---

## Development

Watch for changes and auto-reload:
```bash
python main.py  # Already has reload=True
```

---

**Backend API Version:** 1.14.1  
**Python:** 3.10+  
**FastAPI:** 0.104.1
