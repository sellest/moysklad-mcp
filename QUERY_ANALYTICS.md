# query_analytics (3.6.0: orders, documents and positions)

Read-only analytical queries run over **all customer orders** in the selected
interval. Document queries read compact headers only; product queries also read
positions. The server aggregates before sorting/paging. These are order counts,
document totals or ordered items, not shipments/net sales. Sales, inventory and
production datasets are not supported by this release.

First discover actual values:

```json
{"dataset":"orders","operation":"describe"}
```

This returns MoySklad status IDs, product group names/IDs and product attribute
definitions. Categories default to the product's group, taken from MoySklad.
For an explicit category attribute use `category.source="attribute"` with
`attribute_id` or `attribute_name`. No name-based classifier, sleeve inference,
canonical category alias map or manual correction database is maintained.

## City and region rankings: document grain

```json
{
  "dataset":"orders",
  "date_range":{"from":"2026-09-01T00:00:00","to_exclusive":"2026-10-01T00:00:00","timezone":"Europe/Moscow"},
  "dimensions":["order.delivery.city","order.delivery.region"],
  "measures":["orders_count","orders_total_rub"],
  "order_by":{"field":"orders_count","direction":"desc"},
  "limit":100
}
```

`orders_count` counts each selected document once, including documents without
positions and service-only orders. `orders_total_rub` sums **customerorder.sum / 100
once per document**, including delivery/services already included in that total.
It is different from `ordered_revenue`, which sums selected product lines. No
average check is calculated. Money is returned as exact decimal strings.

Geography comes only from `shipmentAddressFull.city` and
`shipmentAddressFull.region`. A region reference may be resolved to its name using
the MoySklad region dictionary. Blank region stays `null` with
`region_status="absent"`; cities, postal codes, free text, customer addresses and
other orders are never used to infer it. An explicit but unresolvable region
reference is counted as unresolved when a region name is required, not as absent.
Different region IDs with the same name remain separate groups.

City values are trimmed only: no spelling correction, case folding, alias matching
or geocoding. Grouping by city alone groups the provided city strings. Add the
region dimension to distinguish explicitly different regions. Blank cities are
excluded from city rankings by default; `include_missing_city=true` enables a null
city group. Missing region is accepted source absence, not an incomplete answer.
For only explicitly populated regions, add this filter:

```json
{"field":"order.delivery.region","op":"is_set","value":true}
```

Geography filters support eq/in/contains plus boolean is_set. Missing fields do not
match eq/in/contains. No full order export/download is required for this calculation.

Document-only dimensions are city, region and `order.channel`; document measures
are `orders_count` and `orders_total_rub`. The planner chooses document grain when
all dimensions/filters/measures are at document level. It rejects geography or
whole-order totals mixed with product/position filters/dimensions/metrics to avoid
silently changing amount semantics or multiplying document totals by position count.
New geography queries default to orders_count; legacy product/channel defaults
remain ordered_quantity. Omitted order_by selects the first requested measure DESC.

Metadata returns `grain="documents"`, `positions_processed=0`, source/eligible/
matched document counts and separate mutually exclusive `excluded` counters for
unposted, cancelled, filter mismatch, missing city, currency, amount and other
unresolved data. `source_missing` counts absent city/region across the whole source;
`missing` counts them after posting/cancellation selection. Unresolved reason
counters can overlap. Confirmed RUB is required only when requesting money; unknown
or unsupported currency/amount excludes that order with a provisional-result
warning. Counts and totals then describe the same resolved subset. Count-only
queries do not exclude orders based on amount/currency.

The snapshot is separately versioned (`schema_version=2`, `grain="documents"`),
contains no positions or full customer/address payloads, and verifies IDs, counts,
headers, sums and geography in a second pass. Old position snapshots cannot be
reused accidentally. Five-minute source reuse also applies across aggregate pages,
dimensions and status policies. If there are more than 100 groups, follow the
aggregate `next_offset`; it does not fetch raw orders into the chat.

## Product and position rankings

Example (replace the category with an actual group value from discovery):

```json
{
  "dataset": "orders",
  "date_range": {
    "from": "2026-08-01T00:00:00",
    "to_exclusive": "2026-10-15T00:00:00",
    "timezone": "Europe/Moscow"
  },
  "filters": [
    {"field":"product.category","op":"eq","value":"Actual category from MoySklad"},
    {"field":"position.net_unit_price_rub","op":"lte","value":4000}
  ],
  "dimensions": ["product", "product.article"],
  "measures": ["ordered_quantity", "ordered_revenue", "orders_count"],
  "order_by": {"field":"ordered_quantity","direction":"desc"},
  "limit": 10
}
```

## Contract and interpretation

- The interval is `[from, to_exclusive)` in an explicit IANA timezone. Local
  timestamps include seconds, without embedded UTC offsets. Invalid, ambiguous
  and nonexistent times are rejected. Maximum interval: 366 elapsed days.
  `MOYSKLAD_REPORT_TIMEZONE` configures the source accounting timezone; its default
  Europe/Moscow is disclosed with a warning until explicitly configured.
