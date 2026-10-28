import {
  AccountIdSchema,
  MarketplaceAssignStaffInputSchema,
  MarketplaceBookingInputSchema,
  MarketplaceBookingStatusSchema,
  MarketplaceCompletionInputSchema,
  MarketplaceDiscoveryQuerySchema,
  MarketplaceDisputeInputSchema,
  MarketplaceIdempotencyKeySchema,
  MarketplacePaymentRecordSchema,
  MarketplaceProfileInputSchema,
  MarketplaceRejectInputSchema,
  MarketplaceServiceInputSchema,
  MarketplaceServiceStatusInputSchema,
  MarketplaceServiceUpdateSchema,
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
  assertBookable,
  sameBookingRequest,
  searchCandidates,
  snapshotFromService,
  toVendorBookingView,
} from "./rules.js";

type HttpError = Error & { statusCode: number };
type RouteDeps = {
  repository: MarketplaceRepository;
  ownerRepository: OwnerRepository;
  vendorPreHandler: preHandlerHookHandler[];
  ownerPreHandler: preHandlerHookHandler[];
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

function publicDetail(detail: MarketplaceBookingDetail, role: "VENDOR" | "OWNER") {
  const booking = role === "VENDOR" ? toVendorBookingView(detail.booking) : detail.booking;
  const { staffId, ...ownerSafe } = publicBooking(booking);
  const accepted = detail.booking.acceptedAt !== null;
  return {
    booking: role === "VENDOR" ? publicBooking(booking) : ownerSafe,
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
      method: payment.method,
      reference: payment.reference,
      note: payment.note,
      status: payment.status,
      createdAt: payment.createdAt,
    })),
    payment: {
      recordedPaise: detail.payments.reduce((sum, payment) => sum + payment.amountPaise, 0),
      verifiedPaise: detail.payments
        .filter((payment) => payment.status === "VERIFIED")
        .reduce((sum, payment) => sum + payment.amountPaise, 0),
      note: "Recorded payments are reported by the vendor and are not verified by Autospokes.",
    },
    vendor: role === "OWNER"
      ? { businessName: detail.vendorBusinessName, contactPhone: accepted ? detail.vendorContactPhone : null }
      : undefined,
    staffName: role === "OWNER" ? detail.staffName : undefined,
    assignedStaffId: role === "VENDOR" ? staffId ?? detail.booking.staffId : undefined,
    assignedStaffName: role === "VENDOR" ? detail.staffName : undefined,
  };
}

export function registerMarketplaceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { repository, ownerRepository, vendorPreHandler, ownerPreHandler, httpError, validationError, now } = deps;
  const vendorRead = { preHandler: vendorPreHandler, config: { rateLimit: READ_LIMIT } };
  const vendorWrite = { preHandler: vendorPreHandler, config: { rateLimit: WRITE_LIMIT } };
  const ownerRead = { preHandler: ownerPreHandler, config: { rateLimit: READ_LIMIT } };
  const ownerWrite = { preHandler: ownerPreHandler, config: { rateLimit: WRITE_LIMIT } };

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
        settlement: "Settlement requires payment verification, which is not available yet.",
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
      const payment = await repository.recordPayment(
        vendorAccount(request),
        request.user.sub,
        idOf(request.params.bookingId, "booking"),
        {
          amountPaise: parsed.data.amountPaise,
          method: parsed.data.method,
          reference: parsed.data.reference ?? null,
          note: parsed.data.note ?? null,
        },
      );
      if (!payment) return notFound("Booking");
      return reply.code(201).send({
        id: payment.id,
        amountPaise: payment.amountPaise,
        method: payment.method,
        reference: payment.reference,
        note: payment.note,
        status: payment.status,
        createdAt: payment.createdAt,
      });
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
  ownerAction("dispute", "dispute", (body) => {
    const parsed = MarketplaceDisputeInputSchema.safeParse(body);
    if (!parsed.success) throw validationError("A dispute reason is required", parsed.error);
    return parsed.data;
  });
}
