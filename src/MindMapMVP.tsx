import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import localforage from "localforage";
import { create } from "zustand";

// =====================================================
// Device Fingerprinting
// =====================================================

async function generateDeviceFingerprint(): Promise<string> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('Device fingerprint', 2, 2);
  }
  
  const fingerprint = [
    navigator.userAgent,
    navigator.language,
    screen.width + 'x' + screen.height,
    new Date().getTimezoneOffset(),
    navigator.platform,
    canvas.toDataURL(),
    navigator.hardwareConcurrency || 'unknown',
    (navigator as any).deviceMemory || 'unknown'
  ].join('|');
  
  // Simple hash function
  let hash = 0;
  for (let i = 0; i < fingerprint.length; i++) {
    const char = fingerprint.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

const DEVICE_PROFILE_KEY = 'mindmap_device_profile';

// =====================================================
// Types
// =====================================================

type ID = string;

type Camera = { x: number; y: number; zoom: number };

type Board = {
  id: ID;
  title: string;
  createdAt: number;
  updatedAt: number;
  camera: Camera;
};

type NodeT = {
  id: ID;
  boardId: ID;
  text: string;
  x: number;
  y: number;
};

type EdgeT = {
  id: ID;
  boardId: ID;
  parentNodeId: ID;
  childNodeId: ID;
};

type StrokePoint = { x: number; y: number; t: number };

type StrokeT = {
  id: ID;
  boardId: ID;
  points: StrokePoint[];
  color: string;
  size: number;
};

type Mode = "select" | "pen" | "eraser";

// =====================================================
// Persistence (only serializable pieces)
// =====================================================

const PERSIST_KEY = "mindmap-mvp-v1";
const PERSIST_VERSION = 1;

// Device-specific storage key
let DEVICE_PERSIST_KEY = PERSIST_KEY;

async function initializeDeviceProfile(): Promise<void> {
  try {
    // Check if we already have a device profile
    const existingProfile = await localforage.getItem<string>(DEVICE_PROFILE_KEY);
    if (existingProfile) {
      DEVICE_PERSIST_KEY = `${PERSIST_KEY}_${existingProfile}`;
      return;
    }
    
    // Generate new device fingerprint
    const fingerprint = await generateDeviceFingerprint();
    await localforage.setItem(DEVICE_PROFILE_KEY, fingerprint);
    DEVICE_PERSIST_KEY = `${PERSIST_KEY}_${fingerprint}`;
    
    console.log(`Device profile initialized: ${fingerprint}`);
  } catch (error) {
    console.error('Failed to initialize device profile:', error);
    // Fallback to default key
    DEVICE_PERSIST_KEY = PERSIST_KEY;
  }
}

type PersistedState = {
  _v: number;
  boards: Record<ID, Board>;
  boardOrder: ID[];
  currentBoardId: ID | null;
  nodes: Record<ID, NodeT>;
  edges: Record<ID, EdgeT>;
  strokes: Record<ID, StrokeT>;
  penColor: string;
  penSize: number;
};

// =====================================================
// Store
// =====================================================

type StoreState = {
  boards: Record<ID, Board>;
  boardOrder: ID[];
  currentBoardId: ID | null;
  nodes: Record<ID, NodeT>;
  edges: Record<ID, EdgeT>;
  strokes: Record<ID, StrokeT>;
  mode: Mode;
  penColor: StrokeT["color"];
  penSize: StrokeT["size"];
  isPanning: boolean;
  // actions
  createBoard: (title: string, prompt?: string) => void;
  switchBoard: (id: ID) => void;
  renameBoard: (id: ID, title: string) => void;
  deleteBoard: (id: ID) => void;
  setMode: (m: Mode) => void;
  setPanning: (p: boolean) => void;
  setCamera: (cam: Partial<Camera>) => void;
  addNode: (n: Partial<NodeT>) => ID;
  updateNode: (id: ID, patch: Partial<NodeT>) => void;
  moveNode: (id: ID, dx: number, dy: number) => void;
  deleteNode: (id: ID) => void;
  addEdge: (e: Partial<EdgeT>) => ID;
  addChildrenFromSide: (nodeId: ID, side: "top" | "right" | "bottom" | "left") => [ID, ID];
  // pen
  startStroke: (pt: StrokePoint) => void;
  addPointToStroke: (pt: StrokePoint) => void;
  endStroke: () => void;
  clearPen: () => void;
  eraseStrokeAt: (x: number, y: number) => void;
  // persistence
  load: () => Promise<void>;
  saveSoon: () => void;
};

const genId = () => Math.random().toString(36).slice(2, 10);

const serializeState = (s: StoreState): PersistedState => ({
  _v: PERSIST_VERSION,
  boards: s.boards,
  boardOrder: s.boardOrder,
  currentBoardId: s.currentBoardId,
  nodes: s.nodes,
  edges: s.edges,
  strokes: s.strokes,
  penColor: s.penColor,
  penSize: s.penSize,
});

let _saveTimer: number | null = null;
const debounceSave = (fn: () => void, ms = 300) => {
  if (_saveTimer) window.clearTimeout(_saveTimer);
  _saveTimer = window.setTimeout(fn, ms);
};

const useStore = create<StoreState>((set, get) => ({
  boards: {},
  boardOrder: [],
  currentBoardId: null,
  nodes: {},
  edges: {},
  strokes: {},
  mode: "select",
  penColor: "#ff0000",
  penSize: 2,
  isPanning: false,

  createBoard: (title: string, prompt?: string) => {
    const id = genId();
    const now = Date.now();
    // Center the origin in the visible viewport (assume 300px sidebar)
    const vw = Math.max(320, (window?.innerWidth ?? 1200) - 300);
    const vh = Math.max(240, window?.innerHeight ?? 800);
    const board: Board = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      camera: { x: vw / 2, y: vh / 2, zoom: 1 },
    };

    // seed central + 4 children
    const nodes = { ...get().nodes } as Record<ID, NodeT>;
    const edges = { ...get().edges } as Record<ID, EdgeT>;

    const centerId = genId();
    nodes[centerId] = { id: centerId, boardId: id, text: prompt || title || "Central", x: 0, y: 0 };

    const r = 320;
    const pts = [
      { x: r, y: 0 },
      { x: 0, y: r },
      { x: -r, y: 0 },
      { x: 0, y: -r },
    ];
    for (const p of pts) {
      const nid = genId();
      nodes[nid] = { id: nid, boardId: id, text: "", x: p.x, y: p.y };
      const eid = genId();
      edges[eid] = { id: eid, boardId: id, parentNodeId: centerId, childNodeId: nid };
    }

    set((s) => ({
      boards: { ...s.boards, [id]: board },
      boardOrder: [id, ...s.boardOrder],
      currentBoardId: id,
      nodes,
      edges,
    }));
    get().saveSoon();
  },

  switchBoard: (id: ID) => set({ currentBoardId: id }),
  renameBoard: (id: ID, title: string) => {
    set((s) => ({ boards: { ...s.boards, [id]: { ...s.boards[id], title, updatedAt: Date.now() } } }));
    get().saveSoon();
  },
  deleteBoard: (id: ID) => {
    const { boards, boardOrder, nodes, edges, strokes, currentBoardId } = get();
    const newBoards = { ...boards } as Record<ID, Board>;
    delete newBoards[id];
    const newOrder = boardOrder.filter((b) => b !== id);

    const newNodes: Record<ID, NodeT> = {};
    const newEdges: Record<ID, EdgeT> = {};
    const newStrokes: Record<ID, StrokeT> = {};

    for (const [nid, n] of Object.entries(nodes)) if ((n as NodeT).boardId !== id) newNodes[nid] = n as NodeT;
    for (const [eid, e] of Object.entries(edges)) if ((e as EdgeT).boardId !== id) newEdges[eid] = e as EdgeT;
    for (const [sid, s] of Object.entries(strokes)) if ((s as StrokeT).boardId !== id) newStrokes[sid] = s as StrokeT;

    set({
      boards: newBoards,
      boardOrder: newOrder,
      nodes: newNodes,
      edges: newEdges,
      strokes: newStrokes,
      currentBoardId: currentBoardId === id ? newOrder[0] ?? null : currentBoardId,
    });
    get().saveSoon();
  },

  setMode: (m: Mode) => set({ mode: m }),
  setPanning: (p: boolean) => set({ isPanning: p }),
  setCamera: (patch: Partial<Camera>) => {
    set((s) => {
      const id = s.currentBoardId; if (!id) return {} as any;
      const b = s.boards[id];
      return { boards: { ...s.boards, [id]: { ...b, camera: { ...b.camera, ...patch }, updatedAt: Date.now() } } };
    });
    get().saveSoon();
  },

  addNode: (n: Partial<NodeT>) => {
    const id = genId();
    const boardId = get().currentBoardId!;
    const node: NodeT = { id, boardId, text: n.text ?? "", x: n.x ?? 0, y: n.y ?? 0 };
    set((s) => ({ nodes: { ...s.nodes, [id]: node } }));
    get().saveSoon();
    return id;
  },
  updateNode: (id: ID, patch: Partial<NodeT>) => { set((s) => ({ nodes: { ...s.nodes, [id]: { ...s.nodes[id], ...patch } } })); get().saveSoon(); },
  moveNode: (id: ID, dx: number, dy: number) => { set((s) => ({ nodes: { ...s.nodes, [id]: { ...s.nodes[id], x: s.nodes[id].x + dx, y: s.nodes[id].y + dy } } })); get().saveSoon(); },
  deleteNode: (id: ID) => {
    const { nodes, edges } = get();
    const nextNodes = { ...nodes } as Record<ID, NodeT>;
    delete nextNodes[id];
    const nextEdges: Record<ID, EdgeT> = {};
    for (const [eid, e] of Object.entries(edges)) {
      const E = e as EdgeT;
      if (E.parentNodeId !== id && E.childNodeId !== id) nextEdges[eid] = E;
    }
    set({ nodes: nextNodes, edges: nextEdges });
    get().saveSoon();
  },

  addEdge: (e: Partial<EdgeT>) => {
    const id = genId();
    const boardId = get().currentBoardId!;
    const edge: EdgeT = { id, boardId, parentNodeId: e.parentNodeId!, childNodeId: e.childNodeId! };
    set((s) => ({ edges: { ...s.edges, [id]: edge } }));
    get().saveSoon();
    return id;
  },

  addChildrenFromSide: (nodeId: ID, side: "top" | "right" | "bottom" | "left") => {
    const node = get().nodes[nodeId];
    if (!node) return ["", ""] as [ID, ID];
    // forward = distance outward along the side
    // spread = perpendicular fan distance
    const forward = 260;
    const spread = 160;

    let baseX = node.x;
    let baseY = node.y;
    if (side === "right") baseX += forward;
    if (side === "left") baseX -= forward;
    if (side === "top") baseY -= forward;
    if (side === "bottom") baseY += forward;

    let c1: ID, c2: ID;
    if (side === "right" || side === "left") {
      // fan vertically
      c1 = get().addNode({ x: baseX, y: baseY - spread, text: "" });
      c2 = get().addNode({ x: baseX, y: baseY + spread, text: "" });
    } else {
      // fan horizontally
      c1 = get().addNode({ x: baseX - spread, y: baseY, text: "" });
      c2 = get().addNode({ x: baseX + spread, y: baseY, text: "" });
    }
    get().addEdge({ parentNodeId: nodeId, childNodeId: c1 });
    get().addEdge({ parentNodeId: nodeId, childNodeId: c2 });
    return [c1, c2];
  },

  // pen (transient id not persisted)
  _currentStrokeId: undefined as any,
  startStroke: (pt: StrokePoint) => {
    const id = genId();
    const boardId = get().currentBoardId!;
    const s: StrokeT = { id, boardId, points: [pt], color: get().penColor, size: get().penSize };
    set((st) => ({ strokes: { ...st.strokes, [id]: s } }));
    (get() as any)._currentStrokeId = id;
  },
  addPointToStroke: (pt: StrokePoint) => {
    const id = (get() as any)._currentStrokeId as ID;
    if (!id) return;
    set((st) => {
      const cur = st.strokes[id];
      if (!cur) return {} as any;
      return { strokes: { ...st.strokes, [id]: { ...cur, points: [...cur.points, pt] } } };
    });
  },
  endStroke: () => { (get() as any)._currentStrokeId = undefined; get().saveSoon(); },
  clearPen: () => {
    const b = get().currentBoardId; if (!b) return;
    const next: Record<ID, StrokeT> = {};
    for (const [sid, s] of Object.entries(get().strokes)) if ((s as StrokeT).boardId !== b) next[sid] = s as StrokeT;
    set({ strokes: next });
    get().saveSoon();
  },
  eraseStrokeAt: (x: number, y: number) => {
    const b = get().currentBoardId; if (!b) return;
    const eraseRadius = 25; // pixels
    const next: Record<ID, StrokeT> = {};
    
    for (const [sid, s] of Object.entries(get().strokes)) {
      const stroke = s as StrokeT;
      if (stroke.boardId !== b) {
        next[sid] = stroke;
        continue;
      }
      
      // Mark points that should be erased
      const toErase = stroke.points.map(pt => {
        const dx = pt.x - x;
        const dy = pt.y - y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        return dist < eraseRadius;
      });
      
      // Split stroke into segments (keep parts not erased)
      const segments: StrokePoint[][] = [];
      let currentSegment: StrokePoint[] = [];
      
      for (let i = 0; i < stroke.points.length; i++) {
        if (!toErase[i]) {
          currentSegment.push(stroke.points[i]);
        } else {
          if (currentSegment.length > 0) {
            segments.push(currentSegment);
            currentSegment = [];
          }
        }
      }
      if (currentSegment.length > 0) {
        segments.push(currentSegment);
      }
      
      // Create new strokes for each segment (need at least 2 points for a stroke)
      for (let i = 0; i < segments.length; i++) {
        if (segments[i].length >= 2) {
          const newId = i === 0 ? sid : genId(); // Reuse original ID for first segment
          next[newId] = {
            ...stroke,
            id: newId,
            points: segments[i]
          };
        }
      }
    }
    
    set({ strokes: next });
    get().saveSoon();
  },

  load: async () => {
    await initializeDeviceProfile();
    const data = await localforage.getItem<PersistedState | null>(DEVICE_PERSIST_KEY);
    if (data && typeof data === "object") {
      set((s) => ({
        ...s,
        boards: data.boards ?? s.boards,
        boardOrder: data.boardOrder ?? s.boardOrder,
        currentBoardId: data.currentBoardId ?? s.currentBoardId,
        nodes: data.nodes ?? s.nodes,
        edges: data.edges ?? s.edges,
        strokes: data.strokes ?? s.strokes,
        penColor: data.penColor ?? s.penColor,
        penSize: data.penSize ?? s.penSize,
      }));
    }
  },
  saveSoon: () => debounceSave(() => {
    try {
      const payload = serializeState(get());
      JSON.stringify(payload); // ensure serializable
      localforage.setItem(DEVICE_PERSIST_KEY, payload);
    } catch (err) {
      console.error("Persist failed (non-serializable?)", err);
    }
  }),
}) as any);