- Document filters are `order.state_id` and `order.channel` (IDs). Product filters
  are `product.id`, `product.article`, `product.category`, `product.category_id`,
  `variant.id`, `variant.size`. String fields support eq/in/contains; IDs eq/in.
  `position.net_unit_price_rub` supports numeric eq/gte/lte. Filters are ANDed;
  `in` represents alternatives. Unknown fields/operators and extra keys are rejected.
- Default: posted orders excluding **operator-confirmed cancellation IDs**.
  `include_unposted=true` includes unposted orders. `include_cancelled=true` or an
  explicit `order.state_id` filter overrides cancellation exclusion. Selecting a
  cancelled ID does not implicitly enable unposted orders. Return statuses are not
  equated with cancellations. `stateType=Unsuccessful` is not a cancellation policy.
- `product`/`product_id` combine variants under their parent model. Article and
  size groupings retain product ID in the key, so identical/missing articles do not
  merge different products. `variant` separates assortment IDs; `variant.size`
  groups sizes within each product. Category/channel groupings can combine products.
- Ordered quantity is the sum of selected position quantities. Unique order count
  is counted per aggregate group. Revenue is quantity × price/100 × (1-discount/100)
  for the selected positions, without rounding before price filtering. Decimal
  quantities/revenue are returned as strings to retain precision; order counts are
  integers. No additional VAT conversion is applied.
- In position-level queries, services are excluded. Physical products/variants/bundles must have a confirmed
  piece unit (OKEI 796); other units have explicit exclusion counters, unknown units
  are unresolved. Bundles count as their own item, without component explosion.
- Price/revenue require a confirmed RUB currency; currency conversion is not
  performed. Missing required category, price, identity, size, article, channel,
  quantity, unit or state information produces counters and a provisional result.
  A known false filter excludes a row even if another condition is unknown.
- `source_complete` describes capture completeness; `classification_complete` and
  `answer_complete` describe required data resolution. `data_complete=false` and
  `status=partial` mean the ranking may change when unresolved data is corrected.
  Result paging is separate: `next_offset` can be non-null for a complete dataset.
- Results have deterministic tie-breaking by the internal grouping key. `limit`
  is 1..100; `offset` is 0..10000. An 80 KB inline row budget may shorten a page;
  follow its returned `next_offset`, not a guessed offset.

## Jobs, cache and bounds

Queries use the existing durable report worker even in standalone mode. A call
can return `job_id` immediately; poll `get_report_job` sequentially every three
seconds or slower. Do not restart the same query or fetch order pages in parallel.
`start_report(tool="query_analytics", parameters=...)` is also supported.
Discovery runs directly, independently of the heavy worker.

One global heavy worker, the existing bounded queue and upstream scheduler limit
load. Identical concurrent queries share a job. Finished query results and frozen
source snapshots are reused for up to five minutes. Changing dimensions, filters,
sorting, limit or offset can reuse the source capture; `refresh_source=true`
loads a new capture/catalog. Configuration changes affect the job fingerprint.
There is no incremental update mechanism in this MVP.

Capture verifies counts, offsets, document/position IDs and a second pass of order
headers. Missing pages, duplicates or changed headers abort the report. This is
not a transactional MoySklad snapshot; capture times and catalog version are
returned. Caps: 50,000 documents, 1,000,000 positions, 10,000 positions per order,
10,000 groups, 20,000 hydrated catalog identities, plus existing disk quota.

Jobs survive client disconnection. After process/container restart, unfinished
jobs are recorded as interrupted and must be restarted; automatic checkpoint
resume is deliberately outside this MVP.

Default output contains inline aggregates and never creates a file. Only explicit
`output="file"` creates an export of all aggregate rows, readable through
`read_report_export` with `section="rows"`; no raw customer order export is needed
for an analytical answer. Job progress exposes upstream API counts, phase timings,
source reuse and processed counts; the result contains timings and completeness
metadata. No customer names, addresses or raw order headers are returned.

## Private cancellation reference

Set `MCP_ANALYTICS_ORDER_POLICY_FILE` to a mounted private JSON file:

```json
{
  "default_policy": {
    "cancellation_mapping_confirmed": true,
    "cancelled_state_ids": ["00000000-0000-4000-8000-000000000001"]
  },
  "states": [
    {"id":"00000000-0000-4000-8000-000000000001"},
    {"id":"00000000-0000-4000-8000-000000000002"}
  ]
}
```

The operator obtains IDs from MoySklad metadata and confirms which mean cancelled.
Keep this reference outside Git; never infer cancellations from names/stateType
during a query. Missing cancellation IDs in current metadata cause an explicit
configuration error. Rows with new/unreviewed state IDs make the default-policy
answer unresolved. The file changes access/selection policy only; MoySklad objects
are never modified.
