import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  actOnMarketplaceBooking,
  assignMarketplaceStaff,
  createMarketplaceService,
  createMarketplaceStaff,
  getMarketplaceBooking,
  getMarketplaceBookings,
  getMarketplaceDashboard,
  getMarketplaceProfile,
  getMarketplaceServices,
  getMarketplaceStaff,
  recordMarketplacePayment,
  respondToMarketplaceDispute,
  cancelMarketplaceBookingAsVendor,
  saveMarketplaceProfile,
  setMarketplaceServiceStatus,
  signOut,
  updateMarketplaceService,
  updateMarketplaceStaff,
  type AuthSession,
  type MarketplaceBookingDetailView,
  type MarketplaceBookingView,
  type MarketplaceDashboard,
  type MarketplaceRecord,
} from "./api";
import { Icon, type IconName } from "./components/Icon";

type Page = "Dashboard" | "Business profile" | "Services" | "Staff" | "Bookings";
const pages: { name: Page; icon: IconName }[] = [
  { name: "Dashboard", icon: "grid" },
  { name: "Bookings", icon: "calendar" },
  { name: "Services", icon: "sparkle" },
  { name: "Staff", icon: "user" },
  { name: "Business profile", icon: "store" },
];

const SERVICE_CATEGORIES = ["EXTERIOR_WASH", "INTERIOR_CLEANING", "DETAILING", "POLISH_AND_COATING", "PERIODIC_SERVICE", "REPAIR", "TYRE_AND_WHEEL", "OTHER"];
const BUSINESS_CATEGORIES = ["GARAGE", "DETAILING_CENTRE", "MOBILE_DETAILER", "OTHER"];
const VEHICLE_TYPES = [
  { value: "TWO_WHEELER", label: "Two-wheeler" },
  { value: "FOUR_WHEELER", label: "Four-wheeler" },
  { value: "OTHER", label: "Other" },
];
const PAYMENT_METHODS = ["CASH", "UPI", "BANK_TRANSFER", "CARD", "OTHER"];

export const label = (value: string): string =>
  value.toLowerCase().replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());
