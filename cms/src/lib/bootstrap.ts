import type { Payload } from 'payload';
import type { CmsEnv } from '../env';
import { INTERNAL_CONTEXT } from '../access';

export function localFirstUserEnabled(env: CmsEnv): boolean {
  return !env.building && env.nodeEnv !== 'production' && env.databaseKind === 'sqlite' && !env.bootstrapAdmin;
}

export async function bootstrapAdmin(payload: Payload, env: CmsEnv): Promise<void> {
  if (env.building) return;
  const admins = await payload.count({ collection: 'users', where: { role: { equals: 'admin' } }, overrideAccess: true });
  if (admins.totalDocs > 0) return;
  const users = await payload.count({ collection: 'users', overrideAccess: true });
  if (!env.bootstrapAdmin) {
    if (env.nodeEnv === 'production') throw new Error(`${users.totalDocs > 0 ? 'CMS has users but no administrator' : 'Empty production CMS'}. Set CMS_ADMIN_EMAIL and CMS_ADMIN_PASSWORD for controlled bootstrap recovery. First-user registration is disabled.`);
    return;
  }
  const matching = await payload.find({ collection: 'users', where: { email: { equals: env.bootstrapAdmin.email } }, limit: 1, depth: 0, overrideAccess: true });
  if (matching.docs[0]) {
    await payload.update({ collection: 'users', id: matching.docs[0].id, data: { password: env.bootstrapAdmin.password, role: 'admin', _verified: true }, overrideAccess: true, context: { ...INTERNAL_CONTEXT } });
    payload.logger.info('existing account recovered as administrator from CMS_ADMIN_EMAIL');
    return;
  }
  await payload.create({ collection: 'users', data: { email: env.bootstrapAdmin.email, password: env.bootstrapAdmin.password, role: 'admin', name: 'Administrator', _verified: true }, overrideAccess: true, context: { ...INTERNAL_CONTEXT } });
  payload.logger.info('bootstrap admin account created from CMS_ADMIN_EMAIL');
}
