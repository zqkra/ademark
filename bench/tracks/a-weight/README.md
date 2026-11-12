# Track A weight runners

`runners` here are A5 Weigh-in, A6 Idle Burn, A7 Fight Weight, A8 Typing Lag, A9 Ghost Weight and A10 Scale, which
run in the Track A block, plus A12 Leak, which runs in the Track C block after C6 and reads the sampler CSV that
block leaves in `state["C.samples_csv"]`.

The procedure of each runner is TESTS.md §2; the values every row publishes are the ones in that section.
`shared.ts` holds the pure computations (settle slope, CPU/wakeup/energy rates, p95, 5-agents count, leak slope and
interval) and the shared row plumbing.

## Pilot items

These numbers belong to the tests but are not measured by these runners in v1:

- **A5: system-wide footprint delta.** TESTS.md §1.2 also asks for a `sudo footprint --sysFootprint` delta over the
  measurement window. It is a pilot item: the pilot measures it on the reference machine, compares it with the
  per-process sums, and decides whether it becomes a row. The runners write `footprint --unmapped` for the `app`
  group and the WindowServer footprint delta only.
- **A6: package power.** TESTS.md §2 asks for `powermetrics` CPU + GPU power minus the no-app baseline. It is a
  pilot item: the pilot checks that the coalition numbers match the per-process samples within 5 % before it becomes
  a row. The runners publish the sampler's `energy_nj` rate in mW only.
