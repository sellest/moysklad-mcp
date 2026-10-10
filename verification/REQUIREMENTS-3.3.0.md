# System Requirements Document

## MoySklad MCP Server: Reliability and Token Efficiency

**Baseline:** Server version 3.2.0, tested on October 10, 2026.  
**Objective:** Produce accurate sales reports while minimizing the total MCP content passed to the model.

API request cost is outside the optimization objective. API rate limits remain a reliability constraint.

## 1. Current Status

The following capabilities have been verified and must be preserved:

- Compact sales summaries and quantity-only report rows.
- File exports accessible through MCP resources.
- Paginated export reading.
- Separate gross sales, returns, and net quantities.
- Exact price-band aggregation.
- Successful category aggregation with explicit classification overrides.

Observed issues:

- `get_sales_by_size` and `get_sales_by_price` returned HTTP 429 during initial testing.
- A subsequent aggregation succeeded with `MOYSKLAD_RATE_BUCKET=8` and `MOYSKLAD_MAX_CONCURRENT=2`, taking approximately 181 seconds. The underlying cause of the earlier failures remains unconfirmed.
- `search_products(fields="quantity")` still returns expanded folder ownership and other unnecessary metadata.
- Compact product responses contain duplicate identifiers, names, paths, and URLs.
- The current application session retained outdated tool definitions, although a fresh `tools/list` exposed 64 updated tools.

Missing capabilities:

- A direct sales ranking by article.
- A direct sales report by category.
- An article field in compact sales report rows.
- Reuse of the same monthly source snapshot across multiple report requests.

## 2. Priority P0 — Reliability and Correctness

### REQ-01: Handle Rate Limits Reliably

- [ ] Investigate the HTTP 429 failures using request timing and response headers.
- [ ] Coordinate cooldown and request scheduling across concurrent operations within one server process.
- [ ] Account for API-provided retry information and applicable request weights.
- [ ] Document how multiple server processes using the same credentials affect rate limits.
- [ ] Bound retries and return a concise, actionable error when recovery fails.

**Acceptance criteria:**

- Monthly aggregation completes under the supported, documented configuration.
- A simulated 429 causes controlled recovery without an immediate retry burst.
- Exhausted retries never produce a successful or apparently complete partial report.
- Logs contain sufficient diagnostic information without credentials or full business payloads.

### REQ-02: Preserve Exact Accounting and Classification

- [ ] Retain separate `sold`, `returned`, and `net` quantities.
- [ ] Preserve exact decimal prices through discount calculation and band comparison.
- [ ] Keep price boundaries explicitly inclusive or exclusive.
- [ ] Report unresolved categories, sizes, and prices separately.
- [ ] Preserve explicit classification evidence and overrides.
- [ ] State the return-price basis in every relevant report.

**Acceptance criteria:**

- `12500.006` is greater than `12500`; display rounding does not affect classification.
- Overlapping price bands are rejected.
- Included, excluded, outside-band, and unresolved quantities reconcile under documented accounting rules.
- Missing classification data is not silently guessed or discarded.

## 3. Priority P1 — Reduce Content Sent to the Model

### REQ-03: Enforce Compact Field Projection

- [ ] Remove expanded `product_folder` objects from quantity-only responses.
- [ ] Return only the folder identifier and path when required.
- [ ] Define minimal field sets for quantity reports, rankings, and classification.
- [ ] Keep compatibility aliases and full metadata in an explicit detailed mode.

**Acceptance criteria:**

- Quantity-only product responses omit `owner`, `group`, `accountId`, nested metadata, and unnecessary URLs.
- Each entity has one canonical identifier and name in the compact contract.
- `limit ≤ 100` does not unexpectedly introduce expanded folder payloads.
- Tests verify the fields actually emitted, rather than merely checking accepted parameters.

### REQ-04: Add Sales Ranking by Article

- [ ] Implement a compact ranking tool accepting period, organizations, categories, quantity basis, and top-N.
- [ ] Group by the actual `article` field.
- [ ] Combine variant quantities and, where applicable, multiple products sharing an article.
- [ ] Define deterministic tie ordering.
- [ ] Report missing articles separately.
- [ ] Make detailed supporting records available on demand.

**Acceptance criteria:**

- A top-20 request returns 20 ranking rows and concise scope metadata.
- Articles retain leading zeros and their original spelling.
- Articles are never inferred from names or replaced with product codes.
- The model does not need to retrieve the entire catalog to construct the ranking.

### REQ-05: Add Sales by Category

