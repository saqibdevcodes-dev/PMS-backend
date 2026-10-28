type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const array = (item: Schema): Schema => ({ type: 'array', items: item });
const object = (properties: Record<string, Schema>): Schema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
});
const str: Schema = { type: 'string' };
const bool: Schema = { type: 'boolean' };
const num: Schema = { type: 'integer' };
const pagination = object({ page: num, limit: num, total: num, totalPages: num });
const paged = (name: string) => object({ items: array(ref(name)), pagination });
const result = (key: string) => object({ [key]: bool });
export function responseSchema(path: string, method: string, hasPagination: boolean): Schema {
  if (path.endsWith('/installments/:id/payment')) return ref('Payment');
  if (path.endsWith('/portal/resend-credentials')) return object({ queued: bool, email: str });
  if (/\/(login|refresh)$/.test(path)) {
    const token = object({
      accessToken: str,
      expiresIn: num,
      sessionId: { type: 'string', format: 'uuid' },
    });
    if (path.includes('/native/'))
      Object.assign(token.properties as object, {
        refreshToken: str,
        refreshExpiresAt: { type: 'string', format: 'date-time' },
      });
    return token;
  }
  if (path === '/auth/me')
    return object({
      id: str,
      name: str,
      email: str,
      accountType: { type: 'string', enum: ['STAFF', 'CUSTOMER'] },
      projects: array(object({ projectId: str })),
      permissions: array(str),
    });
  if (path.includes('/logout')) return result('loggedOut');
  if (path.includes('/forgot-password') || path.includes('/users/:id/reset-password'))
    return object({ message: str });
  if (path.includes('/change-password') || path === '/auth/reset-password')
    return result('changed');
  if (path.includes('/download'))
    return object({ url: { type: 'string', format: 'uri' }, expiresIn: num });
  if (path.endsWith('/revoke-sessions') || method === 'delete') return result('revoked');
  if (path.endsWith('/cancel') || path.endsWith('/withdraw')) return result('cancelled');
  if (path.endsWith('/list-for-sale'))
    return object({ purchase: ref('PropertyPurchase'), unit: ref('Unit') });
  if (path.endsWith('/import')) return object({ imported: num });
  if (path.endsWith('/identity')) return object({ identity: str });
  if (path.endsWith('/access') || path === '/roles/:id') return result('updated');
  if (path.endsWith('/read')) return result('read');
  if (path === '/compatibility')
    return object({
      apiVersion: str,
      minimumClientVersion: str,
      platforms: array(str),
      onlineRequired: bool,
    });
  if (path === '/roles' && method === 'get')
    return object({ roles: array(ref('Role')), permissions: array(str) });
  if (path === '/verify/file/:reference')
    return object({
      valid: bool,
      reference: str,
      verifiedAt: str,
    });
  if (path === '/verify/employee/:id' || path === '/verify/customer/:id')
    return object({
      valid: bool,
      verifiedAt: str,
    });
  if (path.endsWith('/users/:id/documents')) return array(ref('Document'));
  if (path.endsWith('/users/:id/ledger')) {
    if (method === 'post') return ref('EmployeeLedgerEntry');
    return ref('EmployeeLedger');
  }
  if (path.endsWith('/dashboard'))
    return object({
      asOf: { type: 'string', format: 'date-time' },
      currency: str,
      timezone: str,
      totalProjects: num,
      inventory: { type: 'object', additionalProperties: num },
      totalInventory: num,
      availableProperties: num,
      bookedProperties: num,
      soldProperties: num,
      confirmedBookings: num,
      netSales: ref('Money'),
      totalSalesValue: ref('Money'),
      verifiedCollections: ref('Money'),
      totalReceived: ref('Money'),
      outstanding: ref('Money'),
      totalOutstanding: ref('Money'),
      totalReceivables: ref('Money'),
      overdue: ref('Money'),
      overdueInstallments: num,
      defaulterCount: num,
      upcomingInstallments: num,
      upcomingAmount: ref('Money'),
      activeDealers: num,
    });
  if (path.endsWith('/deal-profitability'))
    return object({
      currency: str,
      summary: object({
        totalAcquisitions: num,
        soldCount: num,
        availableCount: num,
        totalBuyPrice: ref('Money'),
        totalExpenses: ref('Money'),
        totalInvestedCost: ref('Money'),
        totalSalesRevenue: ref('Money'),
        totalNetProfit: ref('Money'),
        averageMarginPercent: str,
      }),
      deals: array(
        object({
          id: str,
          reference: str,
          fileReference: str,
          title: str,
          location: str,
          purchaseDate: str,
          status: str,
          seller: object({ id: str, name: str, phone: str }),
          buyPrice: ref('Money'),
          expenses: object({
            taxes: ref('Money'),
            legalFees: ref('Money'),
            brokerage: ref('Money'),
            otherCosts: ref('Money'),
            total: ref('Money'),
          }),
          totalCost: ref('Money'),
          salePrice: { type: ['string', 'null'] },
          collected: ref('Money'),
          netProfit: { type: ['string', 'null'] },
          profitMarginPercent: { type: ['string', 'null'] },
          dealStatus: str,
        }),
      ),
    });
  if (path.endsWith('/reports')) {
    const schema = object({
      kind: str,
      summary: { type: 'object', additionalProperties: { type: ['string', 'boolean'] } },
      rows: array({
        type: 'object',
        additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
      }),
      count: num,
      currency: str,
    });
    (schema.properties as Record<string, Schema>).statement = {
      type: 'object',
      required: ['project', 'customer', 'generatedAt', 'metrics', 'notes', 'sections'],
      properties: {
        project: object({ name: str, currency: str, timezone: str }),
        customer: {
          type: 'object',
          required: ['name', 'reference'],
          properties: {
            name: str,
            reference: str,
            email: { type: ['string', 'null'] },
            phone: { type: ['string', 'null'] },
          },
        },
        generatedAt: { type: 'string', format: 'date-time' },
        reference: str,
        from: str,
        to: str,
        metrics: array({
          type: 'object',
          required: ['label', 'amount'],
          properties: { label: str, amount: ref('Money'), emphasis: bool },
        }),
        notes: array(str),
        sections: array(
          object({
            title: str,
            description: str,
            columns: array({
              type: 'object',
              required: ['key', 'label', 'width'],
              properties: {
                key: str,
                label: str,
                width: num,
                type: { type: 'string', enum: ['money', 'date', 'status'] },
              },
            }),
            rows: array({ type: 'object', additionalProperties: { type: ['string', 'null'] } }),
          }),
        ),
      },
    };
    return schema;
  }
  if (path.endsWith('/exports') || path.endsWith('/generate') || path.includes('/jobs/'))
    return ref('BackgroundJob');
  if (path.endsWith('/reschedule')) return ref('BookingPosition');
  if (path.endsWith('/recalculate')) return object({ cancellation: ref('Cancellation') });
  if (path === '/projects/:projectId/settings') return ref('Project');
  if (method === 'get' && /^\/projects\/:projectId\/(units|customers)(\/:id)?$/.test(path)) {
    const customer = path.includes('/customers');
    const booking = {
      type: 'object',
      properties: {
        id: str,
        reference: str,
        status: str,
        paymentType: str,
        paymentStatus: str,
        total: ref('Money'),
        collected: ref('Money'),
        outstanding: ref('Money'),
        unit: object({ id: str, number: str }),
        customers: array(object({ id: str, name: str })),
      },
    };
    const item = {
      allOf: [
        ref(customer ? 'Customer' : 'Unit'),
        {
          type: 'object',
          properties: { bookings: array(booking), ...(customer ? { paymentStatus: str } : {}) },
        },
      ],
    };
    return hasPagination
      ? {
          ...object({ items: array(item), pagination }),
          properties: {
            items: array(item),
            pagination,
            ...(customer
              ? {
                  groups: object({
                    ALL: num,
                    UNASSIGNED: num,
                    INSTALLMENTS: num,
                    FULLY_PAID: num,
                    PENDING: num,
                  }),
                }
              : {}),
          },
        }
      : item;
  }
  if (path === '/projects/:projectId' && method === 'get')
    return {
      allOf: [
        ref('Project'),
        object({ availableProperties: num, _count: object({ units: num, plans: num }) }),
      ],
    };
  const resources: Record<string, string> = {
    users: 'User',
    roles: 'Role',
    projects: 'Project',
    units: 'Unit',
    customers: 'Customer',
    nominees: 'CustomerNominee',
    contacts: 'CustomerContact',
    bookings: 'Booking',
    'payment-plans': 'PaymentPlan',
    versions: 'PaymentPlanVersion',
    payments: 'Payment',
    receipts: 'Receipt',
    ndcs: 'Ndc',
    transfers: 'Transfer',
    cancellations: 'Cancellation',
    refunds: 'Refund',
    possessions: 'Possession',
    snags: 'Snag',
    'recovery-cases': 'RecoveryCase',
    accounts: 'Account',
    'accounting-periods': 'AccountingPeriod',
    journals: 'Journal',
    settings: 'ProjectSetting',
    'bank-accounts': 'BankAccount',
    vendors: 'Vendor',
    'property-purchases': 'PropertyPurchase',
    audit: 'AuditLog',
    documents: 'Document',
    'document-templates': 'DocumentTemplate',
    notifications: 'Notification',
    devices: 'Device',
    sessions: 'Session',
  };
  const parts = path.split('/').filter((p) => p && !p.startsWith(':'));
  let resource = parts.filter((p) => p in resources).at(-1);
  if (path.endsWith('/reconcile')) return ref('BankReconciliation');
  if (path.endsWith('/activities')) return ref('RecoveryActivity');
  if (path.endsWith('/accounting')) resource = 'settings';
  const model = resources[resource ?? ''];
  if (model) {
    if (
      method === 'post' &&
      ['bookings', 'ndcs', 'transfers', 'cancellations', 'refunds', 'possessions'].includes(
        resource!,
      ) &&
      path.endsWith('/' + resource)
    )
      return object({
        [(
          {
            bookings: 'booking',
            ndcs: 'ndc',
            transfers: 'transfer',
            cancellations: 'cancellation',
            refunds: 'refund',
            possessions: 'possession',
          } as Record<string, string>
        )[resource!]!]: ref(model),
      });
    if (method === 'get' && hasPagination) return paged(model);
    if (method === 'get' && path.endsWith('/' + resource)) return array(ref(model));
    if (model === 'Booking' && method === 'get')
      return { allOf: [ref('Booking'), object({ position: ref('BookingPosition') })] };
    return ref(model);
  }
  throw new Error(`Missing response schema for ${method} ${path}`);
}
export const extraSchemas = {
  BookingPosition: object({
    installments: array({
      allOf: [
        ref('Installment'),
        object({
          paid: ref('Money'),
          outstanding: ref('Money'),
          lateDays: num,
          overdue: ref('Money'),
        }),
      ],
    }),
    collected: ref('Money'),
    unallocated: ref('Money'),
    outstanding: ref('Money'),
    overdue: ref('Money'),
  }),
  EmployeeLedger: object({
    employee: object({
      id: str,
      name: str,
      email: str,
      active: bool,
      roles: array(str),
      createdAt: str,
    }),
    metrics: object({ totalDebit: str, totalCredit: str, balance: str, entryCount: num }),
    entries: array(
      object({
        id: str,
        date: str,
        reference: str,
        type: str,
        description: str,
        debit: str,
        credit: str,
        runningBalance: str,
        paymentMethod: { type: 'string', nullable: true },
        status: str,
        projectId: { type: 'string', nullable: true },
        projectName: { type: 'string', nullable: true },
        createdAt: str,
      }),
    ),
  }),
};
