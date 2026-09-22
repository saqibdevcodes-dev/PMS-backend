import { Prisma } from '@prisma/client';
import type { Tx } from '../database/client.js';
import type { Context } from './context.js';
import { canonical, hash } from './security.js';
import { requireState } from './errors.js';
export const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export async function reference(tx: Tx, prefix: string) {
  const counter = await tx.referenceCounter.upsert({
    where: { prefix },
    create: { prefix, value: 1 },
    update: { value: { increment: 1 } },
  });
  return `${prefix}-${String(counter.value).padStart(8, '0')}`;
}
export async function audit(
  tx: Tx,
  ctx: Context,
  action: string,
  entityId?: string,
  data: unknown = {},
) {
  await tx.auditLog.create({
    data: {
      actorId: ctx.actor.id,
      projectId: ctx.projectId || null,
      requestId: ctx.requestId,
      action,
      entityId,
      data: json(data),
    },
  });
}
export async function outbox(tx: Tx, kind: string, payload: unknown) {
  await tx.outbox.create({ data: { kind, payload: json(payload) } });
}
export async function idempotent<T>(
  tx: Tx,
  ctx: Context,
  operation: string,
  key: string,
  payload: unknown,
  work: () => Promise<T>,
): Promise<T> {
  const scopedOperation = `${ctx.projectId}:${operation}`;
  // Advisory lock serializes first use too, when no idempotency row exists yet.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.actor.id + scopedOperation + key}, 0))`;
  const where = {
    key_actorId_operation: { key, actorId: ctx.actor.id, operation: scopedOperation },
  };
  const existing = await tx.idempotencyRecord.findUnique({ where });
  const requestHash = hash(canonical(payload));
  if (existing) {
    requireState(
      existing.requestHash === requestHash,
      'IDEMPOTENCY_CONFLICT',
      'This key was used with different request data.',
    );
    return existing.response as T;
  }
  const result = await work();
  await tx.idempotencyRecord.create({
    data: {
      key,
      actorId: ctx.actor.id,
      operation: scopedOperation,
      requestHash,
      response: json(result),
    },
  });
  return result;
}