// =====================================================
// Helpers
// =====================================================

const NODE_W = 220;
const NODE_H = 84;
const NODE_RX = 14;

function worldToScreen(x: number, y: number, cam: Camera) { return { sx: x * cam.zoom + cam.x, sy: y * cam.zoom + cam.y }; }
function screenToWorld(sx: number, sy: number, cam: Camera) { return { x: (sx - cam.x) / cam.zoom, y: (sy - cam.y) / cam.zoom }; }

function diagonalPath(x1: number, y1: number, x2: number, y2: number) {
  // Simple straight line from center to center
  return `M ${x1} ${y1} L ${x2} ${y2}`;
}

function useEvent<K extends keyof DocumentEventMap>(type: K, handler: (ev: DocumentEventMap[K]) => void, deps: any[] = []) {
  useEffect(() => {
    const h = (e: any) => handler(e);
    document.addEventListener(type, h as any);
    return () => document.removeEventListener(type, h as any);
  }, deps); // eslint-disable-line
}

function isChildOnSide(parent: NodeT, child: NodeT, side: "top" | "right" | "bottom" | "left") {
  const dx = child.x - parent.x;
  const dy = child.y - parent.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  if (side === "right") return horizontal && dx > 0;
  if (side === "left") return horizontal && dx < 0;
  if (side === "bottom") return !horizontal && dy > 0;
  return !horizontal && dy < 0; // top
}

