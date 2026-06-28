# Cubism 2 Web runtime evidence

This note records the concrete runtime evidence used by the legacy Live2D
backend. It describes a capability of `@haneoka/story`; it is independent of
any content provider, site, or authoring tool.

## Reference artifact

- File: `public/Core/live2d.min.js`
- SHA-256: `e4ea1f18bdd44b65394ffd5a1bab16982e88757d45134d1bd0737c8a6b3ddd08`
- Size: 129,056 bytes

The file is minified and does not carry a reliable release identifier, so this
package does not infer one. Byte offsets below refer to this exact artifact.

## Whole-model color and opacity

- Around byte `31,435`, `DrawParam.setBaseColor` clamps four inputs and stores
  them in alpha, red, green, blue order.
- Around byte `102,510`, `Live2DModelWebGL.getDrawParam()` returns that public
  WebGL draw-parameter object.
- Around byte `109,995`, the WebGL renderer maps those stored channels to
  `u_baseColor` and multiplies every channel by the drawable's authored
  opacity before drawing.
- Around byte `55,329`, each draw copies the owning part's authored opacity
  into the drawable state. The internal `_$5S/_$Hr/_$VS` fields therefore
  represent model part state, not a stable whole-model alpha API.

`Cubism2Model.draw()` consequently uses
`getDrawParam().setBaseColor(alpha, red, green, blue)`. RGB is premultiplied by
the requested whole-model alpha before the call, matching the runtime's
`ONE, ONE_MINUS_SRC_ALPHA` normal blend path without overwriting authored part
opacity.

## Shared scene pipeline

The backend receives the same camera MVP, target framebuffer, viewport, and
draw-state contract as the Cubism 3 and static-portrait backends. It submits
directly into the character target selected by `AdvPostPipeline`; alpha,
brightness, blur, stage capture, and final post effects remain owned by that
single pipeline. No DOM canvas or extra two-dimensional overlay is created for
legacy models.
