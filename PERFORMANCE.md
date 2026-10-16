# Performance verification

Measured 16 October 2026 after the notebook redesign, against the original page at commit `e67f123`.

| Measure | Original | Updated | Reduction |
|---|---:|---:|---:|
| First direct graph | 9.98 s | 2.34 s | 76.5% |
| Full enriched graph | 10.73 s | 4.36 s | 59.3% |
| Cold static asset payload | 3.338 MB | 0.171 MB | 94.9% |
| Idle SVG attribute writes over 500 ms | 30176 | 0 | 100.0% |
| 500-paper synchronous setup | 8901.7 ms | 78.0 ms | 99.1% |
| 500-paper total layout and display | 9.13 s | 1.41 s | 84.6% |
| 500-paper median hover to next displayed frame | 353.7 ms | 223.0 ms | 37.0% |

## Method

155.0.4283.45 Edge/Chromium; 1440 × 1000 viewport; 4× CPU slowdown; 10 Mbit/s and 40 ms network latency for static assets. Cold-load values are medians of three fresh browser contexts. Identical deterministic OpenAlex fixtures isolate application changes from external API latency. The 500-paper comparison is one run per version on identical data; hover is the median of nine changes. Payload is uncompressed response-body bytes. Georgia is a system font and requires no font downloads; optional web typefaces remain available.

The first graph excludes optional co-cited enrichment; full readiness includes enrichment and font readiness. The old application waits for enrichment before first display. Synchronous setup measures the initial JavaScript call; total layout includes background computation and display. The 500-paper timer probe saw a maximum gap of 555 ms at 4× CPU slowdown, versus 9099 ms originally. Rendering still has a cost; these measurements do not guarantee 60 fps for arbitrary graph sizes.

## Readability and functional checks

The fixture overview showed 4 labels originally and 37 after the update, with zero overlapping pairs. Updated labels stay at least 13 screen pixels (15 for the seed). Placement tries all four sides of a paper before hiding its label. Desktop search, navigation, dark theme, graph, details, and mobile layouts were visually inspected.

- Direct graph appears before delayed enrichment; existing paper positions stay fixed.
- Labels remain at least 13 screen pixels and do not overlap at overview or zoom.
- Zero idle SVG mutations.
- Mouse clicks with slight movement open the correct citing, reference and co-cited details.
- Zoom, role filters, keyboard selection, abstract details and dragging.
- Appearance controls, font changes, list view and BibTeX export.
- Notebook palette, accessible diamond navigation, persisted dark paper, reduced motion and article-style details.
- Reload reuses cached API responses.
- 120-paper density loads correctly.
- Overlapping loads keep the newest seed.
- Mobile search controls fit; graph filters do not overlap the heading.
- Time-sliced layout works without Workers; failed optional lookup preserves direct graph.
- Mouse and touch selection, expanded small-node targets, label clicks, drag offsets and pointer cancellation.
- Keyboard selection keeps navigation and details inside the viewport.

Run `pnpm test` and `pnpm test:browser` to repeat the checks. Set `RUN_LIVE=1` for an optional real-API check. Raw results and screenshots are generated under `test-results/`. Live API data and latency can change.
