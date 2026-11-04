# Story creation and community stories

`/{locale}/story-creation/` embeds the production Altair application from
`.generated-public/story-studio/`. AppShell owns the title, account state, save,
publication, and project actions. Altair owns editing, local files, previews,
history, templates, and game packaging. Haneoka receives source, game and tool
download Blobs through the same-origin MessagePort and owns their browser
downloads. The connection negotiates download support; standalone Altair keeps
its own download action. The protocol binds
project operations to the captured project identity.

Project actions occupy the shell's title bar and use its measured overflow
menu when space runs out. The embedded editor fills the content pane; its
panels own scrolling. Host configuration supplies the complete Material roles,
the current font stack and the same local font stylesheets. Interface controls
and Monaco follow subsequent theme, font and language changes.

## Project and publication flow

1. Create a project, import an archive, or open a browser folder. Native source
   documents remain the editable source of truth. Local drafts recover unfinished
   changes; source exports retain their current text.
2. Save a private cloud revision. Files are content-addressed, with a separate
   owner grant. Visual uploads enter the existing media processing and moderation
   pipeline. Public imports retain release-pinned provenance and SHA-256; server
   reuse verifies the downloaded bytes independently. When the public source is
   unavailable or has changed, the captured files follow the normal upload and
   moderation flow.
3. Compile through `project.ts` and the shared Altair Vega projection. Publication
   requires supported commands and plugins plus a complete local resource graph.
   A new private revision leaves the previous public revision readable.
4. Publish publicly or by link. Canonical details live at
   `/{server}/{locale}/community-stories/{id}/`; reading uses the official
   `StoryWorkspace`, including transcript search, speaker filters, voice playback
   and the text/player mode switch. Its Vega stage consumes the authorized
   immutable project and keeps revision-scoped saves. Leaving either reading
   mode releases its media and restores the community detail actions.
   The cover chooser shows the project's images. Uploading a cover adds a
   content-addressed image file to that same project, then uses the normal
   attachment processing and moderation flow when saving. Source exports retain
   the cover file; closing publication releases its temporary image previews.
   Encoded image bytes determine the upload media type and attachment filename;
   source file bytes and source paths remain available in the project archive.
5. Source access and remix grants follow the selected revision's remix setting.
   A remix receives its own asset grants and attribution snapshot. Withdrawal
   removes access to the original; existing recipient grants survive it.
   Grants retain the source revision. Each saved story revision owns its origin
   record, including the source title and author; later remixes keep earlier
   attribution intact. Source archives carry `haneoka.communityOrigin`, and a
   newly created remix resumes through its own local project address.
   Historical edit and remix links carry their selected revision. Historical
   edits open a local workspace and append a new revision when saved. Authors
   can preview withdrawn drafts through the authenticated draft address.

Cloud writes use version checks and durable request receipts. Save, publish,
withdrawal, and deletion retries recover the result of the original request.
Concurrent edits keep their local source and can be saved as a separate project.
Cloud saving commits the project manifest, file references and revision together
after byte uploads complete. An interrupted upload does not advance the saved
revision. Authors can reopen private projects while resources are processing or
blocked; resource review controls publication, not private draft persistence.
Committed revision references protect their assets from idle-upload cleanup.
Old versions, account cleanup, asset leases, and garbage collection belong to
`worker/community-stories.ts`; content transfer and moderation state belong to
`worker/community-story-assets.ts`.

## Import and export

Native archives expose editable `scenes/*.txt` scripts. Internal `.altair/`
maps retain stable node identities, native performances, field locks and cues;
scene caches and the project manifest retain unknown fields. Existing YAML
projects still open. Cloud snapshots and ZIP exports use the same files, and
publication applies the current text before compiling it. Invalid text remains
in the private draft alongside its last valid scene and blocks publication.
WebGAL imports retain source
metadata alongside lowered commands; Bestdori and Sekai share their published
source adapter. A Vega runtime project can restore its authoring snapshot or
import its scene graph as editable source.

