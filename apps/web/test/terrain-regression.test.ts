/// <reference types="node" />
/**
 * Phase-11 minimal renderer regression scene.
 *
 * This harness renders **only a regular grid of terrain** — no actor, no
 * props/trees, no decorations, no fake shadow geometry, no `GridOverlay`
 * content. It exists so a camera defect (near/far foreshortening) and a terrain
 * defect (cracks/footprint) can be measured separately instead of argued about
 * visually. It is the SAME file before and after the camera switch: the
 * camera-type branch below decides which near/far rule to assert.
 *
 * It asserts (docs/architecture.md, "Phase 11 frozen contract"):
 *
 * 1. Near/far edge relationship, per camera type. The projected screen lengths of
 *    a parallel near/far pair of terrain boundary edges are compared:
 *      - orthographic (this wave): the ratio is exactly 1 (within 1e-9);
 *      - perspective (Wave D): the near edge is STABLY longer (a documented
 *        lower bound > 1 at every yaw, not merely `!=`), and the ratio stays in
 *        a tight band around its own reference. The band is a GEOMETRIC,
 *        FOV-independent effect (see the constant below), so it survives the
 *        Wave-D fixed-FOV change.
 *    Wave D also asserts the projection is COMPLETELY constant across the yaw
 *    sweep: `fovDegrees`, `near`, `far`, the camera DISTANCE, the camera HEIGHT
 *    and the NDC length of a fixed-size segment at the focus plane are all
 *    identical at every yaw. That is the "no zoom pumping" guarantee: Wave C's
 *    per-yaw FOV was a per-yaw zoom and made a fixed-size object change apparent
 *    size while rotating.
 *    The measurement self-calibrates first: the world->NDC projection is
 *    reconstructed from `inspect().camera` and validated against the runtime's
 *    own `pick()` at several NDC points. The reported calibration error is what
 *    makes the projected-length measurement trustworthy rather than
 *    self-referential.
 * 2. No terrain crack at any yaw: for every row/column the adjacent tile centres
 *    step by exactly `cellSize` in the grid axis and share their cross-axis
 *    coordinate exactly, and every measured footprint is exactly `cellSize`.
 *    (A raster-level, pixel-gap check needs a browser/WebGL context and is out of
 *    scope for this headless test; this is the geometric precondition.)
 * 3. Every tile footprint is exactly `cellSize` at every yaw.
 * 4. Every tile/node scale is constantly 1.
 * 5. The scene truthfully contains only terrain: no `object`-layer / non-Terrain
 *    group nodes, and the `GridOverlay` is hidden with no highlighted cell.
 *
 * Camera-type detection: `inspect().camera` is read through a local structural
 * snapshot whose perspective fields are optional. A numeric `fovDegrees` (or
 * `fov`) marker means perspective; the orthographic `left/right/top/bottom`
 * frustum alone means orthographic. No runtime change is required for this:
 * the phase-11 frozen contract requires `inspect().camera` to report the
 * perspective frustum honestly (fov/near/far), and this file reads those fields
 * if present.
 */

import { describe, expect, it } from 'vitest';

import type { AppearanceId, NodeCreateCommand, NodeId, Vec3 } from '@starvalley/render-protocol';

import { createThreeRuntime, RENDER_CAMERA } from '../src/render/three/runtime.ts';
import type { RenderInspection, RenderRuntime, RuntimeGridSpec } from '../src/render/three/runtime.ts';

// ---------------------------------------------------------------------------
// Scene definition: a 12x12 terrain grid whose tiles exactly fill the bounds.
// ---------------------------------------------------------------------------

/** 12x12 cells of 1 unit, spanning world [-6, 6] on both axes. */
const GRID: RuntimeGridSpec = {
  origin: { x: -6, y: 0, z: -6 },
  width: 12,
  depth: 12,
  cellSize: 1,
};

/** World AABB the rig frames; its XZ footprint is exactly the grid's. */
const BOUNDS = { min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 8, z: 6 } } as const;

const GRASS = 'appearance.terrain.grass' as AppearanceId;
const PATH = 'appearance.terrain.path' as AppearanceId;
const WATER = 'appearance.terrain.water' as AppearanceId;
const BLOCKED = 'appearance.terrain.blocked' as AppearanceId;

const UNIT_SCALE: Vec3 = { x: 1, y: 1, z: 1 };
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 } as const;

const YAW_STEP_DEGREES = 15;
const ORTHO_RATIO_TOLERANCE = 1e-9;
/**
 * Documented lower bound for the perspective near/far projected-length ratio.
 * It is a "stably longer" floor, not a magnitude target: resolving the projected
 * length of two parallel edges at different depths is already numerically stable
 * for a narrow-FOV rig, so this only proves the near edge is not merely equal or
 * accidentally longer at isolated yaws.
 */
const PERSPECTIVE_MIN_NEAR_FAR_RATIO = 1.02;
/**
 * The perspective acceptance band around the measured near/far ratio reference is
 * a SMOKE CHECK, not the structural guarantee. The guarantees that actually catch
 * a regression are asserted exactly elsewhere in this file: at each SELECTED
 * pitch the camera FOV, near, far, distance and height are CONSTANT across the
 * whole yaw sweep ({@link ORBIT_CONSTANCE_TOLERANCE} /
 * {@link PROJECTION_CONSTANCE_TOLERANCE}, 1e-9), a fixed-size focus-plane segment
 * projects to a yaw-invariant NDC length, the projection self-calibrates against
 * the runtime's own `pick()`, the near edge is strictly longer than the far edge
 * at every yaw, and the terrain footprint/boundary/scale errors are all exactly 0.
 *
 * Why the ratio band is width-dependent on pitch (do NOT "tighten" this by
 * mistake): the residual near/far variation is GEOMETRIC and FOV-independent.
 * With the camera distance fixed, the compared parallel world edges are
 * `12 * cos(pitch)` apart in depth at the axis-aligned yaws but
 * `12 * cos(pitch) * cos(45 deg)` at the diagonals, so the axis ratio is
 * inherently larger. A flatter camera (lower pitch) widens that spread; the
 * per-pitch tolerances live in `perspectiveRatioTolerance` in the test body,
 * re-measured at the phase-13 clamp ends (25 and 75) and the default (35).
 */
