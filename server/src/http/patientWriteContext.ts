// The patient write services' context from the request (S7): the session (sessionOf), its organization
// (orgIdOf — call after requireOrg), the X-Lock-Token lease token and the audit details.
import type { Request } from 'express';
import type { PatientWriteContext } from '../domain/patients/context';
import { orgIdOf, sessionOf } from './authz';
import { lockTokenOf } from './lockToken';

/**
 * @param leaseTokenOverride a lease token that does not come from X-Lock-Token — the workspace save
 *   carries one per patient in its body. `null` means "no token"; omitted, the header is read.
 */
export function patientWriteContextOf(req: Request, leaseTokenOverride?: string | null): PatientWriteContext {
  const session = sessionOf(req);
  return {
    actor: { userId: session.userId, role: session.role, name: session.name },
    orgId: orgIdOf(req),
    leaseToken: leaseTokenOverride !== undefined ? leaseTokenOverride : lockTokenOf(req),
    audit: { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null },
  };
}
