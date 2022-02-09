import { METABALLS_COMPUTE_WORKGROUP_SIZE } from '../constants'
import {
  MarchingCubesEdgeTable,
  MarchingCubesTriTable,
} from '../marching-cubes-tables'

export const ProjectionUniforms = `
  struct ProjectionUniforms {
    matrix : mat4x4<f32>;
    outputSize : vec2<f32>;
    zNear : f32;
    zFar : f32;
  };
  @group(0) @binding(0) var<uniform> projection : ProjectionUniforms;
`

export const ViewUniforms = `
  struct ViewUniforms {
    matrix : mat4x4<f32>;
    position : vec3<f32>;
    time : f32;
  };
  @group(0) @binding(1) var<uniform> view : ViewUniforms;
`

export const IsosurfaceVolume = `
  struct IsosurfaceVolume {
    min: vec3<f32>;
    max: vec3<f32>;
    step: vec3<f32>;
    size: vec3<u32>;
    threshold: f32;
    values: array<f32>;
  };
`

export const MetaballFieldComputeSource = `
  struct Metaball {
    position: vec3<f32>;
    radius: f32;
    strength: f32;
    subtract: f32;
  };

  struct MetaballList {
    ballCount: u32;
    balls: array<Metaball>;
  };
  @group(0) @binding(0) var<storage> metaballs : MetaballList;

  ${IsosurfaceVolume}
  @group(0) @binding(1) var<storage, read_write> volume : IsosurfaceVolume;

  fn positionAt(index : vec3<u32>) -> vec3<f32> {
    return volume.min + (volume.step * vec3<f32>(index.xyz));
  }

  fn surfaceFunc(position : vec3<f32>) -> f32 {
    var result = 0.0;
    for (var i = 0u; i < metaballs.ballCount; i = i + 1u) {
      let ball = metaballs.balls[i];
      let dist = distance(position, ball.position);
      let val = ball.strength / (0.000001 + (dist * dist)) - ball.subtract;
      if (val > 0.0) {
        result = result + val;
      }
    }
    return result;
  }

  @stage(compute) @workgroup_size(${METABALLS_COMPUTE_WORKGROUP_SIZE[0]}, ${METABALLS_COMPUTE_WORKGROUP_SIZE[1]}, ${METABALLS_COMPUTE_WORKGROUP_SIZE[2]})
  fn main(@builtin(global_invocation_id) global_id : vec3<u32>) {
    let position = positionAt(global_id);
    let valueIndex = global_id.x +
                    (global_id.y * volume.size.x) +
                    (global_id.z * volume.size.x * volume.size.y);

    volume.values[valueIndex] = surfaceFunc(position);
  }
`

