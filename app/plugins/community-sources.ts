import { registerCommunitySources } from "~/features/community/register";

export default defineNuxtPlugin({
  name: "community-sources",
  enforce: "pre",
  setup() {
    registerCommunitySources();
  },
});
