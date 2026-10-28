import type {
  MarketplaceBookingStatus,
  MarketplaceCategory,
  MarketplaceOperatingHours,
  MarketplacePaymentMethod,
  MarketplaceServiceCategory,
  MarketplaceServiceInput,
  MarketplaceServiceStatus,
  MarketplaceServiceUpdate,
  MarketplaceVerificationStatus,
  VehicleType,
} from "@autospokes/shared";

export type MarketplaceProfileRecord = {
  id: string;
  accountId: string;
  businessName: string;
  description: string | null;
  category: MarketplaceCategory;
  contactPhone: string;
  contactEmail: string | null;
  addressLine: string | null;
  city: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  serviceRadiusKm: number | null;
  serviceAreas: string[];
  supportedVehicleTypes: VehicleType[];
  operatingHours: MarketplaceOperatingHours;
  logoUrl: string | null;
  galleryUrls: string[];
  verificationStatus: MarketplaceVerificationStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type MarketplaceProfileSave = Omit<
  MarketplaceProfileRecord,
  "id" | "accountId" | "verificationStatus" | "createdAt" | "updatedAt"
>;

export type MarketplaceServiceRecord = {
  id: string;
  accountId: string;
  name: string;
  description: string | null;
  category: MarketplaceServiceCategory;
  vehicleTypes: VehicleType[];
  pricePaise: number;
  durationMinutes: number;
  status: MarketplaceServiceStatus;
  inclusions: string[];
  exclusions: string[];
  terms: string | null;
  serviceAreas: string[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

export type MarketplaceStaffRecord = {
  id: string;
  accountId: string;
  name: string;
  phoneNumber: string | null;
  skills: string[];
  available: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type MarketplaceStaffWithWorkload = MarketplaceStaffRecord & { openBookings: number };

export type MarketplaceStaffCreate = {
  name: string;
  phoneNumber: string | null;
  skills: string[];
  available: boolean;
};

export type MarketplaceStaffPatch = {
  name?: string;
  phoneNumber?: string | null;
  skills?: string[];
  available?: boolean;
  active?: boolean;
};

export type BookingSnapshot = {
  vehicleRegistration: string;
  vehicleType: VehicleType;
  vehicleLabel: string | null;
  serviceName: string;
  serviceDescription: string | null;
  serviceCategory: MarketplaceServiceCategory;
  serviceInclusions: string[];
  serviceExclusions: string[];
  serviceTerms: string | null;
  servicePricePaise: number;
  serviceDurationMinutes: number;
  serviceVersion: number;
};

export type MarketplaceBookingRecord = BookingSnapshot & {
  id: string;
  ownerAccountId: string;
  vendorAccountId: string;
  vehicleId: string;
  serviceId: string;
  staffId: string | null;
  idempotencyKey: string;
  status: MarketplaceBookingStatus;
  windowStart: Date;
  windowEnd: Date;
  serviceLocation: string;
  accessNotes: string | null;
  rejectionReason: string | null;
  completionNotes: string | null;
  completionEvidenceUrls: string[];
  disputeReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  acceptedAt: Date | null;
  startedAt: Date | null;
  completionReportedAt: Date | null;
  customerRespondedAt: Date | null;
  settledAt: Date | null;
  closedAt: Date | null;
};

export type NewMarketplaceBooking = {
  ownerAccountId: string;
  actorId: string;
  idempotencyKey: string;
  vendorAccountId: string;
  vehicleId: string;
  serviceId: string;
  snapshot: BookingSnapshot;
  windowStart: Date;
  windowEnd: Date;
  serviceLocation: string;
  accessNotes: string | null;
};

export type MarketplaceBookingEventRecord = {
  id: string;
  bookingId: string;
  kind: string;
  fromStatus: MarketplaceBookingStatus | null;
  toStatus: MarketplaceBookingStatus | null;
  note: string | null;
  actorRole: string;
  createdAt: Date;
};

export type MarketplacePaymentStatus = "RECORDED_UNVERIFIED" | "VERIFIED";

export type MarketplacePaymentRecord = {
  id: string;
  bookingId: string;
  amountPaise: number;
  method: MarketplacePaymentMethod;
  reference: string | null;
  note: string | null;
  status: MarketplacePaymentStatus;
  createdAt: Date;
};

export type NewMarketplacePayment = {
  amountPaise: number;
  method: MarketplacePaymentMethod;
  reference: string | null;
  note: string | null;
};

export type MarketplaceBookingDetail = {
  booking: MarketplaceBookingRecord;
  events: MarketplaceBookingEventRecord[];
  payments: MarketplacePaymentRecord[];
  vendorBusinessName: string | null;
  vendorContactPhone: string | null;
  staffName: string | null;
};

export type BookingScope = { role: "VENDOR" | "OWNER"; accountId: string };

export type BookingAction =
  | "accept"
  | "reject"
  | "start"
  | "report_completion"
  | "customer_accept"
  | "dispute"
  | "settle"
  | "close";

export type TransitionPayload = {
  reason?: string;
  notes?: string;
  evidenceUrls?: string[];
};

export type DiscoveryCandidate = {
  service: MarketplaceServiceRecord;
  profile: MarketplaceProfileRecord;
};

export interface MarketplaceRepository {
  findProfile(accountId: string): Promise<MarketplaceProfileRecord | null>;
  saveProfile(accountId: string, actorId: string, input: MarketplaceProfileSave): Promise<MarketplaceProfileRecord>;

  listServices(accountId: string): Promise<MarketplaceServiceRecord[]>;
  findService(accountId: string, serviceId: string): Promise<MarketplaceServiceRecord | null>;
  createService(accountId: string, actorId: string, input: MarketplaceServiceInput): Promise<MarketplaceServiceRecord>;
  updateService(
    accountId: string,
    actorId: string,
    serviceId: string,
    patch: MarketplaceServiceUpdate,
  ): Promise<MarketplaceServiceRecord | null>;
  setServiceStatus(
    accountId: string,
    actorId: string,
    serviceId: string,
    status: MarketplaceServiceStatus,
  ): Promise<MarketplaceServiceRecord | null>;

  listStaff(accountId: string): Promise<MarketplaceStaffWithWorkload[]>;
  createStaff(accountId: string, actorId: string, input: MarketplaceStaffCreate): Promise<MarketplaceStaffRecord>;
  updateStaff(
    accountId: string,
    actorId: string,
    staffId: string,
    patch: MarketplaceStaffPatch,
  ): Promise<MarketplaceStaffRecord | null>;

  listActiveCandidates(): Promise<DiscoveryCandidate[]>;
  findServiceForBooking(serviceId: string): Promise<DiscoveryCandidate | null>;
  findBookingByIdempotencyKey(ownerAccountId: string, key: string): Promise<MarketplaceBookingRecord | null>;
  createBooking(input: NewMarketplaceBooking): Promise<{ booking: MarketplaceBookingRecord; created: boolean }>;

  listBookings(scope: BookingScope, statuses?: MarketplaceBookingStatus[]): Promise<MarketplaceBookingRecord[]>;
  findBooking(scope: BookingScope, bookingId: string): Promise<MarketplaceBookingDetail | null>;
  transitionBooking(
    scope: BookingScope,
    actorId: string,
    bookingId: string,
    action: BookingAction,
    payload: TransitionPayload,
    now: Date,
  ): Promise<MarketplaceBookingRecord | null>;
  assignStaff(
    vendorAccountId: string,
    actorId: string,
    bookingId: string,
    staffId: string | null,
    note: string | null,
    now: Date,
  ): Promise<MarketplaceBookingRecord | null>;
  recordPayment(
    vendorAccountId: string,
    actorId: string,
    bookingId: string,
    payment: NewMarketplacePayment,
  ): Promise<MarketplacePaymentRecord | null>;
}