/**
 * Wave D orbit/projection assertion: the camera FOV, near, far, distance and
 * height must be CONSTANT across the whole yaw sweep (a pure orbit with no dolly
 * and no FOV pumping), to within floating-point noise.
 */
const ORBIT_CONSTANCE_TOLERANCE = 1e-9;
/** Same float-noise tolerance for the fixed projection fields (fov/near/far). */
const PROJECTION_CONSTANCE_TOLERANCE = 1e-9;
/**
 * Half-length (world units) of the fixed-size segment whose NDC length is
 * measured at the focus plane. A real world segment of constant size is the
 * direct "no zoom pumping" probe: if the projection is constant while the rig
 * rotates, its projected screen length is constant too.
 */
const FOCUS_SEGMENT_HALF_LENGTH = 1;
/** Tolerance for the fixed-size segment's yaw-invariant NDC length. */
const FOCUS_SEGMENT_NDC_TOLERANCE = 1e-9;
/** World-space tolerance for the reconstructed-vs-pick ground point. */
const CALIBRATION_WORLD_TOLERANCE = 1e-6;
/** NDC tolerance for the reconstruction round-trip. */
const CALIBRATION_NDC_TOLERANCE = 1e-9;
/** Tight world-space tolerance for shared tile boundaries / footprints. */
const GEOMETRY_TOLERANCE = 1e-9;

type AppearancePicker = (cellX: number, cellZ: number) => AppearanceId;

const uniformGrass: AppearancePicker = () => GRASS;

/**
 * Deterministic grass/path/water mix. `blocked` is deliberately absent: it is
 * differentiated by a decorative rock resting on the plate, not by terrain
 * geometry, so it is a prop, not part of this minimal terrain scene.
 */
const mixedTerrain: AppearancePicker = (cellX, cellZ) => {
  if (cellX === 3 && cellZ === 3) {
    return WATER;
  }
  if (cellX === 0 || cellZ === 0 || cellZ === 5) {
    return PATH;
  }
  return GRASS;
};

function cellCentre(cellX: number, cellZ: number): Vec3 {
  return {
    x: GRID.origin.x + (cellX + 0.5) * GRID.cellSize,
    y: GRID.origin.y,
    z: GRID.origin.z + (cellZ + 0.5) * GRID.cellSize,
  };
}

function tileId(cellX: number, cellZ: number): NodeId {
  return `tile:${cellX},${cellZ}` as NodeId;
}

/** One base-layer terrain tile per cell, rooted at that cell's exact centre. */
function buildTerrainFrame(appearanceAt: AppearancePicker): NodeCreateCommand[] {
  const frame: NodeCreateCommand[] = [];
  for (let cellZ = 0; cellZ < GRID.depth; cellZ += 1) {
    for (let cellX = 0; cellX < GRID.width; cellX += 1) {
      frame.push({
        type: 'node.create',
        layer: 'base',
        nodeId: tileId(cellX, cellZ),
        appearance: appearanceAt(cellX, cellZ),
        transform: { position: cellCentre(cellX, cellZ), rotation: { ...IDENTITY }, scale: { ...UNIT_SCALE } },
        visible: true,
      });
    }
  }
  return frame;
}

// ---------------------------------------------------------------------------
// Camera snapshot + projection reconstruction
// ---------------------------------------------------------------------------

/**
 * Local structural view of `inspect().camera`. Projection fields are optional so
 * the same file typechecks and runs before (orthographic) and after (perspective)
 * the Wave-B camera switch; the rig basis fields are the parts both share.
 */
interface CameraSnapshot {
  // Orthographic frustum (present while the rig is orthographic).
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  // Perspective frustum (present once the rig is perspective).
  fovDegrees?: number;
  fov?: number;
  near?: number;
  far?: number;
  aspect?: number;
  // Rig basis (present for both).
  pitchDegrees: number;
  yawDegrees: number;
  zoom: number;
  focus: Vec3;
  position: Vec3;
  forward: Vec3;
  up: Vec3;
}

