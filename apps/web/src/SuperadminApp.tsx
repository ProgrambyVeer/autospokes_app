import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  getAdminAccounts,
  getAdminAuditEvents,
  getAdminBookingDetail,
  getAdminDisputes,
  getAdminPayments,
  rejectAdminPayment,
  resolveAdminDispute,
  setAdminAccountStatus,
  signInAdmin,
  signOut,
  verifyAdminPayment,
  type AdminAccount,
  type AdminAuditEvent,
  type AdminDispute,
  type AdminPayment,
  type AuthSession,
  type MarketplaceBookingDetailView,
} from "./api";
import { Icon, type IconName } from "./components/Icon";
import { ErrorNotice, StatusPill, label, paise } from "./MarketplaceApp";

type Tab = "Accounts" | "Payments" | "Disputes" | "Audit";
const tabs: { name: Tab; icon: IconName }[] = [
  { name: "Accounts", icon: "user" },
  { name: "Payments", icon: "grid" },
  { name: "Disputes", icon: "shield" },
  { name: "Audit", icon: "bell" },
];
const ROLES = ["OWNER", "INDEPENDENT_DETAILER", "SOCIETY_VENDOR", "MARKETPLACE_VENDOR", "SUPERADMIN"];
const when = (value: string): string =>
  new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value));

export function AdminSignIn({ onAuthenticated }: { onAuthenticated: (session: AuthSession) => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      const session = await signInAdmin(String(form.get("email") ?? "").trim(), String(form.get("password") ?? ""));
      if (session.user.role !== "SUPERADMIN") throw new Error("This account is not a Superadmin.");
      onAuthenticated(session);
    } catch (cause) {
      setError(cause);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="admin-sign-in-title">
        <div className="auth-emblem"><Icon name="shield" size={23} /></div>
        <p className="eyebrow">SUPERADMIN</p>
        <h1 id="admin-sign-in-title">Operations sign-in.</h1>
        <p className="auth-description">Restricted to platform operators. Superadmin accounts cannot be created here.</p>
        <form className="owner-form auth-form" onSubmit={submit}>
          <label>Email address<input name="email" type="email" autoComplete="username" maxLength={254} required /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" maxLength={128} required /></label>
          <ErrorNotice error={error} />
          <button className="primary-button auth-submit" type="submit" disabled={submitting}>{submitting ? "Please wait…" : "Sign in"}</button>
        </form>
      </section>
    </main>
  );
}

export function SuperadminWorkspace({ session, onSignOut }: { session: AuthSession; onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>("Accounts");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  const flash = (message: string) => { setError(null); setNotice(message); };
  async function handleSignOut() {
    try { await signOut(session); } finally { onSignOut(); }
  }

  const nav = (mobile: boolean) => tabs.map((item) => (
    <button key={item.name} type="button" className={`owner-nav-item ${tab === item.name ? "owner-nav-active" : ""}`} aria-current={tab === item.name ? "page" : undefined} onClick={() => { setTab(item.name); setError(null); setNotice(""); }}>
      {!mobile && <Icon name={item.icon} size={18} />}<span>{item.name}</span>
    </button>
  ));

  return (
    <div className="owner-app admin-app">
      <aside className="owner-sidebar">
        <a className="brand" href="/" aria-label="Autospokes"><span className="brand-mark"><Icon name="steering" size={20} /></span><span className="brand-word">auto<span>spokes</span></span></a>
        <p className="workspace-label">SUPERADMIN</p>
        <nav className="owner-nav" aria-label="Superadmin navigation">{nav(false)}</nav>
        <div className="owner-sidebar-bottom"><div className="owner-account"><span className="avatar">SA</span><span className="profile-copy"><strong>{session.user.displayName}</strong><small>Superadmin</small></span><button type="button" aria-label="Sign out" onClick={() => void handleSignOut()}><Icon name="more" size={18} /></button></div></div>
      </aside>
      <main className="owner-main">
        <header className="owner-topbar"><div className="topbar-context"><span>Superadmin</span><Icon name="chevron" size={14} /><strong>{tab}</strong></div><div className="owner-top-actions"><button className="mobile-signout" type="button" onClick={() => void handleSignOut()}>Sign out</button></div></header>
        <div className="owner-mobile-nav"><nav className="owner-nav" aria-label="Superadmin mobile navigation">{nav(true)}</nav></div>
        <div className="owner-content">
          <ErrorNotice error={error} />
          {notice && <div className="notice notice-success" role="status">{notice}</div>}
          {tab === "Accounts" && <AccountsTab session={session} onError={setError} onNotice={flash} />}
          {tab === "Payments" && <PaymentsTab session={session} onError={setError} onNotice={flash} />}
          {tab === "Disputes" && <DisputesTab session={session} onError={setError} onNotice={flash} />}
          {tab === "Audit" && <AuditTab session={session} onError={setError} />}
        </div>
      </main>
    </div>
  );
}

type TabProps = { session: AuthSession; onError: (error: unknown) => void; onNotice?: (message: string) => void };
type LoadState = "loading" | "ready" | "error";

function Loading() {
  return <div className="loading-panel" role="status">Loading…</div>;
}
function Failed({ onRetry, what }: { onRetry: () => void; what: string }) {
  return <div className="notice notice-error" role="alert"><span>{what} could not be loaded.</span><button type="button" onClick={onRetry}>Retry</button></div>;
}
function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><h2>{title}</h2><p>{detail}</p></div>;
}

