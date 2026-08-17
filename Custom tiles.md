# Using glb to custom tiles to handle the IFC model in a new Three.js viewer - as an extension

Logical Architecture Plan for a BIM Viewer Using GLB Custom Tiles
# Data Source Layer
IFC - one conversion at the first import 
            ↓
Preprocessing Pipeline
Responsibilities
Import BIM source files
Extract geometry and metadata
Normalize coordinates
Detect reusable geometry
Generate spatial hierarchy
# Preprocessing Pipeline
Raw BIM Model
    ↓
Geometry Optimization
    ↓
Spatial Partitioning
    ↓
Batching & Instancing
    ↓
Compression
    ↓
GLB Tile Generation
Main Operations
## Geometry Optimization
Remove hidden/internal geometry
Weld vertices
Simplify meshes
Generate LODs

## Spatial Partitioning

Possible strategies:

Grid partitioning
Quadtree
Octree
Per-floor segmentation

Output:

Spatial chunks (tiles)
## Batching

Merge:

walls
slabs
pipes
ceilings

to reduce draw calls.

## Instancing

Detect repeated BIM elements:

windows
doors
furniture
columns

Convert them into GPU instances.

## Compression

Use:

Draco
Meshopt

for optimized GLB delivery.

## Tile Storage Structure
/tiles
    root.json
    tile_0_0.glb
    tile_0_1.glb
    tile_1_0.glb
    metadata/

# Tile Metadata System
root.json Example
{
  "tiles": [
    {
      "id": "tile_0_0",
      "url": "tile_0_0.glb",
      "bbox": [-10,0,-10,10,20,10],
      "lod": 0
    }
  ]
}
Metadata Contains
bounding box
LOD level
geometric error
dependencies
semantic category
visibility flags

# Client Runtime Architecture
Camera Movement
       ↓
Frustum Culling
       ↓
Tile Visibility Evaluation
       ↓
Tile Streaming Manager
       ↓
GLB Loader
       ↓
Scene Integration
# Tile Streaming System
Responsibilities
Load visible tiles
Unload distant tiles
Cache active tiles
Prioritize nearby tiles
Manage memory budget
Loading Strategy
Visible Tile
    ↓
Check Cache
    ↓
Download GLB
    ↓
Decode Compression
    ↓
Add to Scene
# Rendering Optimization Layer
Techniques Used
Frustum Culling

Render only visible tiles.

Occlusion Culling

Skip hidden interior geometry.

LOD System

Switch geometry detail based on:

distance
screen size
GPU Instancing

Render repeated elements efficiently.

Geometry Batching

Reduce draw calls.

# Scene Management
Active Scene Structure
Scene
 ├── TileManager
 ├── VisibleTiles
 ├── InstancedMeshes
 ├── DynamicObjects
 └── SelectionLayer

# BIM Metadata System
Recommended Separation
Geometry → GLB
Metadata → JSON / Database
Benefits
smaller GLB files
faster loading
independent querying
scalable property access

# Selection & Interaction System
Components
Raycasting acceleration
BVH indexing
Object highlighting
Property lookup
Isolation mode
Clipping planes
Optimization

Use:

BVH acceleration structures
tile-local raycasting

instead of global scene traversal.

# Memory Management
Runtime Policies
tile cache limits
LRU unloading
texture disposal
geometry disposal
GPU memory monitoring

# Recommended Technology Stack
Frontend
Three.js
WebGL / WebGPU
GLTFLoader
three-mesh-bvh
Formats
glTF / GLB
Draco compression
Meshopt compression
Backend
Node.js / Python preprocessing
Object storage / CDN
Worker threads
# Recommended Performance Targets
Metric	Target
Draw Calls	< 500
Visible Triangles	< 5M
FPS	60 Desktop
Tile Size	1–20 MB
Tile Load Time	< 300 ms
GPU Memory	< 2–4 GB
# High-Level Final Architecture
BIM Files
    ↓
Preprocessing Pipeline
    ↓
Spatial Tile Generation
    ↓
GLB + Metadata Export
    ↓
CDN / Storage
    ↓
Three.js Streaming Viewer
    ↓
Dynamic Tile Loading
    ↓
Optimized Real-Time Rendering