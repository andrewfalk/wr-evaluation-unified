export interface UserCredentials {
  userId: string;
  organizationId: string | null;
  role: string;
  name: string;
  mustChangePassword: boolean;
}

export interface AuthProvider {
  verifyCredentials(loginId: string, password: string): Promise<UserCredentials | null>;
}
