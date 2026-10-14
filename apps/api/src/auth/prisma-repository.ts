import type { ApiRole } from "@autospokes/shared";
import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  AccountRecord,
  AuditInput,
  AuditRecord,
  AuthRepository,
  CredentialRecord,
  SessionCreateInput,
  SessionRecord,
} from "./repository.js";

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

  async listAuditEvents(): Promise<AuditRecord[]> {
    return this.prisma.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, actorId: true, accountId: true, action: true, createdAt: true },
    });
  }
}
