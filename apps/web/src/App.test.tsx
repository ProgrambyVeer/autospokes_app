import {
  CreateDetailerClientSchema,
  CreateDetailerVehicleSchema,
  CreateVehicleSchema,
  SocietyResidentInputSchema,
  SocietyVehicleInputSchema,
} from "@autospokes/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const session = {
  accessToken: "test-access-token",
  csrfToken: "test-csrf-token",
  user: {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    email: "owner@example.test",
    role: "OWNER",
    displayName: "Taylor Owner",
    accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  },
};

const profile = { displayName: "Taylor Owner", phoneNumber: null };
const detailerSession = {
  ...session,
  user: {
    ...session.user,
    email: "detailer@example.test",
    role: "INDEPENDENT_DETAILER",
    displayName: "Morgan Detailer",
  },
};
const societySession = {
  ...session,
  user: {
    ...session.user,
    email: "society@example.test",
    role: "SOCIETY_VENDOR",
    displayName: "Morgan Society",
  },
};

function vehicle(registrationNumber = "MH 12 AB 1234") {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    accountId: session.user.accountId,
    type: "FOUR_WHEELER",
    registrationNumber,
    make: null,
    model: null,
    lengthCm: null,
    widthCm: null,
    heightCm: null,
    photoUrls: [],
    locationName: null,
    address: null,
    city: null,
    postalCode: null,
    providerType: null,
    providerName: null,
    assignedWasherName: null,
    status: "ACTIVE",
    createdAt: "2026-10-14T10:00:00.000Z",
    updatedAt: "2026-10-14T10:00:00.000Z",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const emptyDashboard = {
  summary: {
    totalVehicles: 0,
    activeVehicles: 0,
    inactiveVehicles: 0,
    vehiclesWithoutProvider: 0,
    providerCounts: { INDEPENDENT_WASHER: 0, SOCIETY_VENDOR: 0, MARKETPLACE_VENDOR: 0 },
  },
  vehicles: [],
  marketplace: {
    connected: false,
    counts: { total: 0, awaitingVendor: 0, confirmed: 0, disputed: 0, cancelled: 0 },
    bookings: [],
  },
  recentActivity: [],
  availability: {
    bookings: { available: false },
    billing: { available: false },
    notifications: { available: false },
  },
};

function configureSuccessfulOwnerApi(
  fetchMock: ReturnType<typeof vi.fn>,
  options: {
    vehicles?: unknown[];
    dashboard?: unknown;
    dashboardStatus?: number;
    marketplaceBookingsStatus?: number;
    discovery?: unknown;
  } = {},
) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/auth/login") return jsonResponse(session);
    if (path === "/owner/marketplace/bookings") {
      return options.marketplaceBookingsStatus && options.marketplaceBookingsStatus !== 200
        ? jsonResponse({ message: "boom" }, options.marketplaceBookingsStatus)
        : jsonResponse({ bookings: [] });
    }
    if (path.startsWith("/owner/marketplace/services")) {
      return jsonResponse(options.discovery ?? { status: "LOCATION_REQUIRED", location: null, results: [], noResultsWithinRadius: false, unsupported: [] });
    }
    if (path === "/owner/profile") return jsonResponse(profile);
    if (path === "/owner/dashboard") {
      return jsonResponse(options.dashboard ?? emptyDashboard, options.dashboardStatus ?? 200);
    }
    if (path === "/owner/vehicles" && (init?.method ?? "GET") === "GET") {
      return jsonResponse({ vehicles: options.vehicles ?? [] });
    }
    if (path === "/owner/vehicles" && init?.method === "POST") {
      return jsonResponse(vehicle("MH 12 AB 1234"), 201);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
}

beforeEach(() => {
  document.cookie = "autospokes_csrf=; Max-Age=0; path=/";
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "autospokes_csrf=; Max-Age=0; path=/";
});

describe("Owner experience", () => {
  it("signs in through the existing auth API and shows a data-backed empty garage", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    configureSuccessfulOwnerApi(fetchMock);
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await screen.findByRole("textbox", { name: "Email address" });
    fireEvent.change(screen.getByRole("textbox", { name: "Email address" }), {
      target: { value: "owner@example.test" },
    });

    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse-battery-staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: /A little more care/ })).toBeInTheDocument();
    expect(screen.getByText("Booking data is not available")).toBeInTheDocument();
    expect(screen.getByText("No invoice data is available yet")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/auth/login", expect.objectContaining({
      method: "POST",
      credentials: "include",
    }));
  });

  it("shows API validation errors without reporting a successful sign-in", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ statusCode: 401, message: "Invalid email or password" }, 401),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await screen.findByRole("textbox", { name: "Email address" });
    fireEvent.change(screen.getByRole("textbox", { name: "Email address" }), {
      target: { value: "owner@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
    expect(screen.queryByRole("heading", { name: /A little more care/ })).not.toBeInTheDocument();
  });

  it("adds an optional-provider vehicle and shows it in the garage", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    configureSuccessfulOwnerApi(fetchMock);
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await screen.findByRole("textbox", { name: "Email address" });
    fireEvent.change(screen.getByRole("textbox", { name: "Email address" }), {
      target: { value: "owner@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse-battery-staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByRole("heading", { name: /A little more care/ });
    fireEvent.click(screen.getAllByRole("button", { name: /Add a vehicle|Add your first vehicle/ })[0]!);
    expect(await screen.findByRole("heading", { name: "Add a vehicle" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Registration number/), {
      target: { value: "MH 12 AB 1234" },
    });
    const form = screen.getByLabelText("Vehicle type").closest("form");
    if (!(form instanceof HTMLFormElement)) throw new Error("Vehicle form is missing");
    fireEvent.submit(form);

    expect(await screen.findByText("Vehicle details saved.")).toBeInTheDocument();
    const garage = screen.getByRole("heading", { name: "My vehicles" }).parentElement?.parentElement;
    expect(garage).toBeTruthy();
    expect(await screen.findByText("MH 12 AB 1234")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/owner/vehicles", expect.objectContaining({
      method: "POST",
    }));
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/owner/vehicles" && init?.method === "POST",
    );
    const body = JSON.parse(String((createCall?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("status");
    expect(CreateVehicleSchema.safeParse(body).success).toBe(true);
    expect(within(document.body).getByText("No provider selected")).toBeInTheDocument();
  });
});

async function signInAsOwner(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  await screen.findByRole("textbox", { name: "Email address" });
  fireEvent.change(screen.getByRole("textbox", { name: "Email address" }), {
    target: { value: "owner@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "correct-horse-battery-staple" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: /A little more care/ });
}

describe("Owner dashboard and navigation", () => {
  const second = { ...vehicle("KA 01 CD 5678"), id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", providerType: "SOCIETY_VENDOR" };
  const twoVehicleDashboard = {
    ...emptyDashboard,
    summary: { ...emptyDashboard.summary, totalVehicles: 2, activeVehicles: 2, vehiclesWithoutProvider: 1 },
    vehicles: [
      { vehicleId: vehicle().id, serviceStatus: "NO_PROVIDER", providerType: null, providerVerified: false, upcomingService: null, currentWashStatus: null },
      { vehicleId: second.id, serviceStatus: "PROVIDER_RECORDED", providerType: "SOCIETY_VENDOR", providerVerified: false, upcomingService: null, currentWashStatus: null },
    ],
    recentActivity: [
      { id: "a1", kind: "VEHICLE_ADDED", vehicleId: second.id, registrationNumber: "KA 01 CD 5678", occurredAt: "2026-10-15T10:00:00.000Z" },
    ],
  };

  it("shows the five Owner navigation items on mobile and desktop and only Owner pages", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    configureSuccessfulOwnerApi(fetchMock);
    await signInAsOwner(fetchMock);
    const navs = screen.getAllByRole("navigation", { name: "Owner navigation" });
    expect(navs).toHaveLength(2);
    for (const nav of navs) {
      expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual([
        "Home", "My vehicles", "Services", "Activity", "Profile",
      ]);
    }
    expect(document.querySelector(".owner-app")).toHaveClass("owner-role-app");
    expect(screen.queryByText(/Society|Detailer|Marketplace/i, { selector: "nav *" })).not.toBeInTheDocument();
  });

  it("shows first-use guidance and no invented data for a new Owner", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    configureSuccessfulOwnerApi(fetchMock);
    await signInAsOwner(fetchMock);
    expect(await screen.findByText("Set up your garage")).toBeInTheDocument();
    expect(screen.getByText(/good (morning|afternoon|evening)/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add vehicle/ })).toBeInTheDocument();
    expect(screen.getByText("No invoice data is available yet")).toBeInTheDocument();
  });

  it("keeps per-vehicle status separate for multiple vehicles", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    configureSuccessfulOwnerApi(fetchMock, { vehicles: [vehicle(), second], dashboard: twoVehicleDashboard });
    await signInAsOwner(fetchMock);
    await screen.findByText("Per-vehicle status");
    const list = document.querySelector<HTMLElement>(".status-list");
    if (!list) throw new Error("Status list missing");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("MH 12 AB 1234");
    expect(rows[0]).toHaveTextContent("No provider");
    expect(rows[1]).toHaveTextContent("KA 01 CD 5678");
    expect(rows[1]).toHaveTextContent("Provider recorded");
    expect(rows[1]).toHaveTextContent("Not verified by Autospokes");
    expect(screen.getByText("1 without a provider")).toBeInTheDocument();
  });

  it("shows a retryable error when the dashboard fails without fabricating data", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    configureSuccessfulOwnerApi(fetchMock, { vehicles: [vehicle()], dashboard: { message: "boom" }, dashboardStatus: 500 });
    await signInAsOwner(fetchMock);
    expect(await screen.findByText(/could not load your service summary/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getAllByText("MH 12 AB 1234").length).toBeGreaterThan(0);
    expect(screen.queryByText("Provider recorded")).not.toBeInTheDocument();
  });

  it("states honestly that bookings, billing and notifications are unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    configureSuccessfulOwnerApi(fetchMock, { vehicles: [vehicle(), second], dashboard: twoVehicleDashboard });
    await signInAsOwner(fetchMock);
    fireEvent.click(within(screen.getAllByRole("navigation", { name: "Owner navigation" })[0]!).getByRole("button", { name: "Services" }));
    expect(await screen.findByText("No marketplace bookings.")).toBeInTheDocument();
    expect(screen.getByText(/No invoice data is available yet. No balances/)).toBeInTheDocument();
    fireEvent.click(within(screen.getAllByRole("navigation", { name: "Owner navigation" })[0]!).getByRole("button", { name: "Activity" }));
    expect(await screen.findByText("Vehicle added")).toBeInTheDocument();
    expect(screen.getByText(/No notification channel is connected/)).toBeInTheDocument();
  });
});

describe("Independent Detailer experience", () => {
  function detailerApi(fetchMock: ReturnType<typeof vi.fn>, clients: unknown[] = []) {
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === "/auth/login") return jsonResponse(detailerSession);
      if (path === "/detailer/profile") {
        return jsonResponse({
          displayName: "Morgan Detailer",
          phoneNumber: "+919876543210",
          serviceArea: "Indiranagar",
          contactEmail: null,
          onboardingComplete: true,
        });

        describe("Society Vendor experience", () => {
          it("routes to Society Vendor navigation and keeps its form payloads aligned with shared schemas", async () => {
            const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
              const path = String(input);
              if (path === "/auth/login") return jsonResponse(societySession);
              if (path === "/society/profile") {
                return jsonResponse({
                  displayName: "Morgan Society",
                  phoneNumber: "+919876543210",
                  contactEmail: null,
                  onboardingComplete: true,
                });
              }
              if (path === "/society/societies") return jsonResponse({ societies: [] });
              throw new Error(`Unexpected request: ${path}`);
            });
            vi.stubGlobal("fetch", fetchMock);
            render(<App />);

            await screen.findByRole("textbox", { name: "Email address" });
            fireEvent.change(screen.getByRole("textbox", { name: "Email address" }), {
              target: { value: "society@example.test" },
            });
            fireEvent.change(screen.getByLabelText("Password"), {
              target: { value: "correct-horse-battery-staple" },
            });
            fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "SOCIETY_VENDOR" } });
            fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

            expect(await screen.findByRole("heading", { name: "Your societies" })).toBeInTheDocument();
            expect(screen.getByRole("navigation", { name: "Society Vendor navigation" })).toBeInTheDocument();
            fireEvent.click(screen.getAllByRole("button", { name: "Residents & vehicles" })[0]!);
            expect(await screen.findByRole("heading", { name: "Residents & vehicles" })).toBeInTheDocument();
            expect(SocietyResidentInputSchema.safeParse({
              societyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              name: "Resident",
              phoneNumber: "9876543210",
            }).success).toBe(true);
            expect(SocietyVehicleInputSchema.safeParse({
              societyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              residentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              type: "FOUR_WHEELER",
              registrationNumber: "MH 12 AB 1234",
              monthlyRatePaise: 125000,
            }).success).toBe(true);
            expect(fetchMock).toHaveBeenCalledWith("/auth/login", expect.objectContaining({
              method: "POST",
            }));
          });

          it("shows failed society saves as errors instead of success", async () => {
            const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
              const path = String(input);
              if (path === "/auth/login") return jsonResponse(societySession);
              if (path === "/society/profile") {
                return jsonResponse({
                  displayName: "Morgan Society",
                  phoneNumber: "+919876543210",
                  contactEmail: null,
                  onboardingComplete: true,
                });
              }
              if (path === "/society/societies" && (init?.method ?? "GET") === "GET") {
                return jsonResponse({ societies: [] });
              }
              if (path === "/society/societies" && init?.method === "POST") {
                return jsonResponse({ message: "Society could not be saved" }, 500);
              }
              throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
            });
            vi.stubGlobal("fetch", fetchMock);
            render(<App />);
            await screen.findByRole("textbox", { name: "Email address" });
            fireEvent.change(screen.getByRole("textbox", { name: "Email address" }), {
              target: { value: "society@example.test" },
            });
            fireEvent.change(screen.getByLabelText("Password"), {
              target: { value: "correct-horse-battery-staple" },
            });
            fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "SOCIETY_VENDOR" } });
            fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
            await screen.findByRole("heading", { name: "Your societies" });
            fireEvent.change(screen.getByLabelText("Society name"), { target: { value: "Example Court" } });
            fireEvent.click(screen.getByRole("button", { name: "Add society" }));

            expect(await screen.findByRole("alert")).toHaveTextContent("Society could not be saved");
            expect(screen.queryByText("Changes saved.")).not.toBeInTheDocument();
          });
        });
      }
      if (path === "/detailer/clients" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ clients });
      }
      if (path.startsWith("/detailer/tasks")) {
        return jsonResponse({ date: "2030-01-01", today: "2030-01-01", tasks: [] });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    });
  }

  async function signInAsDetailer() {
    await screen.findByRole("textbox", { name: "Email address" });
    fireEvent.change(screen.getByLabelText("Workspace"), {
      target: { value: "INDEPENDENT_DETAILER" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Email address" }), {
      target: { value: "detailer@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse-battery-staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { name: "Today’s care plan" });
  }

  it("uses the selected role for sign-in and keeps Detailer navigation separate", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    detailerApi(fetchMock);
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await signInAsDetailer();

    expect(screen.getByRole("navigation", { name: "Independent Detailer navigation" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Owner navigation" })).not.toBeInTheDocument();
    const login = fetchMock.mock.calls.find(([url]) => url === "/auth/login");
    expect(JSON.parse(String((login?.[1] as RequestInit).body))).toMatchObject({
      role: "INDEPENDENT_DETAILER",
    });
  });

  it("submits client and vehicle payloads compatible with shared schemas", async () => {
    let clientCreated = false;
    const client = {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      name: "Asha Rao",
      phoneNumber: "+919876543210",
      notes: null,
      status: "ACTIVE",
      vehicleCount: 0,
    };
    const fetchMock = vi.fn<typeof fetch>();
    detailerApi(fetchMock);
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === "/auth/login") return jsonResponse(detailerSession);
      if (path === "/detailer/profile") {
        return jsonResponse({
          displayName: "Morgan Detailer",
          phoneNumber: "+919876543210",
          serviceArea: "Indiranagar",
          contactEmail: null,
          onboardingComplete: true,
        });
      }
      if (path === "/detailer/clients" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ clients: clientCreated ? [client] : [] });
      }
      if (path === "/detailer/clients" && init?.method === "POST") {
        clientCreated = true;
        return jsonResponse(client, 201);
      }
      if (path === `/detailer/clients/${client.id}`) return jsonResponse({ client, vehicles: [] });
      if (path === `/detailer/clients/${client.id}/vehicles` && init?.method === "POST") {
        return jsonResponse({
          id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          clientId: client.id,
          type: "TWO_WHEELER",
          registrationNumber: "KA 03 MN 4567",
          make: null,
          model: null,
          locationName: null,
          status: "ACTIVE",
        }, 201);
      }
      if (path.startsWith("/detailer/tasks")) {
        return jsonResponse({ date: "2030-01-01", today: "2030-01-01", tasks: [] });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await signInAsDetailer();
    fireEvent.click(screen.getAllByRole("button", { name: "Clients" })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Add your first client" }));
    fireEvent.change(screen.getByLabelText("Client name"), { target: { value: "Asha Rao" } });
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "98765 43210" } });
    fireEvent.click(screen.getByRole("button", { name: "Save client" }));
    await screen.findByRole("heading", { name: "Asha Rao" });

    const clientRequest = fetchMock.mock.calls.find(
      ([url, init]) => url === "/detailer/clients" && init?.method === "POST",
    );
    const clientPayload = JSON.parse(String((clientRequest?.[1] as RequestInit).body));
    expect(CreateDetailerClientSchema.safeParse(clientPayload).success).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Add vehicle" }));
    fireEvent.change(screen.getByLabelText("Registration number"), {
      target: { value: "KA 03 MN 4567" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Add vehicle" }).at(-1)!);
    const vehicleRequest = await vi.waitFor(() =>
      fetchMock.mock.calls.find(
        ([url, init]) => url === `/detailer/clients/${client.id}/vehicles` && init?.method === "POST",
      ),
    );
    const vehiclePayload = JSON.parse(String((vehicleRequest?.[1] as RequestInit).body));
    expect(CreateDetailerVehicleSchema.safeParse(vehiclePayload).success).toBe(true);
  });
});

describe("Marketplace Vendor and Owner marketplace", () => {
  const marketplaceSession = {
    ...session,
    user: { ...session.user, email: "market@example.test", role: "MARKETPLACE_VENDOR", displayName: "Morgan Market" },
  };

  it("routes a Marketplace Vendor to its own workspace and shows honest empty states", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/auth/login") return jsonResponse(marketplaceSession);
      if (path === "/marketplace/dashboard") {
        return jsonResponse({
          profile: null,
          bookingCounts: {},
          totalBookings: 0,
          upcoming: [],
          services: { active: 0, inactive: 0, archived: 0 },
          staff: { active: 0, available: 0 },
          availability: { verification: "x", settlement: "x" },
        });
      }
      if (path === "/marketplace/profile") return jsonResponse({ profile: null });
      if (path === "/marketplace/services") return jsonResponse({ services: [] });
      if (path === "/marketplace/staff") return jsonResponse({ staff: [] });
      if (path === "/marketplace/bookings") return jsonResponse({ bookings: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await screen.findByRole("textbox", { name: "Email address" });
    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "MARKETPLACE_VENDOR" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Email address" }), { target: { value: "market@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery-staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Set up your business profile." })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Marketplace Vendor navigation" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Owner navigation" })).not.toBeInTheDocument();
    expect(JSON.parse(String((fetchMock.mock.calls.find(([url]) => url === "/auth/login")?.[1] as RequestInit).body))).toMatchObject({ role: "MARKETPLACE_VENDOR" });
  });

  async function openServices(fetchMock: ReturnType<typeof vi.fn>) {
    await signInAsOwner(fetchMock);
    fireEvent.click(within(screen.getAllByRole("navigation", { name: "Owner navigation" })[0]!).getByRole("button", { name: "Services" }));
    await screen.findByText("Find a service");
  }

  it("shows the empty bookings state and does not invent ratings or availability", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    configureSuccessfulOwnerApi(fetchMock, { vehicles: [vehicle()] });
    await openServices(fetchMock);
    expect(await screen.findByText("No marketplace bookings.")).toBeInTheDocument();
    expect(screen.queryByText(/stars|rating:/i)).not.toBeInTheDocument();
  });

  it("requires a location and reports no results honestly", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    configureSuccessfulOwnerApi(fetchMock, {
      vehicles: [vehicle()],
      discovery: { status: "OK", location: { mode: "AREA", radiusKm: null, city: "Pune" }, results: [], noResultsWithinRadius: false, unsupported: [] },
    });
    await openServices(fetchMock);
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Pune" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("No matching services found.")).toBeInTheDocument();
  });

  it("lists results with the no-ratings note and labels unverified vendors", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    configureSuccessfulOwnerApi(fetchMock, {
      vehicles: [vehicle()],
      discovery: {
        status: "OK",
        location: { mode: "AREA", radiusKm: null, city: "Pune" },
        noResultsWithinRadius: false,
        unsupported: [],
        results: [{
          serviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          name: "Full exterior wash",
          description: null,
          category: "EXTERIOR_WASH",
          pricePaise: 50000,
          durationMinutes: 45,
          inclusions: [],
          exclusions: [],
          terms: null,
          distanceKm: null,
          vendor: { businessName: "Test Garage", city: "Pune", verificationStatus: "UNVERIFIED" },
        }],
      },
    });
    await openServices(fetchMock);
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Pune" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Full exterior wash")).toBeInTheDocument();
    expect(screen.getByText(/Not verified/)).toBeInTheDocument();
    expect(screen.getByText(/Ratings, live availability and sponsored placement are not available/)).toBeInTheDocument();
  });

  it("shows a retryable error when marketplace bookings fail to load", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    configureSuccessfulOwnerApi(fetchMock, { vehicles: [vehicle()], marketplaceBookingsStatus: 500 });
    await openServices(fetchMock);
    expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
    expect(screen.queryByText("No marketplace bookings.")).not.toBeInTheDocument();
  });
});

