import type { ApiRole } from "@autospokes/shared";
import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  AccountRecord,
  AdminUserFilter,
  AdminUserRecord,
  AuditFilter,
  AuditInput,
  AuditRecord,
  AuthRepository,
  CredentialRecord,
  SessionCreateInput,
  SessionRecord,
  UserStatusChange,
} from "./repository.js";

const adminUserSelect = {
  id: true,
  email: true,
  status: true,
  createdAt: true,
  profiles: { select: { role: true, displayName: true, accountId: true }, take: 1 },
} satisfies Prisma.UserSelect;
type AdminUserRow = Prisma.UserGetPayload<{ select: typeof adminUserSelect }>;

const credentialInclude = {
  profiles: {
    select: {
      id: true,
      role: true,
      displayName: true,
      accountId: true,
    },
  },
} satisfies Prisma.UserInclude;

const sessionInclude = {
  user: { select: { id: true, email: true, status: true } },
  roleProfile: {
    select: {
      id: true,
      role: true,
      displayName: true,
      accountId: true,
    },
  },
} satisfies Prisma.SessionInclude;

function toCredential(
  user: Prisma.UserGetPayload<{ include: typeof credentialInclude }>,
): CredentialRecord {
  return {
    id: user.id,
    email: user.email,
    passwordHash: user.passwordHash,
    status: user.status,
    profiles: user.profiles.map((profile) => ({
      ...profile,
      role: profile.role as ApiRole,
    })),
  };
}