function hasChildOnSide(n: NodeT, side: "top" | "right" | "bottom" | "left", nodes: Record<ID, NodeT>, edges: Record<ID, EdgeT>) {
  for (const e of Object.values(edges)) {
    if (e.parentNodeId !== n.id) continue;
    const c = nodes[e.childNodeId];
    if (!c) continue;
    if (isChildOnSide(n, c, side)) return true;
  }
  return false;
}

function getConnectedSide(n: NodeT, _nodes: Record<ID, NodeT>, edges: Record<ID, EdgeT>): "top" | "right" | "bottom" | "left" | null {
  // Find which side this node is connected to its parent
  for (const e of Object.values(edges)) {
    if (e.childNodeId === n.id) {
      const parent = _nodes[e.parentNodeId];
      if (parent) {
        const dx = n.x - parent.x;
        const dy = n.y - parent.y;
        const horizontal = Math.abs(dx) >= Math.abs(dy);
        
        if (horizontal) {
          return dx > 0 ? "left" : "right"; // Node is to the right of parent, so left side faces parent
        } else {
          return dy > 0 ? "top" : "bottom"; // Node is below parent, so top side faces parent
        }
      }
    }
  }
  return null;
}

// =====================================================
// Component
// =====================================================

export default function MindMapMVP() {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const {
    boards, boardOrder, currentBoardId, nodes, edges, strokes,
    mode, penColor, penSize, isPanning,
    createBoard, switchBoard, renameBoard, deleteBoard,
    setMode, setCamera,
    addNode, updateNode, moveNode, deleteNode, addChildrenFromSide,
    startStroke, addPointToStroke, endStroke, clearPen, eraseStrokeAt,
    load,
  } = useStore();

  const currentBoard = currentBoardId ? boards[currentBoardId] : null;
  const cam = currentBoard?.camera ?? { x: 0, y: 0, zoom: 1 };

  // Modals
  const [showNewPrompt, setShowNewPrompt] = useState(false);
  const [newPromptTitle, setNewPromptTitle] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<{ id: ID; title: string } | null>(null);
  const [showRenameBoard, setShowRenameBoard] = useState<{ id: ID; title: string } | null>(null);
  const [renameBoardTitle, setRenameBoardTitle] = useState("");
  
  // Homepage state (show by default if no boards)
  const [showHomepage, setShowHomepage] = useState(() => boardOrder.length === 0);
  
  // Sidebar state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  
  // viewport size (for minimap + fit)
  const [viewport, setViewport] = useState<{ w: number; h: number }>({ w: 800, h: 600 });
  useEffect(() => {
    const update = () => {
      if (!containerRef.current) return;
      setViewport({ w: containerRef.current.clientWidth, h: containerRef.current.clientHeight });
    };
    update();
    // Also update after sidebar animation completes (300ms)
    const timer = setTimeout(update, 350);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      clearTimeout(timer);
    };
  }, [sidebarCollapsed]); // Update when sidebar collapses/expands
  
  // Eraser cursor
  const [eraserPos, setEraserPos] = useState<{ x: number; y: number } | null>(null);
  const [isErasing, setIsErasing] = useState(false);

  // Load persisted state
  useEffect(() => { load(); }, [load]);

  // Prevent browser zoom globally
  useEffect(() => {
    const preventZoom = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
      }
    };
    const preventGesture = (e: Event) => {
      e.preventDefault();
    };
    
    document.addEventListener('wheel', preventZoom, { passive: false });
    document.addEventListener('gesturestart', preventGesture);
    document.addEventListener('gesturechange', preventGesture);
    document.addEventListener('gestureend', preventGesture);
    
    return () => {
      document.removeEventListener('wheel', preventZoom);
      document.removeEventListener('gesturestart', preventGesture);
      document.removeEventListener('gesturechange', preventGesture);
      document.removeEventListener('gestureend', preventGesture);
    };
  }, []);

  // Canvas: resize + redraw strokes with camera
  const drawStrokes = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;

    // reset to device pixel ratio
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    // camera transform
    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.zoom, cam.zoom);

    const list = Object.values(strokes).filter((s) => s.boardId === currentBoardId);
    for (const s of list) {
      ctx.beginPath();
      for (let i = 0; i < s.points.length; i++) {
        const p = s.points[i];
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.lineWidth = s.size;
      ctx.lineCap = "round";
      ctx.strokeStyle = s.color;
      ctx.stroke();
    }
    ctx.restore();
    
    // Draw eraser cursor (in screen space)
    if (mode === 'eraser' && eraserPos && isErasing) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(eraserPos.x, eraserPos.y, 25, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
      ctx.fill();
      ctx.restore();
    }
  }, [strokes, currentBoardId, cam, mode, eraserPos, isErasing]);

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current; const div = containerRef.current;
    if (!canvas || !div) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(div.clientWidth * dpr);
    canvas.height = Math.floor(div.clientHeight * dpr);
    canvas.style.width = `${div.clientWidth}px`;
    canvas.style.height = `${div.clientHeight}px`;
    drawStrokes();
  }, [drawStrokes]);

  useEffect(() => { resizeCanvas(); window.addEventListener("resize", resizeCanvas); return () => window.removeEventListener("resize", resizeCanvas); }, [resizeCanvas]);
  useEffect(() => { drawStrokes(); }, [drawStrokes]);

  // Redraw when eraser position changes
  useEffect(() => {
    if (mode === 'eraser' && eraserPos) {
      drawStrokes();
    }
  }, [mode, eraserPos, drawStrokes]);

  // Wheel zoom (zoom around cursor) - handles touchpad pinch and mouse wheel
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!currentBoard) return;
    e.preventDefault();
    e.stopPropagation();
    
    const rect = containerRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    
    // Check if this is a pinch gesture (touchpad) or just scroll
    if (e.ctrlKey || e.metaKey) {
      // Pinch-to-zoom on touchpad (Ctrl+Wheel)
      // Use smaller multiplier for more controlled zoom
      const delta = e.deltaY;
      const sensitivity = Math.abs(delta) > 100 ? 0.005 : 0.01; // Less sensitive for large deltas
      const scale = Math.exp(-delta * sensitivity);
      const newZoom = Math.min(2.5, Math.max(0.2, cam.zoom * scale));
      const world = screenToWorld(sx, sy, cam);
      const nx = sx - world.x * newZoom;
      const ny = sy - world.y * newZoom;
      setCamera({ zoom: newZoom, x: nx, y: ny });
    } else if (e.shiftKey) {
      // Shift + scroll = pan (horizontal and vertical)
      setCamera({ x: cam.x - e.deltaX, y: cam.y - e.deltaY });
    } else {
      // Default scroll = zoom (more intuitive for users)
      const scale = Math.exp(-e.deltaY * 0.0015);
      const newZoom = Math.min(2.5, Math.max(0.2, cam.zoom * scale));
      const world = screenToWorld(sx, sy, cam);
      const nx = sx - world.x * newZoom;
      const ny = sy - world.y * newZoom;
      setCamera({ zoom: newZoom, x: nx, y: ny });
    }
  }, [cam, currentBoard, setCamera]);

  // Panning
  const panState = useRef<{ lastX: number; lastY: number; active: boolean } | null>(null);
  const onMouseDownCanvas = useCallback((e: React.MouseEvent) => {
    const store = useStore.getState();
    // Enable panning on: Space+left click, middle click, OR left click in select mode on canvas
    if ((store.isPanning && e.button === 0) || e.button === 1 || (e.button === 0 && mode === 'select')) {
      e.preventDefault();
      panState.current = { lastX: e.clientX, lastY: e.clientY, active: true };
      if (!store.isPanning) store.setPanning(true);
      return;
    }
  }, [mode]);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (useStore.getState().isPanning && panState.current?.active) {
      const prev = panState.current; if (!prev) return;
      const dx = e.clientX - prev.lastX; const dy = e.clientY - prev.lastY;
      setCamera({ x: cam.x + dx, y: cam.y + dy });
      panState.current = { ...prev, lastX: e.clientX, lastY: e.clientY };
    }
  }, [cam, setCamera]);
  const onMouseUpLeave = useCallback(() => {
    if (useStore.getState().isPanning) useStore.getState().setPanning(false);
    if (panState.current) panState.current.active = false;
  }, []);

  // Touch controls (pinch-to-zoom + pan)
  const touchState = useRef<{ 
    initialDist?: number; 
    initialZoom?: number; 
    centerX?: number; 
    centerY?: number;
    lastTouchX?: number;
    lastTouchY?: number;
    isPanning?: boolean;
  } | null>(null);
  
  const getDistance = (t1: React.Touch, t2: React.Touch) => {
    const dx = t2.clientX - t1.clientX;
    const dy = t2.clientY - t1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };
  
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    if (e.touches.length === 1) {
      // Single finger - start panning
      const touch = e.touches[0];
      touchState.current = {
        lastTouchX: touch.clientX,
        lastTouchY: touch.clientY,
        isPanning: true,
      };
    } else if (e.touches.length === 2) {
      // Two fingers - prepare for pinch zoom
      e.preventDefault();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = getDistance(t1, t2);
      const centerX = ((t1.clientX + t2.clientX) / 2) - rect.left;
      const centerY = ((t1.clientY + t2.clientY) / 2) - rect.top;
      touchState.current = {
        initialDist: dist,
        initialZoom: cam.zoom,
        centerX,
        centerY,
        lastTouchX: (t1.clientX + t2.clientX) / 2,
        lastTouchY: (t1.clientY + t2.clientY) / 2,
      };
    }
  }, [cam.zoom]);
  
  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchState.current) return;

    if (e.touches.length === 1 && touchState.current.isPanning) {
      // Single finger panning
      const touch = e.touches[0];
      const dx = touch.clientX - touchState.current.lastTouchX!;
      const dy = touch.clientY - touchState.current.lastTouchY!;
      
      setCamera({ x: cam.x + dx, y: cam.y + dy });
      
      touchState.current.lastTouchX = touch.clientX;
      touchState.current.lastTouchY = touch.clientY;
    } else if (e.touches.length === 2 && touchState.current.initialDist !== undefined) {
      // Two finger pinch zoom + pan
      e.preventDefault();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = getDistance(t1, t2);
      const scale = dist / touchState.current.initialDist;
      const newZoom = Math.min(2.5, Math.max(0.2, touchState.current.initialZoom! * scale));
      
      // Calculate current center
      const currentCenterX = (t1.clientX + t2.clientX) / 2;
      const currentCenterY = (t1.clientY + t2.clientY) / 2;
      
      // Pan delta
      const panDx = currentCenterX - touchState.current.lastTouchX!;
      const panDy = currentCenterY - touchState.current.lastTouchY!;
      
      // Zoom around the initial center point
      const world = screenToWorld(touchState.current.centerX!, touchState.current.centerY!, { ...cam, zoom: touchState.current.initialZoom! });
      const nx = touchState.current.centerX! - world.x * newZoom + panDx;
      const ny = touchState.current.centerY! - world.y * newZoom + panDy;
      
      setCamera({ zoom: newZoom, x: nx, y: ny });
      
      touchState.current.lastTouchX = currentCenterX;
      touchState.current.lastTouchY = currentCenterY;
    }
  }, [cam, setCamera]);
  
  const onTouchEnd = useCallback(() => {
    touchState.current = null;
  }, []);

  // Shortcuts
  useEvent("keydown", (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) {
      e.preventDefault();
      const ev = { preventDefault() {}, clientX: window.innerWidth/2, clientY: window.innerHeight/2, deltaY: -100 } as any;
      (onWheel as any)(ev);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "-") {
      e.preventDefault();
      const ev = { preventDefault() {}, clientX: window.innerWidth/2, clientY: window.innerHeight/2, deltaY: 100 } as any;
      (onWheel as any)(ev);
    }
    const k = e.key.toLowerCase();
    if (k === "v") useStore.getState().setMode("select");
    if (k === "p") useStore.getState().setMode("pen");
    if (k === "e") useStore.getState().setMode("eraser");
    if (e.code === "Space") { e.preventDefault(); useStore.getState().setPanning(true); }
  }, [onWheel]);
  useEvent("keyup", (e: KeyboardEvent) => { if (e.code === "Space") useStore.getState().setPanning(false); });

  // Editor overlay for node text
  const [editing, setEditing] = useState<{ id: ID; screenPos: { sx: number; sy: number } } | null>(null);
  const focusNode = (id: ID) => {
    // Clear any existing editing first to prevent text duplication
    setEditing(null);
    // Use setTimeout to ensure the previous editor has submitted
    setTimeout(() => {
    const n = useStore.getState().nodes[id];
    if (!n) return;
    const { sx, sy } = worldToScreen(n.x, n.y, cam);
    setEditing({ id, screenPos: { sx, sy } });
    }, 0);
  };
  const onNodeDoubleClick = (e: React.MouseEvent, n: NodeT) => { 
    e.stopPropagation(); 
    setEditing(null); // Clear first
    setTimeout(() => {
      const { sx, sy } = worldToScreen(n.x, n.y, cam); 
      setEditing({ id: n.id, screenPos: { sx, sy } });
    }, 0);
  };
  useEffect(() => { if (!editing) return; const n = useStore.getState().nodes[editing.id]; if (!n) { setEditing(null); return; } setEditing({ id: editing.id, screenPos: worldToScreen(n.x, n.y, cam) }); }, [cam, editing]);

  // Right-click context
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; world?: { x: number; y: number } } | null>(null);
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = containerRef.current!.getBoundingClientRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, cam);
    setContextMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top, world });
  };

  // Drag nodes
  const dragInfo = useRef<{ id: ID; lastX: number; lastY: number } | null>(null);
  const onNodeMouseDown = (e: React.MouseEvent, id: ID) => { if (mode !== "select") return; e.stopPropagation(); const rect = containerRef.current!.getBoundingClientRect(); const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, cam); dragInfo.current = { id, lastX: w.x, lastY: w.y }; };
  const onContainerMouseMove = (e: React.MouseEvent) => { if (!dragInfo.current || (e.buttons & 1) !== 1) return; const rect = containerRef.current!.getBoundingClientRect(); const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, cam); moveNode(dragInfo.current.id, w.x - dragInfo.current.lastX, w.y - dragInfo.current.lastY); dragInfo.current.lastX = w.x; dragInfo.current.lastY = w.y; };
  const onContainerMouseUp = () => { dragInfo.current = null; };

  // Current board slices
  const boardNodes = useMemo(() => Object.values(nodes).filter((n) => n.boardId === currentBoardId), [nodes, currentBoardId]);
  const boardEdges = useMemo(() => Object.values(edges).filter((e) => e.boardId === currentBoardId), [edges, currentBoardId]);

  // Export PNG (render everything directly onto an offscreen canvas)
  const exportPNG = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const off = document.createElement("canvas");
    off.width = Math.floor(rect.width * dpr);
    off.height = Math.floor(rect.height * dpr);
    const ctx = off.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // background
    ctx.fillStyle = "#0b0b0b";
    ctx.fillRect(0, 0, rect.width, rect.height);

    // camera transform
    ctx.save(); ctx.translate(cam.x, cam.y); ctx.scale(cam.zoom, cam.zoom);

    // pen strokes FIRST (beneath nodes)
    const strokeList = Object.values(strokes).filter((s) => s.boardId === currentBoardId);
    for (const s of strokeList) {
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < s.points.length; i++) { const p = s.points[i]; if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); }
      ctx.lineWidth = s.size; ctx.lineCap = "round"; ctx.strokeStyle = s.color; ctx.stroke();
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";

    // edges (diagonal lines)
    ctx.strokeStyle = "#999"; ctx.lineWidth = 1.8;
    for (const e of boardEdges) {
      const p = nodes[e.parentNodeId]; const c = nodes[e.childNodeId]; if (!p || !c) continue;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();
    }

    // rounded rect helper
    const rr = (x: number, y: number, w: number, h: number, r: number) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };

    // nodes + labels
    ctx.font = '12px Inter, system-ui, sans-serif';
    const wrap = (text: string, mw: number, ml: number) => {
      if (!text) return [];
      const words = text.split(' ');
      const lines: string[] = [];
      let line = "";
      for (const w of words) {
        const test = line ? line + " " + w : w;
        if (ctx.measureText(test).width > mw) {
          if (lines.length === ml - 1) {
            let t = line;
            while (ctx.measureText(t + "…").width > mw && t.length) t = t.slice(0, -1);
            lines.push(t + "…");
            line = "";
          } else {
            lines.push(line || w);
            line = line ? w : "";
          }
        } else {
          line = test;
        }
      }
      if (line && lines.length < ml) lines.push(line);
      return lines;
    };

    for (const n of boardNodes) {
      const x = n.x - NODE_W / 2; const y = n.y - NODE_H / 2;
      rr(x, y, NODE_W, NODE_H, NODE_RX);
      ctx.fillStyle = "#18181b"; ctx.strokeStyle = "#3f3f46"; ctx.lineWidth = 1.6; ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#e4e4e7"; ctx.textBaseline = "top";
      const lines = wrap(n.text || "", NODE_W - 24, 3);
      lines.forEach((ln, i) => ctx.fillText(ln, x + 12, y + 10 + i * 14));
    }

    ctx.restore();

    const a = document.createElement("a");
    a.download = `${currentBoard?.title || "board"}.png`;
    a.href = off.toDataURL("image/png");
    a.click();
  }, [nodes, strokes, currentBoardId, cam, currentBoard, boardNodes, boardEdges]);

  // Mini-map
  const mini = useMemo(() => {
    const ns = boardNodes; if (!ns.length) return null;
    const xs = ns.map((n) => n.x); const ys = ns.map((n) => n.y);
    const minX = Math.min(...xs) - 180, maxX = Math.max(...xs) + 180;
    const minY = Math.min(...ys) - 120, maxY = Math.max(...ys) + 120;
    return { minX, maxX, minY, maxY };
  }, [boardNodes]);

  // Fit to screen (content-aware)
  const fitToScreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!boardNodes.length) { setCamera({ x: viewport.w / 2, y: viewport.h / 2, zoom: 1 }); return; }
    const pad = 80;
    const xs = boardNodes.map((n) => n.x), ys = boardNodes.map((n) => n.y);
    const minX = Math.min(...xs) - (NODE_W / 2) - pad;
    const maxX = Math.max(...xs) + (NODE_W / 2) + pad;
    const minY = Math.min(...ys) - (NODE_H / 2) - pad;
    const maxY = Math.max(...ys) + (NODE_H / 2) + pad;
    const contentW = maxX - minX, contentH = maxY - minY;
    const scale = Math.max(0.2, Math.min(2.5, Math.min(viewport.w / contentW, viewport.h / contentH)));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const nx = viewport.w / 2 - cx * scale;
    const ny = viewport.h / 2 - cy * scale;
    setCamera({ zoom: scale, x: nx, y: ny });
  }, [boardNodes, setCamera, viewport.h, viewport.w]);

  // Double-click empty canvas -> note (DISABLED)
  // const onCanvasDoubleClick = (e: React.MouseEvent) => {
  //   const rect = containerRef.current!.getBoundingClientRect();
  //   const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, cam);
  //   const id = addNode({ x: w.x, y: w.y, text: "" });
  //   focusNode(id);
  // };

  const hasBoards = boardOrder.length > 0;

  return (
    <div className="w-full h-screen flex bg-zinc-900 text-zinc-100 select-none">
      {/* Sidebar - always visible */}
      <div className={`border-r border-zinc-800 p-3 flex flex-col gap-2 relative z-10 transition-all duration-300 ${sidebarCollapsed ? 'w-0 p-0 overflow-hidden' : 'w-[280px]'}`}>
        <div className="text-xs font-semibold tracking-wide mb-1">Boards</div>
        <div className="flex-1 overflow-auto">
          {boardOrder.map((id) => (
            <BoardTab
              key={id}
              board={boards[id]}
              active={currentBoardId === id}
              onClick={() => { switchBoard(id); setShowHomepage(false); }}
              onRenameClick={() => { setShowRenameBoard({ id, title: boards[id].title }); setRenameBoardTitle(boards[id].title); }}
              onDeleteClick={() => setShowDeleteConfirm({ id, title: boards[id].title })}
            />
          ))}
        </div>
        <button
          className="w-full py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs"
          onClick={() => setShowNewPrompt(true)}
        >+ New Board</button>

        {/* Tools */}
        <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs">
          <button className={`py-1.5 rounded-lg ${mode === "select" ? "bg-blue-600" : "bg-zinc-800 hover:bg-zinc-700"}`} onClick={() => setMode("select")} title="V">Select</button>
          <button className={`py-1.5 rounded-lg ${mode === "pen" ? "bg-blue-600" : "bg-zinc-800 hover:bg-zinc-700"}`} onClick={() => setMode("pen")} title="P">Pen</button>
          <button className={`py-1.5 rounded-lg ${mode === "eraser" ? "bg-blue-600" : "bg-zinc-800 hover:bg-zinc-700"}`} onClick={() => setMode("eraser")} title="E">Eraser</button>
          <button className="py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700" onClick={fitToScreen}>Fit</button>
          <button className="col-span-2 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700" onClick={exportPNG}>Export PNG</button>
          <div className="col-span-2">
            <div className="text-xs mb-1.5">Pen Controls</div>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={penColor}
                onChange={(e) => useStore.setState({ penColor: e.target.value })}
                className="w-8 h-8 rounded cursor-pointer border border-zinc-600"
                title="Pen Color"
              />
              <div className="flex items-center gap-1">
                <button 
                  className="w-6 h-6 rounded bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center text-xs"
                  onClick={() => useStore.setState({ penSize: Math.max(1, penSize - 1) })}
                  title="Decrease Size"
                >-</button>
                <div className="w-8 text-center text-xs text-zinc-300">{penSize}px</div>
                <button 
                  className="w-6 h-6 rounded bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center text-xs"
                  onClick={() => useStore.setState({ penSize: Math.min(10, penSize + 1) })}
                  title="Increase Size"
                >+</button>
              </div>
            </div>
          </div>
          <button className="col-span-2 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700" onClick={clearPen}>Clear Drawings</button>
        </div>

        <div className="mt-2 text-[10px] text-zinc-500 leading-tight">
          <div><strong>V</strong> Select • <strong>P</strong> Pen • <strong>E</strong> Eraser</div>
          <div className="mt-1"><strong>Scroll</strong> Zoom • <strong>Shift+Scroll</strong> Pan • <strong>Click+Drag</strong> Pan</div>
        </div>
      </div>

      {/* Canvas Area - Only show when NOT on homepage */}
      {!showHomepage && (
      <div
        className={`relative bg-black flex-1 ${isPanning ? 'cursor-grabbing' : 'cursor-default'}`}
        ref={containerRef}
        style={{ touchAction: 'none' }}
        onMouseMove={(e) => { onMouseMove(e); onContainerMouseMove(e); }}
        onMouseUp={() => { onMouseUpLeave(); onContainerMouseUp(); }}
        onMouseLeave={onMouseUpLeave}
        onWheel={onWheel}
        onContextMenu={onContextMenu}
        onMouseDown={(e) => {
          onMouseDownCanvas(e);
          // Close editor when clicking on canvas (not on nodes)
          if (editing && e.target === e.currentTarget) {
            setEditing(null);
          }
        }}
        onClick={(e) => {
          // Also handle via click for better reliability
          if (editing && (e.target === canvasRef.current || e.target === svgRef.current || e.target === containerRef.current)) {
            setEditing(null);
          }
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Sidebar Toggle Button */}
        <div className="absolute top-4 left-4 z-20">
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="p-2 bg-zinc-800/80 hover:bg-zinc-700/80 border border-zinc-600 rounded-xl text-zinc-100 transition-colors backdrop-blur-sm"
            title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {sidebarCollapsed ? (
                <>
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </>
              ) : (
                <>
                  <line x1="21" y1="6" x2="3" y2="6" />
                  <line x1="15" y1="12" x2="3" y2="12" />
                  <line x1="15" y1="18" x2="3" y2="18" />
                </>
              )}
            </svg>
          </button>
        </div>

        {/* ResearchRoot Logo */}
        <div className="absolute top-4 right-4 z-20">
          <button
            onClick={() => setShowHomepage(true)}
            className="px-4 py-2 bg-zinc-800/80 hover:bg-zinc-700/80 border border-zinc-600 rounded-xl text-zinc-100 font-semibold text-sm transition-colors backdrop-blur-sm"
          >
            ResearchRoot
          </button>
        </div>

        {/* SVG: nodes + edges */}
        {hasBoards && (
          <svg ref={svgRef} className="absolute inset-0 w-full h-full block" width="100%" height="100%" preserveAspectRatio="none" style={{ pointerEvents: (mode === 'pen' || mode === 'eraser') ? 'none' : 'auto' }}>
          <g transform={`translate(${cam.x},${cam.y}) scale(${cam.zoom})`}>
            {boardEdges.map((e) => {
              const p = nodes[e.parentNodeId]; const c = nodes[e.childNodeId]; if (!p || !c) return null;
              const d = diagonalPath(p.x, p.y, c.x, c.y);
              return <path key={e.id} d={d} stroke="#999" strokeWidth={1.8} fill="none" />;
            })}

            {boardNodes.map((n) => {
              const x = n.x - NODE_W / 2; const y = n.y - NODE_H / 2;
              const connectedSide = getConnectedSide(n, nodes, edges);
              const showTop = !hasChildOnSide(n, 'top', nodes, edges) && connectedSide !== 'top';
              const showRight = !hasChildOnSide(n, 'right', nodes, edges) && connectedSide !== 'right';
              const showBottom = !hasChildOnSide(n, 'bottom', nodes, edges) && connectedSide !== 'bottom';
              const showLeft = !hasChildOnSide(n, 'left', nodes, edges) && connectedSide !== 'left';
              const isEditing = editing?.id === n.id;
              return (
                <g key={n.id} transform={`translate(${x},${y})`} 
                   onMouseDown={(e) => onNodeMouseDown(e, n.id)} 
                   onClick={(e) => {
                     // If editing a different node, exit edit mode first
                     if (editing && editing.id !== n.id) {
                       e.stopPropagation();
                       setEditing(null);
                     }
                   }}
                   onDoubleClick={(e) => onNodeDoubleClick(e, n)}>
                  <rect rx={NODE_RX} ry={NODE_RX} width={NODE_W} height={NODE_H} fill="#18181b" stroke={isEditing ? "#3b82f6" : "#3f3f46"} strokeWidth={isEditing ? 2 : 1.6} />
                  {/* delete X */}
                  <g transform={`translate(${NODE_W - 18}, 6)`}>
                    <rect width={12} height={12} rx={3} ry={3} fill="#3f3f46" className="cursor-pointer" onClick={(e) => { e.stopPropagation(); deleteNode(n.id); }} />
                    <path d="M 3 3 L 9 9 M 9 3 L 3 9" stroke="#e4e4e7" strokeWidth={1.4} strokeLinecap="round" pointerEvents="none" />
                  </g>

                  {!isEditing && (
                  <foreignObject x={12} y={10} width={NODE_W - 24} height={NODE_H - 20} pointerEvents="none">
                      <div className="text-sm leading-snug text-zinc-200 break-words" style={{ fontFamily: "Inter, sans-serif", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 3 as any, WebkitBoxOrient: "vertical" as any, wordBreak: "break-word" }}>{n.text || <span className="text-zinc-500 italic">Empty node</span>}</div>
                  </foreignObject>
                  )}

                  {/* Plus handles (per side; disappear once children exist on that side) */}
                  {showTop && <PlusHandle cx={NODE_W / 2} cy={-8} onClick={() => { const [c1] = addChildrenFromSide(n.id, 'top'); focusNode(c1); }} />}
                  {showRight && <PlusHandle cx={NODE_W + 8} cy={NODE_H / 2} onClick={() => { const [c1] = addChildrenFromSide(n.id, 'right'); focusNode(c1); }} />}
                  {showBottom && <PlusHandle cx={NODE_W / 2} cy={NODE_H + 8} onClick={() => { const [c1] = addChildrenFromSide(n.id, 'bottom'); focusNode(c1); }} />}
                  {showLeft && <PlusHandle cx={-8} cy={NODE_H / 2} onClick={() => { const [c1] = addChildrenFromSide(n.id, 'left'); focusNode(c1); }} />}
                </g>
              );
            })}
          </g>
        </svg>
        )}

        {/* Pen/Eraser canvas: only interactive in Pen/Eraser mode so it doesn't block handles */}
        {hasBoards && (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ 
            pointerEvents: (mode === 'pen' || mode === 'eraser') ? 'auto' : 'none',
            cursor: mode === 'eraser' ? 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'16\' height=\'16\' viewBox=\'0 0 16 16\'><circle cx=\'8\' cy=\'8\' r=\'2\' fill=\'rgba(239, 68, 68, 0.8)\'/></svg>") 8 8, auto' : 'default'
          }}
          onMouseDown={(e) => {
            const store = useStore.getState();
            if (store.isPanning) return;
            const rect = containerRef.current!.getBoundingClientRect();
            const screenX = e.clientX - rect.left;
            const screenY = e.clientY - rect.top;
            const { x, y } = screenToWorld(screenX, screenY, cam);
            if (mode === 'pen') {
              startStroke({ x, y, t: Date.now() });
            } else if (mode === 'eraser') {
              setIsErasing(true);
              setEraserPos({ x: screenX, y: screenY });
              eraseStrokeAt(x, y);
              drawStrokes();
            }
          }}
          onMouseMove={(e) => {
            const rect = containerRef.current!.getBoundingClientRect();
            const screenX = e.clientX - rect.left;
            const screenY = e.clientY - rect.top;
            
            if (mode === 'eraser') {
              setEraserPos({ x: screenX, y: screenY });
              if ((e.buttons & 1) === 1) {
                const { x, y } = screenToWorld(screenX, screenY, cam);
                eraseStrokeAt(x, y);
                drawStrokes();
              }
            }
            
            if ((e.buttons & 1) !== 1) return;
            const store = useStore.getState();
            if (store.isPanning) return;
            const { x, y } = screenToWorld(screenX, screenY, cam);
            if (mode === 'pen') { 
              addPointToStroke({ x, y, t: Date.now() }); 
              drawStrokes(); 
            }
          }}
          onMouseUp={() => { 
            if (mode === 'pen') endStroke();
            if (mode === 'eraser') {
              setIsErasing(false);
            }
          }}
          onMouseLeave={() => {
            if (mode === 'eraser') {
              setEraserPos(null);
              setIsErasing(false);
            }
          }}
        />
        )}

        {/* Inline editor */}
        {editing && hasBoards && (
          <InlineEditor
            x={editing.screenPos.sx}
            y={editing.screenPos.sy}
            initial={nodes[editing.id]?.text || ""}
            onSubmit={(txt) => { 
              const id = editing.id;
              setEditing(null); 
              updateNode(id, { text: txt });
            }}
            onCancel={() => setEditing(null)}
          />
        )}

        {/* Context menu */}
        {hasBoards && contextMenu && (
          <div className="absolute z-50 bg-zinc-800 border border-zinc-700 rounded-xl p-1 text-sm" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseLeave={() => setContextMenu(null)}>
            <button className="block px-3 py-2 hover:bg-zinc-700 rounded-lg w-full text-left" onClick={() => { fitToScreen(); setContextMenu(null); }}>Fit to screen</button>
            <button className="block px-3 py-2 hover:bg-zinc-700 rounded-lg w-full text-left" onClick={() => { clearPen(); setContextMenu(null); }}>Clear pen</button>
            <button className="block px-3 py-2 hover:bg-zinc-700 rounded-lg w-full text-left" onClick={() => { if (contextMenu.world) { const id = addNode({ x: contextMenu.world.x, y: contextMenu.world.y, text: "" }); focusNode(id); } setContextMenu(null); }}>Add note here</button>
          </div>
        )}

        {/* Mini-map */}
        {hasBoards && mini && (
          <div className="absolute right-3 bottom-3 w-44 h-28 bg-zinc-800/80 border border-zinc-700 rounded-xl p-1 pointer-events-none">
            <MiniMap 
              key={`${cam.x}-${cam.y}-${cam.zoom}-${viewport.w}-${viewport.h}`}
              nodes={boardNodes} 
              camera={cam} 
              box={mini} 
              viewport={viewport} 
            />
            <div className="absolute top-1 right-1 px-2 py-0.5 bg-zinc-900/90 rounded text-[10px] text-zinc-300 font-semibold">
              {Math.round(cam.zoom * 100)}%
            </div>
          </div>
        )}


        {/* New Prompt Modal */}
        {showNewPrompt && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-50" onMouseDown={() => setShowNewPrompt(false)}>
            <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-4 w-[420px]" onMouseDown={(e) => e.stopPropagation()}>
              <div className="text-sm font-semibold mb-2">Create new board</div>
              <input
                autoFocus
                className="w-full px-3 py-2 rounded-xl bg-zinc-800 border border-zinc-700 outline-none"
                placeholder="Enter prompt/title"
                value={newPromptTitle}
                onChange={(e) => setNewPromptTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { const t = newPromptTitle.trim() || 'Untitled'; createBoard(t, t); setShowNewPrompt(false); setNewPromptTitle(""); }
                  if (e.key === 'Escape') setShowNewPrompt(false);
                }}
              />
              <div className="mt-3 flex justify-end gap-2 text-sm">
                <button className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700" onClick={() => setShowNewPrompt(false)}>Cancel</button>
                <button className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700" onClick={() => { const t = newPromptTitle.trim() || 'Untitled'; createBoard(t, t); setShowNewPrompt(false); setNewPromptTitle(""); }}>Create</button>
              </div>
            </div>
          </div>
        )}

        {/* Delete Confirmation Modal */}
        {showDeleteConfirm && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-50" onMouseDown={() => setShowDeleteConfirm(null)}>
            <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-5 w-[420px]" onMouseDown={(e) => e.stopPropagation()}>
              <div className="text-lg font-semibold mb-3">Delete Board?</div>
              <div className="text-sm text-zinc-400 mb-4">
                Are you sure you want to delete "<span className="text-zinc-100">{showDeleteConfirm.title}</span>"? This action cannot be undone.
              </div>
              <div className="flex justify-end gap-2 text-sm">
                <button className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700" onClick={() => setShowDeleteConfirm(null)}>Cancel</button>
                <button className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700" onClick={() => { 
                  deleteBoard(showDeleteConfirm.id); 
                  setShowDeleteConfirm(null); 
                  // If no boards left, go to homepage
                  if (boardOrder.length === 1) {
                    setShowHomepage(true);
                  }
                }}>Delete</button>
              </div>
            </div>
          </div>
        )}

        {/* Rename Board Modal */}
        {showRenameBoard && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-50" onMouseDown={() => setShowRenameBoard(null)}>
            <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-4 w-[420px]" onMouseDown={(e) => e.stopPropagation()}>
              <div className="text-sm font-semibold mb-2">Rename Board</div>
              <input
                autoFocus
                className="w-full px-3 py-2 rounded-xl bg-zinc-800 border border-zinc-700 outline-none"
                placeholder="Enter new title"
                value={renameBoardTitle}
                onChange={(e) => setRenameBoardTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { 
                    const t = renameBoardTitle.trim();
                    if (t) renameBoard(showRenameBoard.id, t);
                    setShowRenameBoard(null);
                    setRenameBoardTitle("");
                  }
                  if (e.key === 'Escape') { setShowRenameBoard(null); setRenameBoardTitle(""); }
                }}
              />
              <div className="mt-3 flex justify-end gap-2 text-sm">
                <button className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700" onClick={() => { setShowRenameBoard(null); setRenameBoardTitle(""); }}>Cancel</button>
                <button className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700" onClick={() => { 
                  const t = renameBoardTitle.trim();
                  if (t) renameBoard(showRenameBoard.id, t);
                  setShowRenameBoard(null);
                  setRenameBoardTitle("");
                }}>Rename</button>
              </div>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Homepage - Full screen view */}
      {showHomepage && (
        <div className="flex-1 relative bg-black flex flex-col items-center justify-center gap-8 px-4">
          <div className="text-center max-w-3xl">
            <h1 className="text-5xl font-bold mb-4 text-zinc-100 tracking-tight">ResearchRoot</h1>
            <p className="text-xl text-zinc-400 mb-8">Transform your research into visual mind maps. Start by describing what you want to explore.</p>
          </div>
          
          {/* Direct Input */}
          <div className="w-full max-w-2xl">
            <div className="relative">
              <input
                type="text"
                placeholder="What would you like to research today?"
                className="w-full px-6 py-4 pr-32 rounded-2xl bg-zinc-800 border-2 border-zinc-700 focus:border-blue-500 outline-none text-zinc-100 text-lg placeholder-zinc-500 transition-colors"
                value={newPromptTitle}
                onChange={(e) => setNewPromptTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newPromptTitle.trim()) {
                    const title = newPromptTitle.trim();
                    createBoard(title, title);
                    setShowHomepage(false);
                    setNewPromptTitle("");
                  }
                }}
                autoFocus
              />
              <button
                onClick={() => {
                  if (newPromptTitle.trim()) {
                    const title = newPromptTitle.trim();
                    createBoard(title, title);
                    setShowHomepage(false);
                    setNewPromptTitle("");
                  }
                }}
                disabled={!newPromptTitle.trim()}
                className="absolute right-2 top-1/2 -translate-y-1/2 px-6 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-700 disabled:text-zinc-500 disabled:cursor-not-allowed text-white font-medium transition-colors"
              >
                Start →
              </button>
            </div>
            <p className="text-sm text-zinc-500 mt-3 text-center">Press Enter or click Start to create your mind map</p>
          </div>
          
          {/* Recent Boards */}
          {hasBoards && (
            <div className="w-full max-w-2xl mt-4">
              <h2 className="text-sm font-semibold text-zinc-400 mb-3 uppercase tracking-wide">Recent Boards</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {boardOrder.slice(0, 4).map((id) => (
                  <button
                    key={id}
                    onClick={() => {
                      switchBoard(id);
                      setShowHomepage(false);
                    }}
                    className="px-4 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-left transition-colors group"
                  >
                    <div className="text-zinc-100 font-medium truncate group-hover:text-blue-400 transition-colors">{boards[id].title}</div>
                    <div className="text-xs text-zinc-500 mt-1">Updated {new Date(boards[id].updatedAt).toLocaleDateString()}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PlusHandle({ cx, cy, onClick }: { cx: number; cy: number; onClick: () => void }) {
  return (
    <g transform={`translate(${cx - 12},${cy - 12})`}>
      <rect width={24} height={24} rx={7} ry={7} fill="#1f2937" stroke="#374151" onClick={(e) => { e.stopPropagation(); onClick(); }} />
      <path d="M 12 5 L 12 19 M 5 12 L 19 12" stroke="#a3a3a3" strokeWidth={1.8} strokeLinecap="round" pointerEvents="none" />
    </g>
  );
}

function InlineEditor({ x, y, initial, onSubmit, onCancel }: { x: number; y: number; initial: string; onSubmit: (txt: string) => void; onCancel: () => void; }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [val, setVal] = useState(initial);
  const hasSubmitted = useRef(false);
  
  // Reset val when initial changes (switching nodes)
  useEffect(() => {
    setVal(initial);
  }, [initial]);
  
  useEffect(() => { 
    inputRef.current?.focus(); 
    inputRef.current?.select(); 
  }, []);
  
  const handleSubmit = () => {
    if (!hasSubmitted.current) {
      hasSubmitted.current = true;
      onSubmit(val.trim());
    }
  };
  
  const handleCancel = () => {
    if (!hasSubmitted.current) {
      hasSubmitted.current = true;
      onCancel();
    }
  };
  
  return (
    <div className="absolute bg-zinc-800 rounded-xl shadow-lg" style={{ left: x - NODE_W / 2, top: y - NODE_H / 2, width: NODE_W, height: NODE_H }}>
      <textarea
        ref={inputRef}
        className="w-full h-full text-sm text-zinc-100 bg-zinc-800 border-2 border-blue-500 rounded-xl px-3 py-2.5 outline-none resize-none leading-snug"
        style={{ fontFamily: "Inter, sans-serif" }}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { 
          if (e.key === "Enter" && !e.shiftKey) { 
            e.preventDefault(); 
            handleSubmit();
          } 
          if (e.key === "Escape") {
            e.preventDefault();
            handleCancel();
          }
        }}
        onBlur={handleSubmit}
        placeholder="Type here..."
      />
    </div>
  );
}

function BoardTab({ board, active, onClick, onRenameClick, onDeleteClick }: { board: Board; active: boolean; onClick: () => void; onRenameClick: () => void; onDeleteClick: () => void; }) {
  return (
    <div className={`group px-2 py-1.5 rounded-lg mb-1 cursor-pointer ${active ? "bg-zinc-800" : "hover:bg-zinc-800/60"}`}
      onClick={onClick}>
      <div className="flex items-center justify-between gap-1.5">
        <div className="truncate text-xs">{board.title}</div>
        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5">
          <button type="button" className="text-[10px] px-1 py-0.5 bg-zinc-700 rounded hover:bg-zinc-600" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onRenameClick(); }}>Rename</button>
          <button type="button" className="text-[10px] px-1 py-0.5 bg-red-700 rounded hover:bg-red-600" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDeleteClick(); }}>Del</button>
        </div>
      </div>
      <div className="text-[9px] text-zinc-500">Updated {new Date(board.updatedAt).toLocaleDateString()}</div>
    </div>
  );
}

