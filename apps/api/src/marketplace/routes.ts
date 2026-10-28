import {
  AccountIdSchema,
  AdminPaymentQuerySchema,
  MarketplaceAssignStaffInputSchema,
  MarketplaceBookingInputSchema,
  MarketplaceBookingStatusSchema,
  MarketplaceCancelInputSchema,
  MarketplaceCompletionInputSchema,
  MarketplaceDiscoveryQuerySchema,
  MarketplaceDisputeInputSchema,
  MarketplaceDisputeResolveInputSchema,
  MarketplaceDisputeRespondInputSchema,
  MarketplaceDisputeStatusSchema,
  MarketplaceDisputeWithdrawInputSchema,
  MarketplaceIdempotencyKeySchema,
  MarketplacePaymentRecordSchema,
  MarketplacePaymentRejectInputSchema,
  MarketplacePaymentVerifyInputSchema,
  MarketplaceProfileInputSchema,
  MarketplaceRefundConfirmInputSchema,
  MarketplaceRefundInputSchema,
  MarketplaceRejectInputSchema,
  MarketplaceServiceInputSchema,
  MarketplaceServiceStatusInputSchema,
  MarketplaceServiceUpdateSchema,
  MarketplaceSettleInputSchema,
  MarketplaceStaffInputSchema,
  MarketplaceStaffUpdateSchema,
  normalizeIndianPhone,
  type FieldErrors,
  type MarketplaceBookingStatus,
} from "@autospokes/shared";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { OwnerRepository } from "../owner/repository.js";
import type {
  BookingAction,
  MarketplaceBookingDetail,
  MarketplaceBookingRecord,
  MarketplaceRepository,
  TransitionPayload,
} from "./repository.js";
import {
  DEFAULT_CANCELLATION_POLICY,
  assertBookable,
  computeRefundState,
  sameBookingRequest,
  searchCandidates,
  snapshotFromService,
  summarizePayments,
  toVendorBookingView,
  type CancellationPolicy,
} from "./rules.js";

type HttpError = Error & { statusCode: number };
type RouteDeps = {
  repository: MarketplaceRepository;
  ownerRepository: OwnerRepository;
  vendorPreHandler: preHandlerHookHandler[];
  ownerPreHandler: preHandlerHookHandler[];
  adminPreHandler: preHandlerHookHandler[];
  cancellationPolicy?: CancellationPolicy;
  httpError: (statusCode: number, message: string) => HttpError;
  validationError: (
    message: string,
    zodError?: Parameters<typeof import("@autospokes/shared").toFieldErrors>[0],
    fieldErrors?: FieldErrors,
  ) => HttpError;
  now: () => Date;
};

const READ_LIMIT = { max: 300, timeWindow: 60_000 };
const WRITE_LIMIT = { max: 120, timeWindow: 60_000 };

type PublicBooking = Omit<MarketplaceBookingRecord, "idempotencyKey" | "ownerAccountId" | "vendorAccountId">;

function publicBooking(booking: MarketplaceBookingRecord): PublicBooking {
  const rest: Partial<MarketplaceBookingRecord> = { ...booking };
  delete rest.idempotencyKey;
  delete rest.ownerAccountId;
  delete rest.vendorAccountId;
  return rest as PublicBooking;
}

function withoutStaffId<T extends object>(booking: T): Omit<T, "staffId"> {
  const rest: Record<string, unknown> = { ...(booking as Record<string, unknown>) };
  delete rest.staffId;
  return rest as Omit<T, "staffId">;
}

