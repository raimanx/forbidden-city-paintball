import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  ShaderMaterial,
} from 'three';
import { palette } from '../core/Config';
import { NO_OUTLINE_LAYER } from '../render/NprPipeline';
import { GROUND_HALF_X, GROUND_HALF_Z, WATER_Y, heightAt } from './CityLayout';

/**
 * Cells across the map.
 *
 * The city's water is a ring, not a pool: the moat runs round all four sides
 * and the Golden Water River crosses the first courtyard, so there is no
 * bounding box to fit that is smaller than the map. One plane over everything,
 * with the shader discarding wherever the ground stands above the waterline, is
 * both simpler and — because the moat is only 23m wide — no more expensive than
 * four separately fitted strips would be.
 *
 * 144 cells puts about six vertices across the moat, which is enough for the
 * depth ramp that drives the shore foam.
 */
const CELLS = 144;

const VERTEX = /* glsl */ `
attribute float aDepth;
varying float vDepth;
varying vec2 vWorld;

uniform float uTime;

void main() {
  vDepth = aDepth;
  vWorld = position.xz;

  vec3 p = position;
  // Two crossed swells. Tiny amplitude — this is a pond, and a big vertical
  // wobble would break the flat painted look immediately.
  p.y += sin( p.x * 0.19 + uTime * 0.7 ) * 0.035;
  p.y += sin( p.z * 0.26 - uTime * 0.5 ) * 0.028;

  gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
}
`;

/**
 * Stylised water. Flat colour bands and crisp white highlight streaks, not a
 * reflection model — painted water reads by its highlights, not its physics.
 */
const FRAGMENT = /* glsl */ `
varying float vDepth;
varying vec2 vWorld;

uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uAlgae;
uniform vec3 uFoam;

void main() {
  // Everything above the waterline is land; there is no water to draw there.
  if ( vDepth <= 0.0 ) discard;

  // Three bands, not two. Photographs of The Lake show a hard split: open
  // water takes its colour from the sky and goes blue, while the whole margin
  // under the treeline reflects leaves and goes olive-green. A single
  // shallow-to-deep ramp between two blues cannot produce that, and the result
  // reads as a swimming pool laid into the grass.
  // Thresholds are in metres and the lake is only 2.6m deep at the bed, so
  // they have to sit inside that: bands tuned for a 4m body never leave the
  // first colour and the whole lake comes out one flat green.
  vec3 color = mix( uAlgae, uShallow, smoothstep( 0.15, 0.8, vDepth ) );
  color = mix( color, uDeep, smoothstep( 0.9, 2.2, vDepth ) );

  // Highlight streaks: banded, so they read as drawn strokes rather than as a
  // specular gradient.
  // Low frequency and gently modulated. Higher frequency with a strong phase
  // wobble produced hard zigzags that read as a pattern, not as light on water.
  float streak = sin( vWorld.x * 0.28 + sin( vWorld.y * 0.17 + uTime * 0.25 ) * 1.1
                      + uTime * 0.4 );
  float highlight = smoothstep( 0.55, 0.97, streak );
  color = mix( color, uFoam, highlight * 0.30 );

  // Shore foam, with a slow crawl so the edge is never perfectly static.
  float shoreWave = 0.09 * sin( vWorld.x * 0.9 + vWorld.y * 0.7 + uTime * 0.8 );
  float foam = 1.0 - smoothstep( 0.0, 0.55 + shoreWave, vDepth );
  color = mix( color, uFoam, foam * 0.6 );

  // Transparent in the shallows so the sandy bed reads through, opaque out in
  // the deep. Fully opaque water met the shore as a hard cut — a blue mat laid
  // on the grass — because the only transition was the discard at depth zero.
  float alpha = mix( 0.18, 0.96, smoothstep( 0.0, 1.3, vDepth ) );
  // Foam sits on top of the water rather than behind it.
  alpha = max( alpha, foam * 0.85 );

  gl_FragColor = vec4( color, alpha );
  #include <colorspace_fragment>
}
`;

/**
 * The moat and the Golden Water River.
 *
 * Depth is baked per-vertex from the same `heightAt` the terrain uses, so the
 * bank is exactly where the ground crosses the waterline — no z-fighting band,
 * and foam lands in the right place for free.
 */
export class Water {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor() {
    const verts = CELLS + 1;
    const positions = new Float32Array(verts * verts * 3);
    const depths = new Float32Array(verts * verts);
    const indices = new Uint32Array(CELLS * CELLS * 6);

    for (let iz = 0; iz <= CELLS; iz++) {
      for (let ix = 0; ix <= CELLS; ix++) {
        const i = iz * verts + ix;
        const x = -GROUND_HALF_X + (ix / CELLS) * GROUND_HALF_X * 2;
        const z = -GROUND_HALF_Z + (iz / CELLS) * GROUND_HALF_Z * 2;
        positions[i * 3] = x;
        positions[i * 3 + 1] = WATER_Y;
        positions[i * 3 + 2] = z;
        depths[i] = WATER_Y - heightAt(x, z);
      }
    }

    let t = 0;
    for (let iz = 0; iz < CELLS; iz++) {
      for (let ix = 0; ix < CELLS; ix++) {
        const a = iz * verts + ix;
        const b = a + 1;
        const c = a + verts;
        const d = c + 1;
        indices[t++] = a;
        indices[t++] = c;
        indices[t++] = b;
        indices[t++] = b;
        indices[t++] = c;
        indices[t++] = d;
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aDepth', new BufferAttribute(depths, 1));
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();

    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: DoubleSide,
      transparent: true,
      // No depth write: the surface is a single plane, so nothing needs to sort
      // against it, and writing depth would clip the shore geometry beneath.
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uDeep: { value: new Color(palette.waterDeep) },
        uShallow: { value: new Color(palette.waterShallow) },
        uAlgae: { value: new Color(palette.waterAlgae) },
        uFoam: { value: new Color(0xeef6f4) },
      },
    });

    this.mesh = new Mesh(geometry, this.material);
    // Excluded from the outline prepass: the water plane's silhouette against
    // the shore would otherwise be inked, and painted water has no outline.
    this.mesh.layers.set(NO_OUTLINE_LAYER);
    this.mesh.receiveShadow = false;
    // Drawn after the terrain it is blended over.
    this.mesh.renderOrder = 2;
  }

  update(elapsed: number): void {
    this.material.uniforms.uTime!.value = elapsed;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
