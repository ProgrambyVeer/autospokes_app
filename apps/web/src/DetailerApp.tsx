import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  CreateDetailerClientSchema,
  CreateDetailerVehicleSchema,
  DetailerProfileUpdateSchema,
  SaveSchedulesSchema,
  TaskExceptionRequestSchema,
  UpdateDetailerClientSchema,
  UpdateDetailerVehicleSchema,
  type DailyTask,
  type DetailerClient,
  type DetailerProfile,
  type DetailerVehicle,
  type WashActivity,
  type WashScheduleInput,
} from "@autospokes/shared";
import {
  ApiError,
  createDetailerClient,
  createDetailerVehicle,
  getDetailerClient,
  getDetailerClients,
  getDetailerProfile,
  getDetailerTasks,
  getDetailerVehicle,
  saveDetailerSchedules,
  signOut,
  updateDetailerClient,
  updateDetailerException,
  updateDetailerProfile,
  updateDetailerTask,
  updateDetailerVehicle,
  type AuthSession,
} from "./api";
import { Icon } from "./components/Icon";

type DetailerPage = "Today" | "Clients" | "Profile";
type ScheduleForm = {
  activity: WashActivity;
  frequency: "DAILY" | "SELECTED_DAYS";
  weekdays: number[];
  effectiveFrom: string;
  effectiveTo: string;
  isActive: boolean;
};

const activities: { value: WashActivity; label: string }[] = [
  { value: "EXTERIOR_WASH", label: "Exterior wash" },
  { value: "INTERIOR_CLEANING", label: "Interior cleaning" },
  { value: "TYRE_POLISH", label: "Tyre polish" },
];
const weekdays = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

function todayInIndia(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function errorsFor(error: unknown): Record<string, string[]> {
  if (error instanceof ApiError) return error.fieldErrors;
  if (typeof error !== "object" || error === null || !("issues" in error) || !Array.isArray(error.issues)) {
    return {};
  }
  const errors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    if (typeof issue !== "object" || issue === null || !("path" in issue) || !Array.isArray(issue.path) || !("message" in issue) || typeof issue.message !== "string") continue;
    const key = String(issue.path[0] ?? "form");
    errors[key] = [...(errors[key] ?? []), issue.message];
  }
  return errors;
}

function FieldError({ errors, name }: { errors: Record<string, string[]>; name: string }) {
  const messages = errors[name];
  return messages?.length ? <small className="detailer-field-error">{messages.join(" ")}</small> : null;
}

