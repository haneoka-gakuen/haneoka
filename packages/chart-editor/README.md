# `@haneoka/chart-editor`

Framework-neutral chart-authoring core with project models, timing, validation,
undo history, waveform analysis, viewport helpers, and format adapters.

Supported formats:

| Format | Import | Export |
| --- | --- | --- |
| Haneoka Project JSON | Yes | Yes |
| SS JSON | Yes | Yes |
| Universal Sekai Chart | Yes | Yes |
| SUS | Yes | Yes |
| MMWS / CCMMWS / UCMMWS | Native-compatible features | CCMMWS v6 |
| Sonolus `LevelData` | Detect only | No |

```ts
import { importChart, serializeProjectJson } from "@haneoka/chart-editor/formats";
import { validateProject } from "@haneoka/chart-editor/validation";

const { project, warnings } = importChart(sourceText);
if (validateProject(project).valid) {
  const saved = serializeProjectJson(project);
}
```

Timing uses 480 integer ticks per quarter-note beat. `parseBeatTick` accepts
beat decimals and sums of fractions such as `75+1/480`, rejecting positions
between ticks. The site names subdivisions per whole note: `1/1920` is one
tick, while the authoring helpers retain per-beat defaults and accept
`4` as their final `beatsPerUnit` argument for whole-note grids. Snapping,
selection nudging, and generated line points share the same grid basis.
`compressChartSelection` packs distinct selected times into consecutive ticks,
preserving simultaneous notes and rejecting connector reordering across
unselected points. `pasteAuthorSelection` accepts an optional horizontal
lane shift; the host can stage its returned project before committing it.
`copyAuthorSegments` copies spans of at least two selected connector points,
resolving new automatic endpoints against the unchanged source.
`mirrorAuthorClipboard` reflects lanes, flick directions and both easing edges
while retaining automatic controls and clipboard provenance.
`splitNoteLine` creates two connectors at one interior control; `joinNoteLines`
joins selected tail/head pairs of the same kind, merging coincident boundaries.
`repeatLinePattern` repeats a selected path of at least three controls forward
inside its connector while keeping the authored tail. `lineTraces` samples a
connector at the requested whole-note division, optionally keeping the source.
The host may provide its native curve sampler. Both generators retain ownership
and limit each transaction to 100,000 generated notes.
`interpolateChartTimeScales` fills intervals between selected speed events on
the whole-note grid, updating existing events at generated ticks.
Structural edits retain group/layer ownership and source records. Different forced note
speeds reject the join. The host may supply native resolved geometry for a split.
`resizeChartSelectionByDelta` applies one width delta to the selection while
keeping each note's opposite edge fixed and retaining width differences.
Stage bounds limit the whole group; automatic points resolve from the unchanged
source before resizing. The host provides its lane grid for boundary clamping.
`insertLinePoint` inserts a single visible, hidden or automatic middle control,
preserving endpoints, same-tick controls and connector group/layer ownership.
`setLinePointMode` changes selected interior controls using their resolved source
geometry. Automatic controls keep the authored interpolation marker.

SEKAI imports use the same Our Notes project and renderer. SUS text assets may use
`.sus` or `.txt`; USC accepts legacy connections and the v2 `guide`, `judgeType`
and compatible `timeScaleGroup` forms. Uniform group timelines become the native
global speed timeline; group membership remains editable. Independent group
speed timelines, stopped/reversed visual time and engine-specific stage effects
are outside the current Our Notes conversion and are not flattened into a false
equivalent. In-Out and Out-In curves use two native quadratic segments with a
hidden midpoint; sub-tick midpoints are reported. Import warnings retain the
existing conversion diagnostics for non-spatial attached controls.

| Converted feature | Our Notes editing and playback |
| --- | --- |
| Tap, three flick directions, Trace, critical notes | Native note types and original artwork |
| Holds, guides, variable widths and left/right curves | Editable nodes and native connector geometry |
| Hidden and automatic nodes | Existing visibility and interpolation modes |
| BPM, meter, audio offset and positive global speed changes | Shared timeline and media clock |
| Fixed speed groups and layer visibility | Native source-ID visual profiles and collection controls |
| Skill, FEVER and CALL markers | Existing native event editing |

Project JSON and project backups retain the complete converted project. Raw SS,
SUS and USC exports keep their existing format-specific diagnostics; selecting a
format does not make it carry fields absent from that format.

Project JSON optionally carries `waypoints` with stable IDs, names and integer
ticks. Older projects without waypoints remain valid. These author navigation
markers are separate from gameplay skill, fever and call events.

SUS export retains integer ticks, BPM, measure-boundary meters, speed changes,
skills and FEVER ranges. It rejects fractional SUS lane geometry and asymmetric
easing instead of rounding. Conversion diagnostics identify omitted CALL rhythms,
waypoints and resolved automatic controls.

MMW project import accepts MMWS 1–4, CCMMWS 1–6 and UCMMWS 1–4.
The adapter reads binary data directly and retains layers, waypoints, skills and
FEVER. Incompatible gameplay extensions reject the import. CCMMWS v6 export
retains fractional geometry using the format's float32 precision; its diagnostics
identify unsupported groups and CALL rhythms. Referenced media paths are metadata
and are never opened by the adapter. The binary layout follows the upstream
[CC serializer](https://github.com/GuanYixuan/MikuMikuWorld4CC/blob/1abf551c05ec889bd51443536cf2e62068952f2e/MikuMikuWorld/Score.cpp)
and [UC serializer](https://github.com/UntitledCharts/MikuMikuWorld4UC/blob/917f155b4343ebb4aa7dac0c482256e9b8db5a35/MikuMikuWorld/NativeScoreSerializer.cpp).

The host provides the user interface, files, storage, and audio decoding.
Conversion warnings must be shown to the user.

Authoring keeps single notes and line endpoints entirely within the stage.
Interior line points may extend outside it while retaining positive overlap;
zero-width markers stay within the closed stage boundaries. Group movement
preserves relative spacing. Imported geometry is retained until its span or
endpoint role changes.

```sh
pnpm --filter @haneoka/chart-editor typecheck
pnpm --filter @haneoka/chart-editor build
```

Licensed under [MPL-2.0](LICENSE). Preserve the included Next-SEKAI license
notices when redistributing adapted files.