function publicDetail(detail: MarketplaceBookingDetail, role: "VENDOR" | "OWNER" | "ADMIN") {
  const booking = role === "VENDOR" ? toVendorBookingView(detail.booking) : detail.booking;
  const { staffId, ...ownerSafe } = publicBooking(booking);
  const accepted = detail.booking.acceptedAt !== null;
  const admin = role === "ADMIN";
  const summary = summarizePayments(detail.payments, detail.booking.servicePricePaise);
  return {
    booking: role === "OWNER" ? ownerSafe : publicBooking(booking),
    events: detail.events.map((event) => ({
      id: event.id,
      kind: event.kind,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      note: event.note,
      actorRole: event.actorRole,
      createdAt: event.createdAt,
    })),
    payments: detail.payments.map((payment) => ({
      id: payment.id,
      amountPaise: payment.amountPaise,
      currency: payment.currency,
      method: payment.method,
      reference: payment.reference,
      note: payment.note,
      status: payment.status,
      createdAt: payment.createdAt,
      verifiedAt: payment.verifiedAt,
      verificationSource: payment.verificationSource,
      failedAt: payment.failedAt,
      failureReason: payment.failureReason,
      ...(admin ? { verificationEvidence: payment.verificationEvidence } : {}),
    })),
    payment: {
      recordedPaise: summary.committedPaise,
      verifiedPaise: summary.verifiedPaise,
      outstandingPaise: summary.outstandingPaise,
      refundedPaise: summary.refundedPaise,
      state: summary.state,
      note: "Recorded payments are reported by the vendor and are not verified until the platform reconciles them.",
    },
    disputes: detail.disputes.map((dispute) => ({
      id: dispute.id,
      status: dispute.status,
      category: dispute.category,
      reason: dispute.reason,
      description: dispute.description,
      evidenceUrls: dispute.evidenceUrls,
      outcome: dispute.outcome,
      resolutionRationale: dispute.resolutionRationale,
      resolvedAt: dispute.resolvedAt,
      createdAt: dispute.createdAt,
      entries: dispute.entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        actorRole: entry.actorRole,
        message: entry.message,
        evidenceUrls: entry.evidenceUrls,
        createdAt: entry.createdAt,
      })),
    })),
    settlement: detail.settlement
      ? {
          id: detail.settlement.id,
          agreedPricePaise: detail.settlement.agreedPricePaise,
          verifiedPaidPaise: detail.settlement.verifiedPaidPaise,
          createdAt: detail.settlement.createdAt,
          externalTransfer: false,
          note: "An internal settlement record. It does not mean funds were paid out by Autospokes.",
        }
      : null,
    cancellation: detail.cancellation
      ? {
          kind: detail.cancellation.kind,
          initiatorRole: detail.cancellation.initiatorRole,
          reason: detail.cancellation.reason,
          policyKey: detail.cancellation.policyKey,
          policyVersion: detail.cancellation.policyVersion,
          feePaise: detail.cancellation.feePaise,
          createdAt: detail.cancellation.createdAt,
        }
      : null,
    refunds: detail.refunds.map((refund) => ({
      id: refund.id,
      paymentId: refund.paymentId,
      amountPaise: refund.amountPaise,
      status: refund.status,
      reason: refund.reason,
      confirmedAt: refund.confirmedAt,
      createdAt: refund.createdAt,
      ...(admin ? { evidenceReference: refund.evidenceReference } : {}),
    })),
    refundState: computeRefundState(detail.booking.status, detail.payments),
    vendor: role === "OWNER"
      ? { businessName: detail.vendorBusinessName, contactPhone: accepted ? detail.vendorContactPhone : null }
      : undefined,
    staffName: role === "OWNER" ? detail.staffName : undefined,
    assignedStaffId: role !== "OWNER" ? staffId ?? detail.booking.staffId : undefined,
    assignedStaffName: role !== "OWNER" ? detail.staffName : undefined,
  };
}