describe("Owner dashboard with real marketplace bookings", () => {
  const bookingFixture = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    vehicleId: vehicle().id,
    vehicleRegistration: "MH 12 AB 1234",
    serviceName: "Full exterior wash",
    vendorBusinessName: "P8 Test Garage",
    status: "ACCEPTED",
    windowStart: "2030-01-01T06:00:00.000Z",
    windowEnd: "2030-01-01T07:00:00.000Z",
    servicePricePaise: 50_000,
    payment: { state: "PARTIALLY_VERIFIED", verifiedPaise: 10_000, outstandingPaise: 40_000 },
    dispute: "NONE",
    refundState: "NONE",
  };
  const connectedDashboard = {
    ...emptyDashboard,
    summary: { ...emptyDashboard.summary, totalVehicles: 1, activeVehicles: 1, vehiclesWithoutProvider: 1 },
    vehicles: [{
      vehicleId: vehicle().id,
      serviceStatus: "NO_PROVIDER",
      providerType: null,
      providerVerified: false,
      upcomingService: { bookingId: bookingFixture.id, serviceName: "Full exterior wash", windowStart: bookingFixture.windowStart, windowEnd: bookingFixture.windowEnd, status: "ACCEPTED" },
      currentWashStatus: null,
    }],
    marketplace: {
      connected: true,
      counts: { total: 1, awaitingVendor: 0, confirmed: 1, disputed: 0, cancelled: 0 },
      bookings: [bookingFixture],
    },
    recentActivity: [
      { id: "event:1", kind: "BOOKING_EVENT", vehicleId: vehicle().id, registrationNumber: "MH 12 AB 1234", occurredAt: "2030-01-01T05:00:00.000Z", bookingId: bookingFixture.id, eventKind: "accept", serviceName: "Full exterior wash" },
    ],
    availability: { bookings: { available: true }, billing: { available: false }, notifications: { available: false } },
  };

  it("shows real booking, upcoming service, payment state and activity, and keeps billing unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    configureSuccessfulOwnerApi(fetchMock, { vehicles: [vehicle()], dashboard: connectedDashboard });
    await signInAsOwner(fetchMock);
    const section = await screen.findByRole("region", { name: "Marketplace bookings" });
    expect(within(section).getByText(/P8 Test Garage/)).toBeInTheDocument();
    expect(within(section).getByText(/Partly verified/)).toBeInTheDocument();
    expect(within(section).getByText(/1 confirmed/)).toBeInTheDocument();
    expect(screen.getAllByText("Full exterior wash").length).toBeGreaterThan(0);
    expect(screen.queryByText("Booking data is not available")).not.toBeInTheDocument();
    expect(screen.getByText("No invoice data is available yet")).toBeInTheDocument();
    expect(screen.getByText("Full exterior wash: accept")).toBeInTheDocument();
  });

  it("shows an honest empty bookings state when connected but there are none", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const dashboard = {
      ...emptyDashboard,
      marketplace: { ...emptyDashboard.marketplace, connected: true },
      availability: { ...emptyDashboard.availability, bookings: { available: true } },
    };
    configureSuccessfulOwnerApi(fetchMock, { vehicles: [vehicle()], dashboard });
    await signInAsOwner(fetchMock);
    const section = await screen.findByRole("region", { name: "Marketplace bookings" });
    expect(within(section).getByText("No marketplace bookings.")).toBeInTheDocument();
    expect(screen.getByText("No confirmed marketplace booking")).toBeInTheDocument();
  });

  it("does not show a booking section when booking data is unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    configureSuccessfulOwnerApi(fetchMock, { vehicles: [vehicle()] });
    await signInAsOwner(fetchMock);
    expect(screen.queryByRole("region", { name: "Marketplace bookings" })).not.toBeInTheDocument();
  });
});