export function DetailerWorkspace({
  session,
  onSignOut,
}: {
  session: AuthSession;
  onSignOut: () => void;
}) {
  const [profile, setProfile] = useState<DetailerProfile | null>(null);
  const [page, setPage] = useState<DetailerPage>("Today");
  const [clients, setClients] = useState<DetailerClient[]>([]);
  const [tasks, setTasks] = useState<DailyTask[]>([]);
  const [taskNotes, setTaskNotes] = useState<Record<string, string>>({});
  const [taskDate, setTaskDate] = useState(todayInIndia());
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [clientDetail, setClientDetail] = useState<{ client: DetailerClient; vehicles: DetailerVehicle[] } | null>(null);
  const [scheduleForm, setScheduleForm] = useState<ScheduleForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState("");
  const [editingClient, setEditingClient] = useState(false);
  const [addingClient, setAddingClient] = useState(false);
  const [addingVehicle, setAddingVehicle] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<DetailerVehicle | null>(null);
  const [saving, setSaving] = useState(false);

  const initials = useMemo(
    () => (profile?.displayName ?? session.user.displayName).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join(""),
    [profile?.displayName, session.user.displayName],
  );

  async function refreshClients() {
    const result = await getDetailerClients(session);
    setClients(result);
  }

  async function refreshTasks(date = taskDate) {
    const result = await getDetailerTasks(session, date);
    setTasks(result.tasks);
    setTaskDate(result.date);
  }

  useEffect(() => {
    let active = true;
    Promise.all([getDetailerProfile(session), getDetailerClients(session), getDetailerTasks(session)])
      .then(([nextProfile, nextClients, taskResult]) => {
        if (!active) return;
        setProfile(nextProfile);
        setClients(nextClients);
        setTaskDate(taskResult.date);
        setTasks(taskResult.tasks);
      })
      .catch((cause: unknown) => {
        if (active) setError(describeError(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session]);

  useEffect(() => {
    if (!selectedClientId) {
      setClientDetail(null);
      return;
    }
    let active = true;
    getDetailerClient(session, selectedClientId)
      .then((result) => {
        if (active) setClientDetail(result);
      })
      .catch((cause: unknown) => {
        if (active) setError(describeError(cause));
      });
    return () => {
      active = false;
    };
  }, [selectedClientId, session]);

  function navigate(next: DetailerPage) {
    setError("");
    setFieldErrors({});
    setNotice("");
    setPage(next);
    setSelectedClientId(null);
    setSelectedVehicleId(null);
    setEditingClient(false);
    setAddingClient(false);
    setAddingVehicle(false);
    setEditingVehicle(null);
  }

  async function handleSignOut() {
    setError("");
    try {
      await signOut(session);
      onSignOut();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onSignOut();
      else setError(describeError(cause));
    }
  }

  async function loadSchedules(vehicleId: string) {
    setError("");
    setNotice("");
    try {
      const result = await getDetailerVehicle(session, vehicleId);
      setSelectedVehicleId(vehicleId);
      setScheduleForm(activities.map(({ value }) => {
        const existing = result.schedules.find((schedule) => schedule.activity === value);
        return {
          activity: value,
          frequency: existing?.frequency ?? "SELECTED_DAYS",
          weekdays: existing?.weekdays ?? [1],
          effectiveFrom: existing?.effectiveFrom ?? taskDate,
          effectiveTo: existing?.effectiveTo ?? "",
          isActive: existing?.isActive ?? false,
        };
      }));
      setAddingVehicle(false);
      setEditingVehicle(null);
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  async function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    const data = new FormData(event.currentTarget);
    const values = {
      displayName: String(data.get("displayName") ?? ""),
      phoneNumber: String(data.get("phoneNumber") ?? ""),
      serviceArea: String(data.get("serviceArea") ?? ""),
      contactEmail: String(data.get("contactEmail") ?? "") || null,
    };
    const parsed = DetailerProfileUpdateSchema.safeParse(values);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(". "));
      setFieldErrors(errorsFor(parsed.error));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const saved = await updateDetailerProfile(session, parsed.data);
      setProfile(saved);
      setNotice("Business profile saved.");
    } catch (cause) {
      setError(describeError(cause));
      setFieldErrors(errorsFor(cause));
    } finally {
      setSaving(false);
    }
  }

  async function submitClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    const data = new FormData(event.currentTarget);
    const raw = {
      name: String(data.get("name") ?? ""),
      phoneNumber: String(data.get("phoneNumber") ?? ""),
      notes: String(data.get("notes") ?? "") || null,
    };
    setSaving(true);
    setError("");
    try {
      let saved: DetailerClient;
      if (editingClient && clientDetail) {
        const parsed = UpdateDetailerClientSchema.safeParse({
          ...raw,
          status: String(data.get("status") ?? clientDetail.client.status),
        });
        if (!parsed.success) throw parsed.error;
        saved = await updateDetailerClient(session, clientDetail.client.id, parsed.data);
        setClientDetail((current) => current ? { ...current, client: saved } : current);
      } else {
        const parsed = CreateDetailerClientSchema.safeParse(raw);
        if (!parsed.success) throw parsed.error;
        saved = await createDetailerClient(session, parsed.data);
        setSelectedClientId(saved.id);
        setNotice("Client saved.");
      }
      await refreshClients();
      setAddingClient(false);
      setEditingClient(false);
    } catch (cause) {
      setError(describeError(cause));
      setFieldErrors(errorsFor(cause));
    } finally {
      setSaving(false);
    }
  }

  async function submitVehicle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    if (!selectedClientId) return;
    const data = new FormData(event.currentTarget);
    const raw = {
      type: String(data.get("type") ?? ""),
      registrationNumber: String(data.get("registrationNumber") ?? ""),
      make: String(data.get("make") ?? "") || null,
      model: String(data.get("model") ?? "") || null,
      locationName: String(data.get("locationName") ?? "") || null,
    };
    setSaving(true);
    setError("");
    try {
      if (editingVehicle) {
        const parsed = UpdateDetailerVehicleSchema.safeParse({
          ...raw,
          status: String(data.get("status") ?? editingVehicle.status),
        });
        if (!parsed.success) throw parsed.error;
        await updateDetailerVehicle(session, editingVehicle.id, parsed.data);
      } else {
        const parsed = CreateDetailerVehicleSchema.safeParse(raw);
        if (!parsed.success) throw parsed.error;
        await createDetailerVehicle(session, selectedClientId, parsed.data);
      }
      const updated = await getDetailerClient(session, selectedClientId);
      setClientDetail(updated);
      await refreshClients();
      setAddingVehicle(false);
      setEditingVehicle(null);
      setNotice("Vehicle saved.");
    } catch (cause) {
      setError(describeError(cause));
      setFieldErrors(errorsFor(cause));
    } finally {
      setSaving(false);
    }
  }

  async function submitSchedules(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    if (!selectedVehicleId) return;
    const raw: WashScheduleInput[] = scheduleForm.map((schedule) => ({
      ...schedule,
      effectiveTo: schedule.effectiveTo || null,
    }));
    const parsed = SaveSchedulesSchema.safeParse({ schedules: raw });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(". "));
      setFieldErrors(errorsFor(parsed.error));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await saveDetailerSchedules(session, selectedVehicleId, parsed.data.schedules);
      setSelectedVehicleId(null);
      setNotice("Wash schedule saved.");
    } catch (cause) {
      setError(describeError(cause));
      setFieldErrors(errorsFor(cause));
    } finally {
      setSaving(false);
    }
  }

  async function setTaskStatus(task: DailyTask, status: DailyTask["status"], note?: string) {
    setError("");
    try {
      await updateDetailerTask(session, task.id, { status, ...(note !== undefined ? { note } : {}) });
      await refreshTasks();
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  async function saveTaskNote(task: DailyTask) {
    setError("");
    try {
      await updateDetailerTask(session, task.id, {
        status: task.status,
        note: taskNotes[task.id] ?? task.note ?? "",
      });
      await refreshTasks();
      setNotice("Task note saved.");
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  async function setException(
    exception: "VEHICLE_UNAVAILABLE" | "WASH_MISSED" | "DETAILER_ON_LEAVE",
    vehicleId: string | undefined,
    active: boolean,
  ) {
    const parsed = TaskExceptionRequestSchema.safeParse({
      date: taskDate,
      exception,
      ...(vehicleId ? { vehicleId } : {}),
      active,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(". "));
      return;
    }
    setError("");
    try {
      await updateDetailerException(session, parsed.data);
      await refreshTasks();
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  const selectedClient = clientDetail?.client;
  const onLeave = tasks.some((task) => task.exception === "DETAILER_ON_LEAVE");

  return (
    <div className="owner-app detailer-app">
      <aside className="owner-sidebar">
        <a className="brand" href="/" aria-label="Autospokes">
          <span className="brand-mark"><Icon name="steering" size={20} /></span>
          <span className="brand-word">auto<span>spokes</span></span>
        </a>
        <p className="workspace-label">DETAILER WORKSPACE</p>
        <nav className="owner-nav" aria-label="Independent Detailer navigation">
          {(["Today", "Clients", "Profile"] as const).map((item) => (
            <button key={item} type="button" className={`owner-nav-item ${page === item ? "owner-nav-active" : ""}`} aria-current={page === item ? "page" : undefined} onClick={() => navigate(item)}>
              <Icon name={item === "Today" ? "calendar" : item === "Clients" ? "car" : "shield"} size={18} />
              <span>{item === "Today" ? "Daily tasks" : item}</span>
              {item === "Clients" && clients.length > 0 && <span className="detailer-nav-count">{clients.length}</span>}
            </button>
          ))}
        </nav>
        <div className="owner-sidebar-bottom">
          <div className="help-card"><span className="help-icon"><Icon name="help" size={17} /></span><span><strong>Care, made consistent</strong><small>One vehicle at a time.</small></span></div>
          <div className="owner-account"><span className="avatar">{initials || "AS"}</span><span className="profile-copy"><strong>{profile?.displayName ?? session.user.displayName}</strong><small>Independent Detailer</small></span><button type="button" aria-label="Sign out" onClick={handleSignOut}><Icon name="more" size={18} /></button></div>
        </div>
      </aside>
      <main className="owner-main">
        <header className="owner-topbar">
          <a className="brand brand-compact" href="/" aria-label="Autospokes"><span className="brand-mark"><Icon name="steering" size={18} /></span><span className="brand-word">auto<span>spokes</span></span></a>
          <div className="topbar-context"><span>Independent Detailer</span><Icon name="chevron" size={14} /><strong>{selectedClient ? selectedClient.name : page === "Today" ? "Daily tasks" : page}</strong></div>
          <div className="owner-top-actions"><span className="owner-status-dot" /><span>Account private</span><span className="top-divider" /><span className="top-avatar">{initials || "AS"}</span><button className="mobile-signout" type="button" onClick={handleSignOut}>Sign out</button></div>
        </header>
        <div className="owner-mobile-nav">
          <nav className="owner-nav" aria-label="Independent Detailer mobile navigation">
            {(["Today", "Clients", "Profile"] as const).map((item) => (
              <button key={item} type="button" className={`owner-nav-item ${page === item ? "owner-nav-active" : ""}`} aria-current={page === item ? "page" : undefined} onClick={() => navigate(item)}>
                <Icon name={item === "Today" ? "calendar" : item === "Clients" ? "car" : "shield"} size={18} />
                <span>{item === "Today" ? "Tasks" : item}</span>
              </button>
            ))}
          </nav>
        </div>
        <div className="owner-content">
          {error && <div className="notice notice-error" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
          {notice && <div className="notice notice-success" role="status">{notice}</div>}
          {loading ? <div className="loading-panel" role="status">Loading your detailer workspace…</div> : (
            <>
              {!profile?.onboardingComplete && page !== "Profile" && (
                <section className="detailer-onboarding" aria-live="polite">
                  <p className="section-kicker">ONE QUICK STEP</p>
                  <h1>Set up your detailer profile.</h1>
                  <p>Add your business name, phone and service area to get started. Phone details are not verified by SMS.</p>
                  <button className="primary-button" type="button" onClick={() => navigate("Profile")}>Complete profile <Icon name="arrow-up-right" size={16} /></button>
                </section>
              )}
              {page === "Profile" ? (
                <section className="detailer-panel">
                  <p className="section-kicker">YOUR DETAILER ACCOUNT</p>
                  <h1>Business profile</h1>
                  <p className="detailer-muted">Contact and service-area information for your independent detailer workspace.</p>
                  <form className="owner-form detailer-form" onSubmit={submitProfile}>
                    <label>Display or business name<input name="displayName" defaultValue={profile?.displayName ?? session.user.displayName} maxLength={80} required /><FieldError errors={fieldErrors} name="displayName" /></label>
                    <label>Phone number<input name="phoneNumber" type="tel" inputMode="tel" defaultValue={profile?.phoneNumber ?? ""} placeholder="+91 98765 43210" required /><FieldError errors={fieldErrors} name="phoneNumber" /></label>
                    <label>Service area<input name="serviceArea" defaultValue={profile?.serviceArea ?? ""} maxLength={160} placeholder="Neighbourhoods or city" required /><FieldError errors={fieldErrors} name="serviceArea" /></label>
                    <label>Contact email <span className="detailer-optional">Optional</span><input name="contactEmail" type="email" defaultValue={profile?.contactEmail ?? ""} maxLength={254} /><FieldError errors={fieldErrors} name="contactEmail" /></label>
                    <p className="detailer-muted">No OTP or SMS verification is used.</p>
                    <button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save profile"}<Icon name="arrow-up-right" size={16} /></button>
                  </form>
                </section>
              ) : page === "Clients" ? (
                <section className="detailer-panel">
                  {selectedClientId && selectedClient ? (
                    <>
                      <button className="detailer-back" type="button" onClick={() => { setSelectedClientId(null); setAddingVehicle(false); setEditingVehicle(null); setSelectedVehicleId(null); }}>← All clients</button>
                      <div className="detailer-heading-row"><div><p className="section-kicker">CLIENT DETAILS</p><h1>{selectedClient.name}</h1><p className="detailer-muted">{selectedClient.phoneNumber}</p></div><button className="secondary-button" type="button" onClick={() => { setEditingClient(true); setAddingClient(false); }}>Edit client</button></div>
                      {editingClient && <form className="owner-form detailer-inline-form" onSubmit={submitClient}>
                        <label>Name<input name="name" defaultValue={selectedClient.name} required maxLength={100} /><FieldError errors={fieldErrors} name="name" /></label>
                        <label>Phone<input name="phoneNumber" type="tel" defaultValue={selectedClient.phoneNumber} required /><FieldError errors={fieldErrors} name="phoneNumber" /></label>
                        <label>Notes<input name="notes" defaultValue={selectedClient.notes ?? ""} maxLength={500} /></label>
                        <label>Status<select name="status" defaultValue={selectedClient.status}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label>
                        <div className="detailer-actions"><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save client"}</button><button className="secondary-button" type="button" onClick={() => setEditingClient(false)}>Cancel</button></div>
                      </form>}
                      <div className="detailer-subheading"><div><p className="section-kicker">VEHICLES</p><h2>{clientDetail?.vehicles.length ?? 0} vehicles</h2></div><button className="primary-button" type="button" onClick={() => { setAddingVehicle(true); setEditingVehicle(null); setSelectedVehicleId(null); }}>Add vehicle <Icon name="plus" size={16} /></button></div>
                      {addingVehicle && <form className="owner-form detailer-inline-form" onSubmit={submitVehicle}>
                        <label>Vehicle type<select name="type" required defaultValue="FOUR_WHEELER"><option value="TWO_WHEELER">Two-wheeler</option><option value="FOUR_WHEELER">Four-wheeler</option><option value="OTHER">Other</option></select><FieldError errors={fieldErrors} name="type" /></label>
                        <label>Registration number<input name="registrationNumber" required maxLength={32} /><FieldError errors={fieldErrors} name="registrationNumber" /></label>
                        <label>Make <span className="detailer-optional">Optional</span><input name="make" maxLength={80} /></label>
                        <label>Model <span className="detailer-optional">Optional</span><input name="model" maxLength={80} /></label>
                        <label>Location <span className="detailer-optional">Optional</span><input name="locationName" maxLength={100} /></label>
                        <div className="detailer-actions"><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Add vehicle"}</button><button className="secondary-button" type="button" onClick={() => setAddingVehicle(false)}>Cancel</button></div>
                      </form>}
                      {clientDetail && clientDetail.vehicles.length === 0 && !addingVehicle ? <div className="empty-state"><Icon name="car" size={22} /><strong>No vehicles yet</strong><span>Add this client’s first vehicle to set a care schedule.</span></div> : null}
                      <div className="detailer-vehicle-list">
                        {clientDetail?.vehicles.map((vehicle) => (
                          <article className="detailer-vehicle-card" key={vehicle.id}>
                            {editingVehicle?.id === vehicle.id ? <form className="owner-form detailer-inline-form" onSubmit={submitVehicle}>
                              <label>Vehicle type<select name="type" defaultValue={vehicle.type}><option value="TWO_WHEELER">Two-wheeler</option><option value="FOUR_WHEELER">Four-wheeler</option><option value="OTHER">Other</option></select><FieldError errors={fieldErrors} name="type" /></label>
                              <label>Registration number<input name="registrationNumber" defaultValue={vehicle.registrationNumber} required maxLength={32} /><FieldError errors={fieldErrors} name="registrationNumber" /></label>
                              <label>Make<input name="make" defaultValue={vehicle.make ?? ""} maxLength={80} /></label>
                              <label>Model<input name="model" defaultValue={vehicle.model ?? ""} maxLength={80} /></label>
                              <label>Location<input name="locationName" defaultValue={vehicle.locationName ?? ""} maxLength={100} /></label>
                              <label>Status<select name="status" defaultValue={vehicle.status}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label>
                              <div className="detailer-actions"><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save vehicle"}</button><button className="secondary-button" type="button" onClick={() => setEditingVehicle(null)}>Cancel</button></div>
                            </form> : <>
                              <div><span className="detailer-tag">{vehicle.type.replaceAll("_", " ").toLowerCase()}</span><h3>{vehicle.registrationNumber}</h3><p>{[vehicle.make, vehicle.model, vehicle.locationName].filter(Boolean).join(" · ") || "No optional details added"}</p></div>
                              <div className="detailer-actions"><button className="secondary-button" type="button" onClick={() => { setEditingVehicle(vehicle); setAddingVehicle(false); setSelectedVehicleId(null); }}>Edit</button><button className="secondary-button" type="button" onClick={() => void loadSchedules(vehicle.id)}>Schedule</button></div>
                            </>}
                            {selectedVehicleId === vehicle.id && <form className="owner-form detailer-schedule-form" onSubmit={submitSchedules}>
                              <div className="detailer-subheading"><div><p className="section-kicker">SERVICE PLAN</p><h2>Wash schedule</h2></div><button className="secondary-button" type="button" onClick={() => setSelectedVehicleId(null)}>Close</button></div>
                              {scheduleForm.map((schedule, index) => (
                                <fieldset className="detailer-schedule-row" key={schedule.activity}>
                                  <legend>{activities.find((item) => item.value === schedule.activity)?.label}</legend>
                                  <label className="detailer-check"><input type="checkbox" checked={schedule.isActive} onChange={(event) => setScheduleForm((current) => current.map((item, i) => i === index ? { ...item, isActive: event.target.checked } : item))} /> Active</label>
                                  <label>Frequency<select value={schedule.frequency} onChange={(event) => setScheduleForm((current) => current.map((item, i) => i === index ? { ...item, frequency: event.target.value as ScheduleForm["frequency"] } : item))}><option value="DAILY">Daily</option><option value="SELECTED_DAYS">Selected days</option></select></label>
                                  {schedule.frequency === "SELECTED_DAYS" && <div className="detailer-weekdays" aria-label={`${schedule.activity} weekdays`}>
                                    {weekdays.map((day) => <label className="detailer-check" key={day.value}><input type="checkbox" checked={schedule.weekdays.includes(day.value)} onChange={(event) => setScheduleForm((current) => current.map((item, i) => i === index ? { ...item, weekdays: event.target.checked ? [...item.weekdays, day.value].sort() : item.weekdays.filter((value) => value !== day.value) } : item))} />{day.label}</label>)}
                                  </div>}
                                  <div className="form-grid"><label>Effective from<input type="date" value={schedule.effectiveFrom} onChange={(event) => setScheduleForm((current) => current.map((item, i) => i === index ? { ...item, effectiveFrom: event.target.value } : item))} required /></label><label>Effective to <span className="detailer-optional">Optional</span><input type="date" value={schedule.effectiveTo} onChange={(event) => setScheduleForm((current) => current.map((item, i) => i === index ? { ...item, effectiveTo: event.target.value } : item))} /></label></div>
                                </fieldset>
                              ))}
                              <button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save schedule"}</button>
                            </form>}
                            <span className={`detailer-status detailer-status-${vehicle.status.toLowerCase()}`}>{vehicle.status.toLowerCase()}</span>
                          </article>
                        ))}
                      </div>
                    </>
                  ) : addingClient ? (
                    <><button className="detailer-back" type="button" onClick={() => setAddingClient(false)}>← All clients</button><p className="section-kicker">CLIENT PROFILE</p><h1>Add a client</h1><form className="owner-form detailer-form" onSubmit={submitClient}><label>Client name<input name="name" required maxLength={100} /><FieldError errors={fieldErrors} name="name" /></label><label>Phone number<input name="phoneNumber" type="tel" inputMode="tel" required placeholder="+91 98765 43210" /><FieldError errors={fieldErrors} name="phoneNumber" /></label><label>Notes <span className="detailer-optional">Optional</span><textarea name="notes" rows={3} maxLength={500} /></label><div className="detailer-actions"><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save client"}</button><button className="secondary-button" type="button" onClick={() => setAddingClient(false)}>Cancel</button></div></form></>
                  ) : (
                    <><div className="detailer-heading-row"><div><p className="section-kicker">YOUR CUSTOMER LIST</p><h1>Clients</h1><p className="detailer-muted">Clients and vehicles are private to your Detailer account.</p></div><button className="primary-button" type="button" onClick={() => { setAddingClient(true); setEditingClient(false); }}>Add client <Icon name="plus" size={16} /></button></div>
                    {clients.length === 0 ? <div className="empty-state"><Icon name="car" size={22} /><strong>No clients added yet</strong><span>Add a client by name and phone number to begin.</span><button className="secondary-button" type="button" onClick={() => setAddingClient(true)}>Add your first client</button></div> : <div className="detailer-client-list">{clients.map((client) => <button className="detailer-client-card" type="button" key={client.id} onClick={() => { setSelectedClientId(client.id); setAddingClient(false); }}><span className="avatar">{client.name.slice(0, 1).toUpperCase()}</span><span className="detailer-client-copy"><strong>{client.name}</strong><small>{client.phoneNumber}</small></span><span className="detailer-client-count">{client.vehicleCount} {client.vehicleCount === 1 ? "vehicle" : "vehicles"}</span><Icon name="chevron" size={16} /></button>)}</div>}</>
                  )}
                  {selectedClientId && !clientDetail && <div className="loading-panel" role="status">Loading client details…</div>}
                </section>
              ) : (
                <section className="detailer-panel">
                  <div className="detailer-heading-row"><div><p className="section-kicker">DAILY OPERATIONS · IST</p><h1>Today’s care plan</h1><p className="detailer-muted">Tasks are generated from your active vehicle schedules.</p></div></div>
                  <div className="detailer-task-toolbar"><label>Task date<input type="date" value={taskDate} onChange={(event) => { setTaskDate(event.target.value); void refreshTasks(event.target.value); }} /></label><div className="detailer-exceptions"><button className={`secondary-button ${onLeave ? "detailer-exception-active" : ""}`} type="button" onClick={() => void setException("DETAILER_ON_LEAVE", undefined, !onLeave)}>{onLeave ? "Clear leave" : "Mark day off"}</button></div></div>
                  {tasks.length === 0 ? <div className="empty-state"><Icon name="calendar" size={22} /><strong>No tasks for this date</strong><span>Tasks appear when active vehicles have dusting or a scheduled wash.</span></div> : <div className="detailer-task-list">{tasks.map((task) => {
                    const exception = task.exception;
                    const disabled = Boolean(exception) || task.status === "COMPLETED" || task.taskDate > todayInIndia();
                    return <article className="detailer-task-card" key={task.id}>
                      <div className="detailer-task-main"><span className={`detailer-task-indicator detailer-status-${task.status.toLowerCase()}`} /><div><span className="detailer-tag">{task.activity.replaceAll("_", " ").toLowerCase()}</span><h2>{task.registrationNumber}</h2><p>{task.clientName}{task.locationName ? ` · ${task.locationName}` : ""}</p>{exception && <small className="detailer-exception-label">{exception.replaceAll("_", " ").toLowerCase()}</small>}</div></div>
                      <div className="detailer-task-controls">
                        <span className={`detailer-status detailer-status-${task.status.toLowerCase()}`}>{task.status.toLowerCase()}</span>
                        {!exception && <div className="detailer-task-note">
                          <label htmlFor={`task-note-${task.id}`}>Note</label>
                          <input id={`task-note-${task.id}`} value={taskNotes[task.id] ?? task.note ?? ""} maxLength={500} disabled={task.taskDate > todayInIndia()} onChange={(event) => setTaskNotes((current) => ({ ...current, [task.id]: event.target.value }))} />
                          <button className="secondary-button" type="button" disabled={task.taskDate > todayInIndia()} onClick={() => void saveTaskNote(task)}>Save note</button>
                        </div>}
                        {!disabled && <><button className="primary-button" type="button" onClick={() => void setTaskStatus(task, "COMPLETED", taskNotes[task.id] ?? task.note ?? undefined)}>Complete</button><button className="secondary-button" type="button" onClick={() => void setException("WASH_MISSED", task.vehicleId, true)}>Missed</button><button className="secondary-button" type="button" onClick={() => void setException("VEHICLE_UNAVAILABLE", task.vehicleId, true)}>Unavailable</button></>}
                        {exception && <button className="secondary-button" type="button" onClick={() => void setException(exception, exception === "DETAILER_ON_LEAVE" ? undefined : task.vehicleId, false)}>Clear exception</button>}
                        {(task.status === "MISSED" || task.status === "UNAVAILABLE") && !exception && <button className="secondary-button" type="button" onClick={() => void setTaskStatus(task, "SCHEDULED")}>Reopen</button>}
                      </div>
                    </article>;
                  })}</div>}
                </section>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