Every import is converted to the same Our Notes native project before editing.
Actor coordinates, model framing, stage and effect bindings are stored in the
project. Existing drafts migrate when opened. Automatic and manual direction
are shared editing settings for every story. Source provenance does not select
a renderer or a storage format; publication requires the canonical native form.

Vega game export packages the closed resource graph and the shared player.
Only model runtimes used by the project are required. WebGAL export uses a
selected compiled WebGAL engine and reports differences against that engine's
executable capabilities. Both exporters read the same native authoring project.

## Local development

- `pnpm build:story-studio` builds dependencies and the editor. Use
  `node scripts/build/story-studio.mjs --prepared` after dependency builds.
- `pnpm runtime:cubism:provision` restores the licensed Core files before
  `pnpm prepare:frontend` stages the full frontend, including the editor. Restart
  an already running development server after recreating its public directory.
- `LOCAL_WORKER_ORIGIN` connects Astro to a local Worker.
  `PUBLIC_STORY_RESOURCE_ORIGIN` selects the public resource catalogue origin;
  it does not change the destination of community writes.
- Apply the additive community schema through the repository's existing database
  workflow. New story tables are in migration `0069_community_stories.sql` and
  the complete `schema.sql` snapshot.

The studio build rejects assets above 25 MiB. Typst runtime files are gzip
assets decompressed by the browser. Incremental studio builds retain two prior
asset generations and replace the entry document last; a failed lazy module
load offers editor reload, with project recovery from its local identity.

## Administration and upload scope

Admin content management includes stories alongside charts and playlists. The
current draft and published revision expose their file/scene/command counts,
compilation state and pending/rejected resources. Staff can preview either
revision through the same Vega stage. Every admin runtime and resource request
checks staff access; no private preview URLs become public story URLs. Removal
uses the creation version and the existing operation audit trail, and clears
pending publication so a completed review cannot republish removed content.

New visual uploads use the story scope. Their attachments remain in the media
processing and moderation pipeline, and database guards prevent ordinary posts
and playlist/chart covers from binding those uploads. They are not a public resource collection. Source
bytes are shared by hash with separate owner grants and per-revision references;
media-processing originals and variants retain their existing storage lifecycle.

The administration workspace contains the story asset queue at
`/{locale}/admin/story-assets/`. The overview and navigation count resources
requiring human review. Automatic work has its own queue; both provide a
thumbnail grid, list and table, plus original image/video previews and audio
controls. The default queue contains only items requiring intervention.
Approved and rejected history remains available for reconsideration. Decisions
compare the status and latest decision token, so a stale reviewer cannot replace
a newer decision even if its status has changed back to the same value.

Custom audio and self-contained SVG files retain their exact source bytes.
Imported game HTML remains source text with `nosniff` and a sandboxed CSP;
the community reader executes only the compiled native story.
Migration `0074_story_resource_automatic_checks.sql` adds durable, leased jobs
on the existing moderation queue. Audio goes through Workers AI Whisper with
voice activity detection, then the existing text policy. SVG text uses that
same policy, and a bounded Resvg image uses the existing vision policy. The
jobs store policy, model, reason and content identity; user grants share the
result. Completed visual attachment reviews are also reused by content hash.
Existing manual decisions win over late automatic results.

Automatic audio inputs currently accept up to 16 MiB and SVG up to 1 MiB.
Larger inputs, dynamic/external SVG content, unavailable services or exhausted
model retries enter human review. Story visual uploads also require human
review after exhausted model retries. Manual decisions use version checks,
idempotent receipts and the existing operation audit trail. Approved public
source snapshots and pre-existing resource states retain their provenance.
SVG previews use an image context plus a sandboxed, external-resource-blocking
CSP; source markup is never inserted into the page DOM. See the
[SVG image processing modes](https://www.w3.org/TR/SVG/conform.html#secure-animated-mode).

When remix is enabled, publication checks all source files as well as runtime
resources, so an offered source archive is downloadable under its declared
policy. Deletion enters delayed cleanup for both author and staff removal;
other stories and recipients keep independent grants to shared content.
