import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { OwnerVehicle } from "@autospokes/shared";
import {
  cancelMarketplaceBookingAsOwner,
  createMarketplaceBooking,
  getOwnerMarketplaceBooking,
  getOwnerMarketplaceBookings,
  respondToMarketplaceCompletion,
  searchMarketplaceServices,
  type AuthSession,
  type MarketplaceBookingDetailView,
  type MarketplaceBookingView,
  type MarketplaceDiscovery,
} from "./api";
import { ErrorNotice, StatusPill, formatWindow, label, paise } from "./MarketplaceApp";

type Result = MarketplaceDiscovery["results"][number];

const newKey = (): string => `bk-${crypto.randomUUID()}`;

export function OwnerMarketplace({ session, vehicles }: { session: AuthSession; vehicles: OwnerVehicle[] }) {
  const activeVehicles = vehicles.filter((vehicle) => vehicle.status === "ACTIVE");
  const cities = [...new Set(activeVehicles.map((vehicle) => vehicle.city).filter((city): city is string => Boolean(city)))];
  const [city, setCity] = useState(cities[0] ?? "");
  const [category, setCategory] = useState("");
  const [vehicleType, setVehicleType] = useState("");
  const [radiusKm, setRadiusKm] = useState("");
  const [coordinates, setCoordinates] = useState<{ latitude: string; longitude: string } | null>(null);
  const [discovery, setDiscovery] = useState<MarketplaceDiscovery | null>(null);
  const [searching, setSearching] = useState(false);
  const [booking, setBooking] = useState<Result | null>(null);
  const [bookings, setBookings] = useState<MarketplaceBookingView[]>([]);
  const [bookingsState, setBookingsState] = useState<"loading" | "ready" | "error">("loading");
  const [detail, setDetail] = useState<MarketplaceBookingDetailView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKey = useRef(newKey());

  const loadBookings = useCallback(async () => {
    try {
      setBookings(await getOwnerMarketplaceBookings(session));
      setBookingsState("ready");
    } catch (cause) {
      setError(cause);
      setBookingsState("error");
    }
  }, [session]);

  useEffect(() => { void loadBookings(); }, [loadBookings]);

  async function search(event?: FormEvent) {
    event?.preventDefault();
    setError(null);
    setNotice("");
    setSearching(true);
    try {
      setDiscovery(await searchMarketplaceServices(session, {
        ...(coordinates ?? { city }),
        category,
        vehicleType,
        radiusKm,
      }));
    } catch (cause) {
      setError(cause);
    } finally {
      setSearching(false);
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setError(new Error("This browser cannot share your location. Search by city instead."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => setCoordinates({ latitude: String(position.coords.latitude), longitude: String(position.coords.longitude) }),
      () => setError(new Error("Location permission was not granted. Search by city instead.")),
    );
  }

  async function submitBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!booking) return;
    const form = new FormData(event.currentTarget);
    const start = String(form.get("start") ?? "");
    const durationMinutes = booking.durationMinutes;
    // The picker has no time zone; times are interpreted in IST, the zone the app uses everywhere.
    const windowStart = new Date(`${start}:00+05:30`);
    if (Number.isNaN(windowStart.getTime())) {
      setError(new Error("Choose a start date and time."));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await createMarketplaceBooking(session, idempotencyKey.current, {
        vehicleId: String(form.get("vehicleId")),
        serviceId: booking.serviceId,
        windowStart: windowStart.toISOString(),
        windowEnd: new Date(windowStart.getTime() + Math.max(durationMinutes, 60) * 60_000).toISOString(),
        serviceLocation: String(form.get("location") ?? "").trim(),
        accessNotes: String(form.get("notes") ?? "").trim() || null,
      });
      idempotencyKey.current = newKey();
      setBooking(null);
      setNotice(result.replayed ? "This request was already sent." : "Request sent. The vendor has not confirmed it yet.");
      await loadBookings();
    } catch (cause) {
      // The key is kept so a retry of the same request cannot create a duplicate.
      setError(cause);
    } finally {
      setSubmitting(false);
    }
  }

  async function openBooking(id: string) {
    setError(null);
    try {
      setDetail(await getOwnerMarketplaceBooking(session, id));
    } catch (cause) {
      setError(cause);
    }
  }

  async function respond(id: string, decision: "accept-completion" | "dispute", reason?: string) {
    setError(null);
    try {
      await respondToMarketplaceCompletion(session, id, decision, reason);
      setNotice(decision === "dispute" ? "Dispute recorded. It stays open until the platform resolves it." : "Completion confirmed.");
      await Promise.all([loadBookings(), openBooking(id)]);
    } catch (cause) {
      setError(cause);
    }
  }

  async function cancel(id: string, reason: string) {
    setError(null);
    try {
      await cancelMarketplaceBookingAsOwner(session, id, reason);
      setNotice("Booking cancelled. No fee was applied and no refund is automatic.");
      await Promise.all([loadBookings(), openBooking(id)]);
    } catch (cause) {
      setError(cause);
    }
  }

  return (
    <section className="owner-section owner-marketplace" aria-labelledby="marketplace-title">
      <div className="owner-section-heading"><div><p className="section-kicker">MARKETPLACE</p><h2 id="marketplace-title">Find a service</h2></div></div>
      <ErrorNotice error={error} />
      {notice && <div className="notice notice-success" role="status">{notice}</div>}
      <form className="owner-form profile-form" onSubmit={search}>
        <label>City<input value={city} onChange={(event) => { setCity(event.target.value); setCoordinates(null); }} list="owner-cities" maxLength={100} /><datalist id="owner-cities">{cities.map((value) => <option key={value} value={value} />)}</datalist></label>
        <label>Service type<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">Any</option>{["EXTERIOR_WASH", "INTERIOR_CLEANING", "DETAILING", "POLISH_AND_COATING", "PERIODIC_SERVICE", "REPAIR", "TYRE_AND_WHEEL", "OTHER"].map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
        <label>Vehicle type<select value={vehicleType} onChange={(event) => setVehicleType(event.target.value)}><option value="">Any</option><option value="TWO_WHEELER">Two-wheeler</option><option value="FOUR_WHEELER">Four-wheeler</option><option value="OTHER">Other</option></select></label>
        {coordinates && <label>Search radius in km<input value={radiusKm} inputMode="numeric" placeholder="10" onChange={(event) => setRadiusKm(event.target.value)} /></label>}
        <div className="form-actions">
          <button className="primary-button" type="submit" disabled={searching || (!city.trim() && !coordinates)}>{searching ? "Searching…" : "Search"}</button>
          <button className="secondary-button" type="button" onClick={useMyLocation}>{coordinates ? "Location shared" : "Use my location"}</button>
        </div>
      </form>

      {searching && <div className="loading-panel" role="status">Searching vendors…</div>}
      {discovery?.status === "LOCATION_REQUIRED" && <div className="empty-state"><h2>Add a location to search.</h2><p>Enter a city or share your location. Results are never shown without a location.</p></div>}
      {discovery?.status === "OK" && discovery.results.length === 0 && (
        <div className="empty-state">
          <h2>No matching services found.</h2>
          <p>{discovery.noResultsWithinRadius ? `Nothing is available within ${discovery.location?.radiusKm ?? 10} km.` : "No vendor lists a matching service for this area."}</p>
          {discovery.noResultsWithinRadius && <button className="secondary-button" type="button" onClick={() => { setRadiusKm(String(Math.min(200, (Number(radiusKm) || 10) * 2))); setNotice("Radius widened. Search again to include vendors further away."); }}>Widen the search radius</button>}
        </div>
      )}
      {discovery?.status === "OK" && discovery.results.length > 0 && (
        <ul className="status-list">
          {discovery.results.map((result) => (
            <li key={result.serviceId} className="service-row">
              <span className="registration-chip">{paise(result.pricePaise)}</span>
              <span>
                <strong>{result.name}</strong>
                <small>{result.vendor.businessName}{result.vendor.city ? `, ${result.vendor.city}` : ""} · {result.durationMinutes} min{result.distanceKm !== null ? ` · ${result.distanceKm} km away` : ""} · {result.vendor.verificationStatus === "VERIFIED" ? "Verified" : "Not verified"}</small>
                {result.inclusions.length > 0 && <small>Includes: {result.inclusions.join(", ")}</small>}
                {result.terms && <small>Terms: {result.terms}</small>}
              </span>
              <button className="text-button" type="button" disabled={activeVehicles.length === 0} onClick={() => { setBooking(result); setNotice(""); }}>Request</button>
            </li>
          ))}
        </ul>
      )}
      {discovery?.status === "OK" && <p className="owner-form-note">Ratings, live availability and sponsored placement are not available, so results are ordered by {discovery.location?.mode === "COORDINATES" ? "distance" : "price"} only.</p>}
      {activeVehicles.length === 0 && <p className="owner-form-note">Add an active vehicle to request a service.</p>}

      {booking && (
        <form className="owner-form profile-form booking-form" onSubmit={submitBooking} aria-label="Request a booking">
          <h3>Request: {booking.name}</h3>
          <p className="owner-form-note">{paise(booking.pricePaise)} agreed price, about {booking.durationMinutes} minutes. Nothing is paid through Autospokes and the vendor must accept before anything is confirmed.</p>
          <label>Vehicle<select name="vehicleId" required>{activeVehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.registrationNumber}</option>)}</select></label>
          <label>Preferred start (IST)<input name="start" type="datetime-local" required /></label>
          <label>Service address<input name="location" maxLength={240} required defaultValue={activeVehicles[0]?.address ?? ""} /><small>Shared with the vendor only after they accept.</small></label>
          <label>Access notes (optional)<input name="notes" maxLength={500} /></label>
          <div className="form-actions">
            <button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Sending…" : "Send request"}</button>
            <button className="secondary-button" type="button" onClick={() => setBooking(null)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="owner-section-heading"><div><p className="section-kicker">YOUR REQUESTS</p><h2>Marketplace bookings</h2></div></div>
      {bookingsState === "loading" && <div className="loading-panel" role="status">Loading your bookings…</div>}
      {bookingsState === "error" && <div className="notice notice-error" role="alert"><span>Bookings could not be loaded.</span><button type="button" onClick={() => void loadBookings()}>Retry</button></div>}
      {bookingsState === "ready" && bookings.length === 0 && <div className="empty-state"><h2>No marketplace bookings.</h2><p>Requests you send to vendors will appear here with their real status.</p></div>}
      {bookings.length > 0 && (
        <ul className="status-list">
          {bookings.map((item) => (
            <li key={item.id} className="service-row">
              <span className="registration-chip">{item.vehicleRegistration}</span>
              <span><strong>{item.serviceName}</strong><small>{formatWindow(item.windowStart, item.windowEnd)} · <StatusPill status={item.status} /></small></span>
              <button className="text-button" type="button" onClick={() => void openBooking(item.id)}>View</button>
            </li>
          ))}
        </ul>
      )}
      {detail && (
        <section className="panel booking-detail" aria-label="Booking detail">
          <div className="owner-section-heading"><div><p className="section-kicker">BOOKING</p><h2>{detail.booking.serviceName}</h2></div><button className="text-button" type="button" onClick={() => setDetail(null)}>Close</button></div>
          <dl className="detail-list">
            <div><dt>Status</dt><dd><StatusPill status={detail.booking.status} /></dd></div>
            <div><dt>Vendor</dt><dd>{detail.vendor?.businessName ?? "Vendor"}</dd></div>
            {detail.vendor?.contactPhone && <div><dt>Vendor phone</dt><dd>{detail.vendor.contactPhone}</dd></div>}
            {detail.staffName && <div><dt>Assigned staff</dt><dd>{detail.staffName}</dd></div>}
            <div><dt>When</dt><dd>{formatWindow(detail.booking.windowStart, detail.booking.windowEnd)}</dd></div>
            <div><dt>Agreed price</dt><dd>{paise(detail.booking.servicePricePaise)}</dd></div>
            <div><dt>Payment</dt><dd>{paymentCopy(detail.payment)}</dd></div>
            {detail.refundState !== "NONE" && <div><dt>Refund</dt><dd>{detail.refundState === "REVIEW_REQUIRED" ? "Under review by the platform. No refund has been sent yet." : "Refund confirmed by the platform."}</dd></div>}
            {detail.settlement && <div><dt>Settlement</dt><dd>Recorded internally. This does not mean funds were paid out.</dd></div>}
          </dl>
          {detail.booking.rejectionReason && <p className="owner-form-note">Declined: {detail.booking.rejectionReason}</p>}
          {detail.booking.completionNotes && <p className="owner-form-note">Vendor's completion note: {detail.booking.completionNotes}</p>}
          {detail.cancellation && <p className="owner-form-note">Cancelled ({label(detail.cancellation.kind)}): {detail.cancellation.reason}. No cancellation fee was applied.</p>}
          {detail.booking.status === "PROVIDER_REPORTED_COMPLETION" && (
            <div className="form-actions">
              <button className="primary-button" type="button" onClick={() => void respond(detail.booking.id, "accept-completion")}>Confirm completed</button>
              <form className="inline-form" onSubmit={(event) => { event.preventDefault(); const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim(); void respond(detail.booking.id, "dispute", reason); }}>
                <label>Reason for disputing<input name="reason" maxLength={1000} required /></label>
                <button className="secondary-button" type="submit">Dispute</button>
              </form>
            </div>
          )}
          {detail.disputes.length > 0 && (
            <div className="dispute-history" aria-label="Dispute history">
              {detail.disputes.map((dispute) => (
                <article key={dispute.id} className="detail-card">
                  <h3>Dispute: {label(dispute.status)}</h3>
                  <p className="owner-form-note">{label(dispute.category)}: {dispute.reason}</p>
                  <ul className="status-list">
                    {dispute.entries.map((entry) => <li key={entry.id}><span><strong>{label(entry.kind)}</strong><small>{label(entry.actorRole)}{entry.message ? `: ${entry.message}` : ""}</small></span></li>)}
                  </ul>
                  {dispute.status === "RESOLVED" && <p className="owner-form-note">Outcome: {label(dispute.outcome ?? "")}. {dispute.resolutionRationale}</p>}
                </article>
              ))}
            </div>
          )}
          {detail.booking.status === "DISPUTED" && <p className="owner-form-note">The dispute is open until the platform resolves it. Settlement is paused meanwhile.</p>}
          {["REQUESTED", "ACCEPTED"].includes(detail.booking.status) && (
            <form className="inline-form" onSubmit={(event) => { event.preventDefault(); const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim(); void cancel(detail.booking.id, reason); }}>
              <label>Reason for cancelling<input name="reason" maxLength={500} required /></label>
              <button className="secondary-button" type="submit">Cancel booking</button>
            </form>
          )}
        </section>
      )}
    </section>
  );
}

function paymentCopy(payment: MarketplaceBookingDetailView["payment"]): string {
  switch (payment.state) {
    case "NONE": return "None recorded.";
    case "RECORDED_UNVERIFIED": return `${paise(payment.recordedPaise)} reported by the vendor, not yet verified by Autospokes.`;
    case "PARTIALLY_VERIFIED": return `${paise(payment.verifiedPaise)} verified; ${paise(payment.outstandingPaise)} outstanding.`;
    case "VERIFIED": return `${paise(payment.verifiedPaise)} verified.`;
    case "FAILED": return "A reported payment could not be verified.";
    case "REFUNDED": return `${paise(payment.refundedPaise)} refunded.`;
  }
}
