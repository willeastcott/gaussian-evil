// The two meshes the lighting needs, both from the one bake (tools/bake-proxy.mjs).
//
// 'surface' is the figures' real surface: closed, solid, and within a centimetre of the splats.
// That is the right mesh for blocking light, so it casts the shadows. It lives on a layer no
// camera draws, which the lights still reach, so it gets into the shadow maps and nothing else.
//
// 'envelope' is that surface with its small hollows and overhangs smoothed over. The lighting is
// looked up per pixel from the nearest mesh in front, and on the real surface a fringe over a
// forehead, or a brow over an eye, draws its own hard edge and thin shadow across the skin
// behind it. The envelope has nothing that small to do it with.
//
// A splat also reaches a little past the surface it sits on, so at a silhouette some of its
// pixels would find no mesh behind them and go dark. The envelope is therefore grown outwards
// along its normals by about a centimetre before it is used. It casts nothing: a limb that much
// too thick would throw a shadow that much too wide.
import * as pc from 'playcanvas';

/**
 * @param {pc.GraphicsDevice} device - The device.
 * @param {pc.Mesh} source - The baked envelope.
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
 * Lets light reach a little way round the far side of the material's surfaces.
 *
 * Plain diffuse lighting stops dead where a surface turns side-on to the light. The torch is held
 * beside the lens, not on it, so wherever one part of a figure overlaps another, the camera sees
 * a sliver of the nearer part that has already turned away from the torch, and with nothing to
 * fill it that sliver is black: a line along a fringe, a patch beside a nose. Skin, hair and
 * cloth do not light like that. Light scatters through them, so the edge of the light is soft.
 *
 * @param {pc.StandardMaterial} material - The proxy's material.
 * @param {number} wrap - 0 is plain diffuse lighting; at 1 light reaches all the way round.
 */
export function wrapLight(material, wrap) {
    const w = wrap.toFixed(3), d = (1 + wrap).toFixed(3);
    material.shaderChunksVersion = '2.24';
    material.getShaderChunks(pc.SHADERLANGUAGE_GLSL).set('lightDiffuseLambertPS', `
float getLightDiffuse(vec3 worldNormal, vec3 viewDir, vec3 lightDirNorm) {
    return max((dot(worldNormal, -lightDirNorm) + ${w}) / ${d}, 0.0);
}
`);
    material.getShaderChunks(pc.SHADERLANGUAGE_WGSL).set('lightDiffuseLambertPS', `
fn getLightDiffuse(worldNormal: vec3f, viewDir: vec3f, lightDirNorm: vec3f) -> f32 {
    return max((dot(worldNormal, -lightDirNorm) + ${w}) / ${d}, 0.0);
}
`);
    material.update();
}

/**
 * @param {pc.Mesh} mesh - The baked surface.
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
