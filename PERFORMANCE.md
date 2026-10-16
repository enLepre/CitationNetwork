# Performance verification

Measured 16 October 2026 against the original page at commit `e67f123`.

| Measure | Original | Updated | Reduction |
|---|---:|---:|---:|
| First direct graph | 6.74 s | 1.61 s | 76.1% |
| Full enriched graph | 7.31 s | 2.90 s | 60.3% |
| Cold static asset payload | 3.338 MB | 0.169 MB | 94.9% |
| Idle SVG attribute writes over 500 ms | 45264 | 0 | 100% |
| 500-paper synchronous setup | 5906.9 ms | 47.3 ms | 99.2% |
| 500-paper total layout and display | 6.06 s | 1.26 s | 79.2% |
| 500-paper median hover to next displayed frame | 378.8 ms | 200.3 ms | 47.1% |

## Method

155.0.4283.45 Edge/Chromium; 1440 × 1000 viewport; 4× CPU slowdown; 10 Mbit/s and 40 ms network latency for static assets. Cold-load values are medians of three fresh browser contexts. OpenAlex calls use the same deterministic fixtures for both versions, so these figures do not imply that the external API itself became faster. The 500-paper comparison is one run per version on identical data; hover is the median of nine changes. Payload is uncompressed response-body bytes, including fonts actually used.

The first direct graph excludes optional co-cited enrichment; full readiness includes enrichment and font readiness. The old application waits for enrichment before first display. Synchronous setup measures only the initial JavaScript call; the total measurement includes background computation and display. Browser painting still has a cost: the 500-paper timer probe saw a maximum gap of 346 ms at 4× CPU slowdown, versus 6045 ms originally. These are improvements, not a guarantee of 60 fps for arbitrary graph sizes.

## Readability and functional checks

The fixture overview showed 4 labels originally and 10 after the update, with no overlapping label pairs in the updated overview. Updated labels stay at least 12 screen pixels (14 for the seed), including at different zoom levels. Visual review also covered desktop graphs, mobile search and mobile graph controls.

- Direct graph appears before delayed enrichment; existing paper positions stay fixed.
- Labels remain at least 12 screen pixels and do not overlap at overview or zoom.
- Zero idle SVG mutations.
- Zoom, role filters, keyboard selection, abstract details and dragging.
- Appearance controls, font changes, list view and BibTeX export.
- Reload reuses cached API responses.
- 120-paper density loads correctly.
- Overlapping loads keep the newest seed.
- Mobile search controls fit; graph filters do not overlap the heading.
- Time-sliced layout works without Workers; failed optional lookup preserves direct graph.
- Live OpenAlex paper, network and abstract load successfully.

The live API check returned 180 papers and 1118 edges, with 44 visible labels and 0 overlapping label pairs. The selected paper’s abstract also loaded. Live API data and latency can change.

Run `pnpm test` and `pnpm test:browser` to repeat the checks. Set `RUN_LIVE=1` for the optional real-API check. Raw results and screenshots are generated under `test-results/`.
