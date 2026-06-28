import { defineComponent, h, type PropType, type VNodeChild } from "vue";
import { parseAdvRichText, type AdvRichTextNode } from "../core/AdvRichText";

function renderNodes(nodes: readonly AdvRichTextNode[], keyPrefix = "rich"): VNodeChild[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    if (node.type === "text") return node.value;
    if (node.type === "break") return h("br", { key });
    if (node.type === "ruby") {
      return h("ruby", { key }, [h("rb", node.base), h("rt", node.annotation)]);
    }
    return h(
      "span",
      {
        key,
        class: "adv-rich-size",
        style: { fontSize: `${node.percent}%` },
      },
      renderNodes(node.children, key),
    );
  });
}

export default defineComponent({
  name: "StoryRichText",
  props: {
    value: {
      type: null as unknown as PropType<unknown>,
      default: "",
    },
  },
  setup(props) {
    return () => renderNodes(parseAdvRichText(props.value));
  },
});
