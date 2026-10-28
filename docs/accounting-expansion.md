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

| Account code | Type | Purpose |
| --- | --- | --- |
| SYS-PROPERTY-INVENTORY | Asset | Acquisition cost held as property inventory |
| SYS-SELLER-PAYABLES | Liability | Agreed property price owed to sellers |
| SYS-ACQUISITION-ACCRUALS | Liability | Additional direct acquisition costs payable |

## Next implementation stages

1. **Bills, expenses and payments:** expense categories, supplier bills with due dates and documents, allocation against existing acquisition accruals, cash/bank payment vouchers, cheque clearing, partial settlements, reversals, approval controls and payable ageing.
2. **Capital and commissions:** partner contributions/drawings, financing, reinstated dealer management and commission calculation/approval/payment. Keep buyer receipts separate from capital and revenue.
3. **Construction costing:** project → acquired property/site → building/house → floor → unit; work categories, budgets, estimates, purchase orders, material receipts/issues, labour and contractor bills, retention and cost allocation. Report budget, committed, incurred and paid amounts separately.
4. **Assets and financial completion:** fixed-asset register, depreciation/disposals, appropriate classification of investment properties, sale-linked revenue and cost recognition, inventory valuation, reconciliation and period closing.
5. **Dashboard and reports:** buyers/sellers, available/reserved/sold/remaining plots, receivable/payable ageing, purchase and construction profitability, capital and asset summaries, cash flow, trial balance, balance sheet and profit and loss. Profit and loss and income statement are two names for the same core report; do not build conflicting versions.

Existing buyers, bookings, installments, customer receipts, property availability, journal ledger and base financial reports remain in place. The new purchase postings feed the ledger, but this does not make the wider accounting expansion complete.

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
