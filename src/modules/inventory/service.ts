import { UnitStatus } from '@prisma/client';
import { lock, type Tx } from '../../database/client.js';
import type { Context } from '../../common/context.js';
import { found } from '../../common/errors.js';
import { audit } from '../../common/operations.js';
export async function scopedUnit(tx: Tx, ctx: Context, id: string) {
  await lock(tx, 'Unit', id);
  return found(await tx.unit.findFirst({ where: { id, projectId: ctx.projectId } }));
}
export async function unitState(
  tx: Tx,
  ctx: Context,
  id: string,
  status: UnitStatus,
  reason: string,
) {
  const unit = await tx.unit.update({ where: { id }, data: { status } });
  await tx.unitHistory.create({
    data: {
      unitId: id,
      actorId: ctx.actor.id,
      status,
      price: unit.price,
      charges: unit.charges,
      reason,
    },
  });
  await audit(tx, ctx, 'inventory.status_changed', id, { status, reason });
  return unit;
}
