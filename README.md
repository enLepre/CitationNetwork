# Citation Network

Explore references, citing papers and shared foundations around a paper using OpenAlex.

The deployed site is static. `index.html`, `paper.html`, `graph.html`, `list.html`, and `assets/` and their relative paths can be served directly on GitHub Pages, including from a repository subdirectory. No server API key or build service is required. Use an HTTP server locally, rather than opening `index.html` as a file.

## Development

Use Node.js 20 or newer and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`assets/layout.js` is the checked-in bundle of `scripts/layout-entry.js` and d3-force. Rebuild it after changing the layout algorithm. The rest of the JavaScript and CSS is edited directly. All pages use the system Georgia font; no web font download is required.

## Verification

```sh
pnpm test
pnpm exec playwright install chromium  # not needed when using installed Edge on Windows
pnpm test:browser
```

The browser checks compare the original bundled page at commit `e67f123` with the current site. Keep that commit in the checkout history. They use the same OpenAlex fixtures, three cold browser contexts, a 1440 × 1000 viewport, fourfold CPU slowdown, and a 10 Mbit/s connection with 40 ms latency. Results and screenshots are written under `test-results/` (not committed). The larger-graph comparison uses the same 500-paper network in both versions. API fixtures isolate application changes from fluctuations in OpenAlex latency.

Set `RUN_LIVE=1` to additionally check a real OpenAlex network and abstract. This optional check needs internet access and is excluded from CI.

Coverage includes lightweight searches, record and response caching, cancellation, retry handling, progressive enrichment, stable positions, zoom, filtering, keyboard selection, dragging, appearance, export, reload, density changes, mobile layout and the fallback for browsers without workers.

The selection regression suite also checks clicks with small pointer movements on every paper type, small-node targets at low zoom, clickable labels, drag offsets, pointer cancellation, touch taps and the corresponding details panel. To confirm the original failure, run `SELECTION_BASELINE=1 node tests/selection.cjs` against the pre-fix graph; it should fail at the citing-paper jitter check.

## Performance and readability

- Render on changes, with at most one scheduled frame. A brief damped spring effect settles newly placed nodes and lets up to 48 nearby linked papers respond to a drag. Motion changes only display offsets: the computed layout and dropped position stay intact. Position-only frames reuse node styling and label placement, stop within 1.1 seconds after the last input, and leave no idle SVG work. Reduced motion, hidden/inactive views, and very large networks disable the effect; a 12 ms position-frame budget cuts it short on slower devices.
- Calculate the layout with Barnes–Hut repulsion and collision detection in a worker. If workers are unavailable, use short batches that yield to the UI thread.
- Show the direct graph first. Optional co-cited papers load afterward; existing node positions remain fixed.
- Fetch lightweight search records, retrieve references when a paper is selected, and cache responses for 15 minutes in memory and session storage. Failed requests are not cached. Obsolete searches and graph loads are cancelled.
- Keep graph labels at 13 screen pixels (15 for the seed), suppress overlapping labels and labels obscured by other nodes, and refresh them when zoom changes. Full titles remain available through hover, keyboard selection and the details panel.
- Native appearance controls replace the React development builds and runtime Babel compiler.

The OpenAlex API can still be slow or rate limited. Bulk lookups use limited concurrency; transient 429/503 responses are retried with a bounded delay. Optional enrichment failures retain the usable direct graph.

## Third-party software

The local layout bundle contains d3-force, d3-quadtree, d3-dispatch and d3-timer. See `THIRD_PARTY_LICENSES.txt` for their ISC notices. Font license notices are in `assets/fonts/LICENSES.txt`.

## Pages and navigation

Home (`index.html`) is always the centered Search page and never builds a network from a stored paper or query string. Selecting a result opens `graph.html?seed=…&density=…`. Graph fills the entire workspace below the navigation. Selecting a node opens a non-modal popup with only its title, authors, year, journal and original-source URL; the × button, Escape or clicking the empty graph dismisses it. Paper (`paper.html`) contains the detailed paper information, abstract, citation counts, connections and density/filter controls. It opens the last selected paper in the current network (or the seed by default), without loading the graph renderer. Graph filters persist for the session. List (`list.html`) opens paper summaries beside the table, without loading the graph renderer or worker. Each document contains only its own content. Normal links provide browser Back/Forward behavior; the menu preserves the selected seed and density for Paper/Graph/List while Search always links to Home.

A shared graph URL explicitly points to `graph.html`. OpenAlex response caches remain in session storage so switching between Graph and List avoids repeating the same requests. The separate pages share the Georgia notebook style, centered, always-visible navigation and sun/moon theme toggle. Paper, Graph and List remain separate navigation links, with an underline marking the current page. Theme and Share are icon-only actions. Before a paper is selected, Home hides the page links and Share while reserving their space. Once a paper is selected, Search keeps the same full navigation, remembered paper, density, and sharing action as Graph and List. The header has fixed geometry and its theme is restored before first paint. Supported browsers slide the content horizontally in Search → Paper → Graph → List order using cross-document view transitions while the header stays stationary; Back/Forward use the same spatial order. Reduced-motion settings disable the slide, and other browsers retain normal navigation.


### Adaptive graph loading

New sessions default to Adaptive (density=0); explicit 40/80/120-paper links remain supported.
The incoming-citation API total determines the initial citing-paper budget: all for totals up to
300, 250 for totals from 301 to 2,000, and 300 above that. Larger networks start with the
citation count of the last initially selected citing paper as the minimum filter. References
and up to 60 shared-reference papers are additional to that budget. The threshold stays fixed
while more papers arrive; users can lower it to zero.

Changing the citation range debounces an expansion request. Each request reads at most two
100-record cursor pages within the inclusive range (most cited and newest), then adds at most
100 unseen papers. Eighty places favor shared references beyond the seed, with normalization
for reference-list length, downweighting of common references, and a repeated-group penalty.
Twenty places are reserved for recent candidates. This ranks retrieved candidates rather than
claiming a complete clustering of the unseen literature. Unused candidates and pagination
state are cached. The Load more control continues expansion without an automatic unbounded load.

The histogram describes loaded papers only. The panel distinguishes shown papers, loaded
papers, and loaded/total incoming citations. Equal citation counts can leave matching papers
unloaded initially; they remain accessible through expansion. Failed or cancelled requests
retain the existing graph. Prior positions are preserved when batches are added. Request
availability still depends on OpenAlex limits, and very large manually expanded graphs can
require more rendering time.

Tests: `node --test tests/data.test.cjs`, `node tests/adaptive.cjs`, and
`node tests/citation-filter.cjs`. The latter explicitly uses fixed density to isolate controls;
the adaptive suite covers the default loading policy and incremental UI.

### Research group flags

The flag button enables an experimental view of up to 12 connected groups of at least four loaded papers. Detection uses weighted direct links and shared references, excludes the seed and ubiquitous references, and runs only when enabled. A deterministic local modularity pass forms groups independently of positions and filters; loading more papers recomputes them.

Labels use recurring, distinctive title words and phrases. Hover shows supporting phrases and recurring authors; click or Enter highlights a group. Labels are suggestions, not verified research teams. Abstract fetching and abstract-derived labels are not included in this first version. Flags follow visible group members, remain screen-sized during zoom, avoid one another, and hide when fewer than three members remain visible.

Run `node --test tests/clusters.test.cjs` for grouping and label checks; `node tests/citation-filter.cjs` covers flag toggling, highlighting, and zoom stability alongside existing filters.