export const MarchingCubesComputeSource = `
  struct Tables {
    edges: array<u32, ${MarchingCubesEdgeTable.length}>;
    tris: array<i32, ${MarchingCubesTriTable.length}>;
  };
  @group(0) @binding(0) var<storage> tables : Tables;

  ${IsosurfaceVolume}
  @group(0) @binding(1) var<storage, write> volume : IsosurfaceVolume;

  // Output buffers
  struct PositionBuffer {
    values : array<f32>;
  };
  @group(0) @binding(2) var<storage, write> positionsOut : PositionBuffer;

  struct NormalBuffer {
    values : array<f32>;
  };
  @group(0) @binding(3) var<storage, write> normalsOut : NormalBuffer;

  struct IndexBuffer {
    tris : array<u32>;
  };
  @group(0) @binding(4) var<storage, write> indicesOut : IndexBuffer;

  struct DrawIndirectArgs {
    vc : u32;
    vertexCount : atomic<u32>; // Actually instance count, treated as vertex count for point cloud rendering.
    firstVertex : u32;
    firstInstance : u32;

    indexCount : atomic<u32>;
    indexedInstanceCount : u32;
    indexedFirstIndex : u32;
    indexedBaseVertex : u32;
    indexedFirstInstance : u32;
  };
  @group(0) @binding(5) var<storage, read_write> drawOut : DrawIndirectArgs;

  // Data fetchers
  fn valueAt(index : vec3<u32>) -> f32 {
    // Don't index outside of the volume bounds.
    if (any(index >= volume.size)) { return 0.0; }

    let valueIndex = index.x +
                    (index.y * volume.size.x) +
                    (index.z * volume.size.x * volume.size.y);
    return volume.values[valueIndex];
  }

  fn positionAt(index : vec3<u32>) -> vec3<f32> {
    return volume.min + (volume.step * vec3<f32>(index.xyz));
  }

  fn normalAt(index : vec3<u32>) -> vec3<f32> {
    return vec3<f32>(
      valueAt(index - vec3<u32>(1u, 0u, 0u)) - valueAt(index + vec3<u32>(1u, 0u, 0u)),
      valueAt(index - vec3<u32>(0u, 1u, 0u)) - valueAt(index + vec3<u32>(0u, 1u, 0u)),
      valueAt(index - vec3<u32>(0u, 0u, 1u)) - valueAt(index + vec3<u32>(0u, 0u, 1u))
    );
  }

  // Vertex interpolation
  var<private> positions : array<vec3<f32>, 12>;
  var<private> normals : array<vec3<f32>, 12>;
  var<private> indices : array<u32, 12>;
  var<private> cubeVerts : u32 = 0u;

  fn interpX(index : u32, i : vec3<u32>, va : f32, vb : f32) {
    let mu = (volume.threshold - va) / (vb - va);
    positions[cubeVerts] = positionAt(i) + vec3<f32>(volume.step.x * mu, 0.0, 0.0);

    let na = normalAt(i);
    let nb = normalAt(i + vec3<u32>(1u, 0u, 0u));
    normals[cubeVerts] = mix(na, nb, vec3<f32>(mu, mu, mu));

    indices[index] = cubeVerts;
    cubeVerts = cubeVerts + 1u;
  }

  fn interpY(index : u32, i : vec3<u32>, va : f32, vb : f32) {
    let mu = (volume.threshold - va) / (vb - va);
    positions[cubeVerts] = positionAt(i) + vec3<f32>(0.0, volume.step.y * mu, 0.0);

    let na = normalAt(i);
    let nb = normalAt(i + vec3<u32>(0u, 1u, 0u));
    normals[cubeVerts] = mix(na, nb, vec3<f32>(mu, mu, mu));

    indices[index] = cubeVerts;
    cubeVerts = cubeVerts + 1u;
  }

  fn interpZ(index : u32, i : vec3<u32>, va : f32, vb : f32) {
    let mu = (volume.threshold - va) / (vb - va);
    positions[cubeVerts] = positionAt(i) + vec3<f32>(0.0, 0.0, volume.step.z * mu);

    let na = normalAt(i);
    let nb = normalAt(i + vec3<u32>(0u, 0u, 1u));
    normals[cubeVerts] = mix(na, nb, vec3<f32>(mu, mu, mu));

    indices[index] = cubeVerts;
    cubeVerts = cubeVerts + 1u;
  }

  // Main marching cubes algorithm
  @stage(compute) @workgroup_size(${METABALLS_COMPUTE_WORKGROUP_SIZE[0]}, ${METABALLS_COMPUTE_WORKGROUP_SIZE[1]}, ${METABALLS_COMPUTE_WORKGROUP_SIZE[2]})
  fn main(@builtin(global_invocation_id) global_id : vec3<u32>) {
    // Cache the values we're going to be referencing frequently.
    let i0 = global_id;
    let i1 = global_id + vec3<u32>(1u, 0u, 0u);
    let i2 = global_id + vec3<u32>(1u, 1u, 0u);
    let i3 = global_id + vec3<u32>(0u, 1u, 0u);
    let i4 = global_id + vec3<u32>(0u, 0u, 1u);
    let i5 = global_id + vec3<u32>(1u, 0u, 1u);
    let i6 = global_id + vec3<u32>(1u, 1u, 1u);
    let i7 = global_id + vec3<u32>(0u, 1u, 1u);

    let v0 = valueAt(i0);
    let v1 = valueAt(i1);
    let v2 = valueAt(i2);
    let v3 = valueAt(i3);
    let v4 = valueAt(i4);
    let v5 = valueAt(i5);
    let v6 = valueAt(i6);
    let v7 = valueAt(i7);

    var cubeIndex = 0u;
    if (v0 < volume.threshold) { cubeIndex = cubeIndex | 1u; }
    if (v1 < volume.threshold) { cubeIndex = cubeIndex | 2u; }
    if (v2 < volume.threshold) { cubeIndex = cubeIndex | 4u; }
    if (v3 < volume.threshold) { cubeIndex = cubeIndex | 8u; }
    if (v4 < volume.threshold) { cubeIndex = cubeIndex | 16u; }
    if (v5 < volume.threshold) { cubeIndex = cubeIndex | 32u; }
    if (v6 < volume.threshold) { cubeIndex = cubeIndex | 64u; }
    if (v7 < volume.threshold) { cubeIndex = cubeIndex | 128u; }

    let edges = tables.edges[cubeIndex];

    // Once we have atomics we can early-terminate here if edges == 0
    //if (edges == 0u) { return; }

    if ((edges & 1u) != 0u) { interpX(0u, i0, v0, v1); }
    if ((edges & 2u) != 0u) { interpY(1u, i1, v1, v2); }
    if ((edges & 4u) != 0u) { interpX(2u, i3, v3, v2); }
    if ((edges & 8u) != 0u) { interpY(3u, i0, v0, v3); }
    if ((edges & 16u) != 0u) { interpX(4u, i4, v4, v5); }
    if ((edges & 32u) != 0u) { interpY(5u, i5, v5, v6); }
    if ((edges & 64u) != 0u) { interpX(6u, i7, v7, v6); }
    if ((edges & 128u) != 0u) { interpY(7u, i4, v4, v7); }
    if ((edges & 256u) != 0u) { interpZ(8u, i0, v0, v4); }
    if ((edges & 512u) != 0u) { interpZ(9u, i1, v1, v5); }
    if ((edges & 1024u) != 0u) { interpZ(10u, i2, v2, v6); }
    if ((edges & 2048u) != 0u) { interpZ(11u, i3, v3, v7); }

    let triTableOffset = (cubeIndex << 4u) + 1u;
    let indexCount = u32(tables.tris[triTableOffset - 1u]);

    // In an ideal world this offset is tracked as an atomic.
    var firstVertex = atomicAdd(&drawOut.vertexCount, cubeVerts);

    // Instead we have to pad the vertex/index buffers with the maximum possible number of values
    // and create degenerate triangles to fill the empty space, which is a waste of GPU cycles.
    let bufferOffset = (global_id.x +
                        global_id.y * volume.size.x +
                        global_id.z * volume.size.x * volume.size.y);
    let firstIndex = bufferOffset * 15u;
    //firstVertex = bufferOffset*12u;

    // Copy positions to output buffer
    for (var i = 0u; i < cubeVerts; i = i + 1u) {
      positionsOut.values[firstVertex*3u + i*3u] = positions[i].x;
      positionsOut.values[firstVertex*3u + i*3u + 1u] = positions[i].y;
      positionsOut.values[firstVertex*3u + i*3u + 2u] = positions[i].z;

      normalsOut.values[firstVertex*3u + i*3u] = normals[i].x;
      normalsOut.values[firstVertex*3u + i*3u + 1u] = normals[i].y;
      normalsOut.values[firstVertex*3u + i*3u + 2u] = normals[i].z;
    }

    // Write out the indices
    for (var i = 0u; i < indexCount; i = i + 1u) {
      let index = tables.tris[triTableOffset + i];
      indicesOut.tris[firstIndex + i] = firstVertex + indices[index];
    }

    // Write out degenerate triangles whenever we don't have a real index in order to keep our
    // stride constant. Again, this can go away once we have atomics.
    for (var i = indexCount; i < 15u; i = i + 1u) {
      indicesOut.tris[firstIndex + i] = firstVertex;
    }
  }
`

export const METABALLS_VERTEX_SHADER = `
    ${ProjectionUniforms}
    ${ViewUniforms}

    struct Inputs {
      @location(0) position: vec3<f32>;
      @location(1) normal: vec3<f32>;
    }
    
    struct VertexOutput {
      @location(0) normal: vec3<f32>;
      @builtin(position) position: vec4<f32>;
    }

    @stage(vertex)
    fn main(input: Inputs) -> VertexOutput {
      var output: VertexOutput;
      output.position = projection.matrix * view.matrix * vec4<f32>(input.position, 1.0);
      output.normal = input.normal;
      return output;
    }
`

export const METABALLS_FRAGMENT_SHADER = `
    struct Inputs {
      @location(0) normal: vec3<f32>;
    }
    @stage(fragment)
    fn main(input: Inputs) -> @location(0) vec4<f32> {
      var normal = normalize(input.normal);
      return vec4<f32>(normal * 0.5 + 0.5, 1.0);
    }
`
