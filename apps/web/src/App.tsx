import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { OwnerVehicle } from "@autospokes/shared";
import {
  ApiError,
  createVehicle,
  getOwnerDashboard,
  getOwnerProfile,
  getVehicle,
  getVehicles,
  registerAccount,
  restoreSession,
  signIn,
  signOut,
  updateOwnerProfile,
  updateVehicle,
  type AuthSession,
  type AccountRole,
  type OwnerDashboard,
  type OwnerProfile,
  type OwnerServiceStatus,
  type VehicleDashboard,
} from "./api";
import { Icon, type IconName } from "./components/Icon";
import { DetailerWorkspace } from "./DetailerApp";
import { SocietyWorkspace } from "./SocietyApp";
import { MarketplaceWorkspace } from "./MarketplaceApp";
import { OwnerMarketplace } from "./OwnerMarketplace";

type OwnerPage = "Home" | "My vehicles" | "Services" | "Activity" | "Profile" | "Vehicle detail";
type DashboardState = "loading" | "ready" | "error";

const pageItems: { label: Exclude<OwnerPage, "Vehicle detail">; icon: IconName }[] = [
  { label: "Home", icon: "grid" },
  { label: "My vehicles", icon: "car" },
  { label: "Services", icon: "sparkle" },
  { label: "Activity", icon: "bell" },
  { label: "Profile", icon: "user" },
];

