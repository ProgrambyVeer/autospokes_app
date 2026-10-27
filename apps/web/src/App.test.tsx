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

function configureSuccessfulOwnerApi(fetchMock: ReturnType<typeof vi.fn>) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/auth/login") return jsonResponse(session);
    if (path === "/owner/profile") return jsonResponse(profile);
    if (path === "/owner/vehicles" && (init?.method ?? "GET") === "GET") {
      return jsonResponse({ vehicles: [] });
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
    expect(screen.getByText("Service records are not available yet")).toBeInTheDocument();
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
