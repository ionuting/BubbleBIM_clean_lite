/**
 * toCesium.ts — the parsed model as something in the scene.
 *
 * Kept apart from `parse.ts` on purpose: the parser is arithmetic and its
 * tests run in a few milliseconds with no WebGL anywhere. This file is the
 * only part that knows what a viewer is.
 *
 * One `GeometryInstance` per CityObject rather than one merged mesh, because
 * an instance carries its own colour and its own `id` — so Cesium batches
 * them into few draw calls AND a click can still say which building it hit.
 */
import * as Cesium from 'cesium';
import type { CityJsonModel, CityObjectMesh } from './parse';

/**
 * What a pick returns, so the caller does not have to guess at the shape.
 *
 * Carried on the instance itself rather than looked up later: Cesium hands
 * this exact object back from `scene.pick`, and the same reference is the key
 * for `getGeometryInstanceAttributes` — which is how the selection gets
 * highlighted without keeping a parallel index of anything.
 */
export interface CityPickId {
  cityObjectId: string;
  type: string;
  attributes: Record<string, unknown>;
  lod?: string;
  parents?: string[];
}

function instanceOf(o: CityObjectMesh): Cesium.GeometryInstance {
  // `GeometryAttributes` declares every slot a mesh could have — texture
  // coordinates, tangents — so it is built and then filled rather than
  // passed as a literal, which would have to name the ones we do not use.
  const attributes = new Cesium.GeometryAttributes();
  attributes.position = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values: o.positions,
  });
  // Flat shading is done in the parser — a corner per triangle — so an eave
  // stays a crease instead of being smoothed into a dome.
  attributes.normal = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.FLOAT,
    componentsPerAttribute: 3,
    values: o.normals,
  });

  const geometry = new Cesium.Geometry({
    attributes,
    indices: o.indices,
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(o.positions)),
  });

  const color = Cesium.Color
    .fromCssColorString(o.color)
    .withAlpha(Math.max(0.05, 1 - (o.transparency || 0)));

  const id: CityPickId = {
    cityObjectId: o.id, type: o.type, attributes: o.attributes,
    lod: o.lod, parents: o.parents,
  };
  return new Cesium.GeometryInstance({
    geometry,
    attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
    id,
  });
}

/**
 * The model as one primitive, placed by `modelMatrix`.
 *
 * `asynchronous: false` is not a performance choice, it is the only legal
 * one: Cesium combines geometry in a web worker by NAME, re-running the
 * geometry's own constructor there, and a `Geometry` built by hand here has
 * no constructor for the worker to call. Asking for the default throws
 * `Must define either _workerName or _workerPath for asynchronous geometry`
 * and stops the render loop — the whole globe, not just this layer.
 */
export function cityJsonPrimitive(
  model: CityJsonModel,
  modelMatrix: Cesium.Matrix4,
): Cesium.Primitive {
  const translucent = model.objects.some((o) => (o.transparency ?? 0) > 0.01);
  return new Cesium.Primitive({
    geometryInstances: model.objects.map(instanceOf),
    appearance: new Cesium.PerInstanceColorAppearance({
      flat: false,
      // Opaque geometry sorts by depth and needs no blending; asking for
      // translucency anyway makes a solid city render back-to-front wrong.
      translucent,
    }),
    modelMatrix,
    asynchronous: false,
    allowPicking: true,
  });
}

/**
 * Where to point the camera, in world coordinates.
 *
 * Read off the parsed extent rather than off the primitive: the extent is
 * already known and already recentred, so the flight can be started in the
 * same breath as the add, without reaching into Cesium's combined volumes.
 */
export function cityJsonBoundingSphere(
  model: CityJsonModel,
  modelMatrix: Cesium.Matrix4,
): Cesium.BoundingSphere {
  const e = model.extent;
  const corners: Cesium.Cartesian3[] = [];
  for (const x of [e.minX, e.maxX]) {
    for (const y of [e.minY, e.maxY]) {
      for (const z of [e.minZ, e.maxZ]) {
        corners.push(Cesium.Matrix4.multiplyByPoint(
          modelMatrix, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3(),
        ));
      }
    }
  }
  const sphere = Cesium.BoundingSphere.fromPoints(corners);
  // A flat site gives a sphere barely bigger than nothing to fly to.
  sphere.radius = Math.max(sphere.radius, 15);
  return sphere;
}
