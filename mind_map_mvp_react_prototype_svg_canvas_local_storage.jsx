import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import localforage from "localforage";
import { create } from "zustand";

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
  color: "black" | "red";
  size: 2 | 4;
};

type Mode = "select" | "pen";

// =====================================================
// Persistence (only serializable pieces)
// =====================================================

const PERSIST_KEY = "mindmap-mvp-v1";
const PERSIST_VERSION = 1;

type PersistedState = {
  _v: number;
  boards: Record<ID, Board>;
  boardOrder: ID[];
  currentBoardId: ID | null;
  nodes: Record<ID, NodeT>;
  edges: Record<ID, EdgeT>;
  strokes: Record<ID, StrokeT>;
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
  addEdge: (e: Partial<EdgeT>) => ID;
  addChildrenFromSide: (nodeId: ID, side: "top" | "right" | "bottom" | "left") => void;
  // pen
  startStroke: (pt: StrokePoint) => void;
  addPointToStroke: (pt: StrokePoint) => void;
  endStroke: () => void;
  clearPen: () => void;
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
  penColor: "black",
  penSize: 2,
  isPanning: false,

  createBoard: (title: string, prompt?: string) => {
    const id = genId();
    const now = Date.now();
    const board: Board = { id, title, createdAt: now, updatedAt: now, camera: { x: 0, y: 0, zoom: 1 } };

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

  switchBoard: (id) => set({ currentBoardId: id }),
  renameBoard: (id, title) => {
    set((s) => ({ boards: { ...s.boards, [id]: { ...s.boards[id], title, updatedAt: Date.now() } } }));
    get().saveSoon();
  },
  deleteBoard: (id) => {
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

  setMode: (m) => set({ mode: m }),
  setPanning: (p) => set({ isPanning: p }),
  setCamera: (patch) => {
    set((s) => {
      const id = s.currentBoardId; if (!id) return {} as any;
      const b = s.boards[id];
      return { boards: { ...s.boards, [id]: { ...b, camera: { ...b.camera, ...patch }, updatedAt: Date.now() } } };
    });
    get().saveSoon();
  },

  addNode: (n) => {
    const id = genId();
    const boardId = get().currentBoardId!;
    const node: NodeT = { id, boardId, text: n.text ?? "", x: n.x ?? 0, y: n.y ?? 0 };
    set((s) => ({ nodes: { ...s.nodes, [id]: node } }));
    get().saveSoon();
    return id;
  },
  updateNode: (id, patch) => { set((s) => ({ nodes: { ...s.nodes, [id]: { ...s.nodes[id], ...patch } } })); get().saveSoon(); },
  moveNode: (id, dx, dy) => { set((s) => ({ nodes: { ...s.nodes, [id]: { ...s.nodes[id], x: s.nodes[id].x + dx, y: s.nodes[id].y + dy } } })); get().saveSoon(); },

  addEdge: (e) => {
    const id = genId();
    const boardId = get().currentBoardId!;
    const edge: EdgeT = { id, boardId, parentNodeId: e.parentNodeId!, childNodeId: e.childNodeId! };
    set((s) => ({ edges: { ...s.edges, [id]: edge } }));
    get().saveSoon();
    return id;
  },

  addChildrenFromSide: (nodeId, side) => {
    const node = get().nodes[nodeId];
    if (!node) return;
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
  },

  // pen (transient id not persisted)
  _currentStrokeId: undefined as any,
  startStroke: (pt) => {
    const id = genId();
    const boardId = get().currentBoardId!;
    const s: StrokeT = { id, boardId, points: [pt], color: get().penColor, size: get().penSize };
    set((st) => ({ strokes: { ...st.strokes, [id]: s } }));
    (get() as any)._currentStrokeId = id;
  },
  addPointToStroke: (pt) => {
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

  load: async () => {
    const data = await localforage.getItem<PersistedState | null>(PERSIST_KEY);
    if (data && typeof data === "object") {
      set((s) => ({
        ...s,
        boards: data.boards ?? s.boards,
        boardOrder: data.boardOrder ?? s.boardOrder,
        currentBoardId: data.currentBoardId ?? s.currentBoardId,
        nodes: data.nodes ?? s.nodes,
        edges: data.edges ?? s.edges,
        strokes: data.strokes ?? s.strokes,
      }));
    }
  },
  saveSoon: () => debounceSave(() => {
    try {
      const payload = serializeState(get());
      JSON.stringify(payload); // ensure serializable
      localforage.setItem(PERSIST_KEY, payload);
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

function elbowPath(x1: number, y1: number, x2: number, y2: number) {
  const verticalFirst = Math.abs(y2 - y1) > Math.abs(x2 - x1);
  if (verticalFirst) { return `M ${x1} ${y1} L ${x1} ${y2} L ${x2} ${y2}`; }
  return `M ${x1} ${y1} L ${x2} ${y1} L ${x2} ${y2}`;
}

function useEvent<K extends keyof DocumentEventMap>(type: K, handler: (ev: DocumentEventMap[K]) => void, deps: any[] = []) {
  useEffect(() => {
    const h = (e: any) => handler(e);
    document.addEventListener(type, h as any);
    return () => document.removeEventListener(type, h as any);
  }, deps); // eslint-disable-line
}

function isLeaf(nodeId: ID, edges: Record<ID, EdgeT>) {
  for (const e of Object.values(edges)) if (e.parentNodeId === nodeId) return false;
  return true;
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
    setMode, setPanning, setCamera,
    addNode, updateNode, moveNode, addChildrenFromSide,
    startStroke, addPointToStroke, endStroke, clearPen,
    load,
  } = useStore();

  const currentBoard = currentBoardId ? boards[currentBoardId] : null;
  const cam = currentBoard?.camera ?? { x: 0, y: 0, zoom: 1 };

  // Modal for new prompt
  const [showNewPrompt, setShowNewPrompt] = useState(false);
  const [newPromptTitle, setNewPromptTitle] = useState("");

  // Load persisted state
  useEffect(() => { load(); }, [load]);

  // Canvas: resize + redraw strokes with camera
  const drawStrokes = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
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
  }, [strokes, currentBoardId, cam]);

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current; const div = containerRef.current;
    if (!canvas || !div) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(div.clientWidth * dpr);
    canvas.height = Math.floor(div.clientHeight * dpr);
    canvas.style.width = `${div.clientWidth}px`;
    canvas.style.height = `${div.clientHeight}px`;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStrokes();
  }, [drawStrokes]);

  useEffect(() => { resizeCanvas(); window.addEventListener("resize", resizeCanvas); return () => window.removeEventListener("resize", resizeCanvas); }, [resizeCanvas]);
  useEffect(() => { drawStrokes(); }, [drawStrokes]);

  // Wheel zoom (zoom around cursor)
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!currentBoard) return;
    e.preventDefault();
    const scale = Math.exp(-e.deltaY * 0.0015);
    const newZoom = Math.min(2.5, Math.max(0.2, cam.zoom * scale));
    const rect = containerRef.current!.getBoundingClientRect();
    const before = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, cam);
    setCamera({ zoom: newZoom });
    const cam2 = { ...cam, zoom: newZoom };
    const after = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, cam2);
    setCamera({ x: cam2.x + (after.x - before.x) * newZoom, y: cam2.y + (after.y - before.y) * newZoom });
  }, [cam, currentBoard, setCamera]);

  // Panning
  const panState = useRef<{ lastX: number; lastY: number } | null>(null);
  const onMouseDownCanvas = useCallback((e: React.MouseEvent) => {
    const store = useStore.getState();
    if (store.isPanning && e.button === 0) { panState.current = { lastX: e.clientX, lastY: e.clientY }; return; }
    if ((e as any).nativeEvent.button === 1) { store.setPanning(true); panState.current = { lastX: e.clientX, lastY: e.clientY }; return; }
  }, []);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (useStore.getState().isPanning) {
      const prev = panState.current; if (!prev) return;
      const dx = e.clientX - prev.lastX; const dy = e.clientY - prev.lastY;
      setCamera({ x: cam.x + dx, y: cam.y + dy });
      panState.current = { lastX: e.clientX, lastY: e.clientY };
    }
  }, [cam, setCamera]);
  const onMouseUpLeave = useCallback(() => { if (useStore.getState().isPanning) useStore.getState().setPanning(false); }, []);

  // Shortcuts
  useEvent("keydown", (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) { e.preventDefault(); const ev = { preventDefault() {}, clientX: window.innerWidth/2, clientY: window.innerHeight/2, deltaY: -100 } as any; (onWheel as any)(ev); }
    if ((e.ctrlKey || e.metaKey) && e.key === "-") { e.preventDefault(); const ev = { preventDefault() {}, clientX: window.innerWidth/2, clientY: window.innerHeight/2, deltaY: 100 } as any; (onWheel as any)(ev); }
    if (e.key.toLowerCase() === "v") useStore.getState().setMode("select");
    if (e.key.toLowerCase() === "p") useStore.getState().setMode("pen");
    if (e.code === "Space") useStore.getState().setPanning(true);
  }, [onWheel]);
  useEvent("keyup", (e: KeyboardEvent) => { if (e.code === "Space") useStore.getState().setPanning(false); });

  // Editor overlay for node text
  const [editing, setEditing] = useState<{ id: ID; screenPos: { sx: number; sy: number } } | null>(null);
  const onNodeDoubleClick = (e: React.MouseEvent, n: NodeT) => { e.stopPropagation(); const { sx, sy } = worldToScreen(n.x, n.y, cam); setEditing({ id: n.id, screenPos: { sx, sy } }); };
  useEffect(() => { if (!editing) return; const n = useStore.getState().nodes[editing.id]; if (!n) { setEditing(null); return; } setEditing({ id: editing.id, screenPos: worldToScreen(n.x, n.y, cam) }); }, [cam, editing]);

  // Right-click context
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const onContextMenu = (e: React.MouseEvent) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }); };

  // Drag nodes
  const dragInfo = useRef<{ id: ID; lastX: number; lastY: number } | null>(null);
  const onNodeMouseDown = (e: React.MouseEvent, id: ID) => { if (mode === "pen") return; e.stopPropagation(); const rect = containerRef.current!.getBoundingClientRect(); const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, cam); dragInfo.current = { id, lastX: w.x, lastY: w.y }; };
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

    // edges
    ctx.strokeStyle = "#999"; ctx.lineWidth = 1.8;
    for (const e of boardEdges) {
      const p = nodes[e.parentNodeId]; const c = nodes[e.childNodeId]; if (!p || !c) continue;
      if (Math.abs(c.y - p.y) > Math.abs(c.x - p.x)) { ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, c.y); ctx.lineTo(c.x, c.y); ctx.stroke(); }
      else { ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(c.x, p.y); ctx.lineTo(c.x, c.y); ctx.stroke(); }
    }

    // rounded rect helper
    const rr = (x: number, y: number, w: number, h: number, r: number) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };

    // nodes + labels
    ctx.font = '12px Inter, system-ui, sans-serif';
    const wrap = (text: string, mw: number, ml: number) => { const words = (text || "(empty)").split(/\s+/); const lines: string[] = []; let line = ""; for (const w of words) { const test = line ? line + " " + w : w; if (ctx.measureText(test).width > mw) { if (lines.length === ml - 1) { let t = line; while (ctx.measureText(t + "…").width > mw && t.length) t = t.slice(0, -1); lines.push(t + "…"); line = ""; } else { lines.push(line || w); line = line ? w : ""; } } else { line = test; } } if (line && lines.length < ml) lines.push(line); if (!lines.length) lines.push("(empty)"); return lines; };

    for (const n of boardNodes) {
      const x = n.x - NODE_W / 2; const y = n.y - NODE_H / 2;
      rr(x, y, NODE_W, NODE_H, NODE_RX);
      ctx.fillStyle = "#18181b"; ctx.strokeStyle = "#3f3f46"; ctx.lineWidth = 1.6; ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#e4e4e7"; ctx.textBaseline = "top";
      const lines = wrap(n.text || "", NODE_W - 24, 3);
      lines.forEach((ln, i) => ctx.fillText(ln, x + 12, y + 10 + i * 14));
    }

    // pen strokes
    const list = Object.values(strokes).filter((s) => s.boardId === currentBoardId);
    for (const s of list) { ctx.beginPath(); for (let i = 0; i < s.points.length; i++) { const p = s.points[i]; if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); } ctx.lineWidth = s.size; ctx.lineCap = "round"; ctx.strokeStyle = s.color; ctx.stroke(); }

    ctx.restore();

    const a = document.createElement("a");
    a.download = `${currentBoard?.title || "board"}.png`;
    a.href = off.toDataURL("image/png");
    a.click();
  }, [boardEdges, boardNodes, nodes, strokes, currentBoardId, cam, currentBoard]);

  // Mini-map
  const mini = useMemo(() => {
    const ns = boardNodes; if (!ns.length) return null;
    const xs = ns.map((n) => n.x); const ys = ns.map((n) => n.y);
    const minX = Math.min(...xs) - 180, maxX = Math.max(...xs) + 180;
    const minY = Math.min(...ys) - 120, maxY = Math.max(...ys) + 120;
    return { minX, maxX, minY, maxY };
  }, [boardNodes]);

  // Runtime tests (console)
  useEffect(() => {
    try {
      const state = useStore.getState();
      const payload = serializeState(state as any);
      // 1) serializable
      const hasFn = (o: any): boolean => { if (!o || typeof o !== "object") return false; for (const k of Object.keys(o)) { const v = o[k]; if (typeof v === "function") return true; if (hasFn(v)) return true; } return false; };
      console.assert(!hasFn(payload), "[TEST] Persist payload should not contain functions");
      console.assert(typeof JSON.stringify(payload) === "string", "[TEST] JSON stringify should succeed");
      // 2) leaf util
      const ee: Record<ID, EdgeT> = { e1: { id: "e1", boardId: "b", parentNodeId: "a", childNodeId: "b" } };
      console.assert(isLeaf("b", ee) && !isLeaf("a", ee), "[TEST] isLeaf works");
      // 3) world/screen invertibility
      const camT: Camera = { x: 100, y: 50, zoom: 2 }; const w = { x: 23, y: -7 }; const sPt = worldToScreen(w.x, w.y, camT); const w2 = screenToWorld(sPt.sx, sPt.sy, camT); console.assert(Math.abs(w2.x - w.x) < 1e-6 && Math.abs(w2.y - w.y) < 1e-6, "[TEST] world<->screen roundtrip");
      // 4) elbow path format
      const d = elbowPath(0, 0, 10, 20); console.assert(d.startsWith("M 0 0 L "), "[TEST] elbowPath prefix");
      // 5) addChildrenFromSide geometry
      const tmpId = genId();
      useStore.setState((s: StoreState) => ({ ...s, nodes: { ...s.nodes, [tmpId]: { id: tmpId, boardId: s.currentBoardId || "b", text: "", x: 0, y: 0 } } }));
      (useStore.getState() as StoreState).addChildrenFromSide(tmpId, "right");
      const created = Object.values(useStore.getState().nodes).filter((n) => n.id !== tmpId);
      console.assert(created.length >= 2, "[TEST] branching creates at least 2 children");
    } catch (err) { console.warn("Runtime tests error", err); }
  }, []);

  return (
    <div className="w-full h-screen grid grid-cols-[300px_1fr] bg-zinc-900 text-zinc-100">
      {/* Sidebar */}
      <div className="border-r border-zinc-800 p-4 flex flex-col gap-3 relative z-10">
        <div className="text-sm font-semibold tracking-wide">Boards</div>
        <div className="flex-1 overflow-auto">
          {boardOrder.map((id) => (
            <BoardTab
              key={id}
              board={boards[id]}
              active={currentBoardId === id}
              onClick={() => switchBoard(id)}
              onRename={(t) => renameBoard(id, t)}
              onDelete={() => deleteBoard(id)}
            />
          ))}
        </div>
        <button
          className="w-full py-2 rounded-2xl bg-zinc-800 hover:bg-zinc-700 text-sm"
          onClick={() => setShowNewPrompt(true)}
        >+ New prompt</button>

        {/* Tools */}
        <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
          <button className={`py-2 rounded-xl ${mode === "select" ? "bg-blue-600" : "bg-zinc-800"}`} onClick={() => setMode("select")} title="V">Select (V)</button>
          <button className={`py-2 rounded-xl ${mode === "pen" ? "bg-blue-600" : "bg-zinc-800"}`} onClick={() => setMode("pen")} title="P">Pen (P)</button>
          <button className="col-span-2 py-2 rounded-xl bg-zinc-800" onClick={exportPNG}>Export PNG</button>
          <div className="col-span-2 flex items-center justify-between gap-2">
            <div>Pen</div>
            <div className="flex items-center gap-2">
              <button className={`w-6 h-6 rounded-full border ${penColor === "black" ? "ring-2 ring-blue-500" : "border-zinc-700"}`} style={{ background: "black" }} onClick={() => useStore.setState({ penColor: "black" })} />
              <button className={`w-6 h-6 rounded-full border ${penColor === "red" ? "ring-2 ring-blue-500" : "border-zinc-700"}`} style={{ background: "red" }} onClick={() => useStore.setState({ penColor: "red" })} />
              <button className={`px-2 py-1 rounded-md bg-zinc-800 ${penSize === 2 ? "ring-2 ring-blue-500" : ""}`} onClick={() => useStore.setState({ penSize: 2 })}>2px</button>
              <button className={`px-2 py-1 rounded-md bg-zinc-800 ${penSize === 4 ? "ring-2 ring-blue-500" : ""}`} onClick={() => useStore.setState({ penSize: 4 })}>4px</button>
            </div>
          </div>
          <button className="col-span-2 py-2 rounded-xl bg-zinc-800" onClick={clearPen}>Clear pen</button>
        </div>

        <div className="mt-4 text-xs text-zinc-400">Shortcuts: V Select, P Pen, Space+drag Pan, Ctrl/Cmd +/- Zoom. Double-click node to edit.</div>
      </div>

      {/* Canvas Area */}
      <div
        className={`relative bg-black ${isPanning ? 'cursor-grab' : ''}`}
        ref={containerRef}
        onMouseMove={(e) => { onMouseMove(e); onContainerMouseMove(e); }}
        onMouseUp={() => { onMouseUpLeave(); onContainerMouseUp(); }}
        onMouseLeave={onMouseUpLeave}
        onWheel={onWheel}
        onContextMenu={onContextMenu}
        onMouseDown={onMouseDownCanvas}
      >
        {/* SVG: nodes + edges */}
        <svg ref={svgRef} className="absolute inset-0 w-full h-full block" width="100%" height="100%" preserveAspectRatio="none" style={{ pointerEvents: mode === 'pen' ? 'none' : 'auto' }}>
          <g transform={`translate(${cam.x},${cam.y}) scale(${cam.zoom})`}>
            {boardEdges.map((e) => {
              const p = nodes[e.parentNodeId]; const c = nodes[e.childNodeId]; if (!p || !c) return null;
              const d = elbowPath(p.x, p.y, c.x, c.y);
              return <path key={e.id} d={d} stroke="#999" strokeWidth={1.8} fill="none" />;
            })}

            {boardNodes.map((n) => {
              const x = n.x - NODE_W / 2; const y = n.y - NODE_H / 2; const leaf = isLeaf(n.id, edges);
              return (
                <g key={n.id} transform={`translate(${x},${y})`} onMouseDown={(e) => onNodeMouseDown(e, n.id)} onDoubleClick={(e) => onNodeDoubleClick(e, n)}>
                  <rect rx={NODE_RX} ry={NODE_RX} width={NODE_W} height={NODE_H} fill="#18181b" stroke="#3f3f46" strokeWidth={1.6} />
                  <foreignObject x={12} y={10} width={NODE_W - 24} height={NODE_H - 20} pointerEvents="none">
                    <div className="text-sm leading-snug text-zinc-200" style={{ fontFamily: "Inter, sans-serif", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 3 as any, WebkitBoxOrient: "vertical" as any }}>{n.text || "(empty)"}</div>
                  </foreignObject>

                  {/* Plus handles: leaf -> 2 (short sides = top/bottom); non-leaf -> 4 */}
                  {leaf ? (
                    <>
                      <PlusHandle cx={NODE_W / 2} cy={-8} onClick={() => addChildrenFromSide(n.id, 'top')} />
                      <PlusHandle cx={NODE_W / 2} cy={NODE_H + 8} onClick={() => addChildrenFromSide(n.id, 'bottom')} />
                    </>
                  ) : (
                    <>
                      <PlusHandle cx={NODE_W / 2} cy={-8} onClick={() => addChildrenFromSide(n.id, 'top')} />
                      <PlusHandle cx={NODE_W + 8} cy={NODE_H / 2} onClick={() => addChildrenFromSide(n.id, 'right')} />
                      <PlusHandle cx={NODE_W / 2} cy={NODE_H + 8} onClick={() => addChildrenFromSide(n.id, 'bottom')} />
                      <PlusHandle cx={-8} cy={NODE_H / 2} onClick={() => addChildrenFromSide(n.id, 'left')} />
                    </>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Pen canvas: only interactive in Pen mode so it doesn't block handles */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ pointerEvents: mode === 'pen' ? 'auto' : 'none' }}
          onMouseDown={(e) => {
            if (mode !== 'pen') return; const rect = containerRef.current!.getBoundingClientRect(); const { x, y } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, cam); startStroke({ x, y, t: Date.now() });
          }}
          onMouseMove={(e) => {
            if (mode !== 'pen' || (e.buttons & 1) !== 1) return; const rect = containerRef.current!.getBoundingClientRect(); const { x, y } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, cam); addPointToStroke({ x, y, t: Date.now() });
          }}
          onMouseUp={() => { if (mode === 'pen') endStroke(); }}
        />

        {/* Inline editor */}
        {editing && (
          <InlineEditor
            x={editing.screenPos.sx}
            y={editing.screenPos.sy}
            initial={nodes[editing.id]?.text || ""}
            onSubmit={(txt) => { updateNode(editing.id, { text: txt }); setEditing(null); }}
            onCancel={() => setEditing(null)}
          />
        )}

        {/* Context menu */}
        {contextMenu && (
          <div className="absolute z-50 bg-zinc-800 border border-zinc-700 rounded-xl p-1 text-sm" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseLeave={() => setContextMenu(null)}>
            <button className="block px-3 py-2 hover:bg-zinc-700 rounded-lg w-full text-left" onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}>Fit (reset)</button>
            <button className="block px-3 py-2 hover:bg-zinc-700 rounded-lg w-full text-left" onClick={() => { clearPen(); setContextMenu(null); }}>Clear pen</button>
          </div>
        )}

        {/* Mini-map */}
        {mini && (
          <div className="absolute right-3 bottom-3 w-44 h-28 bg-zinc-800/80 border border-zinc-700 rounded-xl p-1">
            <MiniMap nodes={boardNodes} camera={cam} box={mini} />
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
                <button className="px-3 py-1.5 rounded-lg bg-zinc-800" onClick={() => setShowNewPrompt(false)}>Cancel</button>
                <button className="px-3 py-1.5 rounded-lg bg-blue-600" onClick={() => { const t = newPromptTitle.trim() || 'Untitled'; createBoard(t, t); setShowNewPrompt(false); setNewPromptTitle(""); }}>Create</button>
              </div>
            </div>
          </div>
        )}
      </div>
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
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  const [val, setVal] = useState(initial);
  return (
    <div className="absolute" style={{ left: x - NODE_W / 2, top: y - NODE_H / 2, width: NODE_W }}>
      <textarea
        ref={inputRef}
        className="w-[220px] h-[84px] text-sm bg-zinc-950 border border-blue-500 rounded-xl p-2 outline-none"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(val.trim()); } if (e.key === "Escape") onCancel(); }}
        onBlur={() => onSubmit(val.trim())}
      />
    </div>
  );
}

