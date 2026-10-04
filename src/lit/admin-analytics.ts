import { init, registerMap, getMap, use, type EChartsType, type ComposeOption } from "echarts/core";
import {
  LineChart,
  BarChart,
  PieChart,
  ScatterChart,
  type LineSeriesOption,
  type BarSeriesOption,
  type PieSeriesOption,
  type ScatterSeriesOption,
} from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  GeoComponent,
  AriaComponent,
  DataZoomComponent,
  type GridComponentOption,
  type TooltipComponentOption,
  type LegendComponentOption,
  type GeoComponentOption,
  type AriaComponentOption,
  type DataZoomComponentOption,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

use([
  LineChart,
  BarChart,
  PieChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  GeoComponent,
  AriaComponent,
  DataZoomComponent,
  CanvasRenderer,
]);
type Option = ComposeOption<
  | LineSeriesOption
  | BarSeriesOption
  | PieSeriesOption
  | ScatterSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | GeoComponentOption
  | AriaComponentOption
  | DataZoomComponentOption
>;
export interface AdminSeriesData {
  from: string;
  to: string;
  timezone: "UTC";
  bucket: "day" | "month";
  series: Array<{ metric: string; basis: string; points: Array<{ bucket: string; count: number }> }>;
  activity?: { historicalSeriesAvailable: boolean };
}
export interface AdminGeoCountry {
  countryCode: string | null;
  count: number;
  usersUrl: string;
}
export interface AdminGeoPoint extends AdminGeoCountry {
  regionCode: string | null;
  city: string | null;
  latitude: number;
  longitude: number;
}
export interface AdminGeoData {
  generatedAt: number;
  coordinatePrecision: number;
  cohort: { role: string; status: string };
  window: { from: number | null; to: number | null };
  totals: { total: number; unknownCountry: number; unknownCoordinates: number; noVisit: number };
  countries: AdminGeoCountry[];
  points: AdminGeoPoint[];
  pointsTruncated: boolean;
}
export interface AdminAnalyticsOptions {
  locale: string;
  labels: Record<string, string>;
  valueLabel: (value: string) => string;
  isCurrent: () => boolean;
  onUsers: (apiUrl: string) => void;
  onPostState: (key: "status" | "moderationStatus", value: string) => void;
  onMapError: () => void;
  onThemeChange: () => void;
}
interface Geometry {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { name: string; label: string; iso2: string | null };
    geometry: unknown;
  }>;
}
const mapName = "haneoka-admin-world-110m";
let publicGeometry: Promise<Geometry> | undefined;
function worldGeometry() {
  publicGeometry ??= fetch("/admin/world-110m.geo.json", { credentials: "omit", cache: "force-cache" })
    .then(async (response) => {
      if (!response.ok) throw new Error("World map unavailable");
      const value = (await response.json()) as Geometry;
      if (value.type !== "FeatureCollection" || !Array.isArray(value.features)) throw new Error("Invalid world map");
      return value;
    })
    .catch((error) => {
      publicGeometry = undefined;
      throw error;
    });
  return publicGeometry;
}
const validCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown) => String(value ?? "").replace(/[{}|]/g, " ");

