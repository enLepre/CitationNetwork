# Citation Network

Explore references, citing papers and shared foundations around a paper using OpenAlex.

The deployed site is static. `index.html`, `assets/` and their relative paths can be served directly on GitHub Pages, including from a repository subdirectory. No server API key or build service is required. Use an HTTP server locally, rather than opening `index.html` as a file.

## Development

Use Node.js 20 or newer and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`assets/layout.js` is the checked-in bundle of `scripts/layout-entry.js` and d3-force. Rebuild it after changing the layout algorithm. The rest of the JavaScript and CSS is edited directly. Font faces are separate files: browsers load only the subsets and typefaces used on screen.

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

- Render on changes, with at most one scheduled frame. The graph does no SVG work while idle or hidden.
- Calculate the layout with Barnes–Hut repulsion and collision detection in a worker. If workers are unavailable, use short batches that yield to the UI thread.
- Show the direct graph first. Optional co-cited papers load afterward; existing node positions remain fixed.
- Fetch lightweight search records, retrieve references when a paper is selected, and cache responses for 15 minutes in memory and session storage. Failed requests are not cached. Obsolete searches and graph loads are cancelled.
- Keep graph labels at 13 screen pixels (15 for the seed), suppress overlapping labels and labels obscured by other nodes, and refresh them when zoom changes. Full titles remain available through hover, keyboard selection and the details panel.
- Native appearance controls replace the React development builds and runtime Babel compiler.

The OpenAlex API can still be slow or rate limited. Bulk lookups use limited concurrency; transient 429/503 responses are retried with a bounded delay. Optional enrichment failures retain the usable direct graph.

## Third-party software

The local layout bundle contains d3-force, d3-quadtree, d3-dispatch and d3-timer. See `THIRD_PARTY_LICENSES.txt` for their ISC notices. Font license notices are in `assets/fonts/LICENSES.txt`.

## Notebook appearance

The interface uses an academic notebook style: Georgia, warm paper, muted ink, fine rules, a borderless diamond menu for navigation and controls and a symbol-only dark paper switch. Search contains only its title, explanatory text and input; graph headings and filters sit above the drawing; paper details use article typography. Appearance settings persist locally. Georgia needs no font download; optional typefaces load only when selected. Motion follows the browser’s reduced-motion preference.
