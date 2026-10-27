import type {
  CreateDetailerClientInput,
  CreateDetailerVehicleInput,
  DailyTask,
  DetailerClient,
  DetailerProfile,
  DetailerVehicle,
  OwnerVehicle,
  TaskExceptionRequest,
  UpdateDetailerClientInput,
  UpdateDetailerVehicleInput,
  WashSchedule,
  WashScheduleInput,
  SocietyResidentInput,
  SocietyScheduleActivity,
  SocietyWashScheduleInput,
  SocietyVehicleInput,
  SocietyWasherInput,
} from "@autospokes/shared";

export type AuthSession = {
  accessToken: string;
  csrfToken: string;
  user: {
    id: string;
    email: string;
    role: string;
    displayName: string;
    accountId: string | null;
  };
};

export type OwnerProfile = {
  displayName: string;
  phoneNumber: string | null;
};

export type VehicleDashboard = {
  upcomingService: unknown | null;
  currentWashStatus: unknown | null;
  recentServiceHistory: unknown[];
  invoices: unknown | null;
};

export type OwnerServiceStatus = "INACTIVE" | "NO_PROVIDER" | "PROVIDER_RECORDED";

export type OwnerDashboard = {
  summary: {
    totalVehicles: number;
    activeVehicles: number;
    inactiveVehicles: number;
    vehiclesWithoutProvider: number;
    providerCounts: Record<"INDEPENDENT_WASHER" | "SOCIETY_VENDOR" | "MARKETPLACE_VENDOR", number>;
  };
  vehicles: {
    vehicleId: string;
    serviceStatus: OwnerServiceStatus;
    providerType: OwnerVehicle["providerType"];
    providerVerified: false;
    upcomingService: null;
    currentWashStatus: null;
  }[];
  recentActivity: {
    id: string;
    kind: "VEHICLE_ADDED" | "VEHICLE_UPDATED";
    vehicleId: string;
    registrationNumber: string;
    occurredAt: string;
  }[];
  availability: {
    bookings: { available: boolean };
    billing: { available: boolean };
    notifications: { available: boolean };
  };
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function csrfCookie(): string | null {
  const cookie = document.cookie.split("; ").find((part) => part.startsWith("autospokes_csrf="));
  return cookie ? decodeURIComponent(cookie.slice("autospokes_csrf=".length)) : null;
}

async function responseBody<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = "Something went wrong. Please try again.";
    let fieldErrors: Record<string, string[]> = {};
    try {
      const body = (await response.json()) as {
        message?: string;
        fieldErrors?: Record<string, string[]>;
      };
      if (body.message) message = body.message;
      if (body.fieldErrors) fieldErrors = body.fieldErrors;
    } catch {
      // Retain the generic error message when the response has no JSON body.
    }
    throw new ApiError(message, response.status, fieldErrors);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function request<T>(
  path: string,
  session?: AuthSession,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (session) headers.set("authorization", `Bearer ${session.accessToken}`);
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "include",
  });
  return responseBody<T>(response);
}

export async function restoreSession(): Promise<AuthSession | null> {
  const csrfToken = csrfCookie();
  if (!csrfToken) return null;

  const response = await fetch("/auth/refresh", {
    method: "POST",
    headers: { "x-csrf-token": csrfToken },
    credentials: "include",
  });
  if (response.status === 401 || response.status === 403) return null;
  return responseBody<AuthSession>(response);
}

export type AccountRole = "OWNER" | "INDEPENDENT_DETAILER" | "SOCIETY_VENDOR";

export function signIn(email: string, password: string, role: AccountRole): Promise<AuthSession> {
  return request("/auth/login", undefined, {
    method: "POST",
    body: JSON.stringify({ email, password, role }),
  });
}

export function registerAccount(
  email: string,
  password: string,
  displayName: string,
  role: AccountRole,
): Promise<AuthSession> {
  return request("/auth/register", undefined, {
    method: "POST",
    body: JSON.stringify({ email, password, displayName, role }),
  });
}

export function signOut(session: AuthSession): Promise<void> {
  return request("/auth/logout", session, {
    method: "POST",
    headers: { "x-csrf-token": session.csrfToken },
  });
}

export function getOwnerProfile(session: AuthSession): Promise<OwnerProfile> {
  return request("/owner/profile", session);
}

