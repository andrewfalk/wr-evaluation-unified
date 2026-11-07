// Express Request augmentation shared across the server.
// sessionInfo is populated by the auth middleware (T11).

declare global {
  namespace Express {
    interface Request {
      /** Set by requestIdMiddleware (http/requestId.ts) for every request. */
      requestId?: string;
      /** Set by requireOrg() (http/authz.ts): the session's organization, never null after it. */
      orgId?: string;
      /** Set by requireLockToken() (http/lockToken.ts): If-Match revision + X-Lock-Token. */
      lock?: { ifMatch: number; token: string | null };
      sessionInfo?: {
        sessionId:          string;
        userId:             string;
        csrfTokenHash:      string;
        organizationId:     string | null;
        role:               string;
        name:               string;
        mustChangePassword: boolean;
      };
    }
  }
}

export {};