/** Owns only chart presentation. Geometry is public; all private series and handlers are instance-local. */
export class AdminAnalyticsView {
  private readonly charts = new Map<string, EChartsType>();
  private readonly observer: ResizeObserver;
  private readonly themeObserver: MutationObserver;
  private lastSeries?: AdminSeriesData;
  private lastMetric = "";
  private lastStatistics?: Record<string, unknown>;
  private lastGeo?: AdminGeoData;
  private themeKey = "";
  private disposed = false;
  private countries = new Map<string, AdminGeoCountry>();
  private geo?: AdminGeoData;
  private geometry?: Geometry;
  private mapLoad = 0;
  constructor(
    private readonly root: HTMLElement,
    private options: AdminAnalyticsOptions,
  ) {
    this.observer = new ResizeObserver(() => {
      if (this.current()) this.charts.forEach((chart) => chart.resize());
    });
    this.themeObserver = new MutationObserver(() => {
      if (this.current()) this.options.onThemeChange();
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });
  }
  private current() {
    return !this.disposed && this.root.isConnected && this.options.isCurrent();
  }
  private label(key: string) {
    return this.options.labels[key] || key;
  }
  private count(value: number) {
    return value.toLocaleString(this.options.locale);
  }
  private country(code: string | null) {
    if (!code) return this.label("unknownCountry");
    try {
      return `${new Intl.DisplayNames([this.options.locale], { type: "region" }).of(code) || code} (${code})`;
    } catch {
      return code;
    }
  }
  private colors() {
    const style = getComputedStyle(this.root);
    const color = (name: string, fallback: string) =>
      style.getPropertyValue(`--md-sys-color-${name}`).trim() || fallback;
    return {
      text: color("on-surface", "#1b1b1f"),
      muted: color("on-surface-variant", "#46464f"),
      line: color("outline-variant", "#c7c5d0"),
      surface: color("surface-container-low", "#f6f2f7"),
      palette: [
        color("primary", "#555994"),
        color("tertiary", "#006a7c"),
        color("secondary", "#5b5d72"),
        color("error", "#ba1a1a"),
      ],
      font: style.fontFamily,
    };
  }
  private chart(key: string) {
    if (!this.current()) return undefined;
    const element = this.root.querySelector<HTMLElement>(`[data-admin-chart="${key}"]`);
    if (!element) return undefined;
    let chart = this.charts.get(key);
    if (!chart) {
      chart = init(element, undefined, { renderer: "canvas" });
      this.charts.set(key, chart);
      this.observer.observe(element);
    }
    return chart;
  }
  private base(description: string): Option {
    const colors = this.colors();
    return {
      animation: false,
      color: colors.palette,
      textStyle: { color: colors.text, fontFamily: colors.font },
      aria: { enabled: true, label: { enabled: true, description: text(description) } },
      tooltip: {
        renderMode: "richText",
        confine: true,
        backgroundColor: colors.surface,
        borderColor: colors.line,
        textStyle: { color: colors.text },
      },
    };
  }
  updateOptions(options: AdminAnalyticsOptions) {
    const key = JSON.stringify([options.locale, this.colors()]);
    if (key !== this.themeKey) {
      this.lastSeries = undefined;
      this.lastStatistics = undefined;
      this.lastGeo = undefined;
      this.themeKey = key;
    }
    this.options = options;
  }
  renderSeries(data: AdminSeriesData | null, metric: string) {
    if (!data) {
      this.lastSeries = undefined;
      this.charts.get("trend")?.clear();
      return;
    }
    if (this.lastSeries === data && this.lastMetric === metric) return;
    this.lastSeries = data;
    this.lastMetric = metric;
    const chart = this.chart("trend");
    if (!chart) return;
    const requested = data.series.find((series) => series.metric === metric);
    const rows = requested?.points.filter((point) => typeof point.bucket === "string" && validCount(point.count)) || [];
    const colors = this.colors();
    chart.setOption(
      {
        ...this.base(this.label(metric)),
        grid: { left: 52, right: 20, top: 24, bottom: 68 },
        xAxis: {
          type: "category",
          data: rows.map((point) => point.bucket),
          axisLabel: { color: colors.muted, hideOverlap: true },
          axisLine: { lineStyle: { color: colors.line } },
        },
        yAxis: {
          type: "value",
          minInterval: 1,
          axisLabel: { color: colors.muted },
          splitLine: { lineStyle: { color: colors.line } },
        },
        dataZoom: [
          { type: "inside", start: 0, end: 100 },
          { type: "slider", height: 18, bottom: 12 },
        ],
        tooltip: {
          trigger: "axis",
          renderMode: "richText",
          confine: true,
          formatter: (parameters: unknown) => {
            const p = (Array.isArray(parameters) ? parameters[0] : parameters) as { dataIndex?: number } | undefined;
            const row = rows[p?.dataIndex ?? -1];
            return row ? `${text(row.bucket)} UTC\n${text(this.label(metric))}: ${this.count(row.count)}` : "";
          },
        },
        series: [
          {
            name: this.label(metric),
            type: "line",
            data: rows.map((point) => point.count),
            connectNulls: false,
            symbolSize: 6,
            lineStyle: { width: 2 },
            areaStyle: { opacity: 0.08 },
          },
        ],
      } as Option,
      { notMerge: true },
    );
  }
  renderPartitions(statistics: Record<string, unknown>) {
    if (this.lastStatistics === statistics) return;
    this.lastStatistics = statistics;
    for (const [key, field, kind] of [
      ["users", "profiles", "user"],
      ["content", "postStatus", "status"],
      ["moderation", "postModeration", "moderationStatus"],
    ] as const) {
      const chart = this.chart(key);
      if (!chart) continue;
      const record = statistics[field];
      const entries =
        record && typeof record === "object" && !Array.isArray(record)
          ? Object.entries(record).filter((entry): entry is [string, number] => validCount(entry[1]))
          : [];
      const data = entries.map(([state, value]) => ({ name: this.options.valueLabel(state), value, state }));
      const colors = this.colors();
      chart.setOption(
        {
          ...this.base(this.label(`${key}Partition`)),
          legend: { bottom: 0, type: "scroll", textStyle: { color: colors.muted } },
          tooltip: {
            renderMode: "richText",
            confine: true,
            formatter: (parameter: unknown) => {
              const p = parameter as { data?: { name: string; value: number } };
              return p.data ? `${text(p.data.name)}: ${this.count(p.data.value)}` : "";
            },
          },
          series: [
            {
              name: this.label(`${key}Partition`),
              type: "pie",
              stillShowZeroSum: false,
              radius: ["42%", "67%"],
              center: ["50%", "44%"],
              data,
              avoidLabelOverlap: true,
              label: { show: false },
              emphasis: { label: { show: true, color: colors.text, fontSize: 14 } },
              itemStyle: { borderWidth: 2, borderColor: colors.surface },
            },
          ],
        } as Option,
        { notMerge: true },
      );
      chart.off("click");
      chart.on("click", (parameter) => {
        if (!this.current()) return;
        const state = (parameter.data as { state?: unknown } | undefined)?.state;
        if (typeof state !== "string") return;
        if (kind === "user" && ["active", "suspended", "deleted"].includes(state))
          this.options.onUsers(`/api/v1/admin/users?status=${encodeURIComponent(state)}`);
        else if (kind !== "user") this.options.onPostState(kind, state);
      });
    }
  }
  renderCountries(data: AdminGeoData | null) {
    if (!this.current()) return;
    if (!data) {
      ++this.mapLoad;
      this.geo = undefined;
      this.lastGeo = undefined;
      this.countries.clear();
      this.charts.get("map")?.off("click");
      this.charts.get("map")?.clear();
      this.charts.get("countries")?.off("click");
      this.charts.get("countries")?.clear();
      return;
    }
    if (this.lastGeo === data) return;
    this.lastGeo = data;
    this.geo = data;
    this.countries = new Map(
      data.countries
        .filter((row) => typeof row.countryCode === "string" && validCount(row.count))
        .map((row) => [row.countryCode!, row]),
    );
    const chart = this.chart("countries");
    if (chart) {
      const rows = data.countries.filter((row) => validCount(row.count));
      const colors = this.colors();
      chart.setOption(
        {
          ...this.base(this.label("countries")),
          grid: { left: 12, right: 36, top: 16, bottom: 24, containLabel: true },
          xAxis: {
            type: "value",
            minInterval: 1,
            splitNumber: 2,
            axisLabel: { color: colors.muted, hideOverlap: true },
            splitLine: { lineStyle: { color: colors.line } },
          },
          yAxis: {
            type: "category",
            inverse: true,
            data: rows.map((row) => this.country(row.countryCode)),
            axisLabel: { color: colors.text, width: 150, overflow: "truncate" },
            axisLine: { show: false },
            axisTick: { show: false },
          },
          dataZoom:
            rows.length > 10
              ? [
                  { type: "slider", yAxisIndex: 0, right: 0, width: 14, startValue: 0, endValue: 9 },
                  { type: "inside", yAxisIndex: 0, zoomOnMouseWheel: false, moveOnMouseWheel: true },
                ]
              : [],
          tooltip: {
            renderMode: "richText",
            confine: true,
            formatter: (parameter: unknown) => {
              const row = rows[(parameter as { dataIndex: number }).dataIndex];
              return row ? `${text(this.country(row.countryCode))}: ${this.count(row.count)}` : "";
            },
          },
          series: [{ type: "bar", data: rows.map((row) => row.count), barMaxWidth: 22 }],
        } as Option,
        { notMerge: true },
      );
      chart.off("click");
      chart.on("click", (parameter) => {
        if (this.current()) {
          const row = rows[parameter.dataIndex];
          if (row) this.options.onUsers(row.usersUrl);
        }
      });
    }
    const load = ++this.mapLoad;
    void worldGeometry()
      .then((geometry) => {
        if (!this.current() || load !== this.mapLoad) return;
        this.geometry = geometry;
        if (!getMap(mapName)) registerMap(mapName, geometry as Parameters<typeof registerMap>[1]);
        this.renderMap();
      })
      .catch(() => {
        if (this.current() && load === this.mapLoad) this.options.onMapError();
      });
  }
  private renderMap() {
    const data = this.geo,
      geometry = this.geometry,
      chart = this.chart("map");
    if (!data || !geometry || !chart || !this.current()) return;
    const colors = this.colors();
    const labels = new Map(geometry.features.map((feature) => [feature.properties.name, feature.properties.label]));
    const points = data.points
      .filter(
        (point) =>
          validCount(point.count) &&
          point.count > 0 &&
          Number.isFinite(point.latitude) &&
          Number.isFinite(point.longitude) &&
          Math.abs(point.latitude) <= 90 &&
          Math.abs(point.longitude) <= 180,
      )
      .map((point) => ({
        ...point,
        name: [this.country(point.countryCode), point.regionCode, point.city].filter(Boolean).join(" · "),
        value: [point.longitude, point.latitude, point.count],
      }));
    chart.setOption(
      {
        ...this.base(this.label("map")),
        geo: {
          map: mapName,
          roam: true,
          selectedMode: "single",
          scaleLimit: { min: 1, max: 12 },
          left: "2%",
          right: "2%",
          top: "5%",
          bottom: "5%",
          preserveAspect: "contain",
          itemStyle: { areaColor: colors.surface, borderColor: colors.line, borderWidth: 0.7 },
          emphasis: { itemStyle: { areaColor: colors.palette[1] }, label: { show: false } },
          select: { itemStyle: { areaColor: colors.palette[1] }, label: { show: false } },
          tooltip: { show: true },
        },
        tooltip: {
          renderMode: "richText",
          confine: true,
          formatter: (parameter: unknown) => {
            const p = parameter as { name?: string; data?: AdminGeoPoint; seriesType?: string };
            if (p.seriesType === "scatter" && p.data)
              return `${text(this.country(p.data.countryCode))}\n${text([p.data.regionCode, p.data.city].filter(Boolean).join(" · "))}\n${this.label("usersCount")}: ${this.count(p.data.count)}\n${p.data.latitude.toFixed(1)}, ${p.data.longitude.toFixed(1)}\n${this.label("approximate")}`;
            const code = p.name || "",
              row = this.countries.get(code);
            return `${text(/^[A-Z]{2}$/.test(code) ? this.country(code) : labels.get(code) || code)}\n${this.label("usersCount")}: ${row ? this.count(row.count) : /^[A-Z]{2}$/.test(code) ? "0" : "—"}`;
          },
        },
        series: [
          {
            name: this.label("usersCount"),
            type: "scatter",
            coordinateSystem: "geo",
            data: points,
            symbolSize: (value: unknown) => Math.min(30, 7 + Math.sqrt(Number((value as number[])[2])) * 2),
            itemStyle: { color: colors.palette[0], opacity: 0.8 },
            emphasis: { scale: 1.25 },
          },
        ],
      } as Option,
      { notMerge: true },
    );
    chart.off("click");
    chart.on("click", (parameter) => {
      if (!this.current()) return;
      const row =
        parameter.seriesType === "scatter" ? (parameter.data as AdminGeoPoint) : this.countries.get(parameter.name);
      if (row) this.options.onUsers(row.usersUrl);
    });
  }
  retryMap() {
    if (this.current() && this.geo) {
      this.lastGeo = undefined;
      this.renderCountries(this.geo);
    }
  }
  zoomMap(factor: number) {
    const chart = this.charts.get("map");
    if (!this.current() || !chart) return;
    const geo = (chart.getOption()?.geo as Array<{ map?: string; zoom?: number }> | undefined)?.[0];
    if (!geo?.map) return;
    chart.setOption({ geo: { zoom: Math.max(1, Math.min(12, (geo.zoom || 1) * factor)) } });
  }
  resetMap() {
    const chart = this.charts.get("map");
    if (!this.current() || !chart) return;
    const geo = (chart.getOption()?.geo as Array<{ map?: string }> | undefined)?.[0];
    if (!geo?.map) return;
    chart.setOption({ geo: { center: null, zoom: 1 } });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    ++this.mapLoad;
    this.observer.disconnect();
    this.themeObserver.disconnect();
    this.lastSeries = undefined;
    this.lastStatistics = undefined;
    this.lastGeo = undefined;
    this.charts.forEach((chart) => {
      chart.off();
      chart.clear();
      chart.dispose();
    });
    this.charts.clear();
    this.countries.clear();
    this.geo = undefined;
    this.geometry = undefined;
    this.root.querySelectorAll<HTMLElement>("[data-admin-chart]").forEach((element) => {
      element.replaceChildren();
      element.removeAttribute("aria-label");
    });
  }
}
