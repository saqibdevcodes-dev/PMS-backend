# Business rules and report definitions

## Inventory and ownership

A reservation expires at its stored UTC deadline. Expiry runs each minute and is also checked when a competing reservation arrives. Converting a valid reservation creates a draft booking, claims its unit and generates installments from an immutable plan version. A draft keeps the unit until its controlled cancellation; it does not silently expire after conversion. Unit status cannot be manually changed from a booked, sold or possessed state.

Discount approvals bind an exact requested amount to a unit. Price changes require approval and uncommitted inventory. A confirmed booking cannot be confirmed twice. Full ownership transfers close every current ownership row and create the buyer's effective-dated ownership, retaining previous owners. This version supports full transfers to one buyer and joint ownership at original booking; partial ownership transfers need an additional operation-specific contract.

NDC issuance requires verified identity/documents and no outstanding installments. Issuance has project-configured validity. Transfer completion rechecks NDC validity, dues and verified charges. NDCs are invalidated after transfer. Possession requires a confirmed sold unit, settled dues, an inspection, resolution of every snag and a consumed approval.

## Money and accounting

The API accepts non-negative decimal strings with at most two fractional digits. Positive amounts are required for collections, installment obligations and refunds. NUMERIC(18,2) and Prisma.Decimal preserve cents. All installment percentages must total exactly 100; the final installment receives the rounding remainder. Plan versions do not rewrite existing bookings.

Verification is performed by a different user from the payment recipient. Only CLEARED payments create receipts, allocate oldest due installments first and post accounting entries. Excess payments remain unallocated customer credit. `POST /payments/{id}/allocate-advance` applies that credit to outstanding installments on the same booking, such as obligations reopened by another payment's reversal. It never creates another receipt or journal and repeated requests cannot allocate the same credit twice. Reversal changes the payment state, marks allocations and receipts reversed, and posts an inverse journal in the current open period. It is blocked after finalized transfer, possession or cancellation. A reschedule preserves paid and partially paid rows and replaces only wholly unpaid installments with equal total principal.

Payment verification and advance-allocation responses return allocations in installment due-date order, then installment sequence, with the installment ID as a stable tie-breaker.

Cancellation snapshots cleared collections, the explicit deduction and the refundable balance. Execution refuses a changed collection balance so stale approval amounts cannot be used. Pending payments are rejected, ownership ends and inventory becomes available. Refund requests reserve part of the approved refundable amount; completed and pending refunds together cannot exceed it. Each payout posts a debit to customer advances and a credit to the selected cash/bank asset account.

Dealer commission is calculated once at booking confirmation from that dealer's configured percentage. Settlement requires separate approval. Cancellation before settlement rejects the commission. Cancellation after settlement posts a dealer-recoverable asset against commission expense; it does not pretend the paid cash has returned. Reclaiming this receivable is recorded through approved journals.

Each posted journal has at least two lines, exactly one positive side per line, and equal total debits and credits. PostgreSQL deferred constraints check balance at commit. Journal and line mutation is forbidden, including appending new balanced lines after the journal's original transaction commits. Payment facts cannot be rewritten or deleted, and terminal payment statuses cannot be reopened. Closed accounting periods reject posting. Reversal never edits the original journal. Collection reporting and property revenue recognition are deliberately separate: default collections credit customer advances, and the accounting team posts approved recognition journals according to its policy.

## Reporting

- Inventory counts reflect the current unit status. RESERVED excludes converted, cancelled and expired reservations after expiry processing.
- Net sales is the total value of currently CONFIRMED bookings. Drafts and cancellations are excluded.
- Verified collections is the sum of current CLEARED payments, including amounts received on later-cancelled bookings. It excludes reversed payments. Refunds are reported separately; this KPI is gross receipts, not net cash flow.
- Outstanding is current installment principal less non-reversed allocations on non-cancelled bookings. It excludes obsolete schedule versions and unallocated excess credit.
- Overdue is outstanding on installments past their due date plus project grace days. Ageing uses project local dates, with default buckets 1–30, 31–60, 61–90 and 90+ days.
- Defaulter count counts distinct current customers with overdue obligations. Dashboard cache entries are project/phase scoped and live for at most 15 seconds.
- Trial balance sums all posted debit and credit lines in the selected range, including reversals. Income statement selects revenue and expense accounts. Balance sheet reports cumulative asset, liability and equity balances through the selected end date, with unclosed net earnings folded into the synthetic `CURRENT_EARNINGS` equity row. The response `summary` includes financial totals and, for trial balance and balance sheet, whether the accounting equation balances.
- Daily/monthly collection reports use the project timezone for date boundaries. All events are stored as UTC timestamps. Caller-supplied dates use ISO formats.

Synchronous report responses are limited to 1,000 rows. Background exports support up to 50,000 rows per request; larger portfolios should use date/project partitions or a reporting warehouse. PDF exports render records as readable labeled fields; XLSX exports provide tabular data without executable formulas.

## Approvals and delivery

Approval policies select the highest applicable amount threshold and snapshot its sequential permission levels at request time. A requester cannot approve their own request. One user cannot fill multiple levels. Final business execution checks current state again and consumes the approval atomically. Existing approvals are unaffected by later policy edits.

Critical business events are written into a PostgreSQL outbox in the same transaction as the business change. Dispatch occurs only after commit. Stable BullMQ job IDs prevent duplicate queue insertion. Handlers persist completion in PostgreSQL. External email/SMS/push delivery is at least once; provider implementations should honor the supplied message identifier to deduplicate retries.