export function updateOwnerProfile(
  session: AuthSession,
  input: OwnerProfile,
): Promise<OwnerProfile> {
  return request("/owner/profile", session, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function getOwnerDashboard(session: AuthSession): Promise<OwnerDashboard> {
  return request("/owner/dashboard", session);
}

export function getVehicles(session: AuthSession): Promise<OwnerVehicle[]> {
  return request<{ vehicles: OwnerVehicle[] }>("/owner/vehicles", session).then(
    (result) => result.vehicles,
  );
}

export function getVehicle(
  session: AuthSession,
  id: string,
): Promise<{ vehicle: OwnerVehicle; serviceSummary: VehicleDashboard }> {
  return request(`/owner/vehicles/${id}`, session);
}

export function createVehicle(
  session: AuthSession,
  input: Record<string, unknown>,
): Promise<OwnerVehicle> {
  return request("/owner/vehicles", session, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateVehicle(
  session: AuthSession,
  id: string,
  input: Record<string, unknown>,
): Promise<OwnerVehicle> {
  return request(`/owner/vehicles/${id}`, session, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function getDetailerProfile(session: AuthSession): Promise<DetailerProfile> {
  return request("/detailer/profile", session);
}

export function updateDetailerProfile(
  session: AuthSession,
  input: Partial<DetailerProfile>,
): Promise<DetailerProfile> {
  return request("/detailer/profile", session, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function getDetailerClients(session: AuthSession): Promise<DetailerClient[]> {
  return request<{ clients: DetailerClient[] }>("/detailer/clients", session).then(
    ({ clients }) => clients,
  );
}

export function getDetailerClient(
  session: AuthSession,
  id: string,
): Promise<{ client: DetailerClient; vehicles: DetailerVehicle[] }> {
  return request(`/detailer/clients/${id}`, session);
}

export function createDetailerClient(
  session: AuthSession,
  input: CreateDetailerClientInput,
): Promise<DetailerClient> {
  return request("/detailer/clients", session, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateDetailerClient(
  session: AuthSession,
  id: string,
  input: UpdateDetailerClientInput,
): Promise<DetailerClient> {
  return request(`/detailer/clients/${id}`, session, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function createDetailerVehicle(
  session: AuthSession,
  clientId: string,
  input: CreateDetailerVehicleInput,
): Promise<DetailerVehicle> {
  return request(`/detailer/clients/${clientId}/vehicles`, session, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type SocietyRecord = {
  id: string;
  [key: string]: unknown;
};

export type SocietyProfile = {
  displayName: string;
  phoneNumber: string | null;
  contactEmail: string | null;
  onboardingComplete: boolean;
};

export function getSocietyProfile(session: AuthSession): Promise<SocietyProfile> {
  return request("/society/profile", session);
}

export function updateSocietyProfile(
  session: AuthSession,
  input: Partial<SocietyProfile>,
): Promise<SocietyProfile> {
  return request("/society/profile", session, { method: "PATCH", body: JSON.stringify(input) });
}

export function getSocieties(session: AuthSession): Promise<SocietyRecord[]> {
  return request<{ societies: SocietyRecord[] }>("/society/societies", session).then((value) => value.societies);
}

export function createSociety(
  session: AuthSession,
  input: { name: string; address?: string },
): Promise<SocietyRecord> {
  return request("/society/societies", session, { method: "POST", body: JSON.stringify(input) });
}

export function updateSociety(
  session: AuthSession,
  societyId: string,
  input: { name?: string; address?: string | null; status?: "ACTIVE" | "INACTIVE" },
): Promise<SocietyRecord> {
  return request(`/society/societies/${societyId}`, session, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function getSocietyResidents(session: AuthSession, societyId: string): Promise<SocietyRecord[]> {
  return request<{ residents: SocietyRecord[] }>(`/society/societies/${societyId}/residents`, session)
    .then((value) => value.residents);
}

export function createSocietyResident(
  session: AuthSession,
  input: SocietyResidentInput,
): Promise<SocietyRecord> {
  return request(`/society/societies/${input.societyId}/residents`, session, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateSocietyResident(
  session: AuthSession,
  residentId: string,
  input: { name?: string; phoneNumber?: string; unit?: string | null; status?: "ACTIVE" | "INACTIVE" },
): Promise<SocietyRecord> {
  return request(`/society/residents/${residentId}`, session, { method: "PATCH", body: JSON.stringify(input) });
}

export function getSocietyVehicles(session: AuthSession, societyId: string): Promise<SocietyRecord[]> {
  return request<{ vehicles: SocietyRecord[] }>(`/society/societies/${societyId}/vehicles`, session)
    .then((value) => value.vehicles);
}

export function createSocietyVehicle(session: AuthSession, input: SocietyVehicleInput): Promise<SocietyRecord> {
  return request(`/society/societies/${input.societyId}/vehicles`, session, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateSocietyVehicle(
  session: AuthSession,
  vehicleId: string,
  input: { registrationNumber?: string; monthlyRatePaise?: number; status?: "ACTIVE" | "INACTIVE" },
): Promise<SocietyRecord> {
  return request(`/society/vehicles/${vehicleId}`, session, { method: "PATCH", body: JSON.stringify(input) });
}

export function getSocietyVehicleSchedules(session: AuthSession, vehicleId: string): Promise<SocietyRecord[]> {
  return request<{ schedules: SocietyRecord[] }>(`/society/vehicles/${vehicleId}/schedules`, session)
    .then((value) => value.schedules);
}

export function saveSocietyVehicleSchedule(
  session: AuthSession,
  vehicleId: string,
  activity: SocietyScheduleActivity,
  input: SocietyWashScheduleInput,
): Promise<SocietyRecord> {
  return request(`/society/vehicles/${vehicleId}/schedules/${activity}`, session, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function updateSocietyScheduleStatus(
  session: AuthSession,
  scheduleId: string,
  status: "ACTIVE" | "PAUSED" | "STOPPED",
): Promise<SocietyRecord> {
  return request(`/society/schedules/${scheduleId}/status`, session, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export function getSocietyWashers(session: AuthSession, societyId: string): Promise<SocietyRecord[]> {
  return request<{ washers: SocietyRecord[] }>(`/society/societies/${societyId}/washers`, session)
    .then((value) => value.washers);
}

export function createSocietyWasher(session: AuthSession, input: SocietyWasherInput): Promise<SocietyRecord> {
  return request(`/society/societies/${input.societyId}/washers`, session, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateSocietyWasher(
  session: AuthSession,
  washerId: string,
  input: { name?: string; phoneNumber?: string; ratePerTaskPaise?: number; status?: "ACTIVE" | "INACTIVE" },
): Promise<SocietyRecord> {
  return request(`/society/washers/${washerId}`, session, { method: "PATCH", body: JSON.stringify(input) });
}

export function assignSocietyWasher(
  session: AuthSession,
  vehicleId: string,
  washerId: string,
  startsAt: string,
): Promise<SocietyRecord> {
  return request(`/society/vehicles/${vehicleId}/assignments`, session, {
    method: "POST",
    body: JSON.stringify({ washerId, startsAt }),
  });
}

export function getSocietyAttendance(session: AuthSession, societyId: string, date: string): Promise<SocietyRecord[]> {
  return request<{ attendance: SocietyRecord[] }>(
    `/society/societies/${societyId}/attendance?date=${encodeURIComponent(date)}`,
    session,
  ).then((value) => value.attendance);
}

export function recordSocietyAttendance(
  session: AuthSession,
  input: { societyId: string; washerId: string; workDate: string; status: string; note?: string },
): Promise<SocietyRecord> {
  return request(`/society/societies/${input.societyId}/attendance`, session, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getSocietyTasks(session: AuthSession, societyId: string, date: string): Promise<SocietyRecord[]> {
  return request<{ tasks: SocietyRecord[] }>(
    `/society/tasks?societyId=${encodeURIComponent(societyId)}&date=${encodeURIComponent(date)}`,
    session,
  ).then((value) => value.tasks);
}

export function updateSocietyTask(
  session: AuthSession,
  taskId: string,
  status: string,
  note?: string,
): Promise<SocietyRecord> {
  return request(`/society/tasks/${taskId}`, session, {
    method: "PATCH",
    body: JSON.stringify({ status, note }),
  });
}

export function generateSocietyInvoices(
  session: AuthSession,
  societyId: string,
  month: string,
): Promise<{ month: string; createdCount: number }> {
  return request("/society/invoices/generate", session, {
    method: "POST",
    body: JSON.stringify({ societyId, month }),
  });
}

export function getSocietyInvoices(session: AuthSession, societyId: string): Promise<SocietyRecord[]> {
  return request<{ invoices: SocietyRecord[] }>(
    `/society/invoices?societyId=${encodeURIComponent(societyId)}`,
    session,
  ).then((value) => value.invoices);
}

export function recordSocietyPayment(
  session: AuthSession,
  invoiceId: string,
  input: { amountPaise: number; method: string; note?: string; reference?: string },
): Promise<SocietyRecord> {
  return request(`/society/invoices/${invoiceId}/payments`, session, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function createSocietyReminder(session: AuthSession, invoiceId: string, note?: string): Promise<SocietyRecord> {
  return request(`/society/invoices/${invoiceId}/reminders`, session, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

export function getSocietyEarnings(session: AuthSession, societyId: string): Promise<SocietyRecord[]> {
  return request<{ earnings: SocietyRecord[] }>(`/society/societies/${societyId}/earnings`, session)
    .then((value) => value.earnings);
}

export function getSocietyDeductions(session: AuthSession, societyId: string): Promise<SocietyRecord[]> {
  return request<{ deductions: SocietyRecord[] }>(`/society/societies/${societyId}/deductions`, session)
    .then((value) => value.deductions);
}

export function createSocietyDeduction(
  session: AuthSession,
  societyId: string,
  input: { washerId: string; amountPaise: number; reason: string },
): Promise<SocietyRecord> {
  return request(`/society/societies/${societyId}/deductions`, session, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function decideSocietyDeduction(
  session: AuthSession,
  deductionId: string,
  decision: string,
  reason: string,
): Promise<SocietyRecord> {
  return request(`/society/deductions/${deductionId}/decision`, session, {
    method: "PATCH",
    body: JSON.stringify({ decision, reason }),
  });
}

export function getSocietyExtraWork(session: AuthSession, societyId: string): Promise<SocietyRecord[]> {
  return request<{ extraWork: SocietyRecord[] }>(`/society/societies/${societyId}/extra-work`, session)
    .then((value) => value.extraWork);
}

export function createSocietyExtraWork(
  session: AuthSession,
  societyId: string,
  input: {
    residentId: string;
    vehicleId: string;
    description: string;
    amountPaise: number;
    residentApproverName: string;
    consentNote: string;
    workDate: string;
  },
): Promise<SocietyRecord> {
  return request(`/society/societies/${societyId}/extra-work`, session, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function decideSocietyExtraWork(
  session: AuthSession,
  extraWorkId: string,
  decision: string,
  reason: string,
): Promise<SocietyRecord> {
  return request(`/society/extra-work/${extraWorkId}/decision`, session, {
    method: "PATCH",
    body: JSON.stringify({ decision, reason }),
  });
}

export function getDetailerVehicle(
  session: AuthSession,
  id: string,
): Promise<{ vehicle: DetailerVehicle; schedules: WashSchedule[] }> {
  return request(`/detailer/vehicles/${id}`, session);
}

export function updateDetailerVehicle(
  session: AuthSession,
  id: string,
  input: UpdateDetailerVehicleInput,
): Promise<DetailerVehicle> {
  return request(`/detailer/vehicles/${id}`, session, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function saveDetailerSchedules(
  session: AuthSession,
  vehicleId: string,
  schedules: WashScheduleInput[],
): Promise<{ schedules: WashSchedule[] }> {
  return request(`/detailer/vehicles/${vehicleId}/schedules`, session, {
    method: "PUT",
    body: JSON.stringify({ schedules }),
  });
}

export function getDetailerTasks(
  session: AuthSession,
  date?: string,
): Promise<{ date: string; today: string; tasks: DailyTask[] }> {
  const query = date ? `?date=${encodeURIComponent(date)}` : "";
  return request(`/detailer/tasks${query}`, session);
}

export function updateDetailerTask(
  session: AuthSession,
  id: string,
  input: { status: DailyTask["status"]; note?: string | null },
): Promise<DailyTask> {
  return request(`/detailer/tasks/${id}`, session, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function updateDetailerException(
  session: AuthSession,
  input: TaskExceptionRequest,
): Promise<{ date: string; updated: number; tasks: DailyTask[] }> {
  return request("/detailer/tasks/exceptions", session, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
