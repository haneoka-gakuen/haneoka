# Embed your own story or model

Vega plays original stories from a JavaScript object or a JSON URL. The story describes scenes, dialogue and cues. The embedding site can supply the media from its own URLs.

```html
<div id="story" style="height: 60vh; min-height: 320px"></div>
<button id="play" disabled>Play</button>
<script type="module">
  import { ADV_COMMAND, mountStory } from "https://haneoka.org/embed/vega.js";

  const player = mountStory(document.querySelector("#story"), {
    document: {
      localization: { locales: ["en"], defaultLocale: "en" },
      commands: [
        { command: ADV_COMMAND.Stage, background: { url: "garden" } },
        { command: ADV_COMMAND.Se, seId: 10000001 },
        { command: ADV_COMMAND.Talk, targetName: "Mira", text: "Welcome to the garden." },
      ],
    },
    resources: { garden: "/media/garden.webp" },
    sounds: { 10000001: "/media/bell.ogg" },
  });

  await player.ready;
  const play = document.querySelector("#play");
  play.disabled = false;
  play.onclick = () => player.play();
  window.addEventListener("pagehide", () => player.dispose(), { once: true });
</script>
```

Use `source: "/stories/garden.json"` to load the document on each mount. Relative asset paths resolve against the document directory or the host page for an inline document. Set `assetsBase` to use another directory. The `resources` map accepts URLs and browser `Blob` or `File` objects. For dynamic lookup, `resolveResource(key, context)` can return a resource or let the map and document URL supply it.

`sounds` fills sound slots identified by `bgmId`, `seId`, `voiceIds`, or a sound entry's ID or cue name. Vega keeps the authored cue metadata. An extensionless audio URL can advertise its format with `Content-Type`.

The same document and resource options are available in `mountChart()` and `mountHomeSpot()` for their own document formats. Vega accepts browser-decodable images, audio and video, declared web fonts, static portrait images, Cubism models and Spine JSON or binary skeletons with their atlas and image pages. Cassiopeia accepts its chart documents, soundtrack and visual assets. Home Spot accepts its scene descriptor with GLB environments and Spine characters. Serve cross-origin resources with CORS permission and a matching content type.

## Live2D

```js
import { ModelPlayer } from "https://haneoka.org/embed/vega.js";

const model = await ModelPlayer.create(document.querySelector("#model"), {
  src: "https://example.org/models/hero.zip",
});
if (model.motions.length) model.playMotion(model.motions[0]);
```

Supply a Cubism 3 JSON descriptor with `FileReferences.Moc` and `FileReferences.Textures` and the files they name. Include each declared physics, pose, motion or expression file to use those features. You can serve the descriptor and assets as separate files or put them in a ZIP while preserving their relative paths. A ZIP should contain one `.model3.json` or `model.json` descriptor. PNG and WebP atlases both work. The hosted module provisions the Cubism Web runtime automatically.

In a story, set `models: { hero: "/models/hero.zip" }` and reference it with `characterModelRef: "hero"` on the character command. You can also put portable model descriptors in the story's `characterModels` registry.

The standalone model viewer uses its built-in rendering by default. To apply your own effects, pass `shaders: "/effects/shaders.json"` and optionally `shadersDir: "/effects/glsl/"`. The JSON is an array of GLSL ES 3.00 fragment shader paths, applied in order. Each pass receives `in vec2 v_uv` and `uniform sampler2D u_model` containing the premultiplied RGBA output of the previous pass. Preserve premultiplied alpha when writing the output.

Call `model.dispose()` before replacing the model or removing its container.
