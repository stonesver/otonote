# Calculation algorithm optimization

The user approved the ordered approach after the algorithm exploration: reduce exact replay cost, tighten exact-search bounds, then search event rewards using grade reachability. UI work is owned by another branch. Completion includes a full-card-library and full-chart timing audit, not just fixture benchmarks.

## Ordered implementation

1. Preserve native life history semantics while indexing occupied time buckets. Batch ordinary performance orders so one team's skill-free reference is evaluated once per player sample. Retain every order's outcome, probability and trace identity. Native delayed insertion, float32 rollback, healing and conversion remain part of the acceptance gate.
2. Keep exact cardinality matching and disjoint Lawler partitions. Bound ordinary scores using legal pair capabilities and chart timing; compare all improved bounds against independent small-pool exhaustive search before enabling pruning. Expansion follows the previous power ordering; a separate heap tracks the best remaining score bound. This retains short-budget candidate quality while tightening certificates. Preserve cancellation and checkpoints, versioning changed search semantics (`boundVersion: 3`).
3. Add event reward search with explicit badges, event-points and grade objectives, using attainable-grade and reward bounds. First test whether the retained teams already attain the global grade/bonus ceiling, using two exact character-capacitated bonus matchings. Otherwise refine with legal pairing partitions. Default certificates cover the selected reward tuple; expected score remains the display tie-break and is explicitly not certified. `refineScoreTies: true` additionally searches that final tie. Existing expected-score-grade reward semantics remain the default; order-expected rewards are a separate existing calculation and are not silently substituted. Audit challenge power adapters before using score bounds. Cache the challenge spending value table within the calculation job.

## Verification and completion

- A frozen pre-change source snapshot supplies differential results; native evidence supplies arithmetic and late-history tests.
- Small inventories compare optimum values and top results with independent exhaustive enumeration. Bound values must dominate the true optimum for every tested subspace; cancellation/resume must converge.
- The full benchmark records source release and dataset identity, all member/support IDs, all eligible chart IDs, exclusions and unsupported mechanisms. It records cold CPU time, wall time, precision, candidate counts, completion/optimality, and before/after equality. Timeouts or missing charts are reported as incomplete coverage and cannot count as successful all-chart verification.
- Full inventory means the complete rule snapshot for each tested release, with explicit reproducible growth. Full charts means every projected chart matched to that release's Master; completeness is checked against Master IDs. Archived and current-release data are distinguished.
- Initial full-corpus runs cover exact single-team replay, full-library power matching, bounded full-library score searches and event/challenge paths where an event exists. Unbounded score search is additionally measured to completion on small pools; the full-library run reports the remaining gap rather than claiming optimality on budget expiry.

## Progress

- [x] Repository exploration and design approval in chat.
- [x] Replay optimization and native/differential regression gate.
- [x] Exact-search bound optimization and exhaustive regression gate.
- [x] Event search optimization and grade/reward regression gate.
- [x] Full-library, full-chart inventory audit and timing report. See [results](2026-10-10-calculation-algorithms-results.md) and [strict machine report](2026-10-10-calculation-algorithms-benchmarks.json): 700 charts, 233,510 card checks, 174 regression tests, complete baseline/optimized sweeps and serial AB/BA controls. Budget-limited score/challenge searches retain explicit incomplete status.

## Bound and objective contracts

`ordinary-score-bound.mjs` bounds ideal, full-life ordinary scoring. It does not supply a dynamic-player or Gekisou stochastic bound. Pure challenge power/song-context effects are incorporated in the matching weights; note-score and fixed-score adapters are rejected before either bound shortcut runs.

For a subspace, fixed pairs and the required leader contribute their absolute skill magnitudes. Remaining character maxima relax support conflicts, so their sum A bounds every feasible team. For each note and activation position, the envelope permits the best available positive effect profile independently. This relaxation covers every skill order, including all 120 orders used by the exact scorer.

Float32 start/end cancellation is not exact. Let C bound the number of commands, R = 4 × (notes + C + 1) bound replay queries, U = C × R, u = 2^-24 and gamma(n) = n*u/(1-n*u). The envelope includes both repeated state-rounding error and bucket-delta accumulation error. The implementation uses gamma(2U+1) × (1+4A) + (1+gamma(2U+1)) × U × gamma(C) × 2A, followed by the final general/perfect addition margin. It uses the older 1+2A ceiling only when its spare A dominates this error. An unbounded error estimate remains an infinite bound; it must not permit pruning. Directed inflation precedes the native note arithmetic.

When every available pair has the same nonnegative effective skill profile, every feasible pairing has the same command stream at a given power. The maximum-power matching's exact objective is then a valid bound. This avoids replaying all equivalent-skill pairings merely to certify them.

Event reward bounds maximize reward and event-point bonuses independently, then consider every reachable grade. Continuation currency bounds also optimize each currency independently, so non-monotone grade tables and the secondary reward at a smaller CP budget cannot invalidate pruning. Full comparisons use a separate expected-score bound when the chosen grade basis is minimum score. Grade/bonus matching uses power only as an integer lexicographic tie-break; it does not trade away bonus.

At an unconstrained root the pair graph is complete and bonus is additive over cards. For a fixed leader, the exact bonus ceiling is its own bonus plus the four largest other-character member maxima plus the five largest support bonuses. Root candidates and weighted bonus edge matrices are created lazily only when a node actually needs evaluation. Constrained child partitions retain exact matching. A global bonus ceiling combined with reachable-grade bounds can also certify the retained reward tuples before those bonus flows are constructed.

The default event certificate does not claim the highest expected score among equally profitable teams. `certifiedSearch.objective` distinguishes `reward_tuple` from `reward_tuple_and_expected_score`; `scoreTieOptimality` is explicit. The continuation is optimal only over the supplied challenge rows. Searching all songs and finding the best challenge rows remain separate coverage questions.

Ordinary/challenge pairing search retains the existing fixed non-leader slot convention. Skill orders are fully enumerated; the 24 non-leader placements are not expanded by this change. Gekisou random samples, unknown opponents, device timing, growth planning and dynamic-player recommendations retain their existing conditional/practical meanings. An AP-model certificate is not a real-client optimum claim.