function toSession(
  session: Prisma.SessionGetPayload<{ include: typeof sessionInclude }>,
): SessionRecord {
  return {
    id: session.id,
    userId: session.userId,
    email: session.user.email,
    userStatus: session.user.status,
    roleProfileId: session.roleProfile.id,
    role: session.roleProfile.role as ApiRole,
    displayName: session.roleProfile.displayName,
    accountId: session.accountId,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
  };
}

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findCredentialByEmail(email: string): Promise<CredentialRecord | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: credentialInclude,
    });
    return user ? toCredential(user) : null;
  }

  async createDeveloperUser(input: {
    email: string;
    passwordHash: string;
    role: Exclude<ApiRole, "SUPERADMIN">;
    displayName: string;
  }): Promise<CredentialRecord> {
    return this.prisma.$transaction(async (transaction) => {
      const user = await transaction.user.create({
        data: { email: input.email, passwordHash: input.passwordHash },
      });
      const account = await transaction.account.create({
        data: { name: `${input.displayName}'s account`, ownerId: user.id },
      });
      await transaction.roleProfile.create({
        data: {
          userId: user.id,
          accountId: account.id,
          role: input.role,
          displayName: input.displayName,
        },
      });
      const created = await transaction.user.findUniqueOrThrow({
        where: { id: user.id },
        include: credentialInclude,
      });
      return toCredential(created);
    });
  }

  async createSuperadmin(input: {
    email: string;
    passwordHash: string;
    displayName: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(4837261901)::text AS lock_result`;
      const existing = await transaction.roleProfile.count({
        where: { role: "SUPERADMIN" },
      });
      if (existing > 0) {
        throw new Error("A Superadmin already exists; bootstrap can only run once");
      }

      const user = await transaction.user.create({
        data: { email: input.email, passwordHash: input.passwordHash },
      });
      await transaction.roleProfile.create({
        data: {
          userId: user.id,
          role: "SUPERADMIN",
          displayName: input.displayName,
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: user.id,
          action: "SUPERADMIN_BOOTSTRAPPED",
        },
      });
    });
  }

  async createSession(input: SessionCreateInput): Promise<SessionRecord> {
    const session = await this.prisma.session.create({
      data: input,
      include: sessionInclude,
    });
    return toSession(session);
  }

  async findSessionById(id: string): Promise<SessionRecord | null> {
    const session = await this.prisma.session.findUnique({
      where: { id },
      include: sessionInclude,
    });
    return session ? toSession(session) : null;
  }

  async findSessionByRefreshHash(hash: string): Promise<SessionRecord | null> {
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hash },
      include: sessionInclude,
    });
    return session ? toSession(session) : null;
  }

  async rotateRefreshToken(input: {
    currentHash: string;
    nextHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<SessionRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.session.findUnique({
        where: { refreshTokenHash: input.currentHash },
        select: { id: true },
      });
      if (!current) return null;

      const update = await transaction.session.updateMany({
        where: {
          id: current.id,
          refreshTokenHash: input.currentHash,
          revokedAt: null,
          expiresAt: { gt: input.now },
        },
        data: {
          refreshTokenHash: input.nextHash,
          expiresAt: input.expiresAt,
        },
      });
      if (update.count !== 1) return null;

      const session = await transaction.session.findUnique({
        where: { id: current.id },
        include: sessionInclude,
      });
      return session ? toSession(session) : null;
    });
  }

  async revokeSession(id: string, at: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at },
    });
  }

  async appendAuditEvent(input: AuditInput): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorId: input.actorId ?? null,
        accountId: input.accountId ?? null,
        action: input.action,
        details: input.details,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
    });
  }

  async findAccountById(id: string): Promise<AccountRecord | null> {
    return this.prisma.account.findUnique({
      where: { id },
      select: { id: true, name: true, ownerId: true },
    });
  }

  async listAuditEvents(filter: AuditFilter = {}): Promise<AuditRecord[]> {
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        ...(filter.action ? { action: filter.action } : {}),
        ...(filter.accountId ? { accountId: filter.accountId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: filter.limit ?? 100,
      select: { id: true, actorId: true, accountId: true, action: true, details: true, createdAt: true },
    });
    return rows.map((row) => ({
      ...row,
      details:
        row.details && typeof row.details === "object" && !Array.isArray(row.details)
          ? (row.details as Record<string, unknown>)
          : null,
    }));
  }

  private async toAdminUser(user: AdminUserRow): Promise<AdminUserRecord | null> {
    const profile = user.profiles[0];
    if (!profile) return null;
    let suspension: AdminUserRecord["suspension"] = null;
    if (user.status === "DISABLED") {
      const event = await this.prisma.auditEvent.findFirst({
        where: { action: "ACCOUNT_SUSPENDED", details: { path: ["targetUserId"], equals: user.id } },
        orderBy: { createdAt: "desc" },
        select: { details: true, createdAt: true },
      });
      const reason =
        event?.details && typeof event.details === "object" && !Array.isArray(event.details)
          ? (event.details as Record<string, unknown>).reason
          : null;
      suspension = event ? { reason: typeof reason === "string" ? reason : "", at: event.createdAt } : null;
    }
    return {
      id: user.id,
      email: user.email,
      status: user.status,
      createdAt: user.createdAt,
      role: profile.role as ApiRole,
      displayName: profile.displayName,
      accountId: profile.accountId,
      suspension,
    };
  }

  async listUsersForAdmin(filter: AdminUserFilter): Promise<AdminUserRecord[]> {
    const users = await this.prisma.user.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.role ? { profiles: { some: { role: filter.role } } } : {}),
        ...(filter.q
          ? {
              OR: [
                { email: { contains: filter.q, mode: "insensitive" } },
                { profiles: { some: { displayName: { contains: filter.q, mode: "insensitive" } } } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: filter.limit,
      select: adminUserSelect,
    });
    const records = await Promise.all(users.map((user) => this.toAdminUser(user)));
    return records.filter((record): record is AdminUserRecord => record !== null);
  }

  async findUserForAdmin(userId: string): Promise<AdminUserRecord | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: adminUserSelect });
    return user ? this.toAdminUser(user) : null;
  }

  async setUserStatus(input: {
    userId: string;
    status: "ACTIVE" | "DISABLED";
    actorId: string;
    reason: string;
    now: Date;
  }): Promise<UserStatusChange> {
    const outcome = await this.prisma.$transaction(async (transaction) => {
      const user = await transaction.user.findUnique({
        where: { id: input.userId },
        select: { status: true, profiles: { select: { role: true, accountId: true } } },
      });
      if (!user) return "NOT_FOUND" as const;
      if (user.profiles.some((profile) => profile.role === "SUPERADMIN") || input.userId === input.actorId) {
        return "PROTECTED" as const;
      }
      // Compare-and-set so concurrent identical requests change state (and audit) only once.
      const changed = await transaction.user.updateMany({
        where: { id: input.userId, status: input.status === "DISABLED" ? "ACTIVE" : "DISABLED" },
        data: { status: input.status },
      });
      if (changed.count !== 1) return "UNCHANGED" as const;
      if (input.status === "DISABLED") {
        await transaction.session.updateMany({
          where: { userId: input.userId, revokedAt: null },
          data: { revokedAt: input.now },
        });
      }
      await transaction.auditEvent.create({
        data: {
          actorId: input.actorId,
          accountId: user.profiles[0]?.accountId ?? null,
          action: input.status === "DISABLED" ? "ACCOUNT_SUSPENDED" : "ACCOUNT_REACTIVATED",
          details: {
            targetUserId: input.userId,
            reason: input.reason,
            from: user.status,
            to: input.status,
          },
        },
      });
      return "OK" as const;
    });
    if (outcome !== "OK") return { ok: false, reason: outcome };
    const updated = await this.findUserForAdmin(input.userId);
    return updated ? { ok: true, user: updated } : { ok: false, reason: "NOT_FOUND" };
  }
}