function MiniMap({ nodes, camera, box, viewport }: { 
  nodes: NodeT[]; 
  camera: Camera; 
  box: { minX: number; maxX: number; minY: number; maxY: number };
  viewport: { w: number; h: number };
}) {
  const w = 170, h = 90;
  const pad = 5;
  
  // Calculate content dimensions
  const contentW = box.maxX - box.minX;
  const contentH = box.maxY - box.minY;
  
  // Scale to fit minimap with padding
  const scaleX = (w - pad * 2) / contentW;
  const scaleY = (h - pad * 2) / contentH;
  const s = Math.min(scaleX, scaleY);
  
  // Center the content in the minimap
  const scaledW = contentW * s;
  const scaledH = contentH * s;
  const offX = (w - scaledW) / 2 - box.minX * s;
  const offY = (h - scaledH) / 2 - box.minY * s;

  // Calculate viewport rectangle in world coordinates
  const tl = screenToWorld(0, 0, camera);
  const br = screenToWorld(viewport.w, viewport.h, camera);
  
  // Convert to minimap coordinates using the same transform as nodes
  const viewportX = tl.x * s + offX;
  const viewportY = tl.y * s + offY;
  const viewportW = (br.x - tl.x) * s;
  const viewportH = (br.y - tl.y) * s;

  // Node size on minimap - scale with zoom level
  // When zoomed in (>100%), nodes appear larger
  // When zoomed out (<100%), nodes appear smaller
  const baseNodeW = 14;
  const baseNodeH = 9;
  const zoomScale = Math.max(0.4, Math.min(1.8, camera.zoom));
  const nodeW = baseNodeW * zoomScale;
  const nodeH = baseNodeH * zoomScale;

  return (
    <svg className="w-full h-full">
      <rect x={0} y={0} width="100%" height="100%" fill="#0a0a0a" stroke="#3f3f46" rx={10} />
      {nodes.map((n) => (
        <rect 
          key={n.id} 
          x={n.x * s + offX - nodeW / 2} 
          y={n.y * s + offY - nodeH / 2} 
          width={nodeW} 
          height={nodeH} 
          fill="#52525b" 
          rx={2} 
        />
      ))}
      <rect 
        x={viewportX} 
        y={viewportY} 
        width={Math.max(viewportW, 1)} 
        height={Math.max(viewportH, 1)} 
        fill="rgba(96, 165, 250, 0.15)" 
        stroke="#60a5fa" 
        strokeWidth={2} 
        rx={2}
      />
    </svg>
  );
} 