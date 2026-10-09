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
  if (path.endsWith('/dashboard'))
    return object({
      asOf: { type: 'string', format: 'date-time' },
      currency: str,
      timezone: str,
      inventory: { type: 'object', additionalProperties: num },
      totalInventory: num,
      confirmedBookings: num,
      netSales: ref('Money'),
      verifiedCollections: ref('Money'),
      outstanding: ref('Money'),
      overdue: ref('Money'),
      defaulterCount: num,
      pendingApprovals: num,
      upcomingInstallments: num,
    });
  if (path.endsWith('/reports'))
    return object({
      kind: str,
      summary: { type: 'object', additionalProperties: { type: ['string', 'boolean'] } },
      rows: array({
        type: 'object',
        additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
      }),
      count: num,
      currency: str,
    });
  if (path.endsWith('/exports') || path.endsWith('/generate') || path.includes('/jobs/'))
    return ref('BackgroundJob');
  if (path.endsWith('/reschedule')) return ref('BookingPosition');
  if (path.endsWith('/requests') || path.endsWith('-requests') || path.endsWith('/resubmit'))
    return ref('Approval');
  if (path.endsWith('/recalculate'))
    return object({ cancellation: ref('Cancellation'), approval: ref('Approval') });
  const resources: Record<string, string> = {
    users: 'User',
    roles: 'Role',
    projects: 'Project',
    units: 'Unit',
    customers: 'Customer',
    nominees: 'CustomerNominee',
    contacts: 'CustomerContact',
    reservations: 'Reservation',
    bookings: 'Booking',
    'payment-plans': 'PaymentPlan',
    versions: 'PaymentPlanVersion',
    payments: 'Payment',
    receipts: 'Receipt',
    approvals: 'Approval',
    'approval-policies': 'ApprovalPolicy',
    ndcs: 'Ndc',
    transfers: 'Transfer',
    cancellations: 'Cancellation',
    refunds: 'Refund',
    possessions: 'Possession',
    snags: 'Snag',
    commissions: 'DealerCommission',
    leads: 'Lead',
    'recovery-cases': 'RecoveryCase',
    dealers: 'Dealer',
    allocations: 'DealerAllocation',
    accounts: 'Account',
    'accounting-periods': 'AccountingPeriod',
    journals: 'Journal',
    settings: 'ProjectSetting',
    'bank-accounts': 'BankAccount',
    vendors: 'Vendor',
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
  if (path.endsWith('/activities'))
    return ref(path.includes('/leads/') ? 'LeadActivity' : 'RecoveryActivity');
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
        approval: ref('Approval'),
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
};
