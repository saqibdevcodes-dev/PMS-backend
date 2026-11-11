# Accounting expansion — implementation status

## Delivered in the first implementation

- A separate optional project logo on project creation and editing, plus replacement/removal in Project settings.
- Project branding on receipt previews, printable journal vouchers, member statements, property files and generated PDFs. Projects without custom branding use the existing Etihad artwork. Already-generated files retain their original contents.
- PNG/JPEG artwork up to 5 MiB, private storage, project/member access checks, bounded server-side reads and a project-name fallback when artwork cannot be loaded.
- Sellers and suppliers: contact category (seller, supplier, contractor or multi-role), name, phone, email and address. Existing vendors remain suppliers until recategorised.
- Property purchase drafts with seller, title, location, agreement reference, acquisition date, purchase price and direct acquisition costs. Totals are calculated with decimal arithmetic on the server.
- Review and post a purchase; edit drafts; void a draft or reverse a posted purchase. Posted costs cannot be edited through the API. A changed draft must be reviewed again. Repeated post/void requests do not produce duplicate journals. An agreement reference cannot be reused for the same seller/project, including after voiding; use a new reference for an amended agreement.
- A posting records inventory at acquisition cost, the agreed price as a seller payable, and additional costs as a separate acquisition accrual. It does not record any payment. Balanced journals, locked accounting periods and the existing audit trail apply.
- Printable vouchers include the project's logo, account names, party names, debit/credit totals and reversal references.

## Scope of property purchases

This first purchase workflow is for property acquired for resale or development for sale. It is not the fixed-asset register or investment-property workflow. Acquisition inventory is a separate cost record; it does not automatically create sellable plots/units or allocate cost to existing units.

Only non-recoverable acquisition taxes and directly attributable acquisition costs belong in this breakdown. Recoverable taxes, general administration and selling expenses require their own accounting treatment. This distinction follows the inventory-cost principle in [IAS 2](https://www.ifrs.org/issued-standards/list-of-standards/ias-2-inventories/). This release does not implement net-realisable-value testing, revenue recognition or sale-linked cost-of-sales postings.

The purchase price is credited to **Property seller payables** with the seller on the ledger line. Additional taxes/fees/brokerage are credited to **Other acquisition costs payable** without attributing them to that seller. Both are unpaid accruals, not cash outflows. Future bills and settlements must clear these accruals rather than capitalising the same costs again.

Reserved accounts are created in the selected project on first posting:

| Account code             | Type      | Purpose                                     |
| ------------------------ | --------- | ------------------------------------------- |
| SYS-PROPERTY-INVENTORY   | Asset     | Acquisition cost held as property inventory |
| SYS-SELLER-PAYABLES      | Liability | Agreed property price owed to sellers       |
| SYS-ACQUISITION-ACCRUALS | Liability | Additional direct acquisition costs payable |

## Accounting completion delivered on 11 November 2026

- Chart-of-account categories and parent/child accounts now distinguish sales, purchases, direct and indirect expenses, capital, supplier, customer, asset, liability and other accounts while retaining the unified ledger.
- Supplier payment vouchers support purchase allocation, partial settlement, exact outstanding purchase balances, immutable journals and reversal without treating the payment as a property expense.
- Expenses have a direct navigation entry and can be posted without a property. An optional property/purchase link adds the item to the property financial summary. Every expense explicitly chooses operating-expense or capitalized-cost treatment and an account of the matching type.
- Partners receive dedicated equity accounts automatically. Contributions and withdrawals post through balanced, reversible capital vouchers and partner balances remain separate.
- Supplier statements and property financial summaries expose purchase price, acquisition cost, allocated supplier payments, supplier payable, operating costs, capitalized costs, customer receipts and sale receivables separately.
- The reporting center includes the requested 30 sales, purchase, profit/loss, balance-sheet and other financial report entries, in addition to the existing operational reports and ledgers. Every report reads stored transactions.

The current domain models uniquely identified real-estate properties rather than generic stock-keeping units. Product reports therefore group by property type, and FIFO output preserves specific property cost in acquisition order instead of inventing pooled FIFO layers. Draft bookings/purchases provide sale/purchase order views; completed cancellations and voided purchases provide return views. Tax reporting currently exposes stored non-recoverable acquisition taxes and explicitly states that sales-tax and withholding workflows require future configured tax fields and rules.

## Remaining specialist accounting stages

1. **Supplier bill controls:** due dates independent of the acquisition date, document matching, cheque-clearing states, approval thresholds, purchase credits and formal supplier-return documents. Current partial payments and payable ageing operate against posted property purchases.
2. **Construction operations:** budgets, estimates, purchase orders, material receipts/issues, labour certification, retention and committed-versus-incurred reporting. Current construction costs can be capitalized to a property but do not form a quantity-surveying subsystem.
3. **Tax configuration:** project-specific sales tax, withholding, exemptions, rates and filing periods. The report does not infer jurisdictional tax rules.
4. **Assets and recognition policy:** fixed-asset depreciation/disposals, investment-property measurement and automated sale-linked revenue/cost recognition. Existing ledger postings remain policy-controlled and auditable.

## Rollout

The frontend and backend must be released together. Apply the additive migrations `202610240001_project_branding` and `202610240002_property_purchases` before running the new backend. Preserve the uploads volume so project logos survive rebuilds. These two migrations do not rewrite historical transactions or infer opening purchase balances from selling prices.

On 25 October 2026, the local `pms_1` database was reconciled after its tables and columns had been changed outside migration history. A full backup was saved in the ignored `.runtime` directory. Missing constraints, defaults and the booking scope guard were restored; all 64 application tables retained identical row counts and contents. All nine previously pending migrations were then marked applied after comparing columns, constraints, indexes, functions, triggers and data backfill conditions against a fresh migration replay. This repair applies only to that local database. Check the VPS independently; do not blindly mark its migrations applied.

Use `npm run db:migrate` to apply committed migrations. Use `prisma migrate dev` when intentionally developing a new schema change. Avoid `db push` for this project because it skips the custom SQL constraints, triggers and data backfills. Automated database tests use an isolated database.

VPS deployment from `/var/www/PMS-BE`, using the existing `pms` Compose project:

```bash
docker compose -p pms --profile app build api worker &&
docker compose -p pms --profile app stop api worker &&
docker compose -p pms --profile app run --rm --no-deps api npm run db:migrate &&
docker compose -p pms --profile app up -d --no-deps --force-recreate api worker
```

For a backend started directly with Node on the local machine, apply `npm run db:migrate`, then restart the existing API and worker processes with their normal development commands. A logo or purchase change does not require sending any test emails.