type CameraView =
  | {
      readonly kind: 'orthographic';
      readonly camera: CameraSnapshot;
      readonly right: Vec3;
      readonly halfWidth: number;
      readonly halfHeight: number;
    }
  | {
      readonly kind: 'perspective';
      readonly camera: CameraSnapshot;
      readonly right: Vec3;
      readonly tanHalfFov: number;
      readonly aspect: number;
    };

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(v: Vec3, factor: number): Vec3 {
  return { x: v.x * factor, y: v.y * factor, z: v.z * factor };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function isPerspective(camera: CameraSnapshot): boolean {
  return typeof camera.fovDegrees === 'number' || typeof camera.fov === 'number';
}

function cameraView(camera: CameraSnapshot): CameraView {
  // `right = forward x up` — the same basis the runtime's orthographic helper and
  // `pick()`'s camera use (verified by the calibration below).
  const right = cross(camera.forward, camera.up);
  if (isPerspective(camera)) {
    const fovDegrees = camera.fovDegrees ?? camera.fov ?? 0;
    return {
      kind: 'perspective',
      camera,
      right,
      tanHalfFov: Math.tan((fovDegrees * Math.PI) / 360),
      // Unmounted harness: the runtime defaults to a square aspect (1).
      // inspect() reports it; the fallback keeps a non-reporting implementation
      // honest for the headless case.
      aspect: camera.aspect ?? 1,
    };
  }
  const left = camera.left ?? -1;
  const rightBound = camera.right ?? 1;
  const bottom = camera.bottom ?? -1;
  const top = camera.top ?? 1;
  return {
    kind: 'orthographic',
    camera,
    right,
    halfWidth: (rightBound - left) / 2,
    halfHeight: (top - bottom) / 2,
  };
}

/** Camera-space depth of a world point (positive in front of the camera). */
function viewDepth(point: Vec3, view: CameraView): number {
  return dot(sub(point, view.camera.position), view.camera.forward);
}

/** Reconstructed world -> NDC projection, from `inspect().camera` alone. */
function projectToNdc(point: Vec3, view: CameraView): { x: number; y: number } {
  const relative = sub(point, view.camera.position);
  const viewX = dot(relative, view.right);
  const viewY = dot(relative, view.camera.up);
  if (view.kind === 'orthographic') {
    return { x: viewX / view.halfWidth, y: viewY / view.halfHeight };
  }
  const depth = viewDepth(point, view);
  return {
    x: viewX / (view.tanHalfFov * view.aspect * depth),
    y: viewY / (view.tanHalfFov * depth),
  };
}

/** Inverse: the ground-plane point a NDC ray resolves to, or `null` if parallel. */
function ndcToGround(ndc: { x: number; y: number }, view: CameraView, groundY: number): Vec3 | null {
  let origin: Vec3;
  let direction: Vec3;
  if (view.kind === 'orthographic') {
    origin = add(
      view.camera.position,
      add(scale(view.right, ndc.x * view.halfWidth), scale(view.camera.up, ndc.y * view.halfHeight)),
    );
    direction = view.camera.forward;
  } else {
    origin = view.camera.position;
    direction = add(
      view.camera.forward,
      add(
        scale(view.right, ndc.x * view.tanHalfFov * view.aspect),
        scale(view.camera.up, ndc.y * view.tanHalfFov),
      ),
    );
  }
  if (Math.abs(direction.y) < 1e-12) {
    return null;
  }
  const t = (groundY - origin.y) / direction.y;
  return add(origin, scale(direction, t));
}

// ---------------------------------------------------------------------------
// Self-calibration: is the reconstructed projection the one the runtime picks with?
// ---------------------------------------------------------------------------

/** Small NDC offsets that stay well inside the world at every yaw. */
const CALIBRATION_NDC: readonly { x: number; y: number }[] = [
  { x: 0, y: 0 },
  { x: 0.2, y: 0 },
  { x: -0.2, y: 0 },
  { x: 0, y: 0.2 },
  { x: 0, y: -0.2 },
  { x: 0.15, y: -0.15 },
  { x: -0.15, y: 0.15 },
];

interface Calibration {
  readonly maxGroundError: number;
  readonly maxRoundTripError: number;
}

/**
 * Validate the reconstruction against the runtime's own `pick()`:
 *  - inverse-project each NDC point and compare it with `pick()`'s ground point;
 *  - re-project `pick()`'s ground point and compare it with the input NDC.
 * Both errors must be tiny, which is what lets the near/far measurement below be
 * trusted rather than being a restatement of itself.
 */
function calibrate(runtime: RenderRuntime, view: CameraView, groundY: number): Calibration {
  let maxGroundError = 0;
  let maxRoundTripError = 0;
  for (const ndc of CALIBRATION_NDC) {
    const picked = runtime.pick(ndc.x, ndc.y);
    expect(picked?.kind).toBe('ground');
    if (picked?.kind !== 'ground') {
      continue;
    }
    const reconstructed = ndcToGround(ndc, view, groundY);
    expect(reconstructed).not.toBeNull();
    if (reconstructed === null) {
      continue;
    }
    maxGroundError = Math.max(maxGroundError, distance(reconstructed, picked.point));
    const roundTrip = projectToNdc(picked.point, view);
    maxRoundTripError = Math.max(
      maxRoundTripError,
      Math.hypot(roundTrip.x - ndc.x, roundTrip.y - ndc.y),
    );
  }
  return { maxGroundError, maxRoundTripError };
}

// ---------------------------------------------------------------------------
// Rule 1: near/far projected edge length
// ---------------------------------------------------------------------------

type EdgeName = 'south' | 'north' | 'east' | 'west';

interface EdgeMeasurement {
  readonly name: EdgeName;
  readonly length: number;
  readonly midDepth: number;
}

function measureEdge(name: EdgeName, a: Vec3, b: Vec3, view: CameraView): EdgeMeasurement {
  const pa = projectToNdc(a, view);
  const pb = projectToNdc(b, view);
  return {
    name,
    length: Math.hypot(pb.x - pa.x, pb.y - pa.y),
    midDepth: (viewDepth(a, view) + viewDepth(b, view)) / 2,
  };
}

interface NearFar {
  readonly near: EdgeMeasurement;
  readonly far: EdgeMeasurement;
  readonly ratio: number;
  readonly axis: 'N/S' | 'E/W';
}

/**
 * The grid's four boundary edges, then a parallel near/far pair.
 *
 * The contract compares "the parallel near and far edges". The south/north edges
 * (spanning X) are the near/far pair only while the camera faces ±Z; at yaw ≈ 90°
 * they are depth-degenerate, and the east/west edges (spanning Z) are the
 * perpendicular pair instead. So the harness selects the opposite-edge pair with
 * the larger mean-depth separation (the pair most perpendicular to the view) and
 * orders it by depth. This keeps near/far parallel and depth-separated at EVERY
 * yaw, which a fixed "south is near" label would not.
 */
function nearAndFarEdges(view: CameraView): NearFar {
  const x0 = GRID.origin.x;
  const x1 = GRID.origin.x + GRID.width * GRID.cellSize;
  const z0 = GRID.origin.z;
  const z1 = GRID.origin.z + GRID.depth * GRID.cellSize;
  const y = GRID.origin.y;
  const south = measureEdge('south', { x: x0, y, z: z1 }, { x: x1, y, z: z1 }, view);
  const north = measureEdge('north', { x: x0, y, z: z0 }, { x: x1, y, z: z0 }, view);
  const east = measureEdge('east', { x: x1, y, z: z0 }, { x: x1, y, z: z1 }, view);
  const west = measureEdge('west', { x: x0, y, z: z0 }, { x: x0, y, z: z1 }, view);

  const nsSeparation = Math.abs(south.midDepth - north.midDepth);
  const ewSeparation = Math.abs(east.midDepth - west.midDepth);
  const useNS = nsSeparation >= ewSeparation;
  const first = useNS ? south : east;
  const second = useNS ? north : west;
  const near = first.midDepth <= second.midDepth ? first : second;
  const far = first.midDepth <= second.midDepth ? second : first;
  return { near, far, ratio: near.length / far.length, axis: useNS ? 'N/S' : 'E/W' };
}

// ---------------------------------------------------------------------------
// Rules 2-4: shared boundaries, exact footprint, unit scale
// ---------------------------------------------------------------------------

interface NodeGeometry {
  readonly world: Vec3;
  readonly footprintX: number;
  readonly footprintZ: number;
  readonly scale: Vec3;
}

function geometryById(runtime: RenderRuntime): Map<string, NodeGeometry> {
  const byId = new Map<string, NodeGeometry>();
  for (const node of runtime.inspect().nodes) {
    byId.set(node.nodeId, {
      world: node.world,
      footprintX: node.footprintX,
      footprintZ: node.footprintZ,
      scale: node.scale,
    });
  }
  return byId;
}

/**
 * Rule 2/3: every adjacent pair steps by exactly `cellSize` in its grid axis and
 * shares its cross-axis coordinate exactly. This is the world-space geometric
 * precondition for a crack-free surface.
 */
function maxBoundaryError(runtime: RenderRuntime): number {
  const byId = geometryById(runtime);
  let error = 0;
  const step = GRID.cellSize;
  const requireTile = (cellX: number, cellZ: number): NodeGeometry => {
    const tile = byId.get(tileId(cellX, cellZ));
    if (tile === undefined) {
      throw new Error(`terrain tile ${cellX},${cellZ} is missing`);
    }
    return tile;
  };

  // Rows: adjacent centres in +X.
  for (let cellZ = 0; cellZ < GRID.depth; cellZ += 1) {
    for (let cellX = 0; cellX + 1 < GRID.width; cellX += 1) {
      const a = requireTile(cellX, cellZ);
      const b = requireTile(cellX + 1, cellZ);
      error = Math.max(error, Math.abs(b.world.x - a.world.x - step));
      error = Math.max(error, Math.abs(b.world.y - a.world.y));
      error = Math.max(error, Math.abs(b.world.z - a.world.z));
    }
  }
  // Columns: adjacent centres in +Z.
  for (let cellX = 0; cellX < GRID.width; cellX += 1) {
    for (let cellZ = 0; cellZ + 1 < GRID.depth; cellZ += 1) {
      const a = requireTile(cellX, cellZ);
      const b = requireTile(cellX, cellZ + 1);
      error = Math.max(error, Math.abs(b.world.z - a.world.z - step));
      error = Math.max(error, Math.abs(b.world.x - a.world.x));
      error = Math.max(error, Math.abs(b.world.y - a.world.y));
    }
  }
  return error;
}

/** Rule 2/3: the largest `|measured footprint - cellSize|` over all tiles. */
function maxFootprintError(runtime: RenderRuntime): number {
  const step = GRID.cellSize;
  let error = 0;
  for (const node of runtime.inspect().nodes) {
    error = Math.max(error, Math.abs(node.footprintX - step), Math.abs(node.footprintZ - step));
  }
  return error;
}

/** Rule 4: the largest deviation from unit scale over all tiles. */
function maxScaleError(runtime: RenderRuntime): number {
  let error = 0;
  for (const node of runtime.inspect().nodes) {
    expect(node.scale).toEqual({ x: 1, y: 1, z: 1 });
    error = Math.max(
      error,
      Math.abs(node.scale.x - 1),
      Math.abs(node.scale.y - 1),
      Math.abs(node.scale.z - 1),
    );
  }
  return error;
}

/** Rule 5: the scene contains terrain and nothing else, and the overlay is off. */
function assertTerrainOnly(runtime: RenderRuntime): void {
  const inspection: RenderInspection = runtime.inspect();
  expect(inspection.nodes).toHaveLength(GRID.width * GRID.depth);
  const allowed = new Set<string>([GRASS, PATH, WATER]);
  for (const node of inspection.nodes) {
    expect(node.layer).toBe('base');
    expect(node.group).toBe('Terrain');
    expect(allowed.has(node.appearance)).toBe(true);
    expect(node.appearance).not.toBe(BLOCKED);
  }
  expect(inspection.nodes.some((node) => node.layer === 'object')).toBe(false);
  expect(
    inspection.nodes.some(
      (node) => node.group === 'Actors' || node.group === 'WorldObjects' || node.group === 'Effects',
    ),
  ).toBe(false);
  for (const bucket of inspection.buckets) {
    expect(bucket.key.startsWith('base:appearance.terrain.')).toBe(true);
  }
  // GridOverlay is a presentation layer built from the grid spec; here it must be
  // hidden with no highlighted cell, i.e. contributing no scene content.
  expect(inspection.gridOverlay.visible).toBe(false);
  expect(inspection.gridOverlay.highlightedCell).toBeNull();
}

// ---------------------------------------------------------------------------
// Yaw sweep + baseline table
// ---------------------------------------------------------------------------

type NearFarAxis = NearFar['axis'];

/** The four ground-level corners of the framed world footprint. */
function worldGroundCorners(): Vec3[] {
  const corners: Vec3[] = [];
  for (const x of [BOUNDS.min.x, BOUNDS.max.x]) {
    for (const z of [BOUNDS.min.z, BOUNDS.max.z]) {
      corners.push({ x, y: GRID.origin.y, z });
    }
  }
  return corners;
}

/**
 * NDC length of a fixed-size world segment centred on the focus and lying along
 * the camera's right axis. Because the projection is constant while rotating, a
 * segment of constant world size must keep a constant screen size; a per-yaw FOV
 * (Wave C) would make it grow/shrink — the "zoom pumping" defect.
 *
 * This is computed from {@link projectToNdc}, the same reconstructed projection
 * the harness self-calibrates against the runtime's `pick()`.
 */
function fixedFocusSegmentNdc(view: CameraView): number {
  const half = scale(view.right, FOCUS_SEGMENT_HALF_LENGTH);
  const a = projectToNdc(add(view.camera.focus, half), view);
  const b = projectToNdc(sub(view.camera.focus, half), view);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Largest `|ndc|` over the framed world's ground corners: how much of the
 * half-frame the world's projected outline occupies. `< 1` means the whole
 * silhouette is inside the viewport with the framing margin to spare. It is
 * yaw-dependent (a square world subtends differently edge-on vs corner-on) and
 * that is GEOMETRIC, not zoom pumping: object scale at the focus plane is held
 * constant by {@link fixedFocusSegmentNdc}.
 */
function frameUtilisation(view: CameraView): number {
  let maxNdc = 0;
  for (const corner of worldGroundCorners()) {
    const ndc = projectToNdc(corner, view);
    maxNdc = Math.max(maxNdc, Math.abs(ndc.x), Math.abs(ndc.y));
  }
  return maxNdc;
}

/** Yaw class for the framing-utilisation report: axis-aligned vs diagonal. */
function yawClass(yaw: number): 'axis' | 'diagonal' | 'other' {
  const mod = ((yaw % 90) + 90) % 90;
  if (mod === 0) {
    return 'axis';
  }
  if (mod === 45) {
    return 'diagonal';
  }
  return 'other';
}

interface BaselineRow {
  readonly yaw: number;
  readonly kind: CameraView['kind'];
  readonly axis: NearFarAxis;
  readonly ratio: number;
  readonly nearLength: number;
  readonly farLength: number;
  /** Camera distance from the rig focus (orbit radius). */
  readonly distance: number;
  /** Camera height above the focus plane. */
  readonly height: number;
  /** Vertical FOV actually applied to the camera, in degrees. */
  readonly fovDegrees: number;
  /** Near clip plane, in world units. */
  readonly near: number;
  /** Far clip plane, in world units. */
  readonly far: number;
  /** NDC length of the fixed-size focus-plane segment (no zoom pumping). */
  readonly focusSegmentNdc: number;
  /** Largest `|ndc|` over the world ground corners (frame utilisation, < 1). */
  readonly frameUtilisation: number;
  /**
   * How far the visible viewport ground reaches into the backdrop, as the max
   * ratio of `|ground - backdrop centre| / backdrop half-extent`. `< 1` means the
   * floor's silhouette edge is off-screen (never visible) at this yaw.
   */
  readonly backdropMargin: number;
  readonly yawClass: 'axis' | 'diagonal' | 'other';
  readonly groundError: number;
  readonly roundTripError: number;
  readonly footprintError: number;
  readonly boundaryError: number;
  readonly scaleError: number;
}

/**
 * Build the minimal scene and sweep yaw 0..345 in 15° steps, asserting all five
 * rules at every yaw and returning the measured baseline.
 */
function sweepScene(appearanceAt: AppearancePicker, pitchDegrees: number): BaselineRow[] {
  const runtime = createThreeRuntime({ bounds: BOUNDS, grid: GRID });
  runtime.apply(buildTerrainFrame(appearanceAt));
  // Select the pitch for this sweep through the phase-13 rig setter. The world is
  // reframed exactly once here; every yaw below must then leave the projection
  // constant at THIS pitch.
  runtime.setCameraPitch(pitchDegrees);
  assertTerrainOnly(runtime);

  const rows: BaselineRow[] = [];
  try {
    for (let yaw = 0; yaw < 360; yaw += YAW_STEP_DEGREES) {
      runtime.setCameraOrientation({ yawDegrees: yaw });
      const inspection = runtime.inspect();
      const camera = inspection.camera as CameraSnapshot;
      const view = cameraView(camera);

      // The pitch is a selected, clamped rig parameter (phase 13). It is
      // reported exactly and every yaw must leave it constant; a drifting rig or
      // a yaw trying to tilt the view changes this value.
      expect(camera.pitchDegrees).toBe(pitchDegrees);

      // Rule 1, precondition: the reconstructed projection must be the one the
      // runtime actually picks with.
      const calibration = calibrate(runtime, view, GRID.origin.y);
      expect(calibration.maxGroundError).toBeLessThanOrEqual(CALIBRATION_WORLD_TOLERANCE);
      expect(calibration.maxRoundTripError).toBeLessThanOrEqual(CALIBRATION_NDC_TOLERANCE);

      // Rule 1: near/far relationship, per camera type.
      const nearFar = nearAndFarEdges(view);
      if (view.kind === 'orthographic') {
        expect(Math.abs(nearFar.ratio - 1)).toBeLessThanOrEqual(ORTHO_RATIO_TOLERANCE);
      } else {
        expect(nearFar.ratio).toBeGreaterThanOrEqual(PERSPECTIVE_MIN_NEAR_FAR_RATIO);
        expect(nearFar.near.length).toBeGreaterThan(nearFar.far.length);
      }

      // Wave D constant projection: the camera distance from the focus and its
      // height must be identical at every yaw, and the projection fields must be
      // identical too (no per-yaw FOV). The world segment of a fixed world size
      // must therefore keep a constant screen size, and the world still fits.
      const focusOffset = sub(camera.position, camera.focus);
      const distance = Math.hypot(focusOffset.x, focusOffset.y, focusOffset.z);
      const height = focusOffset.y;
      expect(distance).toBeGreaterThan(0);
      const focusSegmentNdc = fixedFocusSegmentNdc(view);
      const utilisation = frameUtilisation(view);
      // The world silhouette never touches the viewport edge; the framing margin
      // leaves air around it. (`< 1` is the strict-inside guarantee.)
      expect(utilisation).toBeLessThanOrEqual(1 + GEOMETRY_TOLERANCE);

      // The floor's edge is never visible: every visible viewport ground point
      // lies strictly inside the single backdrop rectangle.
      let backdropMargin = 0;
      const backdrop = inspection.backdrop;
      expect(backdrop).not.toBeNull();
      if (backdrop !== null && backdrop.sizeX > 0 && backdrop.sizeZ > 0) {
        for (const ndcX of [-1, 1]) {
          for (const ndcY of [-1, 1]) {
            const ground = ndcToGround({ x: ndcX, y: ndcY }, view, GRID.origin.y);
            expect(ground).not.toBeNull();
            if (ground === null) {
              continue;
            }
            backdropMargin = Math.max(
              backdropMargin,
              Math.abs(ground.x - backdrop.center.x) / (backdrop.sizeX / 2),
              Math.abs(ground.z - backdrop.center.z) / (backdrop.sizeZ / 2),
            );
          }
        }
      }
      expect(backdropMargin).toBeLessThan(1);

      // Rules 2-4: geometry is camera-independent, asserted at every yaw anyway.
      const boundaryError = maxBoundaryError(runtime);
      const footprintError = maxFootprintError(runtime);
      const scaleError = maxScaleError(runtime);
      expect(boundaryError).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
      expect(footprintError).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
      expect(scaleError).toBe(0);

      rows.push({
        yaw,
        kind: view.kind,
        axis: nearFar.axis,
        ratio: nearFar.ratio,
        nearLength: nearFar.near.length,
        farLength: nearFar.far.length,
        distance,
        height,
        fovDegrees: camera.fovDegrees ?? 0,
        near: camera.near ?? 0,
        far: camera.far ?? 0,
        focusSegmentNdc,
        frameUtilisation: utilisation,
        backdropMargin,
        yawClass: yawClass(yaw),
        groundError: calibration.maxGroundError,
        roundTripError: calibration.maxRoundTripError,
        footprintError,
        boundaryError,
        scaleError,
      });
    }
  } finally {
    runtime.dispose();
  }
  return rows;
}

interface BaselineSummary {
  readonly kind: CameraView['kind'];
  readonly ratioMin: number;
  readonly ratioMax: number;
  readonly distanceMin: number;
  readonly distanceMax: number;
  readonly heightMin: number;
  readonly heightMax: number;
  readonly fovMin: number;
  readonly fovMax: number;
  readonly nearMin: number;
  readonly nearMax: number;
  readonly farMin: number;
  readonly farMax: number;
  readonly focusSegmentNdcMin: number;
  readonly focusSegmentNdcMax: number;
  /** Max frame utilisation over axis-aligned yaws (0/90/180/270). */
  readonly axisUtilisation: number;
  /** Max frame utilisation over diagonal yaws (45/135/225/315). */
  readonly diagonalUtilisation: number;
  readonly maxFrameUtilisation: number;
  /** Max `backdropMargin` over the sweep; must be `< 1` (edge off-screen). */
  readonly maxBackdropMargin: number;
  readonly maxGroundError: number;
  readonly maxRoundTripError: number;
  readonly maxFootprintError: number;
  readonly maxBoundaryError: number;
  readonly maxScaleError: number;
}

function maxOver(
  rows: readonly BaselineRow[],
  select: (row: BaselineRow) => number,
  filter: (row: BaselineRow) => boolean = () => true,
): number {
  const values = rows.filter(filter).map(select);
  return values.length === 0 ? 0 : Math.max(...values);
}

function summarize(rows: readonly BaselineRow[]): BaselineSummary {
  const ratios = rows.map((row) => row.ratio);
  const distances = rows.map((row) => row.distance);
  const heights = rows.map((row) => row.height);
  const fovs = rows.map((row) => row.fovDegrees);
  const nears = rows.map((row) => row.near);
  const fars = rows.map((row) => row.far);
  const segments = rows.map((row) => row.focusSegmentNdc);
  return {
    kind: rows[0]?.kind ?? 'orthographic',
    ratioMin: Math.min(...ratios),
    ratioMax: Math.max(...ratios),
    distanceMin: Math.min(...distances),
    distanceMax: Math.max(...distances),
    heightMin: Math.min(...heights),
    heightMax: Math.max(...heights),
    fovMin: Math.min(...fovs),
    fovMax: Math.max(...fovs),
    nearMin: Math.min(...nears),
    nearMax: Math.max(...nears),
    farMin: Math.min(...fars),
    farMax: Math.max(...fars),
    focusSegmentNdcMin: Math.min(...segments),
    focusSegmentNdcMax: Math.max(...segments),
    axisUtilisation: maxOver(
      rows,
      (row) => row.frameUtilisation,
      (row) => row.yawClass === 'axis',
    ),
    diagonalUtilisation: maxOver(
      rows,
      (row) => row.frameUtilisation,
      (row) => row.yawClass === 'diagonal',
    ),
    maxFrameUtilisation: maxOver(rows, (row) => row.frameUtilisation),
    maxBackdropMargin: maxOver(rows, (row) => row.backdropMargin),
    maxGroundError: Math.max(...rows.map((row) => row.groundError)),
    maxRoundTripError: Math.max(...rows.map((row) => row.roundTripError)),
    maxFootprintError: Math.max(...rows.map((row) => row.footprintError)),
    maxBoundaryError: Math.max(...rows.map((row) => row.boundaryError)),
    maxScaleError: Math.max(...rows.map((row) => row.scaleError)),
  };
}

function formatRows(label: string, rows: readonly BaselineRow[]): string {
  const header = [
    'scene'.padEnd(15),
    'yaw'.padStart(4),
    'camera'.padEnd(13),
    'pair'.padEnd(5),
    'near/far ratio'.padStart(16),
    'near len'.padStart(12),
    'far len'.padStart(12),
    'cam distance'.padStart(13),
    'cam height'.padStart(11),
    'fov'.padStart(8),
    'near'.padStart(10),
    'far'.padStart(12),
    'seg ndc'.padStart(11),
    'frame util'.padStart(11),
    'backdrop in'.padStart(12),
    'calib world'.padStart(13),
    'calib ndc'.padStart(12),
    'footprint err'.padStart(15),
    'boundary err'.padStart(14),
    'scale err'.padStart(10),
  ].join(' | ');
  const lines = rows.map((row) =>
    [
      label.padEnd(15),
      String(row.yaw).padStart(4),
      row.kind.padEnd(13),
      row.axis.padEnd(5),
      row.ratio.toFixed(12).padStart(16),
      row.nearLength.toFixed(9).padStart(12),
      row.farLength.toFixed(9).padStart(12),
      row.distance.toFixed(9).padStart(13),
      row.height.toFixed(9).padStart(11),
      row.fovDegrees.toFixed(9).padStart(8),
      row.near.toFixed(9).padStart(10),
      row.far.toFixed(9).padStart(12),
      row.focusSegmentNdc.toFixed(12).padStart(11),
      row.frameUtilisation.toFixed(9).padStart(11),
      row.backdropMargin.toFixed(9).padStart(12),
      row.groundError.toExponential(3).padStart(13),
      row.roundTripError.toExponential(3).padStart(12),
      row.footprintError.toExponential(3).padStart(15),
      row.boundaryError.toExponential(3).padStart(14),
      row.scaleError.toExponential(3).padStart(10),
    ].join(' | '),
  );
  return [header, ...lines].join('\n');
}

/** The invariant assertions that must hold for a whole sweep, not just a yaw. */
function assertSummary(label: string, summary: BaselineSummary, ratioTolerance: number): void {
  if (summary.kind === 'orthographic') {
    // Rule 1 (orthographic): exactly 1 to 9 decimals at every yaw.
    expect(summary.ratioMin).toBeGreaterThanOrEqual(1 - ORTHO_RATIO_TOLERANCE);
    expect(summary.ratioMax).toBeLessThanOrEqual(1 + ORTHO_RATIO_TOLERANCE);
  } else {
    // Rule 1 (perspective): stably longer at every yaw. The residual near/far
    // variation is GEOMETRIC and FOV-independent: with the distance fixed, the
    // compared parallel world edges are `12*cos(pitch)` apart in depth at the
    // axis yaws but `12*cos(pitch)*cos(45)` at the diagonals, so the axis ratio is
    // inherently larger. It must therefore sit in a documented band around its
    // own reference (a SMOKE CHECK; `ratioTolerance` is per selected pitch).
    // Separately, the projection is COMPLETELY constant: FOV, near, far, distance
    // and height do not move while rotating at a fixed pitch, which is what
    // actually pins "no zoom pumping".
    expect(summary.ratioMin).toBeGreaterThanOrEqual(PERSPECTIVE_MIN_NEAR_FAR_RATIO);
    const reference = (summary.ratioMin + summary.ratioMax) / 2;
    expect(summary.ratioMax - reference).toBeLessThanOrEqual(ratioTolerance);
    expect(reference - summary.ratioMin).toBeLessThanOrEqual(ratioTolerance);
    expect(summary.distanceMax - summary.distanceMin).toBeLessThanOrEqual(
      ORBIT_CONSTANCE_TOLERANCE,
    );
    expect(summary.heightMax - summary.heightMin).toBeLessThanOrEqual(
      ORBIT_CONSTANCE_TOLERANCE,
    );
    // Wave D: the whole projection is fixed across the sweep.
    expect(summary.fovMax - summary.fovMin).toBeLessThanOrEqual(
      PROJECTION_CONSTANCE_TOLERANCE,
    );
    expect(summary.nearMax - summary.nearMin).toBeLessThanOrEqual(
      PROJECTION_CONSTANCE_TOLERANCE,
    );
    expect(summary.farMax - summary.farMin).toBeLessThanOrEqual(
      PROJECTION_CONSTANCE_TOLERANCE,
    );
    // ...and a fixed-size world segment keeps a constant screen size: the direct
    // "no zoom pumping" guarantee.
    expect(summary.focusSegmentNdcMax - summary.focusSegmentNdcMin).toBeLessThanOrEqual(
      FOCUS_SEGMENT_NDC_TOLERANCE,
    );
  }
  // The world's projected ground outline still fits inside the viewport at every
  // yaw (framing margin), even though its utilisation varies as the square world
  // turns edge-on vs corner-on, and the floor's silhouette edge stays off-screen.
  expect(summary.maxFrameUtilisation).toBeLessThanOrEqual(1 + GEOMETRY_TOLERANCE);
  expect(summary.maxBackdropMargin).toBeLessThan(1);
  expect(summary.axisUtilisation).toBeGreaterThan(0);
  expect(summary.diagonalUtilisation).toBeGreaterThan(0);
  expect(summary.maxGroundError).toBeLessThanOrEqual(CALIBRATION_WORLD_TOLERANCE);
  expect(summary.maxRoundTripError).toBeLessThanOrEqual(CALIBRATION_NDC_TOLERANCE);
  expect(summary.maxFootprintError).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
  expect(summary.maxBoundaryError).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
  expect(summary.maxScaleError).toBe(0);
  console.log(`[terrain-regression] ${label} summary: ${JSON.stringify(summary)}`);
  console.log(
    `[terrain-regression] ${label} frame utilisation: axis ${summary.axisUtilisation.toFixed(6)}` +
      ` | diagonal ${summary.diagonalUtilisation.toFixed(6)}` +
      ` | max ${summary.maxFrameUtilisation.toFixed(6)}`,
  );
}

describe('Phase-11 minimal terrain regression scene', () => {
  /**
   * Selected pitches, in degrees: both clamp ends and the default. Phase 13
   * reversed the "locked pitch" decision, so the old single-pitch sweep becomes
   * "constant per selected pitch": the projection must be exactly constant while
   * YAW rotates *at each* of these pitches.
   */
  const SELECTED_PITCHES = [
    RENDER_CAMERA.minPitchDegrees,
    RENDER_CAMERA.pitchDegrees,
    RENDER_CAMERA.maxPitchDegrees,
  ] as const;

  /**
   * Near/far ratio smoke-check half-band per selected pitch, in the same units
   * as the ratio.
   *
   * This band is a SMOKE CHECK only; the structural guarantees are the exact
   * constancy assertions in {@link assertSummary}. The band's width is a real
   * geometric effect: while yaw rotates, the selected parallel near/far edges are
   * `12*cos(pitch)` apart in depth at the axis-aligned yaws but
   * `12*cos(pitch)*cos(45)` at the diagonals, and the residual ratio is
   * FOV-independent. A flatter camera (smaller pitch) widens the band, which is
   * why the low clamp end gets the widest tolerance. Values are half the measured
   * span with margin, re-measured at the phase-13 ends.
   */
  function perspectiveRatioTolerance(pitchDegrees: number): number {
    switch (pitchDegrees) {
      case RENDER_CAMERA.minPitchDegrees:
        return 0.22;
      case RENDER_CAMERA.pitchDegrees:
        return 0.1;
      case RENDER_CAMERA.maxPitchDegrees:
        return 0.06;
      default:
        return 0.22;
    }
  }

  it('holds rules 1-5 for a uniform grass grid at every selected pitch (clamp ends and default)', () => {
    for (const pitchDegrees of SELECTED_PITCHES) {
      const rows = sweepScene(uniformGrass, pitchDegrees);
      const summary = summarize(rows);
      const label = `uniform grass @ pitch ${pitchDegrees}`;
      console.log(`[terrain-regression] ${label} baseline\n${formatRows(label, rows)}`);
      assertSummary(label, summary, perspectiveRatioTolerance(pitchDegrees));
    }
  });

  it('holds rules 1-5 for a mixed grass/path/water grid at every selected pitch', () => {
    for (const pitchDegrees of SELECTED_PITCHES) {
      const rows = sweepScene(mixedTerrain, pitchDegrees);
      const summary = summarize(rows);
      const label = `mixed terrain @ pitch ${pitchDegrees}`;
      console.log(`[terrain-regression] ${label} baseline\n${formatRows(label, rows)}`);
      assertSummary(label, summary, perspectiveRatioTolerance(pitchDegrees));
    }
    // The mixed case really exercised all three terrain appearances and never
    // the decorative `blocked` prop.
    const appearances = new Set(buildTerrainFrame(mixedTerrain).map((command) => command.appearance));
    expect(appearances).toEqual(new Set([GRASS, PATH, WATER]));
    expect(appearances.has(BLOCKED)).toBe(false);
  });
});
