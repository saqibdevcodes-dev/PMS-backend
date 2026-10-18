import { randomBytes } from 'node:crypto';
import { db, transaction, lock, type Tx } from '../../database/client.js';
import { audit, outbox } from '../../common/operations.js';
import { found, requireState } from '../../common/errors.js';
import { encrypt, decrypt } from '../../common/security.js';
import { passwordHash } from '../auth/service.js';
import { sendEmail } from '../../integrations/notifications.js';
import { webLink } from '../../common/notifications.js';
import type { Context } from '../../common/context.js';
export const generateCustomerPassword = () => randomBytes(18).toString('base64url') + 'aA7!';
export async function queueCredentials(
  tx: Tx,
  customerId: string,
  password: string,
  issuedAt: Date,
) {
  await outbox(tx, 'customer-credentials', {
    customerId,
    encryptedPassword: encrypt(password),
    issuedAt: issuedAt.toISOString(),
  });
}
export async function resendCredentials(ctx: Context, customerId: string) {
  const password = generateCustomerPassword(),
    nextHash = await passwordHash(password);
  return transaction(async (tx) => {
    await lock(tx, 'Customer', customerId);
    const customer = found(
      await tx.customer.findFirst({ where: { id: customerId, projectId: ctx.projectId } }),
    );
    requireState(
      customer.portalUserId,
      'CREDENTIALS_UNAVAILABLE',
      'This customer has no generated login credentials. Send a portal invitation instead.',
      422,
    );
    await lock(tx, 'User', customer.portalUserId);
    const user = found(await tx.user.findUnique({ where: { id: customer.portalUserId } }));
    requireState(
      user.accountType === 'CUSTOMER' &&
        user.active &&
        user.credentialsIssuedAt &&
        !user.firstLoginAt,
      'CREDENTIALS_ALREADY_USED',
      'Credentials can only be resent to new customers who have not signed in. Use password recovery for an existing account.',
      409,
    );
    requireState(
      user.email === customer.email?.trim().toLowerCase(),
      'CUSTOMER_EMAIL_CHANGED',
      'The customer email no longer matches their login. Review portal access before resending credentials.',
      409,
    );
    requireState(
      user.credentialsIssuedAt < new Date(Date.now() - 60000),
      'CREDENTIALS_THROTTLED',
      'Wait one minute before sending credentials again.',
      429,
    );
    const issuedAt = new Date();
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash: nextHash, credentialsIssuedAt: issuedAt },
    });
    await queueCredentials(tx, customer.id, password, issuedAt);
    await audit(tx, ctx, 'customer.credentials_resent', customer.id);
    return { queued: true, email: user.email };
  });
}
export async function deliverCredentials(
  customerId: string,
  encryptedPassword: string,
  issuedAt: string,
  eventId: string,
) {
  const customer = await db.customer.findUnique({
    where: { id: customerId },
    include: { portalUser: true },
  });
  const user = customer?.portalUser;
  // A newer resend, reset, revoked account, changed address or first login invalidates queued credentials.
  if (
    !customer ||
    !user?.active ||
    user.accountType !== 'CUSTOMER' ||
    user.firstLoginAt ||
    user.credentialsIssuedAt?.toISOString() !== issuedAt ||
    user.email !== customer.email?.trim().toLowerCase()
  )
    return;
  await sendEmail(
    user.email,
    'Your Etihad Real Estate customer login',
    `Hello ${customer.name},\n\nYour customer account is ready.\nCustomer ID: ${customer.reference}\nLogin ID (email): ${user.email}\nInitial password: ${decrypt(encryptedPassword)}\n\nSign in: ${webLink('/portal/login')}\n\nKeep these credentials private. You can change your password from My Account. If you lose this email before your first sign-in, ask the office to resend new credentials; the previous password will stop working. After signing in, use Forgot password to recover access.\n\nEtihad Real Estate`,
    eventId,
  );
}
