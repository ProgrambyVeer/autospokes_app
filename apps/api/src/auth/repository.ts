import type { ApiRole } from "@autospokes/shared";

export type AccountRecord = {
  id: string;
  name: string;
  ownerId: string;
};

export type CredentialRecord = {
  id: string;
  email: string;
  passwordHash: string;
  status: "ACTIVE" | "DISABLED";
  profiles: {
    id: string;
    role: ApiRole;
    displayName: string;
    accountId: string | null;
  }[];
};

export type SessionRecord = {
  id: string;
  userId: string;
  email: string;
  userStatus: "ACTIVE" | "DISABLED";
  roleProfileId: string;
  role: ApiRole;
  displayName: string;
  accountId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type SessionCreateInput = {
  userId: string;
  roleProfileId: string;
  accountId: string | null;
  refreshTokenHash: string;
  expiresAt: Date;
};

export type AuditInput = {
  actorId?: string | null;
  accountId?: string | null;
  action: string;
  details?: Record<string, string | number | boolean | null>;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type AuditRecord = {
  id: string;
  actorId: string | null;
  accountId: string | null;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
};

export type AuditFilter = {
  action?: string;
  accountId?: string;
  limit?: number;
};

/** Minimal operator view of a user: no password hash, tokens, phone numbers or documents. */
export type AdminUserRecord = {
  id: string;
  email: string;
  status: "ACTIVE" | "DISABLED";
  createdAt: Date;
  role: ApiRole;
  displayName: string;
  accountId: string | null;
  suspension: { reason: string; at: Date } | null;
};

export type AdminUserFilter = {
  role?: ApiRole;
  status?: "ACTIVE" | "DISABLED";
  q?: string;
  limit: number;
};

export type UserStatusChange =
  | { ok: true; user: AdminUserRecord }
  | { ok: false; reason: "NOT_FOUND" | "PROTECTED" | "UNCHANGED" };

export interface AuthRepository {
  findCredentialByEmail(email: string): Promise<CredentialRecord | null>;
  createDeveloperUser(input: {
    email: string;
    passwordHash: string;
    role: Exclude<ApiRole, "SUPERADMIN">;
    displayName: string;
  }): Promise<CredentialRecord>;
  createSuperadmin(input: {
    email: string;
    passwordHash: string;
    displayName: string;
  }): Promise<void>;
  createSession(input: SessionCreateInput): Promise<SessionRecord>;
  findSessionById(id: string): Promise<SessionRecord | null>;
  findSessionByRefreshHash(hash: string): Promise<SessionRecord | null>;
  rotateRefreshToken(input: {
    currentHash: string;
    nextHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<SessionRecord | null>;
  revokeSession(id: string, at: Date): Promise<void>;
  appendAuditEvent(input: AuditInput): Promise<void>;
  findAccountById(id: string): Promise<AccountRecord | null>;
  listAuditEvents(filter?: AuditFilter): Promise<AuditRecord[]>;
  listUsersForAdmin(filter: AdminUserFilter): Promise<AdminUserRecord[]>;
  findUserForAdmin(userId: string): Promise<AdminUserRecord | null>;
  /**
   * Atomically disables or re-enables a non-Superadmin user. Disabling also revokes every session.
   * The reason and actor are recorded in the audit trail in the same transaction.
   */
  setUserStatus(input: {
    userId: string;
    status: "ACTIVE" | "DISABLED";
    actorId: string;
    reason: string;
    now: Date;
  }): Promise<UserStatusChange>;
}
