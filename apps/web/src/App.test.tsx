import { CreateVehicleSchema } from "@autospokes/shared";
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
