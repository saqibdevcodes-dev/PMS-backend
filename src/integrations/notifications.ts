import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { db } from '../database/client.js';
import { found, requireState } from '../common/errors.js';
export async function sendEmail(to: string, subject: string, text: string, messageId: string) {
  requireState(env.SMTP_HOST, 'PROVIDER_NOT_CONFIGURED', 'Email provider is not configured.', 503);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTLS: Boolean(env.SMTP_USER) && !env.SMTP_SECURE,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    disableFileAccess: true,
    disableUrlAccess: true,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
  const escapeHtml = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  await transport.sendMail({
    from: env.SMTP_FROM,
    to,
    subject,
    text,
    html: `<html><body style="margin:0;background:#f4f6fa;font-family:Arial,sans-serif;color:#182337"><div style="max-width:600px;margin:24px auto;padding:28px;background:white;border-radius:12px"><p style="color:#526585;font-weight:bold">ETIHAD REAL ESTATE</p><h1 style="font-size:22px">${escapeHtml(subject)}</h1><div style="font-size:15px;line-height:1.7;white-space:pre-wrap">${escapeHtml(text)}</div></div></body></html>`,
    messageId: `<${messageId}@${new URL(env.PUBLIC_WEB_URL).hostname}>`,
  });
}
export async function webhook(channel: 'SMS' | 'PUSH', payload: unknown) {
  const url = channel === 'SMS' ? env.SMS_WEBHOOK_URL : env.PUSH_WEBHOOK_URL;
  requireState(url, 'PROVIDER_NOT_CONFIGURED', `${channel} provider is not configured.`, 503);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.PROVIDER_TOKEN ?? ''}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  requireState(
    response.ok,
    'PROVIDER_DELIVERY_FAILED',
    'Notification provider rejected the request.',
    503,
  );
}
export async function deliverNotification(id: string, customerRegistration = false) {
  const notification = found(
    await db.notification.findUnique({
      where: { id },
      include: {
        user: { select: { email: true, devices: true } },
        customer: { select: { communicationConsent: true } },
        deliveries: true,
      },
    }),
  );
  if (notification.deliveries.some((d) => d.success)) return;
  // Only the internal customer-welcome outbox event sets this policy. Property updates
  // always use the default and recheck communication consent immediately before sending.
  if (customerRegistration)
    requireState(
      notification.channel === 'EMAIL' && notification.customer,
      'INVALID_NOTIFICATION',
      'A customer registration email is required.',
      400,
    );
  if (
    notification.customer &&
    !notification.customer.communicationConsent &&
    !customerRegistration
  ) {
    await db.notificationDelivery.create({
      data: { notificationId: id, success: false, error: 'Consent withdrawn; delivery skipped.' },
    });
    return;
  }
  try {
    if (notification.channel === 'EMAIL')
      await sendEmail(
        found(notification.recipient ?? notification.user?.email),
        notification.title,
        notification.body,
        notification.id,
      );
    else if (notification.channel === 'SMS')
      await webhook('SMS', {
        to: found(notification.recipient),
        text: notification.body,
        messageId: notification.id,
      });
    else if (notification.channel === 'PUSH') {
      for (const device of found(notification.user).devices.filter((d) => d.pushToken))
        await webhook('PUSH', {
          token: device.pushToken,
          platform: device.platform,
          title: 'PMS update',
          body: 'Open PMS to view your update.',
          messageId: notification.id,
        });
    } else
      requireState(
        notification.channel === 'IN_APP',
        'UNSUPPORTED_CHANNEL',
        'This notification channel is unsupported.',
        422,
      );
    await db.notificationDelivery.create({ data: { notificationId: id, success: true } });
  } catch (error) {
    await db.notificationDelivery.create({
      data: {
        notificationId: id,
        success: false,
        error: 'Delivery failed; provider credentials or availability require attention.',
      },
    });
    throw error;
  }
}
