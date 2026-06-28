export interface CompositeEntityVisual {
  image?: string;
  /** Ordered fallbacks; renderers advance when an earlier source fails. */
  imageCandidates?: string[];
  text?: string;
  lang?: string;
  icon?: string;
  fit?: "contain" | "cover";
  color?: string;
}
