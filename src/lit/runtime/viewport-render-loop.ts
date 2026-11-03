// L3 — GEB
// Input: 媒体宿主、绘制回调、显式重绘与页面／视口可见性。
// Output: 可见时按需或连续绘制的动画帧。
// Pos: [Map](L2-2.md)；模型舞台的共用渲染生命周期。
// Effects/Dependencies: 持有 IntersectionObserver、visibilitychange 和至多一个待执行动画帧；dispose 释放全部订阅。
export class ViewportRenderLoop {
  private frame = 0;
  private visible = true;
  private disposed = false;
  private observer?: IntersectionObserver;
  private readonly document: Document;

  constructor(host: HTMLElement, private readonly paint: (time: number) => boolean) {
    this.document = host.ownerDocument;
    this.document.addEventListener("visibilitychange", this.visibilityChanged);
    if (typeof IntersectionObserver !== "undefined") {
      this.observer = new IntersectionObserver(([entry]) => {
        this.visible = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
        this.visibilityChanged();
      });
      this.observer.observe(host);
    }
    this.request();
  }

  request = () => {
    if (this.disposed || this.frame || !this.visible || this.document.hidden) return;
    this.frame = requestAnimationFrame(this.tick);
  };

  private readonly tick = (time: number) => {
    this.frame = 0;
    if (!this.disposed && this.visible && !this.document.hidden && this.paint(time)) this.request();
  };

  private readonly visibilityChanged = () => {
    if (this.visible && !this.document.hidden) this.request();
    else {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.observer?.disconnect();
    this.document.removeEventListener("visibilitychange", this.visibilityChanged);
  }
}