- [ ] Implement category aggregation without artificial size or price restrictions.
- [ ] Return quantity and percentage for each requested category.
- [ ] Include the percentage denominator, quantity basis, exclusions, and unresolved counts.
- [ ] Define how unresolved classifications affect the denominator.

**Acceptance criteria:**

- The requested three-category report returns three rows.
- Percentages use unit quantities rather than product or article counts.
- Gross-sales and net-sales percentages cannot be confused.
- The report does not require broad placeholder price bands.

### REQ-06: Preserve File Export Efficiency

- [ ] Keep large arrays outside inline responses.
- [ ] Preserve accessible MCP resources and paginated export reading.
- [ ] Include export size, expiration, and retrieval instructions once.
- [ ] Verify that result blocks do not duplicate the exported array.
- [ ] Handle expired resources and server restarts with concise errors.

**Acceptance criteria:**

- Large exports return a short summary and accessible resource reference.
- Reading one page returns only that page.
- Completeness and pagination remain explicit.
- Documentation explains that reading an entire resource into model context removes the token-saving benefit.

## 4. Priority P2 — Reduce Repeated Work and Improve Discovery

### REQ-07: Reuse Source Snapshots

- [ ] Reuse one monthly document-and-position snapshot across related reports.
- [ ] Define snapshot freshness, credential scope, organization scope, expiration, and refresh behavior.
- [ ] Keep source caching distinct from catalog-card caching.
- [ ] Avoid enriching irrelevant records where correctness permits.

**Acceptance criteria:**

- Ranking, category, size, and price reports can share a source snapshot.
- Repeated reports avoid unnecessary document downloads and enrichment.
- Responses identify the snapshot used and its freshness.
- Explicit refresh remains available.

### REQ-08: Publish Accurate Tool Definitions

- [ ] Compare runtime `tools/list` with documented schemas and implementation.
- [ ] Include supported output modes, field projections, date formats, and pagination parameters.
- [ ] Investigate stale definitions after server updates.
- [ ] Document the client reconnection procedure if required.

**Acceptance criteria:**

- A fresh connection exposes the implemented tools and parameters.
- Schema tests detect implementation/documentation drift.
- Client caching issues are distinguished from server registration defects.

### REQ-09: Keep Errors and Reconciliation Compact

- [ ] Return short error codes, causes, and corrective actions.
- [ ] Keep verbose diagnostics outside normal MCP responses.
- [ ] Preserve compact reconciliation with bounded mismatch examples.
- [ ] Avoid repeating full sales and profitability reports solely for validation.

**Acceptance criteria:**

- Successful reconciliation returns totals, mismatch counts, and a limited number of examples.
- Errors do not include full requests, API responses, or stack traces by default.
- Additional diagnostics remain available when explicitly requested.

## 5. Regression Fixtures

Use a stable fixture based on the September 2026 snapshot verified on October 10, 2026. Changes in live business data must not be mistaken for regressions.

For standalone gymnastics leotards, all organizations and sizes:

| Category          | Sold | Returned |  Net | Gross-sales share |
| ----------------- | ---: | -------: | ---: | ----------------: |
| Female sleeveless | 1117 |       25 | 1092 |            67.49% |
| Female sleeved    |  166 |       20 |  146 |            10.03% |
| Male              |  372 |        7 |  365 |            22.48% |
| Total             | 1655 |       52 | 1603 |           100.00% |

Additional checks:

- Female ranking leader: article `202-153`, 187 units.
- Female top-20 total: 742 units.
- 203 female products have sales or returns; one has returns only.
- Classification of Quatro 0111-04 requires the recorded photo-based override unless explicit catalog evidence becomes available.
- Sizes 24–46 produce a different male total: 353 sales. Do not interchange this restricted fixture with the all-size report.

## 6. Measurement and Definition of Done

- [ ] Benchmark identical tasks and fixtures before and after each optimization.
- [ ] Measure all MCP content passed to the model, including schemas, result blocks, resource reads, retries, and follow-up requests.
- [ ] Use an appropriate tokenizer where available; label character and byte measurements separately.
- [ ] Measure total content per completed task, alongside execution time and failure rate.
- [ ] Confirm unchanged results, complete pagination, and accessible supporting detail.

Observed reference measurements:

- Quantity-only sales JSON: approximately 67,447 characters.
- Previous financial sales JSON: approximately 129,548 characters.
- Aggregated category response with export reference: approximately 3,511 characters.
- Full category audit export: approximately 1.04 MB.

These are observations, not universal size guarantees or measured token counts.

**Completion requires:** implemented requirements, passing regression tests, documented contracts, a before/after benchmark, and a list of remaining limitations. Mark a task complete only after both implementation and verification.
