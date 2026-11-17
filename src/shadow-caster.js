// Shadow caster: a slimmer copy of the lighting proxy.
//
// The proxy mesh is deliberately fat. It has to cover every pixel the splats cover, or the splats
// at a silhouette would find no lighting behind them, so it is baked about 2 cm outside the
// surface you see (tools/proxy-girth.mjs measures it). That is right for receiving light and wrong
// for blocking it: a forearm 4 cm too thick casts a shadow 4 cm too wide, and the extra shows up
// as a black band along the limb's edge on whatever is behind it.
//
// So the fat mesh only receives. Shadows are cast by this copy, pulled in along its normals to
// where the splats really are. It lives on a layer no camera draws, which the torch still lights,
// so it reaches the shadow map and nothing else.
import * as pc from 'playcanvas';

/**
 * @param {pc.GraphicsDevice} device - The device.
 * @param {pc.Mesh} source - The proxy mesh.
 * @param {number} shrink - How far to pull the surface in, in the mesh's own units.
 * @returns {pc.Mesh} The slimmer mesh.
 */
export function createCasterMesh(device, source, shrink) {
    const positions = [], normals = [], indices = [];
    source.getPositions(positions);
    source.getNormals(normals);
    source.getIndices(indices);

    const slim = new Float32Array(positions.length);
    for (let i = 0; i < slim.length; i++) slim[i] = positions[i] - normals[i] * shrink;

    const mesh = new pc.Mesh(device);
    mesh.setPositions(slim);
    mesh.setIndices(indices);
    mesh.update();
    return mesh;
}

/**
 * @param {pc.Mesh} mesh - From createCasterMesh.
 * @param {pc.Material} material - Any material; only its shadow pass is ever drawn.
 * @param {number[]} layers - Ids of the layers to put it on.
 * @returns {pc.Entity} An entity that casts the mesh's shadow.
 */
export function createCasterEntity(mesh, material, layers) {
    const entity = new pc.Entity('shadow-caster');
    entity.addComponent('render', {
        meshInstances: [new pc.MeshInstance(mesh, material)],
        layers,
        castShadows: true,
        receiveShadows: false
    });
    return entity;
}