function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authStatus, setAuthStatus] = useState<"loading" | "ready" | "error">("loading");
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    let mounted = true;
    restoreSession()
      .then((restored) => {
        if (!mounted) return;
        setSession(restored);
        setAuthStatus("ready");
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setAuthError(errorMessage(error));
        setAuthStatus("error");
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (authStatus === "loading") {
    return <main className="auth-loading" aria-live="polite">Opening your Autospokes garage…</main>;
  }

  if (!session || authStatus === "error") {
    return (
      <SignIn
        initialError={authError}
        onAuthenticated={(authenticated) => {
          setAuthError("");
          setSession(authenticated);
          setAuthStatus("ready");
        }}
      />
    );
  }

  if (session.user.role !== "OWNER") {
    if (session.user.role === "INDEPENDENT_DETAILER") {
      return <DetailerWorkspace session={session} onSignOut={() => setSession(null)} />;
    }
    if (session.user.role === "SOCIETY_VENDOR") {
      return <SocietyWorkspace session={session} onSignOut={() => setSession(null)} />;
    }
    if (session.user.role === "MARKETPLACE_VENDOR") {
      return <MarketplaceWorkspace session={session} onSignOut={() => setSession(null)} />;
    }
    return (
      <main className="auth-page">
        <Brand />
        <section className="auth-card" aria-labelledby="role-denied-title">
          <div className="auth-emblem"><Icon name="shield" size={23} /></div>
          <p className="eyebrow">OWNER SPACE</p>
          <h1 id="role-denied-title">This workspace is for vehicle owners.</h1>
          <p className="auth-description">
            The signed-in profile does not have Owner access. Other role workflows are not part of this phase.
          </p>
          <button className="secondary-button" type="button" onClick={() => setSession(null)}>
            Sign out
          </button>
        </section>
      </main>
    );
  }

  return <OwnerWorkspace session={session} onSignOut={() => setSession(null)} />;
}

function SignIn({
  initialError,
  onAuthenticated,
}: {
  initialError: string;
  onAuthenticated: (session: AuthSession) => void;
}) {
  const canRegister = import.meta.env.DEV;
  const [role, setRole] = useState<AccountRole>("OWNER");
  const [registering, setRegistering] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(initialError);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    try {
      const session = registering
        ? await registerAccount(email, password, String(form.get("displayName") ?? "").trim(), role)
        : await signIn(email, password, role);
      if (session.user.role !== role) {
        throw new Error("This account does not have the selected role.");
      }
      onAuthenticated(session);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <Brand />
      <section className="auth-card" aria-labelledby="sign-in-title">
        <div className="auth-emblem"><Icon name="steering" size={23} /></div>
        <p className="eyebrow">A MORE CONSIDERED KIND OF CAR CARE</p>
        <h1 id="sign-in-title">{registering ? "Make yourself at home." : "Welcome back."}</h1>
        <p className="auth-description">
          {registering
            ? role === "OWNER"
              ? "Create an Owner account and start building your private garage."
              : role === "INDEPENDENT_DETAILER"
                ? "Create a Detailer account to manage your clients and daily care."
                : role === "SOCIETY_VENDOR"
                  ? "Create a Society Vendor account to coordinate residents, washers and service."
                  : "Create a Marketplace Vendor account to list services and receive booking requests."
            : role === "OWNER"
              ? "Sign in to see your vehicles and keep their care in one place."
              : role === "INDEPENDENT_DETAILER"
                ? "Sign in to manage your clients, schedules and daily tasks."
                : role === "SOCIETY_VENDOR"
                  ? "Sign in to manage your societies, service and billing."
                  : "Sign in to manage your services, staff and booking requests."}
        </p>
        <form className="owner-form auth-form" onSubmit={submit}>
          <label>
            Workspace
            <select
              value={role}
              onChange={(event) => {
                setRole(event.target.value as AccountRole);
                setError("");
              }}
            >
              <option value="OWNER">Owner</option>
              <option value="INDEPENDENT_DETAILER">Independent Detailer</option>
              <option value="SOCIETY_VENDOR">Society Vendor</option>
              <option value="MARKETPLACE_VENDOR">Marketplace Vendor</option>
            </select>
          </label>
          {registering && (
            <label>
              Your name
              <input name="displayName" autoComplete="name" maxLength={80} required />
            </label>
          )}
          <label>
            Email address
            <input name="email" type="email" autoComplete="email" maxLength={254} required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete={registering ? "new-password" : "current-password"}
              minLength={registering ? 12 : 1}
              maxLength={128}
              required
            />
            {registering && <small>Use at least 12 characters.</small>}
          </label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="primary-button auth-submit" type="submit" disabled={submitting}>
            {submitting
              ? "Please wait…"
              : registering
                ? `Create ${role === "OWNER" ? "Owner" : role === "INDEPENDENT_DETAILER" ? "Detailer" : role === "SOCIETY_VENDOR" ? "Society Vendor" : "Marketplace Vendor"} account`
                : "Sign in"}
            {!submitting && <Icon name="arrow-up-right" size={16} />}
          </button>
        </form>
        {(canRegister || registering) && (
          <p className="auth-switch">
            {registering ? "Already have an account?" : "New to Autospokes?"}{" "}
            <button
              type="button"
              onClick={() => {
                setRegistering(!registering);
                setError("");
              }}
            >
              {registering
                ? "Sign in"
                : `Create a ${role === "OWNER" ? "Owner" : role === "INDEPENDENT_DETAILER" ? "Detailer" : role === "SOCIETY_VENDOR" ? "Society Vendor" : "Marketplace Vendor"} account`}
            </button>
          </p>
        )}
        {registering && (
          <p className="auth-footnote">
            Account creation uses the existing development-only registration endpoint; it is unavailable in production.
          </p>
        )}
      </section>
      <p className="auth-footer">Thoughtful care for every journey.</p>
    </main>
  );
}

function OwnerWorkspace({
  session,
  onSignOut,
}: {
  session: AuthSession;
  onSignOut: () => void;
}) {
  const [profile, setProfile] = useState<OwnerProfile | null>(null);
  const [vehicles, setVehicles] = useState<OwnerVehicle[]>([]);
  const [page, setPage] = useState<OwnerPage>("Home");
  const [dashboard, setDashboard] = useState<OwnerDashboard | null>(null);
  const [dashboardState, setDashboardState] = useState<DashboardState>("loading");
  const [dashboardRevision, setDashboardRevision] = useState(0);
  const [editingVehicle, setEditingVehicle] = useState<OwnerVehicle | null>(null);
  const [showVehicleForm, setShowVehicleForm] = useState(false);
  const [activeVehicleId, setActiveVehicleId] = useState<string | null>(null);
  const [vehicleDetail, setVehicleDetail] = useState<{
    vehicle: OwnerVehicle;
    serviceSummary: VehicleDashboard;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let mounted = true;
    Promise.all([getOwnerProfile(session), getVehicles(session)])
      .then(([ownerProfile, ownerVehicles]) => {
        if (!mounted) return;
        setProfile(ownerProfile);
        setVehicles(ownerVehicles);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setPageError(errorMessage(error));
        setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [session]);

  useEffect(() => {
    let mounted = true;
    setDashboardState("loading");
    getOwnerDashboard(session)
      .then((result) => {
        if (!mounted) return;
        setDashboard(result);
        setDashboardState("ready");
      })
      .catch(() => {
        if (!mounted) return;
        setDashboard(null);
        setDashboardState("error");
      });
    return () => {
      mounted = false;
    };
  }, [session, dashboardRevision]);

  const reloadDashboard = useCallback(() => setDashboardRevision((value) => value + 1), []);

  useEffect(() => {
    if (page !== "Vehicle detail" || !activeVehicleId) return;
    let mounted = true;
    setVehicleDetail(null);
    getVehicle(session, activeVehicleId)
      .then((detail) => {
        if (mounted) setVehicleDetail(detail);
      })
      .catch((error: unknown) => {
        if (mounted) setPageError(errorMessage(error));
      });
    return () => {
      mounted = false;
    };
  }, [activeVehicleId, page, session]);

  function showPage(nextPage: OwnerPage) {
    setPageError("");
    setNotice("");
    setShowVehicleForm(false);
    setEditingVehicle(null);
    setPage(nextPage);
  }

  function addVehicle() {
    setPageError("");
    setNotice("");
    setEditingVehicle(null);
    setShowVehicleForm(true);
    setPage("My vehicles");
  }

  async function saveVehicle(input: Record<string, unknown>) {
    setPageError("");
    setNotice("");
    try {
      const saved = editingVehicle
        ? await updateVehicle(session, editingVehicle.id, input)
        : await createVehicle(session, input);
      setVehicles((current) =>
        editingVehicle
          ? current.map((vehicle) => vehicle.id === saved.id ? saved : vehicle)
          : [saved, ...current],
      );
      setShowVehicleForm(false);
      setEditingVehicle(null);
      setNotice("Vehicle details saved.");
      reloadDashboard();
    } catch (error) {
      setPageError(errorMessage(error));
      throw error;
    }
  }

  async function saveProfile(input: OwnerProfile) {
    setPageError("");
    setNotice("");
    try {
      const saved = await updateOwnerProfile(session, input);
      setProfile(saved);
      setNotice("Profile details saved.");
    } catch (error) {
      setPageError(errorMessage(error));
      throw error;
    }
  }

  async function handleSignOut() {
    setPageError("");
    try {
      await signOut(session);
      onSignOut();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSignOut();
      } else {
        setPageError(errorMessage(error));
      }
    }
  }

  const initials = (profile?.displayName ?? session.user.displayName)
    .split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");

  return (
    <div className="owner-app owner-role-app">
      <aside className="owner-sidebar">
        <Brand />
        <p className="workspace-label">YOUR GARAGE</p>
        <OwnerNavigation page={page} onNavigate={showPage} />
        <div className="owner-sidebar-bottom">
          <div className="help-card">
            <span className="help-icon"><Icon name="help" size={17} /></span>
            <span><strong>Your space, your pace</strong><small>Vehicle care, kept clear.</small></span>
          </div>
          <div className="owner-account">
            <span className="avatar">{initials || "AS"}</span>
            <span className="profile-copy"><strong>{profile?.displayName ?? session.user.displayName}</strong><small>Vehicle owner</small></span>
            <button type="button" aria-label="Sign out" onClick={handleSignOut}><Icon name="more" size={18} /></button>
          </div>
        </div>
      </aside>

      <main className="owner-main">
        <header className="owner-topbar">
          <Brand compact />
          <div className="topbar-context"><span>Owner space</span><Icon name="chevron" size={14} /><strong>{page === "Vehicle detail" ? "Vehicle details" : page}</strong></div>
          <div className="owner-top-actions">
            <span className="owner-status-dot" />
            <span>Private garage</span>
            <span className="top-divider" />
            <span className="top-avatar">{initials || "AS"}</span>
            <button className="mobile-signout" type="button" onClick={handleSignOut}>Sign out</button>
          </div>
        </header>
        <div className="owner-mobile-nav">
          <OwnerNavigation page={page} onNavigate={showPage} />
        </div>

        <div className="owner-content">
          {pageError && (
            <div className="notice notice-error" role="alert">
              <span>{pageError}</span>
              <button type="button" aria-label="Dismiss error" onClick={() => setPageError("")}>×</button>
            </div>
          )}
          {notice && <div className="notice notice-success" role="status">{notice}</div>}
          {loading ? (
            <div className="loading-panel" role="status">Loading your garage…</div>
          ) : page === "Home" ? (
            <OwnerOverview
              profile={profile}
              vehicles={vehicles}
              dashboard={dashboard}
              dashboardState={dashboardState}
              onRetryDashboard={reloadDashboard}
              onAddVehicle={addVehicle}
              onNavigate={showPage}
              onOpenVehicle={(id) => {
                setActiveVehicleId(id);
                setPage("Vehicle detail");
              }}
            />
          ) : page === "My vehicles" ? (
            showVehicleForm ? (
              <VehicleForm
                vehicle={editingVehicle}
                onCancel={() => {
                  setShowVehicleForm(false);
                  setEditingVehicle(null);
                }}
                onSave={saveVehicle}
              />
            ) : (
              <VehicleList
                vehicles={vehicles}
                statuses={dashboard?.vehicles ?? []}
                onAdd={addVehicle}
                onEdit={(vehicle) => {
                  setEditingVehicle(vehicle);
                  setShowVehicleForm(true);
                }}
                onOpen={(id) => {
                  setActiveVehicleId(id);
                  setPage("Vehicle detail");
                }}
              />
            )
          ) : page === "Services" ? (
            <ServicesPage
              session={session}
              vehicles={vehicles}
              dashboard={dashboard}
              dashboardState={dashboardState}
              onRetry={reloadDashboard}
              onAddVehicle={addVehicle}
              onEdit={(vehicle) => {
                setEditingVehicle(vehicle);
                setShowVehicleForm(true);
                setPage("My vehicles");
              }}
            />
          ) : page === "Activity" ? (
            <ActivityPage
              dashboard={dashboard}
              dashboardState={dashboardState}
              onRetry={reloadDashboard}
              onOpenVehicle={(id) => {
                setActiveVehicleId(id);
                setPage("Vehicle detail");
              }}
            />
          ) : page === "Profile" ? (
            profile ? (
              <ProfilePage profile={profile} email={session.user.email} onSave={saveProfile} />
            ) : <div className="loading-panel">Loading your profile…</div>
          ) : (
            <VehicleDetail
              detail={vehicleDetail}
              loading={!vehicleDetail && !pageError}
              onBack={() => showPage("My vehicles")}
              onEdit={(vehicle) => {
                setEditingVehicle(vehicle);
                setShowVehicleForm(true);
                setPage("My vehicles");
              }}
            />
          )}
          <footer className="page-footer">
            <span>Thoughtful care for every journey.</span>
            <span>© 2026 Autospokes <span className="footer-separator">·</span> Made for the road ahead</span>
          </footer>
        </div>
      </main>
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <a className={`brand ${compact ? "brand-compact" : ""}`} href="/" aria-label="Autospokes">
      <span className="brand-mark"><Icon name="steering" size={compact ? 18 : 20} /></span>
      <span className="brand-word">auto<span>spokes</span></span>
    </a>
  );
}

function OwnerNavigation({
  page,
  onNavigate,
}: {
  page: OwnerPage;
  onNavigate: (page: OwnerPage) => void;
}) {
  return (
    <nav className="owner-nav" aria-label="Owner navigation">
      {pageItems.map((item) => (
        <button
          key={item.label}
          type="button"
          className={`owner-nav-item ${page === item.label || (item.label === "My vehicles" && page === "Vehicle detail") ? "owner-nav-active" : ""}`}
          aria-current={page === item.label || (item.label === "My vehicles" && page === "Vehicle detail") ? "page" : undefined}
          onClick={() => onNavigate(item.label)}
        >
          <Icon name={item.icon} size={18} />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function greeting(date = new Date()): string {
  const hour = date.getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

const statusCopy: Record<OwnerServiceStatus, { label: string; detail: string }> = {
  INACTIVE: { label: "Inactive", detail: "This vehicle is marked inactive." },
  NO_PROVIDER: { label: "No provider", detail: "No provider has been recorded for this vehicle." },
  PROVIDER_RECORDED: { label: "Provider recorded", detail: "Recorded by you. Not verified by Autospokes." },
};

function activityLabel(kind: OwnerDashboard["recentActivity"][number]["kind"]): string {
  return kind === "VEHICLE_ADDED" ? "Vehicle added" : "Vehicle details updated";
}

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function DashboardUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="notice notice-error" role="alert">
      <span>We could not load your service summary. Your vehicles are still available.</span>
      <button type="button" onClick={onRetry}>Try again</button>
    </div>
  );
}

function OwnerOverview({
  profile,
  vehicles,
  dashboard,
  dashboardState,
  onRetryDashboard,
  onAddVehicle,
  onNavigate,
  onOpenVehicle,
}: {
  profile: OwnerProfile | null;
  vehicles: OwnerVehicle[];
  dashboard: OwnerDashboard | null;
  dashboardState: DashboardState;
  onRetryDashboard: () => void;
  onAddVehicle: () => void;
  onNavigate: (page: OwnerPage) => void;
  onOpenVehicle: (id: string) => void;
}) {
  const statusById = new Map((dashboard?.vehicles ?? []).map((item) => [item.vehicleId, item.serviceStatus]));
  const withoutProvider = dashboard?.summary.vehiclesWithoutProvider ?? 0;
  return (
    <>
      <div className="owner-eyebrow"><span className="eyebrow-line" /> YOUR AUTOSPOKES OWNER SPACE</div>
      <section className="owner-welcome">
        <div>
          <p className="section-kicker">{greeting().toUpperCase()}{profile?.displayName ? `, ${profile.displayName.toUpperCase()}` : ""}</p>
          <h1>A little more care,<br /><span>for every journey.</span></h1>
          <p className="welcome-copy">
            {profile?.displayName ? `Welcome, ${profile.displayName}. ` : ""}
            Keep the details and care history for each of your vehicles together.
          </p>
        </div>
        <button className="primary-button" type="button" onClick={onAddVehicle}>
          <Icon name="plus" size={17} /> Add a vehicle <Icon name="arrow-up-right" size={16} />
        </button>
      </section>

      {dashboardState === "error" && <DashboardUnavailable onRetry={onRetryDashboard} />}

      <section className="quick-actions" aria-label="Quick actions">
        <button type="button" onClick={onAddVehicle}><Icon name="plus" size={18} /><span>Add vehicle</span></button>
        <button type="button" onClick={() => onNavigate("My vehicles")}><Icon name="car" size={18} /><span>View vehicles</span></button>
        <button type="button" onClick={() => onNavigate("Services")}><Icon name="sparkle" size={18} /><span>Services</span></button>
      </section>

      <section className="owner-stats" aria-label="Garage summary">
        <article className="owner-stat">
          <span className="stat-icon"><Icon name="car" size={18} /></span>
          <span className="stat-label">Vehicles in your garage</span>
          <strong>{vehicles.length}</strong>
          <small>{vehicles.length === 1 ? "Your first vehicle" : "Across your private account"}</small>
        </article>
        <article className="owner-stat">
          <span className="stat-icon"><Icon name="calendar" size={18} /></span>
          <span className="stat-label">Upcoming service</span>
          <strong>—</strong>
          <small>Service records are not available yet</small>
        </article>
        <article className="owner-stat">
          <span className="stat-icon"><Icon name="clock" size={18} /></span>
          <span className="stat-label">Invoices &amp; balance</span>
          <strong>—</strong>
          <small>No invoice data is available yet</small>
        </article>
      </section>

      {vehicles.length === 0 ? (
        <section className="owner-section">
          <div className="owner-section-heading"><div><p className="section-kicker">GETTING STARTED</p><h2>Set up your garage</h2></div></div>
          <ol className="first-use-steps">
            <li><strong>Add a vehicle.</strong> Only the registration number is required.</li>
            <li><strong>Record a provider if you have one.</strong> You can also leave this blank.</li>
            <li><strong>Return here for updates.</strong> Service, billing and booking details appear only when real records exist.</li>
          </ol>
        </section>
      ) : (
        <section className="owner-section">
          <div className="owner-section-heading">
            <div><p className="section-kicker">SERVICE STATUS</p><h2>Per-vehicle status</h2></div>
            {dashboardState === "ready" && withoutProvider > 0 && (
              <span className="status-pill">{withoutProvider} without a provider</span>
            )}
          </div>
          {dashboardState === "loading" ? (
            <div className="loading-panel" role="status">Loading service status…</div>
          ) : (
            <ul className="status-list">
              {vehicles.slice(0, 6).map((vehicle) => {
                const status = statusById.get(vehicle.id);
                return (
                  <li key={vehicle.id}>
                    <button type="button" onClick={() => onOpenVehicle(vehicle.id)}>
                      <span className="registration-chip">{vehicle.registrationNumber}</span>
                      <span>
                        <strong>{status ? statusCopy[status].label : "Status unavailable"}</strong>
                        <small>{status ? statusCopy[status].detail : "Service status could not be loaded."}</small>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {dashboard && dashboard.recentActivity.length > 0 && (
        <section className="owner-section">
          <div className="owner-section-heading">
            <div><p className="section-kicker">RECENT ACTIVITY</p><h2>Latest changes</h2></div>
            <button className="quiet-button" type="button" onClick={() => onNavigate("Activity")}>
              View all <Icon name="arrow" size={15} />
            </button>
          </div>
          <ul className="activity-list">
            {dashboard.recentActivity.slice(0, 3).map((item) => (
              <li key={item.id}>
                <strong>{activityLabel(item.kind)}</strong>
                <span>{item.registrationNumber}</span>
                <time dateTime={item.occurredAt}>{formatWhen(item.occurredAt)}</time>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="owner-section">
        <div className="owner-section-heading">
          <div><p className="section-kicker">IN YOUR GARAGE</p><h2>Your vehicles</h2></div>
          <button className="quiet-button" type="button" onClick={() => onNavigate("My vehicles")}>
            View all <Icon name="arrow" size={15} />
          </button>
        </div>
        {vehicles.length === 0 ? (
          <EmptyState
            icon="car"
            title="Your garage is ready when you are."
            detail="Add a vehicle to keep its details, provider and future service records together."
            action="Add your first vehicle"
            onAction={onAddVehicle}
          />
        ) : (
          <div className="vehicle-card-grid">
            {vehicles.slice(0, 3).map((vehicle) => (
              <VehicleCard key={vehicle.id} vehicle={vehicle} status={statusById.get(vehicle.id)} onOpen={onOpenVehicle} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function ServicesPage({
  session,
  vehicles,
  dashboard,
  dashboardState,
  onRetry,
  onAddVehicle,
  onEdit,
}: {
  session: AuthSession;
  vehicles: OwnerVehicle[];
  dashboard: OwnerDashboard | null;
  dashboardState: DashboardState;
  onRetry: () => void;
  onAddVehicle: () => void;
  onEdit: (vehicle: OwnerVehicle) => void;
}) {
  return (
    <>
      <PageHeading
        eyebrow="SERVICES"
        title="Services"
        detail="Provider arrangements you have recorded, and what is not available yet."
      />
      {dashboardState === "error" && <DashboardUnavailable onRetry={onRetry} />}
      <section className="owner-section">
        <div className="owner-section-heading"><div><p className="section-kicker">PROVIDERS</p><h2>Provider by vehicle</h2></div></div>
        {vehicles.length === 0 ? (
          <EmptyState
            icon="car"
            title="No vehicles to show."
            detail="Add a vehicle to record its provider arrangement."
            action="Add a vehicle"
            onAction={onAddVehicle}
          />
        ) : (
          <ul className="status-list">
            {vehicles.map((vehicle) => (
              <li key={vehicle.id} className="service-row">
                <span className="registration-chip">{vehicle.registrationNumber}</span>
                <span>
                  <strong>{vehicle.providerType ? providerLabel(vehicle.providerType) : "No provider selected"}</strong>
                  <small>{vehicle.providerType ? "Recorded by you. Not verified by Autospokes." : "No active service."}</small>
                </span>
                <button className="text-button" type="button" onClick={() => onEdit(vehicle)}>Edit details</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <OwnerMarketplace session={session} vehicles={vehicles} />
      <section className="unavailable-grid" aria-label="Not yet available">
        <article className="detail-card">
          <h2>Bookings</h2>
          <p>Marketplace requests are listed above with their real status. Other booking types, such as Society or Detailer services, are not scheduled through this page.</p>
        </article>
        <article className="detail-card">
          <h2>Bills &amp; payments</h2>
          <p>{dashboard?.availability.billing.available ? "Billing is available." : "No invoice data is available yet. No balances or payments are shown until real billing records exist."}</p>
        </article>
      </section>
    </>
  );
}

function ActivityPage({
  dashboard,
  dashboardState,
  onRetry,
  onOpenVehicle,
}: {
  dashboard: OwnerDashboard | null;
  dashboardState: DashboardState;
  onRetry: () => void;
  onOpenVehicle: (id: string) => void;
}) {
  return (
    <>
      <PageHeading eyebrow="ACTIVITY" title="Activity" detail="Changes recorded on your account." />
      {dashboardState === "loading" && <div className="loading-panel" role="status">Loading activity…</div>}
      {dashboardState === "error" && <DashboardUnavailable onRetry={onRetry} />}
      {dashboardState === "ready" && dashboard && (
        dashboard.recentActivity.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><Icon name="bell" size={23} /></span>
            <h2>No activity yet.</h2>
            <p>Changes to your vehicles will appear here.</p>
          </div>
        ) : (
          <ul className="activity-list">
            {dashboard.recentActivity.map((item) => (
              <li key={item.id}>
                <strong>{activityLabel(item.kind)}</strong>
                <button className="text-button" type="button" onClick={() => onOpenVehicle(item.vehicleId)}>{item.registrationNumber}</button>
                <time dateTime={item.occurredAt}>{formatWhen(item.occurredAt)}</time>
              </li>
            ))}
          </ul>
        )
      )}
      <article className="detail-card">
        <h2>Notifications</h2>
        <p>No notification channel is connected, so Autospokes does not send SMS, WhatsApp, email or push messages.</p>
      </article>
    </>
  );
}

function VehicleList({
  vehicles,
  statuses,
  onAdd,
  onEdit,
  onOpen,
}: {
  vehicles: OwnerVehicle[];
  statuses: OwnerDashboard["vehicles"];
  onAdd: () => void;
  onEdit: (vehicle: OwnerVehicle) => void;
  onOpen: (id: string) => void;
}) {
  const statusById = new Map(statuses.map((item) => [item.vehicleId, item.serviceStatus]));
  return (
    <>
      <PageHeading
        eyebrow="YOUR PRIVATE GARAGE"
        title="My vehicles"
        detail="Each vehicle has its own details, provider and service view."
        action={<button className="primary-button" type="button" onClick={onAdd}><Icon name="plus" size={17} /> Add vehicle</button>}
      />
      {vehicles.length === 0 ? (
        <EmptyState
          icon="car"
          title="No vehicles here yet."
          detail="Add your first vehicle. You can leave provider details blank and add them later."
          action="Add a vehicle"
          onAction={onAdd}
        />
      ) : (
        <div className="vehicle-card-grid vehicle-list-grid">
          {vehicles.map((vehicle) => (
            <VehicleCard key={vehicle.id} vehicle={vehicle} status={statusById.get(vehicle.id)} onOpen={onOpen} onEdit={onEdit} />
          ))}
        </div>
      )}
    </>
  );
}

function VehicleCard({
  vehicle,
  status,
  onOpen,
  onEdit,
}: {
  vehicle: OwnerVehicle;
  status?: OwnerServiceStatus;
  onOpen: (id: string) => void;
  onEdit?: (vehicle: OwnerVehicle) => void;
}) {
  const vehicleName = [vehicle.make, vehicle.model].filter(Boolean).join(" ") || vehicleTypeLabel(vehicle.type);
  return (
    <article className="vehicle-card">
      <button className="vehicle-card-main" type="button" onClick={() => onOpen(vehicle.id)}>
        <VehicleImage vehicle={vehicle} />
        <span className="vehicle-card-copy">
          <span className="vehicle-overline">{vehicleTypeLabel(vehicle.type)} <span>·</span> {vehicle.status === "ACTIVE" ? "Active" : "Inactive"}</span>
          <strong>{vehicleName}</strong>
          <span className="registration-chip">{vehicle.registrationNumber}</span>
        </span>
        <Icon name="arrow-up-right" size={17} />
      </button>
      <div className="vehicle-card-foot">
        <span className="provider-summary">{vehicle.providerType ? providerLabel(vehicle.providerType) : "No provider selected"}</span>
        {status && <span className="status-pill">{statusCopy[status].label}</span>}
        {onEdit && <button className="text-button" type="button" onClick={() => onEdit(vehicle)}>Edit details</button>}
      </div>
    </article>
  );
}

function VehicleImage({ vehicle }: { vehicle: OwnerVehicle }) {
  return (
    <span className="vehicle-image">
      {vehicle.photoUrls[0] ? (
        <img src={vehicle.photoUrls[0]} alt={`${vehicle.registrationNumber} vehicle`} />
      ) : (
        <Icon name="car" size={43} />
      )}
    </span>
  );
}

function EmptyState({
  icon,
  title,
  detail,
  action,
  onAction,
}: {
  icon: "car" | "clock";
  title: string;
  detail: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon name={icon} size={23} /></span>
      <h2>{title}</h2>
      <p>{detail}</p>
      <button className="secondary-button" type="button" onClick={onAction}><Icon name="plus" size={16} />{action}</button>
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow: string;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <section className="owner-page-heading">
      <div><p className="section-kicker">{eyebrow}</p><h1>{title}</h1><p>{detail}</p></div>
      {action}
    </section>
  );
}

function VehicleForm({
  vehicle,
  onCancel,
  onSave,
}: {
  vehicle: OwnerVehicle | null;
  onCancel: () => void;
  onSave: (input: Record<string, unknown>) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setFieldErrors({});
    const form = new FormData(event.currentTarget);
    const photoUrls = String(form.get("photoUrls") ?? "")
      .split(",").map((url) => url.trim()).filter(Boolean);
    const dimension = (name: string) => {
      const raw = String(form.get(name) ?? "").trim();
      return raw ? Number(raw) : null;
    };
    const input = {
      type: String(form.get("type")),
      registrationNumber: String(form.get("registrationNumber")).trim(),
      make: nullableText(form, "make"),
      model: nullableText(form, "model"),
      lengthCm: dimension("lengthCm"),
      widthCm: dimension("widthCm"),
      heightCm: dimension("heightCm"),
      photoUrls,
      locationName: nullableText(form, "locationName"),
      address: nullableText(form, "address"),
      city: nullableText(form, "city"),
      postalCode: nullableText(form, "postalCode"),
      providerType: nullableText(form, "providerType"),
      providerName: nullableText(form, "providerName"),
      assignedWasherName: nullableText(form, "assignedWasherName"),
      // The status control only exists when editing; never send a missing value.
      ...(form.has("status") ? { status: String(form.get("status")) } : {}),
    };
    try {
      await onSave(input);
    } catch (saveError) {
      setError(errorMessage(saveError));
      setFieldErrors(saveError instanceof ApiError ? saveError.fieldErrors : {});
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="owner-form-page">
      <PageHeading
        eyebrow={vehicle ? "UPDATE YOUR GARAGE" : "ADD TO YOUR GARAGE"}
        title={vehicle ? "Edit vehicle" : "Add a vehicle"}
        detail="Registration is required. Everything else can be added or changed later."
      />
      <form className="owner-form vehicle-form" onSubmit={submit}>
        <div className="form-section">
          <div className="form-section-title"><span>01</span><div><h2>Vehicle details</h2><p>A few details help keep each vehicle distinct.</p></div></div>
          <div className="form-grid">
            <label>Vehicle type <select name="type" defaultValue={vehicle?.type ?? "FOUR_WHEELER"} required><option value="TWO_WHEELER">Two-wheeler</option><option value="FOUR_WHEELER">Four-wheeler</option><option value="OTHER">Other vehicle</option></select></label>
            <label>Registration number <input name="registrationNumber" aria-invalid={Boolean(fieldErrors.registrationNumber)} defaultValue={vehicle?.registrationNumber ?? ""} autoComplete="off" maxLength={32} placeholder="e.g. MH 12 AB 1234" required /><small>Spaces and hyphens are ignored when checking for duplicates.</small></label>
            <label>Make <input name="make" defaultValue={vehicle?.make ?? ""} maxLength={80} placeholder="e.g. Honda" /></label>
            <label>Model <input name="model" defaultValue={vehicle?.model ?? ""} maxLength={80} placeholder="e.g. City" /></label>
          </div>
          <fieldset className="dimension-fieldset">
            <legend>Dimensions <span>optional, in centimetres</span></legend>
            <div className="form-grid dimension-grid">
              <label>Length (cm)<input name="lengthCm" type="number" min="0.1" max="100000" step="any" defaultValue={vehicle?.lengthCm ?? ""} /></label>
              <label>Width (cm)<input name="widthCm" type="number" min="0.1" max="100000" step="any" defaultValue={vehicle?.widthCm ?? ""} /></label>
              <label>Height (cm)<input name="heightCm" type="number" min="0.1" max="100000" step="any" defaultValue={vehicle?.heightCm ?? ""} /></label>
            </div>
          </fieldset>
          <label>Photo URLs <input name="photoUrls" defaultValue={vehicle?.photoUrls.join(", ") ?? ""} placeholder="https://… (separate multiple links with commas)" /><small>Use direct HTTP or HTTPS image links; photo upload is not available yet.</small></label>
        </div>

        <div className="form-section">
          <div className="form-section-title"><span>02</span><div><h2>Location</h2><p>Optional details for where this vehicle is usually kept.</p></div></div>
          <div className="form-grid">
            <label>Location name <input name="locationName" defaultValue={vehicle?.locationName ?? ""} placeholder="e.g. Home garage" maxLength={100} /></label>
            <label>City <input name="city" defaultValue={vehicle?.city ?? ""} maxLength={100} /></label>
            <label className="form-span">Address <input name="address" defaultValue={vehicle?.address ?? ""} maxLength={240} /></label>
            <label>Postal code <input name="postalCode" defaultValue={vehicle?.postalCode ?? ""} maxLength={24} /></label>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title"><span>03</span><div><h2>Care provider</h2><p>Optional. You can register this vehicle without choosing a provider.</p></div></div>
          <div className="form-grid">
            <label>Provider type <select name="providerType" defaultValue={vehicle?.providerType ?? ""}><option value="">No provider selected</option><option value="INDEPENDENT_WASHER">Independent washer</option><option value="SOCIETY_VENDOR">Society Vendor</option><option value="MARKETPLACE_VENDOR">Marketplace Vendor</option></select></label>
            <label>Provider name <input name="providerName" defaultValue={vehicle?.providerName ?? ""} maxLength={120} placeholder="Optional provider name" /></label>
            <label>Assigned washer <input name="assignedWasherName" defaultValue={vehicle?.assignedWasherName ?? ""} maxLength={120} placeholder="For Society Vendor only" /><small>Provider details are owner-entered; vendor assignment workflows are not part of this phase.</small></label>
            {vehicle && <label>Vehicle status <select name="status" defaultValue={vehicle.status}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label>}
          </div>
        </div>

        {error && (
          <div className="form-error" role="alert">
            {error}
            {Object.keys(fieldErrors).length > 0 && (
              <ul>
                {Object.entries(fieldErrors).map(([field, messages]) => (
                  <li key={field}>{messages.join("; ")}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="form-actions">
          <button className="secondary-button" type="button" onClick={onCancel} disabled={saving}>Cancel</button>
          <button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : vehicle ? "Save changes" : "Add vehicle"} <Icon name="arrow-up-right" size={16} /></button>
        </div>
      </form>
    </section>
  );
}

function ProfilePage({
  profile,
  email,
  onSave,
}: {
  profile: OwnerProfile;
  email: string;
  onSave: (profile: OwnerProfile) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await onSave({
        displayName: String(form.get("displayName")).trim(),
        phoneNumber: nullableText(form, "phoneNumber"),
      });
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeading eyebrow="YOUR ACCOUNT" title="Owner profile" detail="Manage the profile details associated with your owner account." />
      <form className="owner-form profile-form" onSubmit={submit}>
        <div className="form-section">
          <div className="form-section-title"><span>01</span><div><h2>Personal details</h2><p>Your details are private to your owner account.</p></div></div>
          <div className="form-grid">
            <label>Display name <input name="displayName" defaultValue={profile.displayName} maxLength={80} required /></label>
            <label>Email address <input value={email} readOnly aria-describedby="email-help" /><small id="email-help">Email changes are not available in this phase.</small></label>
            <label>Phone number <input name="phoneNumber" type="tel" defaultValue={profile.phoneNumber ?? ""} maxLength={32} autoComplete="tel" /><small>Optional. No SMS integrations are connected.</small></label>
          </div>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="form-actions"><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save profile"}</button></div>
      </form>
    </>
  );
}

function VehicleDetail({
  detail,
  loading,
  onBack,
  onEdit,
}: {
  detail: { vehicle: OwnerVehicle; serviceSummary: VehicleDashboard } | null;
  loading: boolean;
  onBack: () => void;
  onEdit: (vehicle: OwnerVehicle) => void;
}) {
  if (loading) return <div className="loading-panel" role="status">Loading vehicle details…</div>;
  if (!detail) return <div className="loading-panel"><h1>Vehicle details unavailable</h1><p>Try opening this vehicle again from your garage.</p><button className="text-button" type="button" onClick={onBack}>Back to vehicles</button></div>;
  const { vehicle, serviceSummary } = detail;
  const dimensions = [
    vehicle.lengthCm ? `L ${vehicle.lengthCm} cm` : null,
    vehicle.widthCm ? `W ${vehicle.widthCm} cm` : null,
    vehicle.heightCm ? `H ${vehicle.heightCm} cm` : null,
  ].filter(Boolean);

  return (
    <section className="vehicle-detail-page">
      <button className="back-link" type="button" onClick={onBack}><Icon name="arrow" size={15} /> Back to vehicles</button>
      <PageHeading
        eyebrow={`${vehicleTypeLabel(vehicle.type)} · ${vehicle.status}`}
        title={vehicle.registrationNumber}
        detail={[vehicle.make, vehicle.model].filter(Boolean).join(" ") || "Vehicle details"}
        action={<button className="secondary-button" type="button" onClick={() => onEdit(vehicle)}>Edit vehicle</button>}
      />
      <div className="detail-layout">
        <div className="detail-main">
          <section className="detail-card vehicle-overview-card">
            <VehicleImage vehicle={vehicle} />
            <div><p className="section-kicker">VEHICLE DETAILS</p><h2>{[vehicle.make, vehicle.model].filter(Boolean).join(" ") || vehicleTypeLabel(vehicle.type)}</h2><span>{vehicle.registrationNumber}</span></div>
            <span className={`status-pill ${vehicle.status === "ACTIVE" ? "status-active" : ""}`}>{vehicle.status === "ACTIVE" ? "Active" : "Inactive"}</span>
          </section>
          <section className="detail-card">
            <div className="panel-heading"><div><p className="section-kicker">SERVICE OVERVIEW</p><h2>Care &amp; activity</h2></div></div>
            <div className="service-summary-grid">
              <SummaryItem title="Upcoming service" value={serviceSummary.upcomingService ? "Upcoming service recorded" : "No service recorded"} detail={serviceSummary.upcomingService ? "See service activity for details." : "Upcoming service details are not available."} icon="calendar" />
              <SummaryItem title="Current wash status" value={String(serviceSummary.currentWashStatus ?? "No wash status available")} detail="Wash statuses appear when a service record is available." icon="sparkle" />
            </div>
            <div className="service-history">
              <h3>Recent service history</h3>
              {serviceSummary.recentServiceHistory.length ? (
                <ul>{serviceSummary.recentServiceHistory.map((record, index) => <li key={index}>{String(record)}</li>)}</ul>
              ) : (
                <p>No service history has been recorded for this vehicle.</p>
              )}
            </div>
          </section>
        </div>
        <aside className="detail-aside">
          <section className="detail-card">
            <p className="section-kicker">PROVIDER</p>
            <h2>{vehicle.providerType ? providerLabel(vehicle.providerType) : "No provider selected"}</h2>
            {vehicle.providerName && <p>{vehicle.providerName}</p>}
            {vehicle.assignedWasherName && <p className="provider-assignee">Assigned washer: {vehicle.assignedWasherName}</p>}
            {!vehicle.providerType && <p>Choose a provider when one is arranged. You can update this vehicle at any time.</p>}
            {vehicle.providerType && <small>Provider details are owner-entered and have not been verified by a vendor workflow.</small>}
          </section>
          <section className="detail-card">
            <p className="section-kicker">LOCATION &amp; SIZE</p>
            <h2>{vehicle.locationName || vehicle.city || "No location added"}</h2>
            {vehicle.address && <p>{vehicle.address}</p>}
            {vehicle.city && <p>{vehicle.city}{vehicle.postalCode ? ` · ${vehicle.postalCode}` : ""}</p>}
            {dimensions.length > 0 && <p className="dimension-summary">{dimensions.join("  ·  ")}</p>}
          </section>
          <section className="detail-card invoice-card">
            <p className="section-kicker">INVOICES &amp; BALANCE</p>
            <h2>{serviceSummary.invoices ? "Invoice records available" : "No invoice data available"}</h2>
            <p>Invoices and balances will appear here when backed by service records.</p>
          </section>
        </aside>
      </div>
    </section>
  );
}

function SummaryItem({
  title,
  value,
  detail,
  icon,
}: {
  title: string;
  value: string;
  detail: string;
  icon: "calendar" | "sparkle";
}) {
  return (
    <article className="summary-item">
      <span className="stat-icon"><Icon name={icon} size={17} /></span>
      <div><span>{title}</span><strong>{value}</strong><small>{detail}</small></div>
    </article>
  );
}

function nullableText(form: FormData, name: string): string | null {
  const value = String(form.get(name) ?? "").trim();
  return value || null;
}

function vehicleTypeLabel(type: OwnerVehicle["type"]): string {
  if (type === "TWO_WHEELER") return "Two-wheeler";
  if (type === "FOUR_WHEELER") return "Four-wheeler";
  return "Other vehicle";
}

function providerLabel(provider: NonNullable<OwnerVehicle["providerType"]>): string {
  if (provider === "INDEPENDENT_WASHER") return "Independent washer";
  if (provider === "SOCIETY_VENDOR") return "Society Vendor";
  return "Marketplace Vendor";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Please try again.";
}

export default App;
