import type { OwnerVehicle } from "@autospokes/shared";

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
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // Retain the generic error message when the response has no JSON body.
    }
    throw new ApiError(message, response.status);
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

export function signIn(email: string, password: string): Promise<AuthSession> {
  return request("/auth/login", undefined, {
    method: "POST",
    body: JSON.stringify({ email, password, role: "OWNER" }),
  });
}

export function registerOwner(
  email: string,
  password: string,
  displayName: string,
): Promise<AuthSession> {
  return request("/auth/register", undefined, {
    method: "POST",
    body: JSON.stringify({ email, password, displayName, role: "OWNER" }),
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
