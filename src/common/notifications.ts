import type { Tx } from '../database/client.js';
import { env } from '../config/env.js';
import { outbox } from './operations.js';
import { found } from './errors.js';

export const webLink = (path = '/') => new URL(path, env.PUBLIC_WEB_URL).toString();

// Persist alongside the triggering change. SMTP is only contacted by the worker.
export async function emailUser(tx: Tx, userId: string, title: string, message: string) {
  const user = found(await tx.user.findUnique({ where: { id: userId } }));
  const notification = await tx.notification.create({
    data: {
      userId,
      channel: 'EMAIL',
      title,
      body: `Hello ${user.name},\n\n${message}\n\nEtihad Real Estate`,
    },
  });
  await outbox(tx, 'notification', { notificationId: notification.id });
  return notification;
}

export async function welcomeUser(tx: Tx, userId: string) {
  const user = found(await tx.user.findUnique({ where: { id: userId } }));
  await emailUser(
    tx,
    userId,
    'Welcome to Etihad Real Estate',
    `Your ${user.accountType === 'CUSTOMER' ? 'customer portal' : 'staff'} account has been created.\n\nSign in: ${webLink(user.accountType === 'CUSTOMER' ? '/portal/login' : '/login')}\n\nUse the password you set or received securely from the office. If you need a new password, request one here: ${webLink('/forgot-password')}\n\nIf you were not expecting this account, contact the property office.`,
  );
}

export async function passwordChangedEmail(tx: Tx, userId: string) {
  await emailUser(
    tx,
    userId,
    'Your password has changed',
    `Your account password was changed at ${new Date().toISOString()} (UTC). All existing sessions have been signed out.\n\nIf you did not make or authorize this change, contact the property office and reset your password immediately: ${webLink('/forgot-password')}`,
  );
}

export async function assignmentEmail(
  tx: Tx,
  userId: string,
  projectId: string,
  title: string,
  description: string,
) {
  const project = found(await tx.project.findUnique({ where: { id: projectId } }));
  await emailUser(
    tx,
    userId,
    title,
    `${description}\n\nProject: ${project.name}\nOpen your dashboard to review the assignment: ${webLink()}`,
  );
}

export async function customerUpdate(tx: Tx, customerId: string, title: string) {
  const customer = found(await tx.customer.findUnique({ where: { id: customerId } }));
  const body = `Hello ${customer.name},\n\n${title}. Sign in to your customer portal to review the update: ${webLink('/portal/login')}\n\nEtihad Real Estate`;
  await tx.notification.create({ data: { customerId, title, body, channel: 'IN_APP' } });
  if (customer.communicationConsent && customer.email) {
    const notification = await tx.notification.create({
      data: { customerId, title, body, channel: 'EMAIL', recipient: customer.email },
    });
    await outbox(tx, 'notification', { notificationId: notification.id });
  }
}