function BoardTab({ board, active, onClick, onRename, onDelete }: { board: Board; active: boolean; onClick: () => void; onRename: (t: string) => void; onDelete: () => void; }) {
  const [hover, setHover] = useState(false);
  return (
    <div className={`group px-3 py-2 rounded-xl mb-2 cursor-pointer ${active ? "bg-zinc-800" : "hover:bg-zinc-800/60"}`}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={onClick}>
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-sm">{board.title}</div>
        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
          <button className="text-xs px-1.5 py-0.5 bg-zinc-700 rounded" onClick={(e) => { e.stopPropagation(); const t = prompt("Rename board", board.title); if (t != null) onRename(t); }}>Rename</button>
          <button className="text-xs px-1.5 py-0.5 bg-zinc-700 rounded" onClick={(e) => { e.stopPropagation(); if (confirm("Delete board?")) onDelete(); }}>Delete</button>
        </div>
      </div>
      <div className="text-[10px] text-zinc-400">Updated {new Date(board.updatedAt).toLocaleString()}</div>
    </div>
  );
}

function MiniMap({ nodes, camera, box }: { nodes: NodeT[]; camera: Camera; box: { minX: number; maxX: number; minY: number; maxY: number } }) {
  const w = 170, h = 90;
  const scaleX = w / (box.maxX - box.minX); const scaleY = h / (box.maxY - box.minY);
  const s = Math.min(scaleX, scaleY);
  const offX = -box.minX * s + 5; const offY = -box.minY * s + 5;

  const vw = (document.querySelector("svg") as any)?.clientWidth || 800;
  const vh = (document.querySelector("svg") as any)?.clientHeight || 600;
  const tl = screenToWorld(0, 0, camera); const br = screenToWorld(vw, vh, camera);

  return (
    <svg className="w-full h-full">
      <rect x={0} y={0} width="100%" height="100%" fill="#0a0a0a" stroke="#3f3f46" rx={10} />
      {nodes.map((n) => (<rect key={n.id} x={n.x * s + offX} y={n.y * s + offY} width={14} height={9} fill="#52525b" rx={2} />))}
      <rect x={tl.x * s + offX} y={tl.y * s + offY} width={(br.x - tl.x) * s} height={(br.y - tl.y) * s} fill="none" stroke="#60a5fa" strokeWidth={1} />
    </svg>
  );
}
