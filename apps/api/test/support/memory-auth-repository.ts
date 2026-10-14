import { randomUUID } from "node:crypto";
import type { ApiRole } from "@autospokes/shared";
import type {
  AccountRecord,
  AuditInput,
  AuditRecord,
  AuthRepository,
  CredentialRecord,
  SessionCreateInput,
  SessionRecord,
} from "../../src/auth/repository.js";

function uniqueError(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

function withoutRefreshHash(
  session: SessionRecord & { refreshTokenHash: string },
): SessionRecord {
  return {
    id: session.id,
    userId: session.userId,
    email: session.email,
    userStatus: session.userStatus,
    roleProfileId: session.roleProfileId,
    role: session.role,
    displayName: session.displayName,
    accountId: session.accountId,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
  };
}

export class MemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, CredentialRecord>();
  private readonly sessions = new Map<string, SessionRecord & { refreshTokenHash: string }>();
  private readonly accounts = new Map<string, AccountRecord>();
  private readonly auditEvents: AuditRecord[] = [];

  async findCredentialByEmail(email: string): Promise<CredentialRecord | null> {
    return [...this.users.values()].find((user) => user.email === email) ?? null;
  }

  async createDeveloperUser(input: {
    email: string;
    passwordHash: string;
    role: Exclude<ApiRole, "SUPERADMIN">;
    displayName: string;
  }): Promise<CredentialRecord> {
    if (await this.findCredentialByEmail(input.email)) throw uniqueError();
    const id = randomUUID();
    const accountId = randomUUID();
    const profileId = randomUUID();
    const user: CredentialRecord = {
      id,
      email: input.email,
      passwordHash: input.passwordHash,
      status: "ACTIVE",
      profiles: [
        {
          id: profileId,
          role: input.role,
          displayName: input.displayName,
          accountId,
        },
      ],
    };
    this.users.set(id, user);
    this.accounts.set(accountId, {
      id: accountId,
      name: `${input.displayName}'s account`,
      ownerId: id,
    });
    return user;
  }

  async createSuperadmin(input: {
    email: string;
    passwordHash: string;
    displayName: string;
  }): Promise<void> {
    if (await this.findCredentialByEmail(input.email)) throw uniqueError();
    const user: CredentialRecord = {
      id: randomUUID(),
      email: input.email,
      passwordHash: input.passwordHash,
      status: "ACTIVE",
      profiles: [
        {
          id: randomUUID(),
          role: "SUPERADMIN",
          displayName: input.displayName,
          accountId: null,
        },
      ],
    };
    this.users.set(user.id, user);
  }

  async createSession(input: SessionCreateInput): Promise<SessionRecord> {
    const user = this.users.get(input.userId);
    const profile = user?.profiles.find((item) => item.id === input.roleProfileId);
    if (!user || !profile) throw new Error("Session user or role profile not found");

    const session: SessionRecord & { refreshTokenHash: string } = {
      id: randomUUID(),
      userId: user.id,
      email: user.email,
      userStatus: user.status,
      roleProfileId: profile.id,
      role: profile.role,
      displayName: profile.displayName,
      accountId: input.accountId,
      expiresAt: input.expiresAt,
      revokedAt: null,
      refreshTokenHash: input.refreshTokenHash,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async findSessionById(id: string): Promise<SessionRecord | null> {
    const record = this.sessions.get(id);
    return record ? withoutRefreshHash(record) : null;
  }

  async findSessionByRefreshHash(hash: string): Promise<SessionRecord | null> {
    const record = [...this.sessions.values()].find((item) => item.refreshTokenHash === hash);
    return record ? withoutRefreshHash(record) : null;
  }

  async rotateRefreshToken(input: {
    currentHash: string;
    nextHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<SessionRecord | null> {
    const session = [...this.sessions.values()].find(
      (item) => item.refreshTokenHash === input.currentHash,
    );
    if (!session || session.revokedAt || session.expiresAt <= input.now) return null;
    session.refreshTokenHash = input.nextHash;
    session.expiresAt = input.expiresAt;
    return withoutRefreshHash(session);
  }

  async revokeSession(id: string, at: Date): Promise<void> {
    const session = this.sessions.get(id);
    if (session && !session.revokedAt) session.revokedAt = at;
  }

  async appendAuditEvent(input: AuditInput): Promise<void> {
    this.auditEvents.unshift({
      id: randomUUID(),
      actorId: input.actorId ?? null,
      accountId: input.accountId ?? null,
      action: input.action,
      createdAt: new Date(),
    });
  }

  async findAccountById(id: string): Promise<AccountRecord | null> {
    return this.accounts.get(id) ?? null;
  }

  async listAuditEvents(): Promise<AuditRecord[]> {
    return this.auditEvents.slice(0, 100);
  }
}
