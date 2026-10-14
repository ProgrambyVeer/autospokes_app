import { useState } from "react";
import { UserRoleSchema, type UserRole } from "@autospokes/shared";
import { Icon, type IconName } from "./components/Icon";

const roles: { name: UserRole; descriptor: string; icon: IconName }[] = [
  { name: "Owner", descriptor: "Vehicle owner", icon: "car" },
  {
    name: "Independent Detailer",
    descriptor: "Independent detailer",
    icon: "sparkle",
  },
  { name: "Society Vendor", descriptor: "Society partner", icon: "building" },
  {
    name: "Marketplace Vendor",
    descriptor: "Marketplace partner",
    icon: "store",
  },
  { name: "Superadmin", descriptor: "Platform operations", icon: "shield" },
];

const navigation: { label: string; icon: IconName }[] = [
  { label: "Overview", icon: "grid" },
  { label: "My vehicles", icon: "car" },
  { label: "Services", icon: "sparkle" },
  { label: "Activity", icon: "clock" },
];

function App() {
  const [role, setRole] = useState<UserRole>("Owner");
  const [page, setPage] = useState("Overview");
  const currentRole = roles.find((item) => item.name === role)!;

  function selectRole(name: UserRole) {
    setRole(UserRoleSchema.parse(name));
    setPage("Overview");
  }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <aside className="sidebar">
        <a className="brand" href="#" aria-label="Autospokes home">
          <span className="brand-mark">
            <Icon name="steering" size={20} />
          </span>
          <span className="brand-word">auto<span>spokes</span></span>
        </a>

        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav className="role-list" aria-label="Choose a workspace">
          {roles.map((item) => (
            <button
              className={`role-button ${role === item.name ? "role-active" : ""}`}
              key={item.name}
              onClick={() => selectRole(item.name)}
              type="button"
              aria-pressed={role === item.name}
            >
              <span className="role-icon"><Icon name={item.icon} size={17} /></span>
              <span className="role-copy">
                <span>{item.name}</span>
                <span className="role-descriptor">{item.descriptor}</span>
              </span>
              {role === item.name && <span className="active-dot" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-divider" />
        <div className="workspace-label nav-label">MENU</div>
        <nav className="nav-list" aria-label="Main navigation">
          {navigation.map((item) => (
            <button
              className={`nav-item ${page === item.label ? "nav-active" : ""}`}
              key={item.label}
              onClick={() => setPage(item.label)}
              type="button"
              aria-current={page === item.label ? "page" : undefined}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
              {item.label === "Activity" && <span className="nav-count">2</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="help-card">
            <span className="help-icon"><Icon name="help" size={17} /></span>
            <span><strong>Need a hand?</strong><small>We’re here to help.</small></span>
            <Icon name="arrow" size={15} />
          </div>
          <button className="profile" type="button">
            <span className="avatar">AS</span>
            <span className="profile-copy"><strong>Alex Sharma</strong><small>{currentRole.descriptor}</small></span>
            <Icon name="more" size={18} />
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="mobile-brand">
            <span className="brand-mark"><Icon name="steering" size={18} /></span>
            <span className="brand-word">auto<span>spokes</span></span>
          </div>
          <div className="breadcrumb"><span>Workspace</span><Icon name="chevron" size={14} /><strong>{page}</strong></div>
          <div className="top-actions">
            <button className="icon-button search-button" aria-label="Search" type="button"><Icon name="search" size={19} /></button>
            <button className="icon-button notification-button" aria-label="Notifications" type="button">
              <Icon name="bell" size={19} /><span className="notification-dot" />
            </button>
            <span className="top-divider" />
            <span className="top-avatar">AS</span>
          </div>
        </header>

        <div className="mobile-controls">
          <nav className="mobile-workspace" aria-label="Choose a workspace">
            {roles.map((item) => (
              <button
                className={`mobile-role ${role === item.name ? "mobile-role-active" : ""}`}
                key={item.name}
                onClick={() => selectRole(item.name)}
                type="button"
                aria-pressed={role === item.name}
              >
                <Icon name={item.icon} size={15} />
                <span>{item.name}</span>
              </button>
            ))}
          </nav>
          <nav className="mobile-navigation" aria-label="Main navigation">
            {navigation.map((item) => (
              <button
                className={`mobile-nav-item ${page === item.label ? "mobile-nav-active" : ""}`}
                key={item.label}
                onClick={() => setPage(item.label)}
                type="button"
                aria-current={page === item.label ? "page" : undefined}
              >
                <Icon name={item.icon} size={15} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="page-content">
          <div className="eyebrow"><span className="eyebrow-line" /> YOUR AUTOSPOKES {role.toUpperCase()} SPACE</div>
          {page === "Overview" ? (
            <Overview role={role} onNavigate={setPage} />
          ) : (
            <section className="placeholder-panel">
              <span className="placeholder-icon"><Icon name={navigation.find((item) => item.label === page)?.icon ?? "grid"} size={22} /></span>
              <p className="section-kicker">{currentRole.name} workspace</p>
              <h1>{page}</h1>
              <p>This space is being prepared. Your {page.toLowerCase()} tools will appear here in a future phase.</p>
              <button className="text-button" onClick={() => setPage("Overview")} type="button">Back to overview <Icon name="arrow" size={15} /></button>
            </section>
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

function Overview({ role, onNavigate }: { role: UserRole; onNavigate: (page: string) => void }) {
  const greeting = role === "Owner" ? "Your car deserves" : "Your workspace,";
  const title = role === "Owner" ? "a little more care." : "all in one place.";

  return (
    <>
      <section className="welcome-row">
        <div>
          <p className="section-kicker">WEDNESDAY, OCTOBER 14, 2026 <span className="date-dot">·</span> GOOD AFTERNOON, ALEX</p>
          <h1>{greeting}<br /><span>{title}</span></h1>
          <p className="welcome-copy">A better day starts with a better cared-for car. Here’s your little corner of Autospokes.</p>
        </div>
        <button className="primary-button" type="button" onClick={() => onNavigate("Services")}>
          <Icon name="plus" size={17} /> Explore services <Icon name="arrow-up-right" size={16} />
        </button>
      </section>

      <section className="hero-card">
        <div className="hero-copy">
          <span className="hero-tag"><span className="hero-tag-dot" /> A MORE CONSIDERED KIND OF CAR CARE</span>
          <h2>Good care.<br />No guesswork.</h2>
          <p>Discover trusted people who treat your car like their own. Quality care, right around the corner.</p>
          <button className="hero-link" type="button">Find your kind of care <Icon name="arrow-up-right" size={16} /></button>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-glow" />
          <div className="art-orbit orbit-one" />
          <div className="art-orbit orbit-two" />
          <div className="art-sun" />
          <div className="art-road" />
          <div className="art-car"><Icon name="car" size={150} /></div>
          <span className="art-caption">TAKE THE SCENIC ROUTE</span>
        </div>
      </section>

      <section className="overview-grid">
        <div className="section-heading">
          <div><p className="section-kicker">AT A GLANCE</p><h2>Your snapshot</h2></div>
          <button className="quiet-button" type="button">This month <Icon name="chevron-down" size={15} /></button>
        </div>
        <div className="stat-grid">
          <StatCard icon="car" label="Vehicles" value="01" note="Ready for some care" />
          <StatCard icon="calendar" label="Upcoming care" value="—" note="Your calendar is clear" />
          <StatCard icon="sparkle" label="Care saved" value="0 hrs" note="A little time well spent" />
        </div>
      </section>

      <section className="lower-grid">
        <div className="panel vehicle-panel">
          <div className="panel-heading"><div><p className="section-kicker">IN YOUR GARAGE</p><h2>Your vehicle</h2></div><button className="round-button" aria-label="Add vehicle" type="button"><Icon name="plus" size={17} /></button></div>
          <div className="vehicle-detail">
            <div className="vehicle-visual"><Icon name="car" size={50} /><span className="vehicle-shine" /></div>
            <div className="vehicle-info"><strong>Your first car goes here</strong><span>Add a vehicle to make care personal.</span></div>
            <button className="text-button add-link" type="button"><Icon name="plus" size={15} /> Add vehicle</button>
          </div>
        </div>
        <div className="panel care-panel">
          <div className="panel-heading"><div><p className="section-kicker">A GOOD PLACE TO START</p><h2>Care, your way</h2></div><span className="new-pill">NEW</span></div>
          <div className="care-row"><span className="care-icon"><Icon name="sparkle" size={18} /></span><div><strong>Explore nearby services</strong><span>Find a little care close to home.</span></div><Icon name="arrow" size={17} /></div>
          <div className="care-row"><span className="care-icon care-icon-blue"><Icon name="shield" size={18} /></span><div><strong>Meet trusted providers</strong><span>Good people, doing good work.</span></div><Icon name="arrow" size={17} /></div>
        </div>
      </section>
    </>
  );
}

function StatCard({ icon, label, value, note }: { icon: IconName; label: string; value: string; note: string }) {
  return (
    <article className="stat-card">
      <div className="stat-top"><span className="stat-icon"><Icon name={icon} size={18} /></span><span className="stat-period">THIS MONTH</span></div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-note">{note}</div>
    </article>
  );
}

export default App;
