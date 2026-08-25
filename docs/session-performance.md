# Session performance contract

The session renderer exposes `window.__sessionPerf()` in development and production.
It returns recent samples, counters, and p50/p95/max summaries.

Telemetry is scoped to the current page lifetime. Summaries use the latest 2,000
samples across all metric names, `recent` contains the latest 100 samples, and
counters are cumulative with no reset API. Reload before measuring one run; for
counters, before/after deltas can also isolate the run.

Targets, not automated checks:

- input event p95: under 50 ms. The current `input_event_ms` telemetry cannot
  validate this target: its Event Timing observer leaves the default 104 ms
  duration threshold instead of requesting 16 ms.
- first stream delta in a coalesced batch to the animation-frame flush p95
  (`first_delta_to_paint_ms`): under 50 ms. This is recorded before subscribers
  are notified and React renders, not after a browser paint.
- transcript React render-duration p95 (`react_transcript_commit_ms`): under 8 ms.
  Despite its name, this records the Profiler's `actualDuration` for every
  transcript mount and update; it neither isolates streaming renders nor
  measures commit work.
- send handler start to the next animation-frame callback for a non-busy
  optimistic send p95 (`send_to_optimistic_paint_ms`): under 50 ms. This is not a
  confirmed browser paint.
- 100-delta/s renderer workload: no `long_task_ms` over 100 ms.

Fixture generators live in
`packages/core/opensession-server/src/frontend/lib/session-performance-fixtures.ts`.
`makeSessionFixture` supports 200, 2,000, and 10,000 entries, and
`makeStreamDeltas` defaults to 100 deltas/s for one second. They are currently
unit-tested only as data generators; there is no runnable renderer harness or
automated enforcement of these targets.

For a scoped run, compare the before/after deltas of `stream_frames_received` and
`stream_paints`. Despite its name, `stream_paints` counts animation-frame-driven
`LiveTurnStore` snapshot publications before React renders, not display paints.
