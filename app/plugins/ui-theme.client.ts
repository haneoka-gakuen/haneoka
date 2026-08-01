export default defineNuxtPlugin({
  name: "ui-theme",
  enforce: "pre",
  setup() {
    useUiTheme();
  },
});
