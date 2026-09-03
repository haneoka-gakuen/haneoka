import { LitElement, html } from "lit";
import type { Material, Mesh } from "three";

export class ModelPreviewStage extends LitElement {
  static properties = { src: { type: String }, phase: { state: true }, error: { state: true } };
  declare src: string;
  declare phase: "loading" | "ready" | "error";
  declare error: string;
  private generation = 0;
  private disposeRuntime?: () => void;
  constructor() {
    super();
    this.src = "";
    this.phase = "loading";
    this.error = "";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    void this.load();
  }
  disconnectedCallback() {
    this.generation += 1;
    this.disposeRuntime?.();
    this.disposeRuntime = undefined;
    super.disconnectedCallback();
  }
  updated(changed: Map<string, unknown>) {
    if (changed.has("src") && changed.get("src") !== undefined) void this.load();
  }
  private async load() {
    const src = this.src;
    if (!src) return;
    const generation = ++this.generation;
    this.disposeRuntime?.();
    this.disposeRuntime = undefined;
    this.phase = "loading";
    this.error = "";
    await this.updateComplete;
    const host = this.querySelector<HTMLElement>(".model-preview-stage__canvas");
    if (!host || generation !== this.generation) return;
    try {
      const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([
        import("three"),
        import("three/addons/loaders/GLTFLoader.js"),
        import("three/addons/controls/OrbitControls.js"),
      ]);
      if (generation !== this.generation) return;
      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      host.replaceChildren(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 1000);
      camera.position.set(1.8, 1.3, 2.4);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x4d5066, 2.1));
      const key = new THREE.DirectionalLight(0xffffff, 2.4);
      key.position.set(3, 5, 4);
      scene.add(key);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.screenSpacePanning = true;
      const gltf = await new GLTFLoader().loadAsync(src);
      if (generation !== this.generation) {
        renderer.dispose();
        return;
      }
      scene.add(gltf.scene);
      const bounds = new THREE.Box3().setFromObject(gltf.scene);
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      gltf.scene.position.sub(center);
      const radius = Math.max(size.x, size.y, size.z, 0.1) * 0.5;
      const distance = (radius / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))) * 1.35;
      camera.position.set(distance * 0.75, distance * 0.5, distance);
      camera.near = Math.max(0.001, distance / 1000);
      camera.far = Math.max(100, distance * 20);
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.update();
      let frame = 0;
      const mixer = gltf.animations.length ? new THREE.AnimationMixer(gltf.scene) : null;
      gltf.animations.forEach((clip) => mixer?.clipAction(clip).play());
      const resize = () => {
        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(host);
      resize();
      let previousTime = performance.now();
      const render = (time = performance.now()) => {
        mixer?.update(Math.min((time - previousTime) / 1000, 0.05));
        previousTime = time;
        controls.update();
        renderer.render(scene, camera);
        frame = requestAnimationFrame(render);
      };
      render();
      this.disposeRuntime = () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        controls.dispose();
        mixer?.stopAllAction();
        scene.traverse((object) => {
          const mesh = object as Mesh;
          mesh.geometry?.dispose();
          const materials: Material[] = Array.isArray(mesh.material)
            ? mesh.material
            : mesh.material
              ? [mesh.material]
              : [];
          materials.forEach((material) => {
            for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
            material.dispose();
          });
        });
        renderer.dispose();
        renderer.domElement.remove();
      };
      this.phase = "ready";
    } catch (error) {
      this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  render() {
    return html`
      <section class="model-preview-stage">
        <div class="model-preview-stage__canvas"></div>
        ${
          this.phase === "loading"
            ? html`
                <div class="model-preview-stage__state">
                  <md-circular-progress indeterminate></md-circular-progress>
                </div>
              `
            : this.phase === "error"
              ? html`
                  <div class="model-preview-stage__state">
                    <svg class="material-icon" width="36" height="36"><use href="/icons.svg#view_in_ar"></use></svg>
                    <p>${this.error}</p>
                  </div>
                `
              : ""
        }
      </section>
    `;
  }
}
customElements.define("model-preview-stage", ModelPreviewStage);
