"use client";
// 3D "skyline" of a model's real weights, read from its GGUF header. Every
// weight matrix in every layer is one tower: height = its larger dimension,
// depth = its smaller one, at ONE absolute scale shared by all models
// (1 unit = 512 dims) — so a wider hidden size, a bigger feed-forward, grouped-
// query attention (short K/V towers), hybrid linear-attention layers, MoE
// experts and deeper stacks all look different, because they are. Brightness
// encodes bits per weight (F16 bright → 4-bit dim). Several models can be laid
// side by side in one scene for comparison. Per-layer measurements (training
// gradients, weight deltas) can recolour the stack via `values`.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ModelArchitecture, LayerSummary } from "@/lib/gguf-meta";
import { TOKENS } from "@/lib/design-tokens";

const BRAND = TOKENS.brand;
const S = 512;              // dims per scene unit — shared by every model
const PLATE = 0.09;         // tower thickness along the layer axis
const STEP = 0.16;          // spacing between towers inside a layer
const LAYER_GAP = 0.55;     // spacing between layers
const MAX_EXPERT_PLATES = 24;

/** `diverging`: values are signed changes — coloured pine (−) · gray (0) · gold (+). */
export type LayerValues = { label: string; unit?: string; values: (number | null)[]; diverging?: boolean };
export type SceneModel = { arch: ModelArchitecture; label: string };

type Family = "attn" | "ssm" | "ffn" | "expert" | "other";
function family(module: string, layerKind?: string): Family {
  if (module.includes("_exps") || module.includes("_shexp")) return "expert";
  if (module.startsWith("ssm_")) return "ssm";
  // In hybrid models the linear-attention layers name their projections attn_qkv /
  // attn_gate too; colour them by what the layer is, so the hybrid pattern shows.
  if (module.startsWith("attn") && (layerKind === "linear-attention" || layerKind === "ssm")) return "ssm";
  if (module.startsWith("ffn")) return "ffn";
  if (module.startsWith("attn")) return "attn";
  return "other";
}
const FAMILY_COLOR: Record<Family, string> = { attn: BRAND.gold, ssm: TOKENS.status.info, ffn: BRAND.leaf, expert: BRAND.moss, other: TOKENS.text.muted };
const FAMILY_LABEL: Record<Family, string> = { attn: "Attention (Q/K/V/O)", ssm: "Linear attention / SSM", ffn: "Feed-forward", expert: "MoE experts", other: "Other" };
const ORDER = ["attn_q", "attn_k", "attn_v", "attn_qkv", "attn_gate", "attn_output", "ssm", "ffn_gate", "ffn_up", "ffn_down"];
const rank = (m: string) => { const i = ORDER.findIndex((o) => m.startsWith(o)); return i < 0 ? ORDER.length : i; };

function bits(type: string) {
  if (type === "F32") return 32; if (type === "F16" || type === "BF16") return 16;
  const m = /^Q(\d)/.exec(type); if (m) return +m[1];
  if (type.startsWith("IQ1") || type.startsWith("TQ")) return 1.6;
  const iq = /IQ(\d)/.exec(type); return iq ? +iq[1] : 4;
}

export function fmtParams(n: number) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n);
}

function ramp(t: number) {
  return new THREE.Color(TOKENS.bg.panelRaised).lerp(new THREE.Color(BRAND.gold), 0.18 + 0.82 * Math.max(0, Math.min(1, t)));
}
function divergingRamp(t: number) {
  const mid = new THREE.Color(TOKENS.text.muted).multiplyScalar(0.55);
  return t >= 0 ? mid.clone().lerp(new THREE.Color(BRAND.gold), Math.min(1, t)) : mid.clone().lerp(new THREE.Color(TOKENS.status.info), Math.min(1, -t));
}

function textSprite(text: string, color: string, px = 44) {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  ctx.font = `600 ${px}px ${TOKENS.font.sans}`;
  c.width = Math.ceil(ctx.measureText(text).width) + 24; c.height = px + 20;
  ctx.font = `600 ${px}px ${TOKENS.font.sans}`;
  ctx.fillStyle = color; ctx.textBaseline = "middle"; ctx.fillText(text, 12, c.height / 2);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  const h = 2.8; sprite.scale.set((h * c.width) / c.height, h, 1);
  return sprite;
}

type Instance = { model: number; layer: LayerSummary | null; label: string; base: THREE.Color };
type Hover = { x: number; y: number; w: number; inst: Instance };

export function Model3D(props: { arch: ModelArchitecture; values?: LayerValues | null; selected?: number | null; onSelect?: (layer: number | null) => void; height?: number }) {
  return <ModelScene models={[{ arch: props.arch, label: props.arch.name ?? props.arch.architecture }]} values={props.values} selected={props.selected} onSelect={props.onSelect} height={props.height} />;
}

