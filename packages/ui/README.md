# `@haneoka/ui`

Accessible Vue primitives for dense archives and authoring tools. Components
use semantic CSS variables from `@haneoka/design-tokens`; import that token
stylesheet before `@haneoka/ui/styles.css`.

The package owns controls, focus behavior and component states. Product
navigation, domain copy and data fetching remain in the host application.

`UiIconButton` separates visual density from pointer accessibility. Use
`size="compact" touch-target` for a 32px Material state layer with a 48px hit
area, or the default size with `touch-target` for a 40px state layer in the
same hit area.

Use `collectFocusableElements(root)` for application-owned drawers and sheets.
It applies the package's single focus contract to native controls and Material
Web hosts, excluding hidden, inert, and disabled targets.