export function registerMarketplaceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { repository, ownerRepository, vendorPreHandler, ownerPreHandler, adminPreHandler, httpError, validationError, now } = deps;
  const cancellationPolicy = deps.cancellationPolicy ?? DEFAULT_CANCELLATION_POLICY;
  const vendorRead = { preHandler: vendorPreHandler, config: { rateLimit: READ_LIMIT } };
  const vendorWrite = { preHandler: vendorPreHandler, config: { rateLimit: WRITE_LIMIT } };
  const ownerRead = { preHandler: ownerPreHandler, config: { rateLimit: READ_LIMIT } };
  const ownerWrite = { preHandler: ownerPreHandler, config: { rateLimit: WRITE_LIMIT } };
  const adminRead = { preHandler: adminPreHandler, config: { rateLimit: READ_LIMIT } };
  const adminWrite = { preHandler: adminPreHandler, config: { rateLimit: WRITE_LIMIT } };

  const vendorAccount = (request: FastifyRequest): string => {
    if (request.user.role !== "MARKETPLACE_VENDOR" || !request.user.aid) {
      throw httpError(403, "A Marketplace Vendor account is required");
    }
    return request.user.aid;
  };
  const ownerAccount = (request: FastifyRequest): string => {
    if (request.user.role !== "OWNER" || !request.user.aid) {
      throw httpError(403, "An owner account is required");
    }
    return request.user.aid;
  };
  const idOf = (value: string, label: string): string => {
    const parsed = AccountIdSchema.safeParse(value);
    if (!parsed.success) throw httpError(400, `Invalid ${label} id`);
    return parsed.data;
  };
  const notFound = (label: string): never => {
    throw httpError(404, `${label} not found`);
  };

  // ----- Vendor: profile -------------------------------------------------

  app.get("/marketplace/profile", vendorRead, async (request) => {
    const profile = await repository.findProfile(vendorAccount(request));
    return { profile };
  });

  app.put<{ Body: unknown }>("/marketplace/profile", vendorWrite, async (request) => {
    const parsed = MarketplaceProfileInputSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid business profile", parsed.error);
    const data = parsed.data;
    const input = {
      businessName: data.businessName,
      description: data.description ?? null,
      category: data.category,
      contactPhone: normalizeIndianPhone(data.contactPhone) ?? data.contactPhone,
      contactEmail: data.contactEmail ?? null,
      addressLine: data.addressLine ?? null,
      city: data.city ?? null,
      postalCode: data.postalCode ?? null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      serviceRadiusKm: data.serviceRadiusKm ?? null,
      serviceAreas: data.serviceAreas,
      supportedVehicleTypes: data.supportedVehicleTypes,
      operatingHours: data.operatingHours,
      logoUrl: data.logoUrl ?? null,
      galleryUrls: data.galleryUrls,
    };
    return { profile: await repository.saveProfile(vendorAccount(request), request.user.sub, input) };
  });

  // ----- Vendor: catalogue -----------------------------------------------

  app.get("/marketplace/services", vendorRead, async (request) => ({
    services: await repository.listServices(vendorAccount(request)),
  }));

  app.post<{ Body: unknown }>("/marketplace/services", vendorWrite, async (request, reply) => {
    const parsed = MarketplaceServiceInputSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid service", parsed.error);
    const service = await repository.createService(vendorAccount(request), request.user.sub, parsed.data);
    return reply.code(201).send(service);
  });

  app.get<{ Params: { serviceId: string } }>("/marketplace/services/:serviceId", vendorRead, async (request) => {
    const service = await repository.findService(vendorAccount(request), idOf(request.params.serviceId, "service"));
    return service ?? notFound("Service");
  });

  app.patch<{ Params: { serviceId: string }; Body: unknown }>(
    "/marketplace/services/:serviceId",
    vendorWrite,
    async (request) => {
      const parsed = MarketplaceServiceUpdateSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid service", parsed.error);
      const accountId = vendorAccount(request);
      const serviceId = idOf(request.params.serviceId, "service");
      const existing = await repository.findService(accountId, serviceId);
      if (!existing) return notFound("Service");
      if (existing.status === "ARCHIVED") throw httpError(409, "Archived services cannot be edited");
      const service = await repository.updateService(accountId, request.user.sub, serviceId, parsed.data);
      return service ?? notFound("Service");
    },
  );

  app.post<{ Params: { serviceId: string }; Body: unknown }>(
    "/marketplace/services/:serviceId/status",
    vendorWrite,
    async (request) => {
      const parsed = MarketplaceServiceStatusInputSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid service status", parsed.error);
      const accountId = vendorAccount(request);
      const serviceId = idOf(request.params.serviceId, "service");
      const existing = await repository.findService(accountId, serviceId);
      if (!existing) return notFound("Service");
      if (existing.status === "ARCHIVED") throw httpError(409, "Archived services cannot be reactivated");
      const service = await repository.setServiceStatus(accountId, request.user.sub, serviceId, parsed.data.status);
      return service ?? notFound("Service");
    },
  );

  // ----- Vendor: staff directory -----------------------------------------

  app.get("/marketplace/staff", vendorRead, async (request) => ({
    staff: await repository.listStaff(vendorAccount(request)),
  }));

  app.post<{ Body: unknown }>("/marketplace/staff", vendorWrite, async (request, reply) => {
    const parsed = MarketplaceStaffInputSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid staff member", parsed.error);
    const input = {
      ...parsed.data,
      phoneNumber: parsed.data.phoneNumber ? normalizeIndianPhone(parsed.data.phoneNumber) : null,
    };
    const staff = await repository.createStaff(vendorAccount(request), request.user.sub, input);
    return reply.code(201).send(staff);
  });

  app.patch<{ Params: { staffId: string }; Body: unknown }>(
    "/marketplace/staff/:staffId",
    vendorWrite,
    async (request) => {
      const parsed = MarketplaceStaffUpdateSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid staff member", parsed.error);
      const patch = {
        ...parsed.data,
        ...(parsed.data.phoneNumber
          ? { phoneNumber: normalizeIndianPhone(parsed.data.phoneNumber) }
          : {}),
      };
      const staff = await repository.updateStaff(
        vendorAccount(request),
        request.user.sub,
        idOf(request.params.staffId, "staff"),
        patch,
      );
      return staff ?? notFound("Staff member");
    },
  );

  // ----- Vendor: bookings -------------------------------------------------

  app.get("/marketplace/dashboard", vendorRead, async (request) => {
    const accountId = vendorAccount(request);
    const [profile, services, staff, bookings] = await Promise.all([
      repository.findProfile(accountId),
      repository.listServices(accountId),
      repository.listStaff(accountId),
      repository.listBookings({ role: "VENDOR", accountId }),
    ]);
    const bookingCounts: Partial<Record<MarketplaceBookingStatus, number>> = {};
    for (const booking of bookings) bookingCounts[booking.status] = (bookingCounts[booking.status] ?? 0) + 1;
    const upcoming = bookings
      .filter((booking) => booking.status === "ACCEPTED" || booking.status === "IN_PROGRESS")
      .sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime())
      .slice(0, 5)
      .map((booking) => publicBooking(toVendorBookingView(booking)));
    return {
      profile: profile
        ? { businessName: profile.businessName, verificationStatus: profile.verificationStatus }
        : null,
      bookingCounts,
      totalBookings: bookings.length,
      upcoming,
      services: {
        active: services.filter((service) => service.status === "ACTIVE").length,
        inactive: services.filter((service) => service.status === "INACTIVE").length,
        archived: services.filter((service) => service.status === "ARCHIVED").length,
      },
      staff: {
        active: staff.filter((member) => member.active).length,
        available: staff.filter((member) => member.active && member.available).length,
      },
      availability: {
        verification: "Business verification review is not available yet; status stays pending.",
        settlement: "Settlement is an internal record created by the platform after verified payment and a resolved dispute state. Autospokes does not pay vendors out.",
      },
    };
  });

  app.get<{ Querystring: { status?: string } }>("/marketplace/bookings", vendorRead, async (request) => {
    const statuses = request.query.status
      ? request.query.status.split(",").map((value) => MarketplaceBookingStatusSchema.safeParse(value))
      : [];
    if (statuses.some((parsed) => !parsed.success)) throw httpError(400, "Invalid booking status filter");
    const bookings = await repository.listBookings(
      { role: "VENDOR", accountId: vendorAccount(request) },
      statuses.length > 0 ? statuses.map((parsed) => parsed.data!) : undefined,
    );
    return { bookings: bookings.map((booking) => publicBooking(toVendorBookingView(booking))) };
  });

  app.get<{ Params: { bookingId: string } }>("/marketplace/bookings/:bookingId", vendorRead, async (request) => {
    const detail = await repository.findBooking(
      { role: "VENDOR", accountId: vendorAccount(request) },
      idOf(request.params.bookingId, "booking"),
    );
    return detail ? publicDetail(detail, "VENDOR") : notFound("Booking");
  });

  const vendorAction = (
    path: string,
    action: BookingAction,
    parse: (body: unknown) => TransitionPayload,
  ) => {
    app.post<{ Params: { bookingId: string }; Body: unknown }>(
      `/marketplace/bookings/:bookingId/${path}`,
      vendorWrite,
      async (request) => {
        const accountId = vendorAccount(request);
        const payload = parse(request.body ?? {});
        const booking = await repository.transitionBooking(
          { role: "VENDOR", accountId },
          request.user.sub,
          idOf(request.params.bookingId, "booking"),
          action,
          payload,
          now(),
        );
        return booking ? { booking: publicBooking(toVendorBookingView(booking)) } : notFound("Booking");
      },
    );
  };
  const noPayload = (body: unknown): TransitionPayload => {
    if (body && typeof body === "object" && Object.keys(body).length > 0) {
      throw httpError(400, "This action does not accept a request body");
    }
    return {};
  };
  vendorAction("accept", "accept", noPayload);
  vendorAction("start", "start", noPayload);
  vendorAction("reject", "reject", (body) => {
    const parsed = MarketplaceRejectInputSchema.safeParse(body);
    if (!parsed.success) throw validationError("A rejection reason is required", parsed.error);
    return parsed.data;
  });
  vendorAction("complete", "report_completion", (body) => {
    const parsed = MarketplaceCompletionInputSchema.safeParse(body);
    if (!parsed.success) throw validationError("Invalid completion report", parsed.error);
    return parsed.data;
  });

  app.put<{ Params: { bookingId: string }; Body: unknown }>(
    "/marketplace/bookings/:bookingId/staff",
    vendorWrite,
    async (request) => {
      const parsed = MarketplaceAssignStaffInputSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid staff assignment", parsed.error);
      const booking = await repository.assignStaff(
        vendorAccount(request),
        request.user.sub,
        idOf(request.params.bookingId, "booking"),
        parsed.data.staffId,
        parsed.data.note ?? null,
        now(),
      );
      return booking ? { booking: publicBooking(toVendorBookingView(booking)) } : notFound("Booking");
    },
  );

  app.post<{ Params: { bookingId: string }; Body: unknown }>(
    "/marketplace/bookings/:bookingId/payments",
    vendorWrite,
    async (request, reply) => {
      const parsed = MarketplacePaymentRecordSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid payment record", parsed.error);
      const keyHeader = request.headers["idempotency-key"];
      let idempotencyKey: string | null = null;
      if (keyHeader !== undefined) {
        const key = MarketplaceIdempotencyKeySchema.safeParse(Array.isArray(keyHeader) ? keyHeader[0] : keyHeader);
        if (!key.success) {
          throw validationError("Invalid Idempotency-Key header", undefined, {
            "idempotency-key": key.error.issues.map((issue) => issue.message),
          });
        }
        idempotencyKey = key.data;
      }
      const result = await repository.recordPayment(
        vendorAccount(request),
        request.user.sub,
        idOf(request.params.bookingId, "booking"),
        {
          amountPaise: parsed.data.amountPaise,
          method: parsed.data.method,
          reference: parsed.data.reference ?? null,
          note: parsed.data.note ?? null,
          idempotencyKey,
        },
      );
      if (!result) return notFound("Booking");
      const { payment } = result;
      return reply.code(result.created ? 201 : 200).send({
        id: payment.id,
        amountPaise: payment.amountPaise,
        currency: payment.currency,
        method: payment.method,
        reference: payment.reference,
        note: payment.note,
        status: payment.status,
        createdAt: payment.createdAt,
        replayed: !result.created,
      });
    },
  );

  app.post<{ Params: { bookingId: string }; Body: unknown }>(
    "/marketplace/bookings/:bookingId/dispute/respond",
    vendorWrite,
    async (request) => {
      const parsed = MarketplaceDisputeRespondInputSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("A response message is required", parsed.error);
      const dispute = await repository.respondDispute(
        vendorAccount(request),
        request.user.sub,
        idOf(request.params.bookingId, "booking"),
        parsed.data,
        now(),
      );
      return dispute ? { disputeId: dispute.id, status: dispute.status } : notFound("Booking");
    },
  );

  const parseCancel = (body: unknown) => {
    const parsed = MarketplaceCancelInputSchema.safeParse(body ?? {});
    if (!parsed.success) throw validationError("A cancellation reason is required", parsed.error);
    return parsed.data;
  };
  app.post<{ Params: { bookingId: string }; Body: unknown }>(
    "/marketplace/bookings/:bookingId/cancel",
    vendorWrite,
    async (request) => {
      const accountId = vendorAccount(request);
      const booking = await repository.cancelBooking(
        { role: "VENDOR", accountId },
        request.user.sub,
        idOf(request.params.bookingId, "booking"),
        parseCancel(request.body),
        cancellationPolicy,
        now(),
      );
      return booking ? { booking: publicBooking(toVendorBookingView(booking)) } : notFound("Booking");
    },
  );

  // ----- Owner: discovery and bookings -----------------------------------

  app.get<{ Querystring: Record<string, string> }>("/owner/marketplace/services", ownerRead, async (request) => {
    ownerAccount(request);
    const parsed = MarketplaceDiscoveryQuerySchema.safeParse(request.query);
    if (!parsed.success) throw validationError("Invalid search", parsed.error);
    return searchCandidates(await repository.listActiveCandidates(), parsed.data);
  });

  app.post<{ Body: unknown }>("/owner/marketplace/bookings", ownerWrite, async (request, reply) => {
    const ownerAccountId = ownerAccount(request);
    const keyHeader = request.headers["idempotency-key"];
    const key = MarketplaceIdempotencyKeySchema.safeParse(Array.isArray(keyHeader) ? keyHeader[0] : keyHeader);
    if (!key.success) {
      throw validationError("An Idempotency-Key header is required", undefined, {
        "idempotency-key": key.error.issues.map((issue) => issue.message),
      });
    }
    const parsed = MarketplaceBookingInputSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid booking request", parsed.error);
    const input = parsed.data;
    const next = {
      vehicleId: input.vehicleId,
      serviceId: input.serviceId,
      windowStart: new Date(input.windowStart),
      windowEnd: new Date(input.windowEnd),
      serviceLocation: input.serviceLocation,
    };

    const replay = await repository.findBookingByIdempotencyKey(ownerAccountId, key.data);
    if (replay) {
      if (!sameBookingRequest(replay, next)) {
        throw httpError(409, "This Idempotency-Key was already used for a different request");
      }
      return reply.code(200).send({ booking: publicBooking(replay), replayed: true });
    }

    // The vehicle is resolved from the authenticated Owner's own garage, never from a registration number.
    const vehicle = await ownerRepository.findVehicle(ownerAccountId, input.vehicleId);
    if (!vehicle) return notFound("Vehicle");
    const candidate = await repository.findServiceForBooking(input.serviceId);
    if (!candidate) return notFound("Service");
    assertBookable({
      service: candidate.service,
      profile: candidate.profile,
      vehicle,
      windowStart: next.windowStart,
      now: now(),
    });

    const result = await repository.createBooking({
      ownerAccountId,
      actorId: request.user.sub,
      idempotencyKey: key.data,
      vendorAccountId: candidate.service.accountId,
      vehicleId: vehicle.id,
      serviceId: candidate.service.id,
      snapshot: snapshotFromService(candidate.service, vehicle),
      windowStart: next.windowStart,
      windowEnd: next.windowEnd,
      serviceLocation: input.serviceLocation,
      accessNotes: input.accessNotes ?? null,
    });
    if (!result.created && !sameBookingRequest(result.booking, next)) {
      throw httpError(409, "This Idempotency-Key was already used for a different request");
    }
    return reply
      .code(result.created ? 201 : 200)
      .send({ booking: publicBooking(result.booking), replayed: !result.created });
  });

  app.get("/owner/marketplace/bookings", ownerRead, async (request) => {
    const bookings = await repository.listBookings({ role: "OWNER", accountId: ownerAccount(request) });
    return { bookings: bookings.map((booking) => withoutStaffId(publicBooking(booking))) };
  });

  app.get<{ Params: { bookingId: string } }>("/owner/marketplace/bookings/:bookingId", ownerRead, async (request) => {
    const detail = await repository.findBooking(
      { role: "OWNER", accountId: ownerAccount(request) },
      idOf(request.params.bookingId, "booking"),
    );
    return detail ? publicDetail(detail, "OWNER") : notFound("Booking");
  });

  const ownerAction = (path: string, action: BookingAction, parse: (body: unknown) => TransitionPayload) => {
    app.post<{ Params: { bookingId: string }; Body: unknown }>(
      `/owner/marketplace/bookings/:bookingId/${path}`,
      ownerWrite,
      async (request) => {
        const accountId = ownerAccount(request);
        const payload = parse(request.body ?? {});
        const booking = await repository.transitionBooking(
          { role: "OWNER", accountId },
          request.user.sub,
          idOf(request.params.bookingId, "booking"),
          action,
          payload,
          now(),
        );
        if (!booking) return notFound("Booking");
        return { booking: withoutStaffId(publicBooking(booking)) };
      },
    );
  };
  ownerAction("accept-completion", "customer_accept", noPayload);

  app.post<{ Params: { bookingId: string }; Body: unknown }>(
    "/owner/marketplace/bookings/:bookingId/dispute",
    ownerWrite,
    async (request) => {
      const accountId = ownerAccount(request);
      const parsed = MarketplaceDisputeInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw validationError("A dispute reason is required", parsed.error);
      const booking = await repository.openDispute(
        accountId,
        request.user.sub,
        idOf(request.params.bookingId, "booking"),
        {
          reason: parsed.data.reason,
          category: parsed.data.category,
          description: parsed.data.description ?? null,
          evidenceUrls: parsed.data.evidenceUrls,
        },
        now(),
      );
      return booking ? { booking: withoutStaffId(publicBooking(booking)) } : notFound("Booking");
    },
  );

  app.post<{ Params: { bookingId: string }; Body: unknown }>(
    "/owner/marketplace/bookings/:bookingId/dispute/withdraw",
    ownerWrite,
    async (request) => {
      const accountId = ownerAccount(request);
      const parsed = MarketplaceDisputeWithdrawInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw validationError("Invalid withdrawal", parsed.error);
      const booking = await repository.withdrawDispute(
        accountId,
        request.user.sub,
        idOf(request.params.bookingId, "booking"),
        parsed.data.note ?? null,
        now(),
      );
      return booking ? { booking: withoutStaffId(publicBooking(booking)) } : notFound("Booking");
    },
  );

  app.post<{ Params: { bookingId: string }; Body: unknown }>(
    "/owner/marketplace/bookings/:bookingId/cancel",
    ownerWrite,
    async (request) => {
      const accountId = ownerAccount(request);
      const booking = await repository.cancelBooking(
        { role: "OWNER", accountId },
        request.user.sub,
        idOf(request.params.bookingId, "booking"),
        parseCancel(request.body),
        cancellationPolicy,
        now(),
      );
      return booking ? { booking: withoutStaffId(publicBooking(booking)) } : notFound("Booking");
    },
  );

  // ----- Superadmin: platform reconciliation, disputes, settlement ---------
  // Verification here is a manual platform reconciliation against external records. It is not a payment
  // gateway callback; no gateway is configured.

  const adminActor = (request: FastifyRequest): string => {
    if (request.user.role !== "SUPERADMIN") throw httpError(403, "A Superadmin account is required");
    return request.user.sub;
  };

  app.get<{ Querystring: { status?: string } }>("/admin/marketplace/disputes", adminRead, async (request) => {
    adminActor(request);
    const status = request.query.status
      ? MarketplaceDisputeStatusSchema.safeParse(request.query.status)
      : undefined;
    if (status && !status.success) throw httpError(400, "Invalid dispute status");
    const disputes = await repository.listDisputes(status?.data);
    return {
      disputes: disputes.map((dispute) => ({
        id: dispute.id,
        bookingId: dispute.bookingId,
        status: dispute.status,
        category: dispute.category,
        reason: dispute.reason,
        outcome: dispute.outcome,
        createdAt: dispute.createdAt,
        entryCount: dispute.entries.length,
      })),
    };
  });

  app.get<{ Querystring: unknown }>("/admin/marketplace/payments", adminRead, async (request) => {
    adminActor(request);
    const parsed = AdminPaymentQuerySchema.safeParse(request.query);
    if (!parsed.success) throw validationError("Invalid payment filter", parsed.error);
    const payments = await repository.listPayments(parsed.data.status);
    return {
      payments: payments.map((payment) => ({
        id: payment.id,
        bookingId: payment.bookingId,
        bookingStatus: payment.bookingStatus,
        agreedPricePaise: payment.agreedPricePaise,
        amountPaise: payment.amountPaise,
        currency: payment.currency,
        method: payment.method,
        status: payment.status,
        createdAt: payment.createdAt,
        verifiedAt: payment.verifiedAt,
        verificationSource: payment.verificationSource,
        hasEvidence: payment.verificationEvidence !== null,
        failedAt: payment.failedAt,
      })),
    };
  });

  app.get<{ Params: { bookingId: string } }>("/admin/marketplace/bookings/:bookingId", adminRead, async (request) => {
    adminActor(request);
    const detail = await repository.findBookingForAdmin(idOf(request.params.bookingId, "booking"));
    return detail ? publicDetail(detail, "ADMIN") : notFound("Booking");
  });

  app.post<{ Params: { disputeId: string }; Body: unknown }>(
    "/admin/marketplace/disputes/:disputeId/resolve",
    adminWrite,
    async (request) => {
      const actorId = adminActor(request);
      const parsed = MarketplaceDisputeResolveInputSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid dispute resolution", parsed.error);
      const result = await repository.resolveDispute(actorId, idOf(request.params.disputeId, "dispute"), parsed.data, now());
      if (!result) return notFound("Dispute");
      return { bookingId: result.booking.id, bookingStatus: result.booking.status, disputeStatus: result.dispute.status, outcome: result.dispute.outcome };
    },
  );

  const paymentView = (payment: {
    id: string;
    status: string;
    amountPaise: number;
    verifiedAt: Date | null;
    verificationSource: string | null;
    failedAt: Date | null;
  }) => ({
    id: payment.id,
    status: payment.status,
    amountPaise: payment.amountPaise,
    verifiedAt: payment.verifiedAt,
    verificationSource: payment.verificationSource,
    failedAt: payment.failedAt,
  });

  app.post<{ Params: { paymentId: string }; Body: unknown }>(
    "/admin/marketplace/payments/:paymentId/verify",
    adminWrite,
    async (request) => {
      const actorId = adminActor(request);
      const parsed = MarketplacePaymentVerifyInputSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("An evidence reference is required to verify a payment", parsed.error);
      const payment = await repository.verifyPayment(
        actorId,
        idOf(request.params.paymentId, "payment"),
        { evidenceReference: parsed.data.evidenceReference, note: parsed.data.note ?? null },
        now(),
      );
      return payment ? { payment: paymentView(payment) } : notFound("Payment");
    },
  );

  app.post<{ Params: { paymentId: string }; Body: unknown }>(
    "/admin/marketplace/payments/:paymentId/reject",
    adminWrite,
    async (request) => {
      const actorId = adminActor(request);
      const parsed = MarketplacePaymentRejectInputSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("A reason is required", parsed.error);
      const payment = await repository.rejectPayment(actorId, idOf(request.params.paymentId, "payment"), parsed.data.reason, now());
      return payment ? { payment: paymentView(payment) } : notFound("Payment");
    },
  );

  app.post<{ Params: { paymentId: string }; Body: unknown }>(
    "/admin/marketplace/payments/:paymentId/refund",
    adminWrite,
    async (request, reply) => {
      const actorId = adminActor(request);
      const parsed = MarketplaceRefundInputSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("A refund reason is required", parsed.error);
      const refund = await repository.approveRefund(actorId, idOf(request.params.paymentId, "payment"), parsed.data.reason, now());
      if (!refund) return notFound("Payment");
      return reply.code(201).send({
        refund: {
          id: refund.id,
          paymentId: refund.paymentId,
          amountPaise: refund.amountPaise,
          status: refund.status,
          note: "Approval is an internal record. The transfer must be made outside Autospokes and then confirmed.",
        },
      });
    },
  );

  app.post<{ Params: { refundId: string }; Body: unknown }>(
    "/admin/marketplace/refunds/:refundId/confirm",
    adminWrite,
    async (request) => {
      const actorId = adminActor(request);
      const parsed = MarketplaceRefundConfirmInputSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("An evidence reference is required", parsed.error);
      const refund = await repository.confirmRefund(actorId, idOf(request.params.refundId, "refund"), parsed.data.evidenceReference, now());
      return refund ? { refund: { id: refund.id, status: refund.status, confirmedAt: refund.confirmedAt } } : notFound("Refund");
    },
  );

  app.post<{ Params: { bookingId: string }; Body: unknown }>(
    "/admin/marketplace/bookings/:bookingId/settle",
    adminWrite,
    async (request, reply) => {
      const actorId = adminActor(request);
      const parsed = MarketplaceSettleInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw validationError("Invalid settlement request", parsed.error);
      const result = await repository.settleBooking(actorId, idOf(request.params.bookingId, "booking"), parsed.data.note ?? null, now());
      if (!result) return notFound("Booking");
      return reply.code(result.created ? 201 : 200).send({
        booking: { id: result.booking.id, status: result.booking.status },
        settlement: {
          id: result.settlement.id,
          agreedPricePaise: result.settlement.agreedPricePaise,
          verifiedPaidPaise: result.settlement.verifiedPaidPaise,
          externalTransfer: false,
        },
        replayed: !result.created,
        note: "Internal settlement record only; no funds were moved by Autospokes.",
      });
    },
  );

  app.post<{ Params: { bookingId: string } }>(
    "/admin/marketplace/bookings/:bookingId/close",
    adminWrite,
    async (request) => {
      const booking = await repository.closeBooking(adminActor(request), idOf(request.params.bookingId, "booking"), now());
      return booking ? { booking: { id: booking.id, status: booking.status } } : notFound("Booking");
    },
  );
}