export function ModelScene({ models, values, selected, onSelect, height = 420 }: {
  models: SceneModel[];
  values?: LayerValues | null;
  selected?: number | null;
  onSelect?: (layer: number | null) => void;
  height?: number;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const valuesRef = useRef(values);
  const selectedRef = useRef(selected ?? null);
  const onSelectRef = useRef(onSelect);
  const paintRef = useRef<(() => void) | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  useEffect(() => { onSelectRef.current = onSelect; });
  useEffect(() => { valuesRef.current = values; selectedRef.current = selected ?? null; paintRef.current?.(); }, [values, selected]);

  const key = models.map((m) => `${m.label}:${m.arch.layers.length}:${m.arch.totalParams}`).join("|");
  useEffect(() => {
    const el = mount.current; if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 2000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.0); keyLight.position.set(10, 30, 20); scene.add(keyLight);
    const rim = new THREE.DirectionalLight(new THREE.Color(BRAND.pine), 0.9); rim.position.set(-20, 10, -15); scene.add(rim);

    const disposables: { dispose: () => void }[] = [];
    const root = new THREE.Group(); scene.add(root);
    type Plate = { x: number; y: number; z: number; sx: number; sy: number; sz: number; inst: Instance };
    const plates: Plate[] = [];

    // ---- lay out every model as one row of towers ------------------------
    let zCursor = 0;
    models.forEach(({ arch, label }, mi) => {
      const rowDepth = Math.max(2, ...arch.layers.flatMap((l) => l.tensors.map((t) => Math.min(t.shape[0], t.shape[1]) / S)));
      const rowHeight = Math.max(2, ...arch.layers.flatMap((l) => l.tensors.map((t) => Math.max(t.shape[0], t.shape[1]) / S)));
      const z = zCursor + rowDepth / 2;
      let x = 0;
      // Token embeddings: vocab × hidden. The vocab side is far longer than any
      // layer matrix, so it is drawn compressed (and says so in its label).
      if (arch.embeddingParams && arch.embedding) {
        const h = arch.embedding / S;
        const inst: Instance = { model: mi, layer: null, label: `${label} · token embeddings · ${arch.vocab?.toLocaleString() ?? "?"} × ${arch.embedding} (${fmtParams(arch.embeddingParams)}) · vocabulary drawn compressed`, base: new THREE.Color(BRAND.moss) };
        plates.push({ x: x + 0.6, y: h / 2, z, sx: 1.2, sy: h, sz: h, inst });
        x += 1.2 + LAYER_GAP * 2;
      }
      for (const layer of arch.layers) {
        const mats = [...layer.tensors].sort((a, b) => rank(a.module) - rank(b.module));
        for (const t of mats) {
          const fam = family(t.module, layer.kind);
          const [a, b] = t.shape;
          const hgt = Math.max(a, b) / S, dep = Math.max(0.04, Math.min(a, b) / S);
          const light = 0.5 + 0.5 * Math.min(1, Math.log2(bits(t.type)) / 4);
          const base = new THREE.Color(FAMILY_COLOR[fam]).multiplyScalar(light);
          const experts = t.shape[2] ?? 1;
          const shown = fam === "expert" ? Math.min(MAX_EXPERT_PLATES, experts) : 1;
          const inst: Instance = { model: mi, layer, label: `${label} · layer ${layer.index} · ${t.module} · ${t.shape.join("×")} · ${t.type} · ${fmtParams(t.shape.reduce((p, q) => p * q, 1))}${experts > shown ? ` (showing ${shown} of ${experts} experts)` : ""}`, base };
          for (let e = 0; e < shown; e++) plates.push({ x: x + e * (PLATE * 0.7), y: hgt / 2, z, sx: fam === "expert" ? PLATE * 0.5 : PLATE, sy: hgt, sz: dep, inst });
          x += STEP + (shown - 1) * PLATE * 0.7;
        }
        if (!mats.length) x += STEP;
        x += LAYER_GAP;
      }
      if (arch.outputParams && arch.embedding) {
        const h = arch.embedding / S;
        const inst: Instance = { model: mi, layer: null, label: `${label} · output head · ${fmtParams(arch.outputParams)}`, base: new THREE.Color(BRAND.olive) };
        plates.push({ x: x + 0.6, y: h / 2, z, sx: 1.2, sy: h, sz: h, inst });
        x += 1.2;
      }
      const sprite = textSprite(label, TOKENS.text.primary); disposables.push(sprite.material.map!, sprite.material);
      sprite.center.set(1, 0.5); sprite.position.set(-1.5, 1.2, z); root.add(sprite);
      const floorG = new THREE.PlaneGeometry(x + 2, rowDepth + 1); disposables.push(floorG);
      const floorM = new THREE.MeshBasicMaterial({ color: TOKENS.bg.panelRaised, transparent: true, opacity: 0.6 }); disposables.push(floorM);
      const floor = new THREE.Mesh(floorG, floorM); floor.rotation.x = -Math.PI / 2; floor.position.set(x / 2, -0.01, z); root.add(floor);
      // Rows sit far enough apart that the tallest towers of one row don't hide the next.
      zCursor += rowDepth + rowHeight * 0.55 + 3;
    });

    const unit = new THREE.BoxGeometry(1, 1, 1); disposables.push(unit);
    const material = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.08 }); disposables.push(material);
    const mesh = new THREE.InstancedMesh(unit, material, Math.max(1, plates.length));
    const m4 = new THREE.Matrix4();
    plates.forEach((p, i) => { m4.compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion(), new THREE.Vector3(p.sx, p.sy, p.sz)); mesh.setMatrixAt(i, m4); });
    root.add(mesh);
    disposables.push(mesh);

    const paint = () => {
      const v = valuesRef.current?.values;
      const div = valuesRef.current?.diverging;
      const finite = (v ?? []).filter((x): x is number => x != null && Number.isFinite(x));
      const lo = finite.length ? Math.min(...finite) : 0, hi = finite.length ? Math.max(...finite) : 1;
      const maxAbs = Math.max(Math.abs(lo), Math.abs(hi), 1e-12);
      const sel = selectedRef.current;
      const c = new THREE.Color();
      plates.forEach((p, i) => {
        const li = p.inst.layer?.index;
        const raw = li != null && v ? v[li] : null;
        if (v && raw != null && Number.isFinite(raw)) c.copy(div ? divergingRamp(raw / maxAbs) : ramp(hi > lo ? (raw - lo) / (hi - lo) : 1));
        else if (v) c.set(TOKENS.bg.interactive);
        else c.copy(p.inst.base);
        if (sel != null && li === sel) c.lerp(new THREE.Color("#ffffff"), 0.35);
        mesh.setColorAt(i, c);
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    paintRef.current = paint;
    paint();

    // ---- camera fit, picking, loop ---------------------------------------
    const bounds = new THREE.Box3().setFromObject(root);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    let userMoved = false;
    controls.addEventListener("start", () => { userMoved = true; });
    const fit = () => {
      const vFov = (camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
      const radius = size.length() / 2;
      const dist = Math.max(radius / Math.sin(vFov / 2), radius / Math.sin(hFov / 2)) * 0.82;
      // High three-quarter view: rows read as separate bands, tower heights stay visible.
      const dir = new THREE.Vector3(-0.1, models.length > 1 ? 1.35 : 0.7, 1).normalize();
      camera.position.copy(center).addScaledVector(dir, dist);
      controls.target.copy(center);
      controls.update();
    };
    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%";
      camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
      if (!userMoved) fit();
    };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();

    const ray = new THREE.Raycaster(); const ptr = new THREE.Vector2();
    const pick = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ptr, camera);
      const hit = ray.intersectObject(mesh, false)[0];
      return { plate: hit?.instanceId != null ? plates[hit.instanceId] : undefined, x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
    };
    const onMove = (e: PointerEvent) => {
      const { plate, x, y, w } = pick(e);
      renderer.domElement.style.cursor = plate ? "pointer" : "grab";
      setHover(plate ? { x, y, w, inst: plate.inst } : null);
    };
    let down = { x: 0, y: 0 };
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      onSelectRef.current?.(pick(e).plate?.inst.layer?.index ?? null);
    };
    const onLeave = () => setHover(null);
    const dom = renderer.domElement;
    dom.addEventListener("pointermove", onMove); dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointerup", onUp); dom.addEventListener("pointerleave", onLeave);
    let raf = 0; const t0 = performance.now();
    const loop = () => {
      if (!reduced && !userMoved) root.rotation.y = Math.sin((performance.now() - t0) / 5000) * 0.12;
      controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); controls.dispose();
      dom.removeEventListener("pointermove", onMove); dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerup", onUp); dom.removeEventListener("pointerleave", onLeave);
      disposables.forEach((d) => d.dispose());
      renderer.dispose(); el.removeChild(dom); paintRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const v = values?.values;
  const finite = (v ?? []).filter((x): x is number => x != null && Number.isFinite(x));
  const fams = new Set(models.flatMap((m) => m.arch.layers.flatMap((l) => l.tensors.map((t) => family(t.module, l.kind)))));
  const hoverValue = hover?.inst.layer && v ? v[hover.inst.layer.index] : null;
  return (
    <div className="relative" style={{ height }}>
      <div ref={mount} className="absolute inset-0 cursor-grab" role="img" aria-label={`3D weight skyline of ${models.map((m) => m.label).join(", ")}`} />
      {hover && (
        <div className="pointer-events-none absolute z-10 max-w-[340px] rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-panel-raised)] px-2.5 py-1.5 text-[12px] shadow-[var(--shadow-panel)]"
          style={{ left: Math.max(0, Math.min(hover.x + 14, hover.w - 350)), top: hover.y + 14 }}>
          <div className="text-[var(--text-primary)]">{hover.inst.label}</div>
          {values && hover.inst.layer && <div className="text-[var(--text-secondary)]">{values.label}: <span className="tabular-nums text-[var(--text-primary)]">{hoverValue == null ? "—" : hoverValue.toPrecision(3)}{values.unit ? ` ${values.unit}` : ""}</span></div>}
        </div>
      )}
      <div className="pointer-events-none absolute left-3 bottom-3 right-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-secondary)]">
        {values ? (
          <span className="inline-flex items-center gap-2">{values.label}
            <span className="tabular-nums text-[var(--text-muted)]">{finite.length ? Math.min(...finite).toPrecision(2) : "—"}</span>
            <span className="h-2 w-24 rounded-full" style={{ background: values.diverging ? `linear-gradient(90deg, #${divergingRamp(-1).getHexString()}, #${divergingRamp(0).getHexString()}, #${divergingRamp(1).getHexString()})` : `linear-gradient(90deg, #${ramp(0).getHexString()}, #${ramp(1).getHexString()})` }} />
            <span className="tabular-nums text-[var(--text-muted)]">{finite.length ? Math.max(...finite).toPrecision(2) : "—"}</span>
          </span>
        ) : <>
          {(["attn", "ssm", "ffn", "expert"] as Family[]).filter((f) => fams.has(f)).map((f) => (
            <span key={f} className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: FAMILY_COLOR[f] }} />{FAMILY_LABEL[f]}</span>
          ))}
          <span className="text-[var(--text-muted)]">· one tower per weight matrix, sized by its real shape · brighter = more bits per weight</span>
        </>}
      </div>
      <div className="pointer-events-none absolute right-3 top-3 text-[11px] text-[var(--text-muted)]">Same scale for every model · drag to orbit · scroll to zoom</div>
    </div>
  );
}