describe("Superadmin console", () => {
  const adminSession = {
    ...session,
    user: { ...session.user, email: "admin@example.test", role: "SUPERADMIN", displayName: "Ada Admin", accountId: null },
  };
  const account = {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    email: "someone@example.test",
    status: "ACTIVE",
    createdAt: "2030-01-01T00:00:00.000Z",
    role: "OWNER",
    displayName: "Some Owner",
    accountId: null,
    suspension: null,
  };

  afterEach(() => {
    window.location.hash = "";
  });

  it("offers no registration, signs in as SUPERADMIN and suspends with a recorded reason", async () => {
    window.location.hash = "#admin";
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/auth/login") return jsonResponse(adminSession);
      if (path.startsWith("/admin/accounts/") && path.endsWith("/suspend")) {
        return jsonResponse({ account: { ...account, status: "DISABLED", suspension: { reason: "Fraud review", at: "2030-01-02T00:00:00.000Z" } } });
      }
      if (path.startsWith("/admin/accounts")) return jsonResponse({ accounts: [account] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Operations sign-in." })).toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace")).not.toBeInTheDocument();
    expect(screen.queryByText(/create .* account/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Email address" }), { target: { value: "admin@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery-staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Find and review accounts" })).toBeInTheDocument();
    expect(JSON.parse(String((fetchMock.mock.calls.find(([url]) => url === "/auth/login")?.[1] as RequestInit).body))).toMatchObject({ role: "SUPERADMIN" });
    expect(await screen.findByText("Some Owner")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Fraud review" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm suspension" }));
    expect(await screen.findByText(/Account suspended/)).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/suspend"));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ reason: "Fraud review" });
  });

  it("shows an honest empty state for payments and requires evidence to verify", async () => {
    document.cookie = "autospokes_csrf=csrf; path=/";
    window.location.hash = "#admin";
    const payment = {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      bookingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      bookingStatus: "CUSTOMER_ACCEPTED",
      agreedPricePaise: 50000,
      amountPaise: 50000,
      currency: "INR",
      method: "UPI",
      status: "RECORDED_UNVERIFIED",
      createdAt: "2030-01-01T00:00:00.000Z",
      verifiedAt: null,
      verificationSource: null,
      hasEvidence: false,
      failedAt: null,
    };
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/auth/refresh") return jsonResponse(adminSession);
      if (path.startsWith("/admin/accounts")) return jsonResponse({ accounts: [] });
      if (path.includes("/verify")) return jsonResponse({ payment: { id: payment.id, status: "VERIFIED" } });
      if (path.startsWith("/admin/marketplace/payments")) return jsonResponse({ payments: [payment] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    expect(await screen.findByText("No accounts match.")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Payments" })[0]!);
    expect(await screen.findByText(/Recorded unverified/)).toBeInTheDocument();
    expect(screen.getByText(/No payment gateway is connected/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    const evidence = screen.getByLabelText(/Evidence reference/);
    expect(evidence).toBeRequired();
    fireEvent.change(evidence, { target: { value: "bank-statement-line-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark verified" }));
    expect(await screen.findByText(/no money was moved by Autospokes/)).toBeInTheDocument();
  });

  it("does not show the Superadmin console to an Owner session", async () => {
    document.cookie = "autospokes_csrf=csrf; path=/";
    const fetchMock = vi.fn<typeof fetch>();
    configureSuccessfulOwnerApi(fetchMock, { vehicles: [] });
    await signInAsOwner(fetchMock);
    expect(screen.queryByLabelText("Superadmin navigation")).not.toBeInTheDocument();
  });
});
