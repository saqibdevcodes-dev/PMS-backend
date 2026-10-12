import type { Tx } from '../../database/client.js';
import { found } from '../../common/errors.js';

// The portal identity and its linked customer records share one profile photo.
// Callers must authorize the upload or staff customer edit before calling this.
export async function setCustomerProfilePhoto(tx: Tx, userId: string, photoId: string | null) {
  found(await tx.user.findFirst({ where: { id: userId, accountType: 'CUSTOMER' } }));
  await tx.user.update({ where: { id: userId }, data: { photoId } });
  return tx.customer.updateMany({ where: { portalUserId: userId }, data: { photoId } });
}
