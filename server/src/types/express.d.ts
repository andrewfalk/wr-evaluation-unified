// Express Request augmentation shared across the server.
// sessionInfo is populated by the auth middleware (T11).

declare global {
  namespace Express {
    interface Request {
      /** Set by requestIdMiddleware (http/requestId.ts) for every request. */
      requestId?: string;
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
