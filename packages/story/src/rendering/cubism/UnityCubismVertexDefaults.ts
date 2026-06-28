/**
 * Stable attribute layout reserved by the Cubism/Unity shader bridge.
 * Position and UV match the two arrays supplied by Cubism Core; normal is a
 * generic attribute because Cubism's generated meshes contain no normal array.
 */
export const UNITY_CUBISM_POSITION_ATTRIBUTE_LOCATION = 0;
export const UNITY_CUBISM_UV_ATTRIBUTE_LOCATION = 1;
export const UNITY_CUBISM_NORMAL_ATTRIBUTE_LOCATION = 2;

/**
 * Unity 6000.3.12f1 GLES missing Float32 NORMAL0 value, including its unused W.
 */
export const UNITY_CUBISM_MISSING_NORMAL = Object.freeze([0, 0, 1, 0] as const);

type GenericVertexAttributeContext = Pick<WebGLRenderingContext, "disableVertexAttribArray" | "vertexAttrib4f">;

/** Bind Unity's missing NORMAL0 value without allocating a per-vertex buffer. */
export function bindUnityCubismMissingNormal(gl: GenericVertexAttributeContext): void {
  const [x, y, z, w] = UNITY_CUBISM_MISSING_NORMAL;
  gl.disableVertexAttribArray(UNITY_CUBISM_NORMAL_ATTRIBUTE_LOCATION);
  gl.vertexAttrib4f(UNITY_CUBISM_NORMAL_ATTRIBUTE_LOCATION, x, y, z, w);
}
