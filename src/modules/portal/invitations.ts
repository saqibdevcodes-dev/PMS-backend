import argon2 from 'argon2';
import { db, transaction, lock } from '../../database/client.js';
import { found, requireState } from '../../common/errors.js';
import { hash, opaqueToken, encrypt, decrypt } from '../../common/security.js';
import { audit, outbox } from '../../common/operations.js';
import type { Context } from '../../common/context.js';
import { passwordHash } from '../auth/service.js';
import { throttle } from '../../integrations/redis.js';
import { env } from '../../config/env.js';
import { sendEmail } from '../../integrations/notifications.js';
import { emailUser, welcomeUser, webLink } from '../../common/notifications.js';
import { setCustomerProfilePhoto } from './profile-photo.js';

export async function inviteCustomer(ctx: Context, customerId: string) {
  requireState(
    env.SMTP_HOST,
    'EMAIL_NOT_CONFIGURED',
    'Configure email delivery before inviting customers.',
    503,
  );
  return transaction(async (tx) => {
    await lock(tx, 'Customer', customerId);
    const customer = found(
      await tx.customer.findFirst({ where: { id: customerId, projectId: ctx.projectId } }),
    );
    requireState(
      !customer.portalUserId,
      'PORTAL_ALREADY_ACTIVE',
      'This customer already has portal access.',
    );
    const email = customer.email?.trim().toLowerCase();
    requireState(
      email,
      'CUSTOMER_EMAIL_REQUIRED',
      'Save a verified customer email address before inviting them.',
      422,
    );
    const existing = await tx.user.findUnique({ where: { email } });
    requireState(
      !existing || (existing.accountType === 'CUSTOMER' && existing.active),
      'EMAIL_UNAVAILABLE',
      'This email is assigned to a staff or disabled account. Use a separate customer email.',
      409,
    );
    const recent = await tx.customerInvitation.count({
      where: { customerId, createdAt: { gt: new Date(Date.now() - 900000) } },
    });
    requireState(
      recent < 3,
      'INVITATION_THROTTLED',
      'Wait 15 minutes before sending another invitation.',
      429,
    );
    await tx.customerInvitation.updateMany({
      where: { customerId, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const token = opaqueToken();
    const invitation = await tx.customerInvitation.create({
      data: {
        customerId,
        email,
        hash: hash(token),
        expiresAt: new Date(Date.now() + 48 * 3600000),
        createdBy: ctx.actor.id,
      },
    });
    await outbox(tx, 'customer-invitation', {
      invitationId: invitation.id,
      encryptedToken: encrypt(token),
    });
    await audit(tx, ctx, 'customer.portal_invited', customerId);
    return { status: 'PENDING', email, expiresAt: invitation.expiresAt };
  });
}

export async function acceptInvitation(token: string, password: string) {
  requireState(
    await throttle(`portal-invite:${hash(token)}`, 10, 900),
    'INVITATION_THROTTLED',
    'Try again later.',
    429,
  );
  // Hash before the transaction; invitation validity is checked again under the customer lock.
  const nextHash = await passwordHash(password);
  return transaction(async (tx) => {
    const candidate = await tx.customerInvitation.findUnique({ where: { hash: hash(token) } });
    requireState(
      candidate,
      'INVITATION_INVALID',
      'This invitation is invalid or expired. Ask the office for another.',
      400,
    );
    await lock(tx, 'Customer', candidate.customerId);
    const invitation = found(
      await tx.customerInvitation.findUnique({
        where: { id: candidate.id },
        include: { customer: true },
      }),
    );
    requireState(
      !invitation.usedAt &&
        !invitation.revokedAt &&
        invitation.expiresAt > new Date() &&
        !invitation.customer.portalUserId &&
        invitation.customer.email?.trim().toLowerCase() === invitation.email,
      'INVITATION_INVALID',
      'This invitation is invalid or expired. Ask the office for another.',
      400,
    );
    let user = await tx.user.findUnique({ where: { email: invitation.email } });
    if (user) {
      await lock(tx, 'User', user.id);
      user = found(await tx.user.findUnique({ where: { id: user.id } }));
      requireState(
        user.accountType === 'CUSTOMER' &&
          user.active &&
          (await argon2.verify(user.passwordHash, password).catch(() => false)),
        'EXISTING_CUSTOMER_PASSWORD_REQUIRED',
        'If you already have a customer account, enter its current password. Use password recovery if needed.',
        400,
      );
    } else {
      user = await tx.user.create({
        data: {
          email: invitation.email,
          name: invitation.customer.name,
          passwordHash: nextHash,
          accountType: 'CUSTOMER',
        },
      });
      await welcomeUser(tx, user.id);
    }
    await tx.customer.update({
      where: { id: invitation.customerId },
      data: { portalUserId: user.id },
    });
    const photoId = user.photoId ?? invitation.customer.photoId;
    if (photoId) await setCustomerProfilePhoto(tx, user.id, photoId);
    await tx.customerInvitation.update({
      where: { id: invitation.id },
      data: { usedAt: new Date() },
    });
    await tx.customerInvitation.updateMany({
      where: { customerId: invitation.customerId, usedAt: null },
      data: { revokedAt: new Date() },
    });
    await emailUser(
      tx,
      user.id,
      'Your customer portal access is active',
      `Your customer profile has been linked to your account. Sign in to view your property information: ${webLink('/portal/login')}`,
    );
    await audit(
      tx,
      {
        actor: { id: user.id, sessionId: '', accountType: 'CUSTOMER', permissions: new Set() },
        projectId: invitation.customer.projectId,
        requestId: invitation.id,
      },
      'customer.portal_activated',
      invitation.customerId,
    );
    return { activated: true, email: invitation.email };
  });
}

export async function revokeCustomer(ctx: Context, customerId: string) {
  return transaction(async (tx) => {
    await lock(tx, 'Customer', customerId);
    const customer = found(
      await tx.customer.findFirst({ where: { id: customerId, projectId: ctx.projectId } }),
    );
    await tx.customer.update({ where: { id: customerId }, data: { portalUserId: null } });
    await tx.customerInvitation.updateMany({
      where: { customerId, usedAt: null },
      data: { revokedAt: new Date() },
    });
    if (customer.portalUserId) {
      await lock(tx, 'User', customer.portalUserId);
      await tx.session.updateMany({
        where: { userId: customer.portalUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await emailUser(
        tx,
        customer.portalUserId,
        'Your customer portal access has changed',
        'The property office removed portal access for one of your customer profiles and signed out your sessions. Contact the office if you need assistance.',
      );
    }
    await audit(tx, ctx, 'customer.portal_revoked', customerId);
    return { revoked: true };
  });
}

export async function deliverInvitation(
  invitationId: string,
  encryptedToken: string,
  eventId: string,
) {
  const invite = found(
    await db.customerInvitation.findUnique({
      where: { id: invitationId },
      include: { customer: true },
    }),
  );
  if (
    invite.usedAt ||
    invite.revokedAt ||
    invite.expiresAt < new Date() ||
    invite.customer.portalUserId ||
    invite.customer.email?.trim().toLowerCase() !== invite.email
  )
    return;
  const url = new URL('/portal/activate', env.PUBLIC_WEB_URL);
  // Fragments stay out of HTTP request logs and referrers; the activation screen removes it.
  url.hash = `token=${encodeURIComponent(decrypt(encryptedToken))}`;
  await sendEmail(
    invite.email,
    'Your property customer portal invitation',
    `You have been invited to view your property account.\n\n${url}\n\nThis invitation expires in 48 hours. Set your password to activate access. If you already have a customer account, enter its current password. If you were not expecting this invitation, contact the property office.`,
    eventId,
  );
}
