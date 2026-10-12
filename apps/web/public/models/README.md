# GLB assets

Real art goes here. Nothing in this repository references an asset yet, so every
appearance still renders its **procedural placeholder** and the client asset
catalogue (`apps/web/src/render/three/assets.ts`, `MODEL_CATALOGUE`) is empty.

## Adding an asset

1. Drop the `.glb` here, e.g. `tree.glb` (served at `/models/tree.glb`).
2. Add one catalogue entry, e.g.:

   ```ts
   export const MODEL_CATALOGUE: AppearanceModelCatalogue = {
     [asAppearanceId('appearance.tree')]: {
       url: '/models/tree.glb',
       scale: { x: 1, y: 1, z: 1 },
       yawRadians: 0,   // rotate the model's front to local +Z
       yOffset: 0,      // put the model's feet at the node anchor
       idleClip: 'Idle',
       walkClip: 'Walk',
     },
   };
   ```

No protocol, Manager, Router or Organizer change is needed: the server cannot
name an asset, and the catalogue is the only place a path lives.

## Constraints the runtime enforces

- **Opaque or alpha-tested materials only.** A blended (`transparent: true`)
  material is coerced to `alphaTest` so it cannot break depth-buffer occlusion;
  there is no y-sorted transparent pass yet.
- The procedural placeholder renders immediately and is swapped out when the
  model resolves; a slow or failed load keeps the placeholder.
- One parse per URL, cloned per node (`SkeletonUtils.clone` for skinned models).
