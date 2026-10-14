import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("Autospokes shell", () => {
  it("shows all five workspaces", () => {
    const { container } = render(<App />);
    const mobileWorkspace = container.querySelector(".mobile-workspace");
    if (!(mobileWorkspace instanceof HTMLElement)) {
      throw new Error("Mobile workspace navigation is missing");
    }

    for (const role of [
      "Owner",
      "Independent Detailer",
      "Society Vendor",
      "Marketplace Vendor",
      "Superadmin",
    ]) {
      expect(within(mobileWorkspace).getByRole("button", { name: new RegExp(role) })).toBeInTheDocument();
    }
  });

  it("switches workspace and shows a navigation placeholder", () => {
    const { container } = render(<App />);
    const mobileWorkspace = container.querySelector(".mobile-workspace");
    const mobileNavigation = container.querySelector(".mobile-navigation");
    if (!(mobileWorkspace instanceof HTMLElement) || !(mobileNavigation instanceof HTMLElement)) {
      throw new Error("Mobile navigation is missing");
    }

    fireEvent.click(within(mobileWorkspace).getByRole("button", { name: /Superadmin/ }));
    expect(screen.getByText(/YOUR AUTOSPOKES SUPERADMIN SPACE/)).toBeInTheDocument();

    fireEvent.click(within(mobileNavigation).getByRole("button", { name: /My vehicles/ }));
    expect(screen.getByRole("heading", { name: "My vehicles" })).toBeInTheDocument();
    expect(screen.getByText(/being prepared/)).toBeInTheDocument();
  });
});