/** The same per-layer values as a flat strip: exact, comparable, and readable
 * without a 3D scene. One bar per layer, hover for the value. */
export function LayerStrip({ values, selected, onSelect, height = 72 }: { values: LayerValues; selected?: number | null; onSelect?: (i: number) => void; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const v = values.values;
  const max = Math.max(1e-9, ...v.filter((x): x is number => x != null && Number.isFinite(x)).map(Math.abs));
  const div = !!values.diverging;
  return (
    <div className="relative">
      <div className="flex items-end gap-[2px]" style={{ height }} onPointerLeave={() => setHover(null)}>
        {v.map((x, i) => (
          <button key={i} type="button" aria-label={`Layer ${i}: ${x == null ? "no data" : x.toPrecision(3)}`}
            onPointerEnter={() => setHover(i)} onClick={() => onSelect?.(i)}
            className={"relative flex-1 h-full flex " + (div ? "flex-col" : "items-end")}>
            {div ? <>
              <span className="flex-1 flex items-end"><span className="block w-full rounded-t-[3px]" style={{ height: x != null && x > 0 ? `${Math.max(3, (x / max) * 100)}%` : 0, background: i === selected ? "var(--brand-gold)" : "var(--brand-olive)" }} /></span>
              <span className="block h-px w-full bg-[var(--border-strong)]" />
              <span className="flex-1 flex items-start"><span className="block w-full rounded-b-[3px]" style={{ height: x != null && x < 0 ? `${Math.max(3, (-x / max) * 100)}%` : 0, background: i === selected ? "var(--brand-gold)" : "var(--status-info)" }} /></span>
            </> : <span className="block w-full rounded-t-[3px]" style={{ height: x == null ? 2 : `${Math.max(3, (x / max) * 100)}%`, background: i === selected ? "var(--brand-gold)" : i === hover ? "var(--brand-olive)" : "var(--brand-leaf)" }} />}
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-[var(--text-muted)]"><span>layer 0</span><span>{hover != null ? `layer ${hover}: ${v[hover] == null ? "—" : v[hover]!.toPrecision(3)}${values.unit ? " " + values.unit : ""}` : values.label}</span><span>layer {v.length - 1}</span></div>
    </div>
  );
}
