// The two meshes the lighting needs, both from the one baked proxy.
//
// The baked mesh (tools/bake-proxy.mjs) is the figures' real surface: closed, solid, and within a
// centimetre of the splats. That is the right mesh for blocking light, so it casts the shadows.
// It lives on a layer no camera draws, which the lights still reach, so it gets into the shadow
// maps and nothing else.
//
// It is not quite the right mesh for receiving light. The lighting is looked up per pixel, and a
// splat reaches a little past the surface it sits on, so at a silhouette some of a splat's pixels
// would find no mesh behind them and go dark. The mesh that receives light is therefore a copy
// grown outwards along its normals by about a centimetre. It casts nothing: a limb that much too
// thick would throw a shadow that much too wide, which shows as a dark band along its edge.
import * as pc from 'playcanvas';

/**
 * @param {pc.GraphicsDevice} device - The device.
 * @param {pc.Mesh} source - The baked mesh.
 * @param {number} grow - How far to push the surface out, in the mesh's own units.
 * @returns {pc.Mesh} The grown mesh, with the same normals.
 */
export function createGrownMesh(device, source, grow) {
    const positions = [], normals = [], indices = [];
    source.getPositions(positions);
    source.getNormals(normals);
    source.getIndices(indices);

    const grown = new Float32Array(positions.length);
    for (let i = 0; i < grown.length; i++) grown[i] = positions[i] + normals[i] * grow;

    const mesh = new pc.Mesh(device);
    mesh.setPositions(grown);
    mesh.setNormals(normals);
    mesh.setIndices(indices);
    mesh.update();
    return mesh;
}

/**
 * @param {pc.Mesh} mesh - The baked mesh.
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