function AccountsTab({ session, onError, onNotice }: TabProps) {
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [acting, setActing] = useState<{ id: string; action: "suspend" | "reactivate" } | null>(null);

  const load = useCallback(async () => {
    onError(null);
    setState("loading");
    try {
      setAccounts(await getAdminAccounts(session, { role, status, q: q.trim() }));
      setState("ready");
    } catch (cause) {
      onError(cause);
      setState("error");
    }
  }, [session, role, status, q, onError]);
  useEffect(() => { void load(); }, [load]);

  async function submitReason(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!acting) return;
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    try {
      await setAdminAccountStatus(session, acting.id, acting.action, reason);
      onNotice?.(acting.action === "suspend" ? "Account suspended. Its sessions were revoked." : "Account reactivated.");
      setActing(null);
      await load();
    } catch (cause) {
      onError(cause);
    }
  }

  return (
    <section className="owner-section" aria-labelledby="accounts-title">
      <div className="owner-section-heading"><div><p className="section-kicker">ACCOUNTS</p><h2 id="accounts-title">Find and review accounts</h2></div></div>
      <form className="owner-form profile-form" onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <label>Search<input value={q} onChange={(event) => setQ(event.target.value)} maxLength={100} placeholder="Email or name" /></label>
        <label>Role<select value={role} onChange={(event) => setRole(event.target.value)}><option value="">All</option>{ROLES.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
        <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All</option><option value="ACTIVE">Active</option><option value="DISABLED">Suspended</option></select></label>
      </form>
      {state === "loading" && <Loading />}
      {state === "error" && <Failed what="Accounts" onRetry={() => void load()} />}
      {state === "ready" && accounts.length === 0 && <Empty title="No accounts match." detail="Try a different search or filter." />}
      {state === "ready" && accounts.length > 0 && (
        <ul className="status-list">
          {accounts.map((account) => (
            <li key={account.id} className="service-row">
              <span className="registration-chip">{label(account.role)}</span>
              <span>
                <strong>{account.displayName}</strong>
                <small>{account.email} · <StatusPill status={account.status === "DISABLED" ? "SUSPENDED" : "ACTIVE"} /></small>
                {account.suspension && <small>Suspended {when(account.suspension.at)}: {account.suspension.reason}</small>}
              </span>
              {account.role !== "SUPERADMIN" && (
                <button className="text-button" type="button" onClick={() => setActing({ id: account.id, action: account.status === "ACTIVE" ? "suspend" : "reactivate" })}>
                  {account.status === "ACTIVE" ? "Suspend" : "Reactivate"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="owner-form-note">Only data held by Autospokes is shown. No identity (KYC) verification is performed or implied.</p>
      {acting && (
        <form className="owner-form profile-form" onSubmit={submitReason} aria-label={acting.action === "suspend" ? "Suspend account" : "Reactivate account"}>
          <label>Reason (recorded in the audit trail)<input name="reason" minLength={5} maxLength={500} required /></label>
          <div className="form-actions">
            <button className="primary-button" type="submit">{acting.action === "suspend" ? "Confirm suspension" : "Confirm reactivation"}</button>
            <button className="secondary-button" type="button" onClick={() => setActing(null)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

function PaymentsTab({ session, onError, onNotice }: TabProps) {
  const [status, setStatus] = useState("RECORDED_UNVERIFIED");
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [selected, setSelected] = useState<{ id: string; mode: "verify" | "reject" } | null>(null);

  const load = useCallback(async () => {
    onError(null);
    setState("loading");
    try {
      setPayments(await getAdminPayments(session, status || undefined));
      setState("ready");
    } catch (cause) {
      onError(cause);
      setState("error");
    }
  }, [session, status, onError]);
  useEffect(() => { void load(); }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    try {
      if (selected.mode === "verify") {
        await verifyAdminPayment(session, selected.id, String(form.get("evidence") ?? "").trim(), String(form.get("note") ?? "").trim() || undefined);
        onNotice?.("Payment marked verified. This is an internal record; no money was moved by Autospokes.");
      } else {
        await rejectAdminPayment(session, selected.id, String(form.get("reason") ?? "").trim());
        onNotice?.("Payment rejected.");
      }
      setSelected(null);
      await load();
    } catch (cause) {
      onError(cause);
    }
  }

  return (
    <section className="owner-section" aria-labelledby="payments-title">
      <div className="owner-section-heading"><div><p className="section-kicker">PAYMENTS</p><h2 id="payments-title">Payment review</h2></div></div>
      <label className="owner-form">Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All</option>{["RECORDED_UNVERIFIED", "VERIFIED", "FAILED", "REFUNDED"].map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
      {state === "loading" && <Loading />}
      {state === "error" && <Failed what="Payments" onRetry={() => void load()} />}
      {state === "ready" && payments.length === 0 && <Empty title="No payments to show." detail="Vendor-recorded payments appear here for review." />}
      {state === "ready" && payments.length > 0 && (
        <ul className="status-list">
          {payments.map((payment) => (
            <li key={payment.id} className="service-row">
              <span className="registration-chip">{paise(payment.amountPaise)}</span>
              <span>
                <strong>{label(payment.status)} · {label(payment.method)}</strong>
                <small>Booking {payment.bookingId.slice(0, 8)} ({label(payment.bookingStatus)}) · agreed {paise(payment.agreedPricePaise)} · recorded {when(payment.createdAt)}</small>
                {payment.verifiedAt && <small>Verified {when(payment.verifiedAt)}{payment.hasEvidence ? " with evidence on file" : ""}</small>}
              </span>
              {payment.status === "RECORDED_UNVERIFIED" && (
                <span>
                  <button className="text-button" type="button" onClick={() => setSelected({ id: payment.id, mode: "verify" })}>Verify</button>
                  <button className="text-button" type="button" onClick={() => setSelected({ id: payment.id, mode: "reject" })}>Reject</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="owner-form-note">Verification is a manual reconciliation against evidence you hold (for example a bank statement line). No payment gateway is connected.</p>
      {selected && (
        <form className="owner-form profile-form" onSubmit={submit} aria-label={selected.mode === "verify" ? "Verify payment" : "Reject payment"}>
          {selected.mode === "verify" ? (
            <>
              <label>Evidence reference (required)<input name="evidence" maxLength={500} required /></label>
              <label>Note (optional)<input name="note" maxLength={500} /></label>
            </>
          ) : (
            <label>Reason (required)<input name="reason" minLength={5} maxLength={500} required /></label>
          )}
          <div className="form-actions">
            <button className="primary-button" type="submit">{selected.mode === "verify" ? "Mark verified" : "Reject payment"}</button>
            <button className="secondary-button" type="button" onClick={() => setSelected(null)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

function DisputesTab({ session, onError, onNotice }: TabProps) {
  const [status, setStatus] = useState("");
  const [disputes, setDisputes] = useState<AdminDispute[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [detail, setDetail] = useState<MarketplaceBookingDetailView | null>(null);

  const load = useCallback(async () => {
    onError(null);
    setState("loading");
    try {
      setDisputes(await getAdminDisputes(session, status || undefined));
      setState("ready");
    } catch (cause) {
      onError(cause);
      setState("error");
    }
  }, [session, status, onError]);
  useEffect(() => { void load(); }, [load]);

  async function open(bookingId: string) {
    try {
      setDetail(await getAdminBookingDetail(session, bookingId));
    } catch (cause) {
      onError(cause);
    }
  }

  async function resolve(event: FormEvent<HTMLFormElement>, disputeId: string, bookingId: string) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await resolveAdminDispute(
        session,
        disputeId,
        String(form.get("outcome")) as "UPHELD_COMPLETION" | "REWORK_REQUIRED" | "CANCELLED_NO_CHARGE",
        String(form.get("rationale") ?? "").trim(),
      );
      onNotice?.("Dispute resolved. The decision and history are preserved.");
      await Promise.all([load(), open(bookingId)]);
    } catch (cause) {
      onError(cause);
    }
  }

  return (
    <section className="owner-section" aria-labelledby="disputes-title">
      <div className="owner-section-heading"><div><p className="section-kicker">DISPUTES</p><h2 id="disputes-title">Dispute review</h2></div></div>
      <label className="owner-form">Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All</option>{["OPEN", "RESPONDED", "RESOLVED", "WITHDRAWN"].map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
      {state === "loading" && <Loading />}
      {state === "error" && <Failed what="Disputes" onRetry={() => void load()} />}
      {state === "ready" && disputes.length === 0 && <Empty title="No disputes." detail="Owner disputes appear here once raised." />}
      {state === "ready" && disputes.length > 0 && (
        <ul className="status-list">
          {disputes.map((dispute) => (
            <li key={dispute.id} className="service-row">
              <span className="registration-chip">{label(dispute.status)}</span>
              <span><strong>{label(dispute.category)}: {dispute.reason}</strong><small>Booking {dispute.bookingId.slice(0, 8)} · {when(dispute.createdAt)} · {dispute.entryCount} entries{dispute.outcome ? ` · ${label(dispute.outcome)}` : ""}</small></span>
              <button className="text-button" type="button" onClick={() => void open(dispute.bookingId)}>Review</button>
            </li>
          ))}
        </ul>
      )}
      {detail && (
        <section className="panel booking-detail" aria-label="Dispute booking detail">
          <div className="owner-section-heading"><div><p className="section-kicker">BOOKING</p><h2>{detail.booking.serviceName}</h2></div><button className="text-button" type="button" onClick={() => setDetail(null)}>Close</button></div>
          <dl className="detail-list">
            <div><dt>Status</dt><dd><StatusPill status={detail.booking.status} /></dd></div>
            <div><dt>Agreed price</dt><dd>{paise(detail.booking.servicePricePaise)}</dd></div>
            <div><dt>Verified paid</dt><dd>{paise(detail.payment.verifiedPaise)}</dd></div>
          </dl>
          {detail.disputes.map((dispute) => (
            <article key={dispute.id} className="detail-card">
              <h3>Dispute: {label(dispute.status)}</h3>
              <p className="owner-form-note">{label(dispute.category)}: {dispute.reason}</p>
              <ul className="status-list">
                {dispute.entries.map((entry) => <li key={entry.id}><span><strong>{label(entry.kind)}</strong><small>{label(entry.actorRole)} · {when(entry.createdAt)}{entry.message ? `: ${entry.message}` : ""}</small></span></li>)}
              </ul>
              {dispute.status === "RESOLVED" && <p className="owner-form-note">Outcome: {label(dispute.outcome ?? "")}. {dispute.resolutionRationale}</p>}
              {(dispute.status === "OPEN" || dispute.status === "RESPONDED") && (
                <form className="owner-form profile-form" onSubmit={(event) => void resolve(event, dispute.id, detail.booking.id)} aria-label="Resolve dispute">
                  <label>Outcome<select name="outcome" defaultValue="UPHELD_COMPLETION"><option value="UPHELD_COMPLETION">Uphold completion</option><option value="REWORK_REQUIRED">Rework required</option><option value="CANCELLED_NO_CHARGE">Cancel, no charge</option></select></label>
                  <label>Rationale (kept in history)<input name="rationale" minLength={10} maxLength={2000} required /></label>
                  <div className="form-actions"><button className="primary-button" type="submit">Resolve dispute</button></div>
                </form>
              )}
            </article>
          ))}
        </section>
      )}
    </section>
  );
}

function AuditTab({ session, onError }: TabProps) {
  const [action, setAction] = useState("");
  const [events, setEvents] = useState<AdminAuditEvent[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  const load = useCallback(async () => {
    onError(null);
    setState("loading");
    try {
      setEvents(await getAdminAuditEvents(session, { action: action.trim() || undefined }));
      setState("ready");
    } catch (cause) {
      onError(cause);
      setState("error");
    }
  }, [session, action, onError]);
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="owner-section" aria-labelledby="audit-title">
      <div className="owner-section-heading"><div><p className="section-kicker">AUDIT</p><h2 id="audit-title">Privileged-operation history</h2></div></div>
      <form className="owner-form profile-form" onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <label>Action (exact)<input value={action} onChange={(event) => setAction(event.target.value)} maxLength={100} placeholder="ACCOUNT_SUSPENDED" /></label>
      </form>
      {state === "loading" && <Loading />}
      {state === "error" && <Failed what="Audit history" onRetry={() => void load()} />}
      {state === "ready" && events.length === 0 && <Empty title="No audit events." detail="Nothing matches this filter." />}
      {state === "ready" && events.length > 0 && (
        <ul className="status-list">
          {events.map((event) => (
            <li key={event.id} className="service-row">
              <span className="registration-chip">{when(event.createdAt)}</span>
              <span><strong>{event.action}</strong><small>Actor {event.actorId ? event.actorId.slice(0, 8) : "system"}{typeof event.details?.reason === "string" ? ` · ${event.details.reason}` : ""}</small></span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
