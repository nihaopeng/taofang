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
 *      - perspective (Wave C): the near edge is STABLY longer (a documented
 *        lower bound > 1 at every yaw, not merely `!=`), and the ratio stays in
 *        a tight band around its own reference. Wave C also asserts the camera
 *        DISTANCE and HEIGHT are constant across the yaw sweep, i.e. the view is
 *        a pure orbit with no dolly, which is what makes the perspective
 *        strength (distance-driven) stable.
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

import { createThreeRuntime } from '../src/render/three/runtime.ts';
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
 * Phase-11 Wave C acceptance band around the measured near/far ratio reference.
 *
 * This tolerance is a SMOKE CHECK, not the structural guarantee. The guarantees
 * that actually catch a regression are asserted exactly elsewhere in this file:
 * the camera distance and height are CONSTANT across the whole yaw sweep
 * ({@link ORBIT_CONSTANCE_TOLERANCE}, 1e-9), the projection self-calibrates
 * against the runtime's own `pick()`, the near edge is strictly longer than the
 * far edge at every yaw, and the terrain footprint/boundary/scale errors are all
 * exactly 0. Those pin a pure orbit independently of any ratio band.
 *
 * Why the ratio band can never be ~2% (do NOT "tighten" this by mistake):
 * (a) The residual near/far variation is GEOMETRIC and yaw-dependent. With the
 *     camera distance fixed, the compared parallel world edges are
 *     `12 * cos(pitch) = 6.36` apart in depth at the axis-aligned yaws but
 *     `12 * cos(pitch) * cos(45 deg) = 4.50` at the diagonals, so the axis ratio
 *     (1.1689) is inherently larger than the diagonal ratio (1.0977).
 * (b) The near/far ratio is FOV-INDEPENDENT (both edge lengths scale by the same
 *     `1 / tan(fov/2)` factor), so NO FOV choice could flatten it.
 * (c) The only way to flatten it is a much larger camera distance: ~145 world
 *     units (a ~8 degree FOV) for a +/-0.02 band, which would abandon the
 *     requested 20.3..28 degree composition.
 * (d) Fixing the distance already collapsed Wave B's dolly-driven span from
 *     0.146 (1.0977..1.2434) to 0.0712 (1.0977..1.1689): the diagonal ratio is
 *     unchanged because Wave B already sat at that distance there, while the
 *     axis ratio fell as the camera stopped dollying in to 29.3.
 * The tolerance below is half the measured span with margin. Approved by Main.
 */
const PERSPECTIVE_RATIO_REFERENCE_TOLERANCE = 0.04;
/**
 * Wave C orbit assertion: the camera distance and height must be CONSTANT across
 * the whole yaw sweep (no yaw dolly), to within floating-point noise.
 */
const ORBIT_CONSTANCE_TOLERANCE = 1e-9;
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
function sweepScene(appearanceAt: AppearancePicker): BaselineRow[] {
  const runtime = createThreeRuntime({ bounds: BOUNDS, grid: GRID });
  runtime.apply(buildTerrainFrame(appearanceAt));
  assertTerrainOnly(runtime);

  const rows: BaselineRow[] = [];
  try {
    for (let yaw = 0; yaw < 360; yaw += YAW_STEP_DEGREES) {
      runtime.setCameraOrientation({ yawDegrees: yaw });
      const camera = runtime.inspect().camera as CameraSnapshot;
      const view = cameraView(camera);

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

      // Wave C pure orbit: the camera distance from the focus and its height must
      // be identical at every yaw (the FOV, not the distance, absorbs the fit).
      const focusOffset = sub(camera.position, camera.focus);
      const distance = Math.hypot(focusOffset.x, focusOffset.y, focusOffset.z);
      const height = focusOffset.y;
      expect(distance).toBeGreaterThan(0);

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
  readonly maxGroundError: number;
  readonly maxRoundTripError: number;
  readonly maxFootprintError: number;
  readonly maxBoundaryError: number;
  readonly maxScaleError: number;
}

function summarize(rows: readonly BaselineRow[]): BaselineSummary {
  const ratios = rows.map((row) => row.ratio);
  const distances = rows.map((row) => row.distance);
  const heights = rows.map((row) => row.height);
  return {
    kind: rows[0]?.kind ?? 'orthographic',
    ratioMin: Math.min(...ratios),
    ratioMax: Math.max(...ratios),
    distanceMin: Math.min(...distances),
    distanceMax: Math.max(...distances),
    heightMin: Math.min(...heights),
    heightMax: Math.max(...heights),
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
function assertSummary(label: string, summary: BaselineSummary): void {
  if (summary.kind === 'orthographic') {
    // Rule 1 (orthographic): exactly 1 to 9 decimals at every yaw.
    expect(summary.ratioMin).toBeGreaterThanOrEqual(1 - ORTHO_RATIO_TOLERANCE);
    expect(summary.ratioMax).toBeLessThanOrEqual(1 + ORTHO_RATIO_TOLERANCE);
  } else {
    // Rule 1 (perspective): stably longer at every yaw. Wave C fixes the camera
    // distance, so the residual near/far variation is geometric (world edges)
    // and must sit in a tight, documented band around its own reference; the
    // distance and height must be exactly constant (pure orbit, no dolly).
    expect(summary.ratioMin).toBeGreaterThanOrEqual(PERSPECTIVE_MIN_NEAR_FAR_RATIO);
    const reference = (summary.ratioMin + summary.ratioMax) / 2;
    expect(summary.ratioMax - reference).toBeLessThanOrEqual(
      PERSPECTIVE_RATIO_REFERENCE_TOLERANCE,
    );
    expect(reference - summary.ratioMin).toBeLessThanOrEqual(
      PERSPECTIVE_RATIO_REFERENCE_TOLERANCE,
    );
    expect(summary.distanceMax - summary.distanceMin).toBeLessThanOrEqual(
      ORBIT_CONSTANCE_TOLERANCE,
    );
    expect(summary.heightMax - summary.heightMin).toBeLessThanOrEqual(
      ORBIT_CONSTANCE_TOLERANCE,
    );
  }
  expect(summary.maxGroundError).toBeLessThanOrEqual(CALIBRATION_WORLD_TOLERANCE);
  expect(summary.maxRoundTripError).toBeLessThanOrEqual(CALIBRATION_NDC_TOLERANCE);
  expect(summary.maxFootprintError).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
  expect(summary.maxBoundaryError).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
  expect(summary.maxScaleError).toBe(0);
  console.log(`[terrain-regression] ${label} summary: ${JSON.stringify(summary)}`);
}

describe('Phase-11 minimal terrain regression scene', () => {
  it('holds rules 1-5 for a uniform grass grid across the yaw sweep', () => {
    const rows = sweepScene(uniformGrass);
    const summary = summarize(rows);
    console.log(`[terrain-regression] uniform grass baseline\n${formatRows('uniform grass', rows)}`);
    assertSummary('uniform grass', summary);
  });

  it('holds rules 1-5 for a mixed grass/path/water grid across the yaw sweep', () => {
    const rows = sweepScene(mixedTerrain);
    const summary = summarize(rows);
    console.log(`[terrain-regression] mixed terrain baseline\n${formatRows('mixed terrain', rows)}`);
    assertSummary('mixed terrain', summary);
    // The mixed case really exercised all three terrain appearances and never
    // the decorative `blocked` prop.
    const appearances = new Set(buildTerrainFrame(mixedTerrain).map((command) => command.appearance));
    expect(appearances).toEqual(new Set([GRASS, PATH, WATER]));
    expect(appearances.has(BLOCKED)).toBe(false);
  });
});