export const paise = (value: number): string =>
  `₹${(value / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const formatWindow = (start: string, end: string): string => {
  const options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" };
  return `${new Intl.DateTimeFormat("en-IN", options).format(new Date(start))} – ${new Intl.DateTimeFormat("en-IN", { timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(end))} IST`;
};
const text = (record: Record<string, unknown> | null | undefined, key: string): string =>
  typeof record?.[key] === "string" ? (record[key] as string) : "";
const list = (record: Record<string, unknown> | null | undefined, key: string): string[] =>
  Array.isArray(record?.[key]) ? (record![key] as string[]) : [];
const splitList = (value: FormDataEntryValue | null): string[] =>
  String(value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
const optional = (value: FormDataEntryValue | null): string | null => {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const fields = error instanceof ApiError ? error.fieldErrors : {};
  return (
    <div className="notice notice-error" role="alert">
      <div>
        <strong>{error instanceof Error ? error.message : "Something went wrong. Please try again."}</strong>
        {Object.entries(fields).map(([field, messages]) => (
          <div key={field}>{field}: {messages.join(" ")}</div>
        ))}
      </div>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone = ["ACCEPTED", "IN_PROGRESS", "CUSTOMER_ACCEPTED", "ACTIVE"].includes(status) ? "status-active" : "";
  return <span className={`status-pill ${tone}`}>{label(status)}</span>;
}

function Heading({ title, description }: { title: string; description: string }) {
  return (
    <div className="owner-page-heading">
      <div><p className="section-kicker">MARKETPLACE VENDOR</p><h1>{title}</h1><p>{description}</p></div>
    </div>
  );
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><h2>{title}</h2><p>{detail}</p></div>;
}

export function MarketplaceWorkspace({ session, onSignOut }: { session: AuthSession; onSignOut: () => void }) {
  const [page, setPage] = useState<Page>("Dashboard");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dashboard, setDashboard] = useState<MarketplaceDashboard | null>(null);
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  const [services, setServices] = useState<MarketplaceRecord[]>([]);
  const [staff, setStaff] = useState<MarketplaceRecord[]>([]);
  const [bookings, setBookings] = useState<MarketplaceBookingView[]>([]);
  const [detail, setDetail] = useState<MarketplaceBookingDetailView | null>(null);
  const [editingService, setEditingService] = useState<MarketplaceRecord | null>(null);
  const [showServiceForm, setShowServiceForm] = useState(false);

  const load = useCallback(async () => {
    const [nextDashboard, nextProfile, nextServices, nextStaff, nextBookings] = await Promise.all([
      getMarketplaceDashboard(session),
      getMarketplaceProfile(session),
      getMarketplaceServices(session),
      getMarketplaceStaff(session),
      getMarketplaceBookings(session),
    ]);
    setDashboard(nextDashboard);
    setProfile(nextProfile.profile);
    setServices(nextServices);
    setStaff(nextStaff);
    setBookings(nextBookings);
  }, [session]);

  useEffect(() => {
    let active = true;
    load()
      .catch((cause: unknown) => { if (active) setError(cause); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load]);

  async function mutate(operation: () => Promise<unknown>, message: string): Promise<boolean> {
    setSaving(true);
    setError(null);
    setNotice("");
    try {
      await operation();
      await load();
      setNotice(message);
      return true;
    } catch (cause) {
      setError(cause);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function openBooking(id: string) {
    setError(null);
    try {
      setDetail(await getMarketplaceBooking(session, id));
    } catch (cause) {
      setError(cause);
    }
  }

  async function actOnBooking(action: "accept" | "reject" | "start" | "complete", body: Record<string, unknown>, message: string) {
    if (!detail) return;
    const id = detail.booking.id;
    const ok = await mutate(() => actOnMarketplaceBooking(session, id, action, body), message);
    if (ok) await openBooking(id);
  }

  async function handleSignOut() {
    try { await signOut(session); } finally { onSignOut(); }
  }

  const businessName = text(profile, "businessName") || session.user.displayName;
  const initials = businessName.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  const profileComplete = profile !== null;

  function renderDashboard() {
    if (!dashboard) return null;
    const counts = dashboard.bookingCounts;
    return (
      <>
        <Heading title="Dashboard" description="A live view of your requests and catalogue. Nothing here is estimated." />
        {!profileComplete && (
          <div className="detailer-onboarding">
            <p className="section-kicker">PROFILE SETUP</p>
            <h1>Set up your business profile.</h1>
            <p>Customers cannot find your services until your profile and at least one active service exist.</p>
            <button className="primary-button" type="button" onClick={() => setPage("Business profile")}>Complete profile <Icon name="arrow-up-right" size={16} /></button>
          </div>
        )}
        <section className="stat-grid" aria-label="Summary">
          <article className="stat-card"><div className="stat-top"><span className="stat-icon"><Icon name="clock" size={15} /></span></div><div className="stat-value">{counts.REQUESTED ?? 0}</div><div className="stat-label">New requests</div><div className="stat-note">Awaiting your response</div></article>
          <article className="stat-card"><div className="stat-top"><span className="stat-icon"><Icon name="calendar" size={15} /></span></div><div className="stat-value">{(counts.ACCEPTED ?? 0) + (counts.IN_PROGRESS ?? 0)}</div><div className="stat-label">Active bookings</div><div className="stat-note">Accepted or in progress</div></article>
          <article className="stat-card"><div className="stat-top"><span className="stat-icon"><Icon name="sparkle" size={15} /></span></div><div className="stat-value">{dashboard.services.active}</div><div className="stat-label">Active services</div><div className="stat-note">{dashboard.staff.available} staff available</div></article>
        </section>
        <section className="owner-section">
          <div className="owner-section-heading"><div><p className="section-kicker">UPCOMING</p><h2>Accepted bookings</h2></div></div>
          {dashboard.upcoming.length === 0 ? (
            <Empty title="No accepted bookings yet." detail="Accepted and in-progress bookings appear here in time order." />
          ) : (
            <ul className="status-list">
              {dashboard.upcoming.map((booking) => (
                <li key={booking.id} className="service-row">
                  <span className="registration-chip">{booking.vehicleRegistration}</span>
                  <span><strong>{booking.serviceName}</strong><small>{formatWindow(booking.windowStart, booking.windowEnd)}</small></span>
                  <button className="text-button" type="button" onClick={() => { setPage("Bookings"); void openBooking(booking.id); }}>Open</button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="unavailable-grid" aria-label="Not yet available">
          <article className="detail-card"><h2>Verification</h2><p>{dashboard.availability.verification}</p></article>
          <article className="detail-card"><h2>Settlement &amp; revenue</h2><p>{dashboard.availability.settlement} Revenue and ratings are not shown because no verified data exists.</p></article>
        </section>
      </>
    );
  }

  async function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const latitude = optional(form.get("latitude"));
    const longitude = optional(form.get("longitude"));
    const radius = optional(form.get("serviceRadiusKm"));
    await mutate(() => saveMarketplaceProfile(session, {
      businessName: String(form.get("businessName") ?? "").trim(),
      description: optional(form.get("description")),
      category: String(form.get("category")),
      contactPhone: String(form.get("contactPhone") ?? "").trim(),
      contactEmail: optional(form.get("contactEmail")),
      addressLine: optional(form.get("addressLine")),
      city: optional(form.get("city")),
      postalCode: optional(form.get("postalCode")),
      latitude: latitude === null ? null : Number(latitude),
      longitude: longitude === null ? null : Number(longitude),
      serviceRadiusKm: radius === null ? null : Number(radius),
      serviceAreas: splitList(form.get("serviceAreas")),
      supportedVehicleTypes: form.getAll("supportedVehicleTypes"),
    }), "Business profile saved.");
  }

  function renderProfile() {
    const supported = list(profile, "supportedVehicleTypes");
    const status = text(profile, "verificationStatus") || "PENDING";
    return (
      <>
        <Heading title="Business profile" description="How customers see your business. Location is used only to match nearby requests." />
        <p className="owner-form-note">Verification status: <StatusPill status={status} /> Autospokes has no verification review process yet, so this stays pending.</p>
        <form className="owner-form profile-form" key={String(profile?.updatedAt ?? "new")} onSubmit={submitProfile}>
          <label>Business name<input name="businessName" defaultValue={text(profile, "businessName")} maxLength={120} required /></label>
          <label>Business type<select name="category" defaultValue={text(profile, "category") || "GARAGE"}>{BUSINESS_CATEGORIES.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
          <label>Contact phone<input name="contactPhone" type="tel" defaultValue={text(profile, "contactPhone")} autoComplete="tel" required /><small>Shown to customers only after you accept a request. Not verified by SMS.</small></label>
          <label>Contact email (optional)<input name="contactEmail" type="email" defaultValue={text(profile, "contactEmail")} maxLength={254} /></label>
          <label>Description (optional)<input name="description" defaultValue={text(profile, "description")} maxLength={1000} /></label>
          <label>Address (optional)<input name="addressLine" defaultValue={text(profile, "addressLine")} maxLength={240} /></label>
          <label>City<input name="city" defaultValue={text(profile, "city")} maxLength={100} /></label>
          <label>Postal code (optional)<input name="postalCode" defaultValue={text(profile, "postalCode")} maxLength={24} /></label>
          <label>Latitude (optional)<input name="latitude" inputMode="decimal" defaultValue={profile?.latitude == null ? "" : String(profile.latitude)} /></label>
          <label>Longitude (optional)<input name="longitude" inputMode="decimal" defaultValue={profile?.longitude == null ? "" : String(profile.longitude)} /><small>Provide both coordinates or neither. Needed for distance-based discovery.</small></label>
          <label>Service radius in km (optional)<input name="serviceRadiusKm" inputMode="numeric" defaultValue={profile?.serviceRadiusKm == null ? "" : String(profile.serviceRadiusKm)} /></label>
          <label>Service areas (comma separated)<input name="serviceAreas" defaultValue={list(profile, "serviceAreas").join(", ")} /></label>
          <fieldset className="check-group">
            <legend>Vehicle types you serve</legend>
            {VEHICLE_TYPES.map((type) => (
              <label key={type.value} className="check-option"><input type="checkbox" name="supportedVehicleTypes" value={type.value} defaultChecked={supported.includes(type.value)} /> {type.label}</label>
            ))}
          </fieldset>
          <button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save profile"}</button>
        </form>
      </>
    );
  }

  async function submitService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const rupees = Number(String(form.get("priceRupees") ?? ""));
    const body = {
      name: String(form.get("name") ?? "").trim(),
      description: optional(form.get("description")),
      category: String(form.get("category")),
      vehicleTypes: form.getAll("vehicleTypes"),
      pricePaise: Number.isFinite(rupees) ? Math.round(rupees * 100) : 0,
      durationMinutes: Number(form.get("durationMinutes")),
      inclusions: splitList(form.get("inclusions")),
      exclusions: splitList(form.get("exclusions")),
      terms: optional(form.get("terms")),
      serviceAreas: splitList(form.get("serviceAreas")),
    };
    const current = editingService;
    const ok = await mutate(
      () => (current ? updateMarketplaceService(session, current.id, body) : createMarketplaceService(session, body)),
      current ? "Service updated. Existing bookings keep the terms they were made under." : "Service added.",
    );
    if (ok) {
      setEditingService(null);
      setShowServiceForm(false);
    }
  }

  function renderServices() {
    const editing = editingService;
    return (
      <>
        <Heading title="Services" description="Your catalogue. Prices are agreed per booking and kept even if you edit them later." />
        {!showServiceForm && <button className="primary-button" type="button" onClick={() => { setEditingService(null); setShowServiceForm(true); }}><Icon name="plus" size={16} /> Add service</button>}
        {showServiceForm && (
          <form className="owner-form profile-form" key={editing?.id ?? "new"} onSubmit={submitService}>
            <label>Service name<input name="name" defaultValue={text(editing, "name")} maxLength={120} required /></label>
            <label>Category<select name="category" defaultValue={text(editing, "category") || "EXTERIOR_WASH"}>{SERVICE_CATEGORIES.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
            <label>Price in rupees<input name="priceRupees" inputMode="decimal" defaultValue={editing ? String(Number(editing.pricePaise) / 100) : ""} required /><small>Must be greater than zero.</small></label>
            <label>Duration in minutes<input name="durationMinutes" inputMode="numeric" defaultValue={editing ? String(editing.durationMinutes) : "60"} required /></label>
            <label>Description (optional)<input name="description" defaultValue={text(editing, "description")} maxLength={1000} /></label>
            <label>Inclusions (comma separated)<input name="inclusions" defaultValue={list(editing, "inclusions").join(", ")} /></label>
            <label>Exclusions (comma separated)<input name="exclusions" defaultValue={list(editing, "exclusions").join(", ")} /></label>
            <label>Terms (optional)<input name="terms" defaultValue={text(editing, "terms")} maxLength={2000} /></label>
            <label>Service areas (optional, comma separated)<input name="serviceAreas" defaultValue={list(editing, "serviceAreas").join(", ")} /></label>
            <fieldset className="check-group">
              <legend>Vehicle types</legend>
              {VEHICLE_TYPES.map((type) => (
                <label key={type.value} className="check-option"><input type="checkbox" name="vehicleTypes" value={type.value} defaultChecked={editing ? list(editing, "vehicleTypes").includes(type.value) : type.value === "FOUR_WHEELER"} /> {type.label}</label>
              ))}
            </fieldset>
            <div className="form-actions">
              <button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : editing ? "Save changes" : "Add service"}</button>
              <button className="secondary-button" type="button" onClick={() => { setShowServiceForm(false); setEditingService(null); }}>Cancel</button>
            </div>
          </form>
        )}
        {services.length === 0 ? (
          <Empty title="No services yet." detail="Add your first service so Owners can request it." />
        ) : (
          <ul className="status-list">
            {services.map((service) => (
              <li key={service.id} className="service-row">
                <span className="registration-chip">{paise(Number(service.pricePaise))}</span>
                <span><strong>{text(service, "name")}</strong><small>{label(text(service, "category"))} · {String(service.durationMinutes)} min · <StatusPill status={text(service, "status")} /></small></span>
                {text(service, "status") !== "ARCHIVED" && (
                  <span className="row-actions">
                    <button className="text-button" type="button" onClick={() => { setEditingService(service); setShowServiceForm(true); }}>Edit</button>
                    <button className="text-button" type="button" disabled={saving} onClick={() => void mutate(() => setMarketplaceServiceStatus(session, service.id, text(service, "status") === "ACTIVE" ? "INACTIVE" : "ACTIVE"), "Service status updated.")}>{text(service, "status") === "ACTIVE" ? "Pause" : "Activate"}</button>
                    <button className="text-button" type="button" disabled={saving} onClick={() => { if (window.confirm("Archive this service? This cannot be undone.")) void mutate(() => setMarketplaceServiceStatus(session, service.id, "ARCHIVED"), "Service archived."); }}>Archive</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  async function submitStaff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const ok = await mutate(() => createMarketplaceStaff(session, {
      name: String(form.get("name") ?? "").trim(),
      phoneNumber: optional(form.get("phoneNumber")),
      skills: splitList(form.get("skills")),
    }), "Staff member added.");
    if (ok) formElement.reset();
  }

  function renderStaff() {
    return (
      <>
        <Heading title="Staff" description="A directory for assigning accepted bookings. Staff do not have logins in this release." />
        <form className="owner-form profile-form" onSubmit={submitStaff}>
          <label>Name<input name="name" maxLength={100} required /></label>
          <label>Phone (optional)<input name="phoneNumber" type="tel" /></label>
          <label>Skills (comma separated)<input name="skills" /></label>
          <button className="primary-button" type="submit" disabled={saving}>Add staff member</button>
        </form>
        {staff.length === 0 ? (
          <Empty title="No staff added." detail="Add staff to assign them to accepted bookings." />
        ) : (
          <ul className="status-list">
            {staff.map((member) => (
              <li key={member.id} className="service-row">
                <span className="registration-chip">{String(member.openBookings ?? 0)} open</span>
                <span><strong>{text(member, "name")}</strong><small>{member.active ? (member.available ? "Available" : "Unavailable") : "Inactive"}{list(member, "skills").length ? ` · ${list(member, "skills").join(", ")}` : ""}</small></span>
                <span className="row-actions">
                  {Boolean(member.active) && <button className="text-button" type="button" disabled={saving} onClick={() => void mutate(() => updateMarketplaceStaff(session, member.id, { available: !member.available }), "Availability updated.")}>{member.available ? "Mark unavailable" : "Mark available"}</button>}
                  <button className="text-button" type="button" disabled={saving} onClick={() => void mutate(() => updateMarketplaceStaff(session, member.id, { active: !member.active }), "Staff member updated.")}>{member.active ? "Deactivate" : "Reactivate"}</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  function renderBookingDetail() {
    if (!detail) return null;
    const { booking } = detail;
    const staffOptions = staff.filter((member) => member.active && member.available);
    return (
      <section className="panel booking-detail" aria-label="Booking detail">
        <div className="owner-section-heading">
          <div><p className="section-kicker">BOOKING</p><h2>{booking.serviceName}</h2></div>
          <button className="text-button" type="button" onClick={() => setDetail(null)}>Close</button>
        </div>
        <dl className="detail-list">
          <div><dt>Status</dt><dd><StatusPill status={booking.status} /></dd></div>
          <div><dt>Vehicle</dt><dd>{booking.vehicleRegistration}</dd></div>
          <div><dt>When</dt><dd>{formatWindow(booking.windowStart, booking.windowEnd)}</dd></div>
          <div><dt>Where</dt><dd>{booking.serviceLocation}</dd></div>
          {booking.accessNotes && <div><dt>Access notes</dt><dd>{booking.accessNotes}</dd></div>}
          <div><dt>Agreed price</dt><dd>{paise(booking.servicePricePaise)}</dd></div>
          <div><dt>Assigned staff</dt><dd>{detail.assignedStaffName ?? "None"}</dd></div>
        </dl>
        {booking.status === "REQUESTED" && (
          <div className="form-actions">
            <button className="primary-button" type="button" disabled={saving} onClick={() => void actOnBooking("accept", {}, "Booking accepted.")}>Accept request</button>
            <form className="inline-form" onSubmit={(event) => { event.preventDefault(); const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim(); void actOnBooking("reject", { reason }, "Request declined."); }}>
              <label>Reason for declining<input name="reason" maxLength={500} required /></label>
              <button className="secondary-button" type="submit" disabled={saving}>Decline</button>
            </form>
          </div>
        )}
        {booking.status === "ACCEPTED" && <button className="primary-button" type="button" disabled={saving} onClick={() => void actOnBooking("start", {}, "Job started.")}>Start job</button>}
        {(booking.status === "ACCEPTED" || booking.status === "IN_PROGRESS") && (
          <label className="inline-select">Assign staff
            <select value={detail.assignedStaffId ?? ""} disabled={saving} onChange={(event) => { const id = event.target.value || null; void mutate(() => assignMarketplaceStaff(session, booking.id, id), "Staff assignment updated.").then(() => openBooking(booking.id)); }}>
              <option value="">Unassigned</option>
              {staffOptions.map((member) => <option key={member.id} value={member.id}>{text(member, "name")}</option>)}
            </select>
          </label>
        )}
        {booking.status === "IN_PROGRESS" && (
          <form className="owner-form" onSubmit={(event) => { event.preventDefault(); const notes = String(new FormData(event.currentTarget).get("notes") ?? "").trim(); void actOnBooking("complete", { notes }, "Completion reported. The Owner must confirm it."); }}>
            <label>Completion notes<input name="notes" maxLength={1000} required /></label>
            <button className="primary-button" type="submit" disabled={saving}>Report completed</button>
          </form>
        )}
        {booking.status === "PROVIDER_REPORTED_COMPLETION" && <p className="owner-form-note">Waiting for the Owner to confirm or dispute completion.</p>}
        {booking.status === "DISPUTED" && <p className="owner-form-note">The Owner disputed this booking: {booking.disputeReason}. The platform resolves disputes; settlement is paused until then.</p>}
        {detail.disputes.map((dispute) => (
          <article key={dispute.id} className="detail-card">
            <h3>Dispute: {label(dispute.status)}</h3>
            <ul className="status-list">
              {dispute.entries.map((entry) => <li key={entry.id}><span><strong>{label(entry.kind)}</strong><small>{label(entry.actorRole)}{entry.message ? `: ${entry.message}` : ""}</small></span></li>)}
            </ul>
            {dispute.status === "RESOLVED" && <p className="owner-form-note">Outcome: {label(dispute.outcome ?? "")}. {dispute.resolutionRationale}</p>}
            {dispute.status === "OPEN" && (
              <form className="owner-form" onSubmit={(event) => { event.preventDefault(); const message = String(new FormData(event.currentTarget).get("message") ?? "").trim(); void mutate(() => respondToMarketplaceDispute(session, booking.id, message), "Response recorded.").then(() => openBooking(booking.id)); }}>
                <label>Your response<input name="message" maxLength={2000} required /></label>
                <button className="secondary-button" type="submit" disabled={saving}>Send response</button>
              </form>
            )}
          </article>
        ))}
        {detail.cancellation && <p className="owner-form-note">Cancelled ({label(detail.cancellation.kind)}): {detail.cancellation.reason}. No cancellation fee was applied.</p>}
        {booking.status === "ACCEPTED" && (
          <form className="inline-form" onSubmit={(event) => { event.preventDefault(); const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim(); void mutate(() => cancelMarketplaceBookingAsVendor(session, booking.id, reason), "Booking cancelled. No fee or refund is applied automatically.").then(() => openBooking(booking.id)); }}>
            <label>Reason for cancelling<input name="reason" maxLength={500} required /></label>
            <button className="secondary-button" type="submit" disabled={saving}>Cancel booking</button>
          </form>
        )}
        {!["REQUESTED", "REJECTED", "CANCELLED"].includes(booking.status) && (
          <>
            <h3>Payments you have recorded</h3>
            <p className="owner-form-note">{detail.payment.note} Recorded {paise(detail.payment.recordedPaise)} of {paise(booking.servicePricePaise)}. Verified by the platform: {paise(detail.payment.verifiedPaise)}.</p>
            <ul className="status-list">
              {detail.payments.map((payment) => <li key={payment.id} className="service-row"><span className="registration-chip">{paise(payment.amountPaise)}</span><span><strong>{label(payment.method)}</strong><small>{label(payment.status)}{payment.reference ? ` · ${payment.reference}` : ""}</small></span></li>)}
            </ul>
            <form className="owner-form" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const rupees = Number(String(form.get("amount") ?? "")); void mutate(() => recordMarketplacePayment(session, booking.id, { amountPaise: Math.round(rupees * 100), method: String(form.get("method")), reference: optional(form.get("reference")) }, `pay-${crypto.randomUUID()}`), "Payment note recorded as unverified.").then(() => openBooking(booking.id)); }}>
              <label>Amount received (rupees)<input name="amount" inputMode="decimal" required /></label>
              <label>Method<select name="method">{PAYMENT_METHODS.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
              <label>Reference (optional)<input name="reference" maxLength={120} /></label>
              <button className="secondary-button" type="submit" disabled={saving}>Record payment note</button>
            </form>
          </>
        )}
        <h3>History</h3>
        <ul className="status-list">
          {detail.events.map((event) => <li key={event.id} className="service-row"><span className="registration-chip">{label(event.kind)}</span><span><strong>{event.toStatus ? label(event.toStatus) : "Update"}</strong><small>{new Date(event.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}{event.note ? ` · ${event.note}` : ""}</small></span></li>)}
        </ul>
      </section>
    );
  }

  function renderBookings() {
    return (
      <>
        <Heading title="Bookings" description="Requests from Owners. Vehicle and address details are shared once you accept." />
        {bookings.length === 0 ? (
          <Empty title="No booking requests yet." detail="Once your profile and an active service exist, Owners nearby can request them." />
        ) : (
          <ul className="status-list">
            {bookings.map((booking) => (
              <li key={booking.id} className="service-row">
                <span className="registration-chip">{booking.vehicleRegistration}</span>
                <span><strong>{booking.serviceName}</strong><small>{formatWindow(booking.windowStart, booking.windowEnd)} · <StatusPill status={booking.status} /></small></span>
                <button className="text-button" type="button" onClick={() => void openBooking(booking.id)}>View</button>
              </li>
            ))}
          </ul>
        )}
        {renderBookingDetail()}
      </>
    );
  }

  const body = () => {
    if (page === "Dashboard") return renderDashboard();
    if (page === "Business profile") return renderProfile();
    if (page === "Services") return renderServices();
    if (page === "Staff") return renderStaff();
    return renderBookings();
  };

  return (
    <div className="owner-app marketplace-app">
      <aside className="owner-sidebar">
        <a className="brand" href="/" aria-label="Autospokes"><span className="brand-mark"><Icon name="steering" size={20} /></span><span className="brand-word">auto<span>spokes</span></span></a>
        <p className="workspace-label">MARKETPLACE VENDOR</p>
        <nav className="owner-nav" aria-label="Marketplace Vendor navigation">
          {pages.map((item) => <button key={item.name} type="button" className={`owner-nav-item ${page === item.name ? "owner-nav-active" : ""}`} aria-current={page === item.name ? "page" : undefined} onClick={() => setPage(item.name)}><Icon name={item.icon} size={18} /><span>{item.name}</span></button>)}
        </nav>
        <div className="owner-sidebar-bottom"><div className="owner-account"><span className="avatar">{initials || "AS"}</span><span className="profile-copy"><strong>{businessName}</strong><small>Marketplace Vendor</small></span><button type="button" aria-label="Sign out" onClick={() => void handleSignOut()}><Icon name="more" size={18} /></button></div></div>
      </aside>
      <main className="owner-main">
        <header className="owner-topbar"><a className="brand brand-compact" href="/" aria-label="Autospokes"><span className="brand-mark"><Icon name="steering" size={18} /></span><span className="brand-word">auto<span>spokes</span></span></a><div className="topbar-context"><span>Marketplace Vendor</span><Icon name="chevron" size={14} /><strong>{page}</strong></div><div className="owner-top-actions"><span className="top-avatar">{initials || "AS"}</span><button className="mobile-signout" type="button" onClick={() => void handleSignOut()}>Sign out</button></div></header>
        <div className="owner-mobile-nav"><nav className="owner-nav" aria-label="Marketplace Vendor mobile navigation">{pages.map((item) => <button key={item.name} type="button" className={`owner-nav-item ${page === item.name ? "owner-nav-active" : ""}`} aria-current={page === item.name ? "page" : undefined} onClick={() => setPage(item.name)}><span>{item.name}</span></button>)}</nav></div>
        <div className="owner-content">
          <ErrorNotice error={error} />
          {notice && <div className="notice notice-success" role="status">{notice}</div>}
          {loading ? <div className="loading-panel" role="status">Loading Marketplace Vendor workspace…</div> : body()}
        </div>
      </main>
    </div>
  );
}
