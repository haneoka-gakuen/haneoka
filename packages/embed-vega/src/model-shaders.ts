const vertexSource = `#version 300 es
out vec2 v_uv;
void main() {
  v_uv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(v_uv * 2.0 - 1.0, 0.0, 1.0);
}`;

export interface ModelShaderOptions {
  /** JSON array of WebGL2 fragment shader paths. */
  readonly shaders?: string | URL;
  /** Directory for relative fragment paths. Defaults to the index directory. */
  readonly shadersDir?: string | URL;
}

export async function loadModelShaders(
  options: ModelShaderOptions,
  base: string,
  read: (url: string) => Promise<Uint8Array>,
): Promise<string[]> {
  if (!options.shaders && !options.shadersDir) return [];
  const directory = options.shadersDir ? new URL(options.shadersDir, base) : undefined;
  if (directory && !directory.pathname.endsWith("/")) directory.pathname += "/";
  const index = options.shaders ? new URL(options.shaders, base) : new URL("shaders.json", directory);
  const decoder = new TextDecoder();
  const files: unknown = JSON.parse(decoder.decode(await read(index.href)));
  if (!Array.isArray(files) || files.length > 8 || files.some((path) => typeof path !== "string" || !path.trim())) {
    throw new TypeError("shaders.json requires an array of up to eight fragment shader paths");
  }
  return Promise.all(
    files.map(async (file: string) => decoder.decode(await read(new URL(file, directory ?? index).href))),
  );
}

/** Apply optional fragment passes to the transparent Cubism canvas. */
export function createModelShaderPasses(gl: WebGL2RenderingContext, fragments: readonly string[]) {
  const programs: WebGLProgram[] = [];
  let texture: WebGLTexture | null = null;
  let vertexArray: WebGLVertexArrayObject | null = null;
  let width = 0;
  let height = 0;

  const dispose = () => {
    for (const program of programs) gl.deleteProgram(program);
    programs.length = 0;
    gl.deleteTexture(texture);
    gl.deleteVertexArray(vertexArray);
    texture = null;
    vertexArray = null;
    width = 0;
    height = 0;
  };
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Cannot allocate a model shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    const error = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Model shader compilation failed: ${error}`);
  };
  const prepare = () => {
    if (texture) return;
    try {
      const vertex = compile(gl.VERTEX_SHADER, vertexSource);
      try {
        for (const [index, source] of fragments.entries()) {
          const fragment = compile(gl.FRAGMENT_SHADER, source);
          try {
            const program = gl.createProgram();
            if (!program) throw new Error("Cannot allocate a model shader program");
            programs.push(program);
            gl.attachShader(program, vertex);
            gl.attachShader(program, fragment);
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
              throw new Error(`Model shader ${index + 1} link failed: ${gl.getProgramInfoLog(program)}`);
            }
          } finally {
            gl.deleteShader(fragment);
          }
        }
      } finally {
        gl.deleteShader(vertex);
      }
      texture = gl.createTexture();
      vertexArray = gl.createVertexArray();
      if (!texture || !vertexArray) throw new Error("Cannot allocate model shader buffers");
    } catch (error) {
      dispose();
      throw error;
    }
  };
  prepare();

  return {
    draw() {
      if (gl.isContextLost()) return;
      prepare();
      const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
      const previousArray = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
      const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
      gl.activeTexture(gl.TEXTURE0);
      const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
      const blend = gl.isEnabled(gl.BLEND);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vertexArray);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      try {
        if (width !== gl.drawingBufferWidth || height !== gl.drawingBufferHeight) {
          width = gl.drawingBufferWidth;
          height = gl.drawingBufferHeight;
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        }
        for (const program of programs) {
          gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
          gl.useProgram(program);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
      } finally {
        if (blend) gl.enable(gl.BLEND);
        gl.useProgram(previousProgram);
        gl.bindVertexArray(previousArray);
        gl.bindTexture(gl.TEXTURE_2D, previousTexture);
        gl.activeTexture(activeTexture);
      }
    },
    dispose,
  };
}
