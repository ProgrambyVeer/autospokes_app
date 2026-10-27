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

export type AccountRole = "OWNER" | "INDEPENDENT_DETAILER";

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
