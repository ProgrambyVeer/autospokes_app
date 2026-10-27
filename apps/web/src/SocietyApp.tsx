import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  SocietyInputSchema,
  SocietyProfileUpdateSchema,
  SocietyResidentInputSchema,
  SocietyResidentUpdateSchema,
  type SocietyScheduleActivity,
  SocietyVehicleInputSchema,
  SocietyVehicleUpdateSchema,
  SocietyWashScheduleInputSchema,
  SocietyWasherInputSchema,
  SocietyWasherUpdateSchema,
} from "@autospokes/shared";
import {
  ApiError,
  assignSocietyWasher,
  createSociety,
  createSocietyDeduction,
  createSocietyExtraWork,
  createSocietyReminder,
  createSocietyResident,
  createSocietyWasher,
  createSocietyVehicle,
  decideSocietyDeduction,
  decideSocietyExtraWork,
  generateSocietyInvoices,
  getSocieties,
  getSocietyAttendance,
  getSocietyDeductions,
  getSocietyEarnings,
  getSocietyExtraWork,
  getSocietyInvoices,
  getSocietyProfile,
  getSocietyResidents,
  getSocietyTasks,
  getSocietyVehicles,
  getSocietyVehicleSchedules,
  getSocietyWashers,
  recordSocietyAttendance,
  recordSocietyPayment,
  signOut,
  saveSocietyVehicleSchedule,
  updateSocietyProfile,
  updateSociety,
  updateSocietyResident,
  updateSocietyTask,
  updateSocietyWasher,
  updateSocietyVehicle,
  updateSocietyScheduleStatus,
  type AuthSession,
  type SocietyRecord,
  type SocietyProfile,
} from "./api";
import { Icon } from "./components/Icon";

type SocietyPage = "Societies" | "Residents & vehicles" | "Washers & attendance" | "Daily tasks" | "Billing" | "Compensation" | "Extra work" | "Profile";
type DataSet = {
  residents: SocietyRecord[];
  vehicles: SocietyRecord[];
  washers: SocietyRecord[];
  attendance: SocietyRecord[];
  tasks: SocietyRecord[];
  invoices: SocietyRecord[];
  earnings: SocietyRecord[];
  deductions: SocietyRecord[];
  extraWork: SocietyRecord[];
};

const pages: SocietyPage[] = [
  "Societies",
  "Residents & vehicles",
  "Washers & attendance",
  "Daily tasks",
  "Billing",
  "Compensation",
  "Extra work",
  "Profile",
];
const emptyData: DataSet = {
  residents: [], vehicles: [], washers: [], attendance: [], tasks: [], invoices: [],
  earnings: [], deductions: [], extraWork: [],
};
const text = (record: Partial<SocietyRecord>, key: string): string =>
  typeof record[key] === "string" ? record[key] as string : "";
const number = (record: Partial<SocietyRecord>, key: string): number =>
  typeof record[key] === "number" ? record[key] as number : 0;
const object = (record: Partial<SocietyRecord>, key: string): SocietyRecord | null => {
  const value = record[key];
  return typeof value === "object" && value !== null ? value as SocietyRecord : null;
};
const records = (record: Partial<SocietyRecord>, key: string): SocietyRecord[] =>
  Array.isArray(record[key]) ? record[key] as SocietyRecord[] : [];
const paise = (value: number): string => `₹${(value / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
const todayInIndia = (): string => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const currentMonth = (): string => todayInIndia().slice(0, 7);
const errorText = (error: unknown): string => error instanceof Error ? error.message : "Something went wrong. Please try again.";

function ValidationNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const fieldErrors: Record<string, string[]> = error instanceof ApiError ? error.fieldErrors : {};
  if (
    !(error instanceof ApiError) &&
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray(error.issues)
  ) {
    for (const issue of error.issues) {
      if (
        typeof issue !== "object" ||
        issue === null ||
        !("path" in issue) ||
        !Array.isArray(issue.path) ||
        !("message" in issue) ||
        typeof issue.message !== "string"
      ) continue;
      const field = String(issue.path[0] ?? "form");
      fieldErrors[field] = [...(fieldErrors[field] ?? []), issue.message];
    }
  }
  return (
    <div className="notice notice-error" role="alert">
      <div>
        <strong>{Object.keys(fieldErrors).length ? "Please review the form fields." : errorText(error)}</strong>
        {Object.entries(fieldErrors).map(([field, messages]) => (
          <div key={field}>{field}: {messages.join(" ")}</div>
        ))}
      </div>
    </div>
  );
}

export function SocietyWorkspace({ session, onSignOut }: { session: AuthSession; onSignOut: () => void }) {
  const [page, setPage] = useState<SocietyPage>("Societies");
  const [profile, setProfile] = useState<SocietyProfile | null>(null);
  const [societies, setSocieties] = useState<SocietyRecord[]>([]);
  const [societyId, setSocietyId] = useState("");
  const [data, setData] = useState<DataSet>(emptyData);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [taskDate, setTaskDate] = useState(todayInIndia());
  const [invoiceMonth, setInvoiceMonth] = useState(currentMonth());

  const currentSociety = societies.find((item) => item.id === societyId);
  const initials = useMemo(
    () => (profile?.displayName ?? session.user.displayName).split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join(""),
    [profile?.displayName, session.user.displayName],
  );

  async function loadSocieties() {
    const result = await getSocieties(session);
    setSocieties(result);
    if (!result.some((item) => item.id === societyId)) setSocietyId(result[0]?.id ?? "");
  }

  const loadSelected = useCallback(async (id = societyId, dateValue = taskDate) => {
    if (!id) {
      setData(emptyData);
      return;
    }
    const [residents, vehicles, washers, attendance, tasks, invoices, earnings, deductions, extraWork] = await Promise.all([
      getSocietyResidents(session, id),
      getSocietyVehicles(session, id),
      getSocietyWashers(session, id),
      getSocietyAttendance(session, id, todayInIndia()),
      getSocietyTasks(session, id, dateValue),
      getSocietyInvoices(session, id),
      getSocietyEarnings(session, id),
      getSocietyDeductions(session, id),
      getSocietyExtraWork(session, id),
    ]);
    setData({ residents, vehicles, washers, attendance, tasks, invoices, earnings, deductions, extraWork });
  }, [session, societyId, taskDate]);

  useEffect(() => {
    let active = true;
    Promise.all([getSocietyProfile(session), getSocieties(session)])
      .then(([nextProfile, nextSocieties]) => {
        if (!active) return;
        setProfile(nextProfile);
        setSocieties(nextSocieties);
        setSocietyId(nextSocieties[0]?.id ?? "");
      })
      .catch((cause: unknown) => { if (active) setError(cause); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [session]);

  useEffect(() => {
    if (!societyId) return;
    let active = true;
    setLoading(true);
    loadSelected(societyId, taskDate)
      .catch((cause: unknown) => { if (active) setError(cause); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [societyId, taskDate, loadSelected]);

  async function refresh() {
    await loadSocieties();
    await loadSelected();
  }

  async function mutate(operation: () => Promise<unknown>, message: string, refreshData = true): Promise<boolean> {
    setSaving(true);
    setError(null);
    setNotice("");
    try {
      await operation();
      if (refreshData) await refresh();
      setNotice(message);
      return true;
    } catch (cause) {
      setError(cause);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function submit(
    event: FormEvent<HTMLFormElement>,
    schema: { safeParse: (input: unknown) => { success: boolean; data?: unknown; error?: unknown } },
    operation: (input: never) => Promise<unknown>,
  ) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const formInput: Record<string, FormDataEntryValue> = Object.fromEntries(formData.entries());
    const input = schema === SocietyResidentInputSchema
      ? { ...formInput, societyId }
      : schema === SocietyWasherInputSchema
        ? { ...formInput, societyId, ratePerTaskPaise: Number(formInput.ratePerTaskPaise) }
        : schema === SocietyProfileUpdateSchema
        ? { ...formInput, contactEmail: formInput.contactEmail === "" ? null : formInput.contactEmail }
        : formInput;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error);
      return;
    }
    if (await mutate(() => operation(parsed.data as never), "Changes saved.")) event.currentTarget.reset();
  }

  async function handleSignOut() {
    try {
      await signOut(session);
    } finally {
      onSignOut();
    }
  }

  const field = (name: string, label: string, props: Record<string, string> = {}) => {
    const { required: requiredProp, ...attributes } = props;
    return <label>{label}<input name={name} {...attributes} required={requiredProp !== "false"} /></label>;
  };

  function renderSocieties() {
    return (
      <>
        <PageHeading title="Your societies" description="Keep each residential community and its service records in one private workspace." />
        <div className="society-grid">
          {societies.map((item) => (
            <button type="button" className={`society-card ${societyId === item.id ? "society-card-selected" : ""}`} key={item.id} onClick={() => setSocietyId(item.id)}>
              <span className="society-card-icon"><Icon name="grid" size={20} /></span>
              <strong>{text(item, "name")}</strong>
              <span>{text(item, "address") || "Address not added"}</span>
              <small>{number(object(item, "_count") ?? {}, "residents")} residents · {number(object(item, "_count") ?? {}, "vehicles")} vehicles</small>
            </button>
          ))}
          {!societies.length && <div className="empty-state"><div className="empty-icon"><Icon name="grid" size={21} /></div><h2>Start with your first society</h2><p>Create a society record before adding residents, vehicles or washers.</p></div>}
        </div>
        <form className="owner-form society-form" onSubmit={(event) => void submit(event, SocietyInputSchema, (input) => createSociety(session, input as { name: string; address?: string }))}>
          <h2>Add a society</h2>
          <div className="form-grid">{field("name", "Society name", { maxLength: "120" })}{field("address", "Address (optional)", { maxLength: "240" })}</div>
          <button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Add society"}</button>
        </form>
        {currentSociety && <form className="owner-form society-form" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const parsed = SocietyInputSchema.safeParse({
            name: form.get("name"),
            address: form.get("address") || null,
          });
          if (!parsed.success) { setError(parsed.error); return; }
          void mutate(() => updateSociety(session, societyId, parsed.data), "Society details updated.");
        }}>
          <h2>Edit selected society</h2>
          <div className="form-grid">
            <label>Society name<input name="name" defaultValue={text(currentSociety, "name")} maxLength={120} required /></label>
            <label>Address<input name="address" defaultValue={text(currentSociety, "address")} maxLength={240} /></label>
          </div>
          <button className="secondary-button" disabled={saving}>Save society details</button>
        </form>}
      </>
    );
  }

  function renderResidents() {
    return (
      <>
        <PageHeading title="Residents & vehicles" description="Maintain vendor-scoped resident and vehicle records; Owner garages remain private and separate." />
        <form className="owner-form society-form" onSubmit={(event) => void submit(event, SocietyResidentInputSchema, (input) => createSocietyResident(session, { ...input as object, societyId } as never))}>
          <h2>Add a resident</h2>
          <div className="form-grid">
            {field("name", "Resident name", { maxLength: "100" })}
            {field("phoneNumber", "Indian mobile number", { inputMode: "tel", maxLength: "16" })}
            {field("unit", "Unit / flat (optional)", { required: "false", maxLength: "40" })}
          </div>
          <button className="primary-button" disabled={saving || !societyId}>{saving ? "Saving…" : "Add resident"}</button>
        </form>
        <form className="owner-form society-form" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const input = {
            societyId,
            residentId: String(form.get("residentId") ?? ""),
            type: String(form.get("type") ?? ""),
            registrationNumber: String(form.get("registrationNumber") ?? ""),
            monthlyRatePaise: Math.round(Number(form.get("monthlyRate") ?? 0) * 100),
          };
          const parsed = SocietyVehicleInputSchema.safeParse(input);
          if (!parsed.success) { setError(parsed.error); return; }
          void mutate(() => createSocietyVehicle(session, parsed.data), "Vehicle added.");
        }}>
          <h2>Add a vehicle</h2>
          <div className="form-grid">
            <label>Resident<select name="residentId" required defaultValue=""><option value="" disabled>Select resident</option>{data.residents.map((r) => <option key={r.id} value={r.id}>{text(r, "name")} {text(r, "unit") ? `· ${text(r, "unit")}` : ""}</option>)}</select></label>
            <label>Vehicle type<select name="type"><option value="FOUR_WHEELER">Four-wheeler</option><option value="TWO_WHEELER">Two-wheeler</option><option value="OTHER">Other</option></select></label>
            {field("registrationNumber", "Registration number", { maxLength: "32" })}
            {field("monthlyRate", "Monthly plan (₹)", { type: "number", min: "0", step: "0.01" })}
          </div>
          <button className="primary-button" disabled={saving || !data.residents.length}>{saving ? "Saving…" : "Add vehicle"}</button>
        </form>
        <div className="society-list">
          {data.residents.map((resident) => {
            const residentVehicles = data.vehicles.filter((vehicle) => text(vehicle, "residentId") === resident.id);
            return <section className="detail-card" key={resident.id}><div className="society-row"><div><p className="section-kicker">RESIDENT · {text(resident, "unit") || "NO UNIT"}</p><h2>{text(resident, "name")}</h2><p>{text(resident, "phoneNumber")} · {text(resident, "status")}</p></div><span className="registration-chip">{residentVehicles.length} vehicles</span></div>
              <button className="secondary-button" disabled={saving} onClick={() => void mutate(() => updateSocietyResident(session, String(resident.id), { status: text(resident, "status") === "ACTIVE" ? "INACTIVE" : "ACTIVE" }), "Resident status updated.")}>{text(resident, "status") === "ACTIVE" ? "Deactivate resident" : "Reactivate resident"}</button>
              <form className="society-inline-form" onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const parsed = SocietyResidentUpdateSchema.safeParse({
                  name: form.get("name"),
                  phoneNumber: form.get("phoneNumber"),
                  unit: form.get("unit") || null,
                });
                if (!parsed.success) { setError(parsed.error); return; }
                void mutate(() => updateSocietyResident(session, String(resident.id), parsed.data), "Resident details updated.");
              }}>
                <label>Name<input name="name" defaultValue={text(resident, "name")} maxLength={100} required /></label>
                <label>Phone<input name="phoneNumber" defaultValue={text(resident, "phoneNumber")} maxLength={16} required /></label>
                <label>Unit<input name="unit" defaultValue={text(resident, "unit")} maxLength={40} /></label>
                <button className="secondary-button" disabled={saving}>Update resident</button>
              </form>
              {residentVehicles.map((vehicle) => <VehicleRow key={vehicle.id} session={session} vehicle={vehicle} washers={data.washers} saving={saving} onAssign={(washerId) => void mutate(() => assignSocietyWasher(session, String(vehicle.id), washerId, todayInIndia()), "Washer assignment updated.")} onUpdate={(input) => void mutate(() => updateSocietyVehicle(session, String(vehicle.id), input), "Vehicle details updated.")} onValidationError={setError} />)}
            </section>;
          })}
          {!data.residents.length && <Empty title="No residents yet" text="Add a resident to start organizing vehicles." />}
        </div>
      </>
    );
  }

  function renderWashers() {
    return (
      <>
        <PageHeading title="Washers & attendance" description="Manage service staff, per-task rates and daily attendance." />
        <form className="owner-form society-form" onSubmit={(event) => void submit(event, SocietyWasherInputSchema, (input) => createSocietyWasher(session, input as never))}>
          <h2>Add a washer</h2>
          <div className="form-grid">{field("name", "Washer name", { maxLength: "100" })}{field("phoneNumber", "Indian mobile number", { inputMode: "tel", maxLength: "16" })}{field("ratePerTaskPaise", "Earning per completed task (paise)", { type: "number", min: "0", step: "1" })}</div>
          <button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Add washer"}</button>
        </form>
        <div className="society-list">
          {data.washers.map((washer) => (
            <section className="detail-card society-row" key={washer.id}>
              <div><p className="section-kicker">WASHER</p><h2>{text(washer, "name")}</h2><p>{text(washer, "phoneNumber")} · {paise(number(washer, "ratePerTaskPaise"))} per completed task</p></div>
              <div className="society-actions"><button className="secondary-button" disabled={saving} onClick={() => void mutate(() => updateSocietyWasher(session, String(washer.id), { status: text(washer, "status") === "ACTIVE" ? "INACTIVE" : "ACTIVE" }), "Washer status updated.")}>{text(washer, "status") === "ACTIVE" ? "Mark unavailable" : "Reactivate washer"}</button>
              <form className="society-attendance" onSubmit={(event) => {
                event.preventDefault();
                const ratePerTaskPaise = Number(new FormData(event.currentTarget).get("ratePerTaskPaise") ?? 0);
                const parsed = SocietyWasherUpdateSchema.safeParse({ ratePerTaskPaise });
                if (!parsed.success) { setError(parsed.error); return; }
                void mutate(() => updateSocietyWasher(session, String(washer.id), { ratePerTaskPaise }), "Washer task rate updated.");
              }}><label>Rate (paise)<input name="ratePerTaskPaise" type="number" min="0" step="1" defaultValue={number(washer, "ratePerTaskPaise")} /></label><button className="secondary-button" disabled={saving}>Update rate</button></form>
              <form className="society-attendance" onSubmit={(event) => {
                event.preventDefault();
                const status = String(new FormData(event.currentTarget).get("status"));
                void mutate(() => recordSocietyAttendance(session, {
                  societyId, washerId: String(washer.id), workDate: todayInIndia(), status,
                }), "Attendance recorded.");
              }}>
                <label>Today<select name="status" defaultValue={text(records(washer, "attendance")[0] ?? {}, "status") || "PRESENT"}><option value="PRESENT">Present</option><option value="ABSENT">Absent</option><option value="LEAVE">On leave</option></select></label>
                <button className="secondary-button" disabled={saving}>Save attendance</button>
              </form></div>
            </section>
          ))}
          {!data.washers.length && <Empty title="No washers yet" text="Add your staff to begin assigning daily work." />}
        </div>
      </>
    );
  }

  function renderTasks() {
    return (
      <>
        <PageHeading title="Daily wash tasks" description="Each due vehicle activity generates one task per date. Completion records the assigned washer and earnings rate." />
        <label className="society-date">Task date<input type="date" value={taskDate} max={todayInIndia()} onChange={(event) => setTaskDate(event.target.value)} /></label>
        <div className="society-list">
          {data.tasks.map((task) => {
            const vehicle = object(task, "vehicle") ?? {};
            const resident = object(vehicle, "resident") ?? {};
            const assignment = object(task, "assignment");
            const washer = object(assignment ?? {}, "washer");
            return <section className="detail-card society-row" key={task.id}>
              <div><p className="section-kicker">{text(task, "activity").replaceAll("_", " ")} · {text(task, "status").replaceAll("_", " ")}</p><h2>{text(vehicle, "registrationNumber")}</h2><p>{text(resident, "name")} · {washer ? text(washer, "name") : "No washer assigned"}</p></div>
              {text(task, "status") === "SCHEDULED" && <div className="society-actions"><button className="primary-button" disabled={saving} onClick={() => void mutate(() => updateSocietyTask(session, String(task.id), "COMPLETED"), "Task completed.")}>Complete</button><button className="secondary-button" disabled={saving} onClick={() => void mutate(() => updateSocietyTask(session, String(task.id), "MISSED"), "Task marked missed.")}>Missed</button><button className="secondary-button" disabled={saving} onClick={() => void mutate(() => updateSocietyTask(session, String(task.id), "UNAVAILABLE"), "Vehicle marked unavailable.")}>Unavailable</button></div>}
            </section>;
          })}
          {!data.tasks.length && <Empty title="No tasks for this date" text="Only active service schedules due on the selected date generate tasks." />}
        </div>
      </>
    );
  }

  function renderBilling() {
    return (
      <>
        <PageHeading title="Monthly billing" description="Calendar-month vehicle plans and approved extra work. Payments are recorded manually; no payment provider or message delivery is connected." />
        <form className="society-inline-form" onSubmit={(event) => {
          event.preventDefault();
          void mutate(() => generateSocietyInvoices(session, societyId, invoiceMonth), "Invoice generation finished.");
        }}>
          <label>Invoice month<input type="month" value={invoiceMonth} onChange={(event) => setInvoiceMonth(event.target.value)} /></label>
          <button className="primary-button" disabled={saving || !societyId}>{saving ? "Generating…" : "Generate invoices"}</button>
        </form>
        <div className="society-list">{data.invoices.map((invoice) => {
          const resident = object(invoice, "resident") ?? {};
          const paid = number(invoice, "paidPaise");
          const outstanding = number(invoice, "outstandingPaise");
          return <section className="detail-card" key={invoice.id}>
            <div className="society-row"><div><p className="section-kicker">{String(text(invoice, "monthStart")).slice(0, 7)} · {text(invoice, "status")}</p><h2>{text(resident, "name")}</h2><p>{text(resident, "unit")} · {text(resident, "phoneNumber")}</p></div><div><strong>{paise(outstanding)}</strong><small className="society-muted"> outstanding · {paise(paid)} paid</small></div></div>
            <ul className="society-lines">{(invoice.lines as SocietyRecord[] | undefined)?.map((line) => <li key={String(line.id)}>{text(line, "description")} <strong>{paise(number(line, "amountPaise"))}</strong></li>)}</ul>
            {outstanding > 0 && <div className="society-actions">
              <form className="society-inline-form" onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void mutate(() => recordSocietyPayment(session, String(invoice.id), {
                  amountPaise: Math.round(Number(form.get("amount") ?? 0) * 100),
                  method: String(form.get("method") ?? "CASH"),
                }), "Payment recorded.");
              }}><label>Partial payment (₹)<input name="amount" type="number" step="0.01" min="0.01" max={(outstanding / 100).toFixed(2)} required /></label><label>Method<select name="method"><option value="CASH">Cash</option><option value="UPI">UPI</option><option value="BANK_TRANSFER">Bank transfer</option><option value="CHEQUE">Cheque</option><option value="OTHER">Other</option></select></label><button className="secondary-button" disabled={saving}>Record payment</button></form>
              <button className="secondary-button" disabled={saving} onClick={() => void mutate(() => createSocietyReminder(session, String(invoice.id), "Internal follow-up reminder"), "Internal reminder recorded.")}>Record internal reminder</button>
            </div>}
            {(invoice.reminders as SocietyRecord[] | undefined)?.length ? <small className="society-muted">{(invoice.reminders as SocietyRecord[]).length} internal reminder(s); nothing was sent.</small> : null}
          </section>;
        })}
        {!data.invoices.length && <Empty title="No invoices yet" text="Generate calendar-month invoices to see current charges and balances." />}
        </div>
      </>
    );
  }

  function renderCompensation() {
    const earnedPaise = data.earnings.reduce((sum, task) => sum + number(task, "earningRatePaise"), 0);
    const deductedPaise = data.deductions
      .filter((deduction) => text(deduction, "status") === "APPROVED")
      .reduce((sum, deduction) => sum + number(deduction, "amountPaise"), 0);
    return (
      <>
        <PageHeading title="Washer compensation" description="Earnings are snapshots of the washer rate when an assigned task is completed. Deductions remain pending until explicitly decided." />
        <div className="owner-stats society-compensation-summary">
          <div className="owner-stat"><span className="stat-label">Completed-task earnings</span><strong>{paise(earnedPaise)}</strong><small>Based on recorded task completions</small></div>
          <div className="owner-stat"><span className="stat-label">Approved deductions</span><strong>{paise(deductedPaise)}</strong><small>Pending requests are excluded</small></div>
          <div className="owner-stat"><span className="stat-label">Accrued balance</span><strong>{paise(earnedPaise - deductedPaise)}</strong><small>Not a payment or payout record</small></div>
        </div>
        <form className="owner-form society-form" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void mutate(() => createSocietyDeduction(session, societyId, {
            washerId: String(form.get("washerId")),
            amountPaise: Math.round(Number(form.get("amount") ?? 0) * 100),
            reason: String(form.get("reason") ?? ""),
          }), "Deduction request recorded for review.");
        }}>
          <h2>Request a deduction</h2><div className="form-grid">
            <label>Washer<select name="washerId" required>{data.washers.map((washer) => <option value={washer.id} key={washer.id}>{text(washer, "name")}</option>)}</select></label>
            {field("amount", "Amount (₹)", { type: "number", step: "0.01", min: "0.01" })}
            {field("reason", "Reason", { maxLength: "500" })}
          </div><button className="primary-button" disabled={saving || !data.washers.length}>Request deduction</button>
        </form>
        <div className="society-list">
          <section className="detail-card"><h2>Completed task earnings</h2>{data.earnings.map((item) => {
            const assignment = object(item, "assignment");
            const washer = object(assignment ?? {}, "washer");
            return <p className="society-line" key={String(item.id)}>{text(washer ?? {}, "name")} · {text(item, "taskDate").slice(0, 10)} · {text(object(item, "vehicle") ?? {}, "registrationNumber")} <strong>{paise(number(item, "earningRatePaise"))}</strong></p>;
          })}{!data.earnings.length && <p className="society-muted">No completed assigned tasks have accrued earnings.</p>}</section>
          <section className="detail-card"><h2>Deductions</h2>{data.deductions.map((item) => <div className="society-row" key={String(item.id)}><p>{text(object(item, "washer") ?? {}, "name")} · {paise(number(item, "amountPaise"))}<br /><small>{text(item, "reason")} · {text(item, "status")}</small></p>{text(item, "status") === "PENDING" && <div className="society-actions"><button className="primary-button" onClick={() => void mutate(() => decideSocietyDeduction(session, String(item.id), "APPROVED", "Approved by the Society Vendor"), "Deduction approved.")}>Approve</button><button className="secondary-button" onClick={() => void mutate(() => decideSocietyDeduction(session, String(item.id), "REJECTED", "Rejected by the Society Vendor"), "Deduction rejected.")}>Reject</button></div>}</div>)}{!data.deductions.length && <p className="society-muted">No deductions have been requested.</p>}</section>
        </div>
      </>
    );
  }

  function renderExtraWork() {
    return (
      <>
        <PageHeading title="Add-on services" description="Record resident consent before requesting vendor approval. Only approved extra work can be included in a monthly bill." />
        <form className="owner-form society-form" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void mutate(() => createSocietyExtraWork(session, societyId, {
            residentId: String(form.get("residentId")),
            vehicleId: String(form.get("vehicleId")),
            description: String(form.get("description")),
            amountPaise: Math.round(Number(form.get("amount") ?? 0) * 100),
            residentApproverName: String(form.get("residentApproverName")),
            consentNote: String(form.get("consentNote")),
            workDate: todayInIndia(),
          }), "Extra-work request recorded.");
        }}>
          <h2>Record extra work and resident consent</h2><div className="form-grid">
            <label>Resident<select name="residentId" required>{data.residents.map((resident) => <option key={resident.id} value={resident.id}>{text(resident, "name")}</option>)}</select></label>
            <label>Vehicle<select name="vehicleId" required>{data.vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{text(vehicle, "registrationNumber")}</option>)}</select></label>
            {field("description", "Service / extra work", { maxLength: "180" })}
            {field("amount", "Charge (₹)", { type: "number", min: "0", step: "0.01" })}
            {field("residentApproverName", "Resident approver name", { maxLength: "100" })}
            {field("consentNote", "Consent note", { maxLength: "500" })}
          </div><button className="primary-button" disabled={saving || !data.vehicles.length}>Record consent</button>
        </form>
        <div className="society-list">{data.extraWork.map((item) => <section className="detail-card society-row" key={String(item.id)}>
          <div><p className="section-kicker">{text(item, "status")}</p><h2>{text(item, "description")}</h2><p>{text(object(item, "resident") ?? {}, "name")} · {text(object(item, "vehicle") ?? {}, "registrationNumber")} · {paise(number(item, "amountPaise"))}</p><small>Consent recorded by {text(item, "residentApproverName")}: {text(item, "consentNote")}</small></div>
          {text(item, "status") === "PENDING" && <div className="society-actions"><button className="primary-button" onClick={() => void mutate(() => decideSocietyExtraWork(session, String(item.id), "APPROVED", "Consent reviewed by vendor"), "Extra work approved.")}>Approve</button><button className="secondary-button" onClick={() => void mutate(() => decideSocietyExtraWork(session, String(item.id), "REJECTED", "Request declined by vendor"), "Extra work rejected.")}>Reject</button></div>}
        </section>)}{!data.extraWork.length && <Empty title="No add-on work" text="Approved extra work is shown here and may be included in its month's invoice." />}</div>
      </>
    );
  }

  function renderProfile() {
    return (
      <>
        <PageHeading title="Vendor profile" description="Set the business identity and contact details for this Society Vendor workspace." />
        <form className="owner-form profile-form" onSubmit={(event) => void submit(event, SocietyProfileUpdateSchema, (input) => updateSocietyProfile(session, input as Partial<SocietyProfile>))}>
          <div className="form-grid">
            <label>Business / display name<input name="displayName" defaultValue={profile?.displayName ?? session.user.displayName} maxLength={80} required /></label>
            <label>Phone<input name="phoneNumber" defaultValue={profile?.phoneNumber ?? ""} maxLength={16} required /></label>
            <label>Email (optional)<input name="contactEmail" type="email" defaultValue={profile?.contactEmail ?? ""} maxLength={254} /></label>
          </div>
          <p className="society-muted">Phone numbers are stored for account operations only; no OTP or SMS verification is claimed.</p>
          <button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Save profile"}</button>
        </form>
        {!profile?.onboardingComplete && <div className="notice notice-error" role="status">Complete the required phone contact field to finish onboarding.</div>}
      </>
    );
  }

  const selectedPage = () => {
    if (page === "Societies") return renderSocieties();
    if (page === "Residents & vehicles") return renderResidents();
    if (page === "Washers & attendance") return renderWashers();
    if (page === "Daily tasks") return renderTasks();
    if (page === "Billing") return renderBilling();
    if (page === "Compensation") return renderCompensation();
    if (page === "Extra work") return renderExtraWork();
    return renderProfile();
  };

  return (
    <div className="owner-app society-app">
      <aside className="owner-sidebar">
        <a className="brand" href="/" aria-label="Autospokes"><span className="brand-mark"><Icon name="steering" size={20} /></span><span className="brand-word">auto<span>spokes</span></span></a>
        <p className="workspace-label">SOCIETY VENDOR</p>
        <nav className="owner-nav" aria-label="Society Vendor navigation">
          {pages.map((item) => <button key={item} type="button" className={`owner-nav-item ${page === item ? "owner-nav-active" : ""}`} aria-current={page === item ? "page" : undefined} onClick={() => setPage(item)}><Icon name={item === "Daily tasks" ? "calendar" : item === "Profile" ? "shield" : item === "Residents & vehicles" ? "car" : "grid"} size={18} /><span>{item}</span></button>)}
        </nav>
        <div className="owner-sidebar-bottom"><div className="help-card"><span className="help-icon"><Icon name="help" size={17} /></span><span><strong>Care, coordinated</strong><small>Society operations at a glance.</small></span></div><div className="owner-account"><span className="avatar">{initials || "AS"}</span><span className="profile-copy"><strong>{profile?.displayName ?? session.user.displayName}</strong><small>Society Vendor</small></span><button type="button" aria-label="Sign out" onClick={() => void handleSignOut()}><Icon name="more" size={18} /></button></div></div>
      </aside>
      <main className="owner-main">
        <header className="owner-topbar"><a className="brand brand-compact" href="/" aria-label="Autospokes"><span className="brand-mark"><Icon name="steering" size={18} /></span><span className="brand-word">auto<span>spokes</span></span></a><div className="topbar-context"><span>Society Vendor</span><Icon name="chevron" size={14} /><strong>{text(currentSociety ?? {}, "name") || page}</strong></div><div className="owner-top-actions"><span className="owner-status-dot" /><span>Account private</span><span className="top-divider" /><span className="top-avatar">{initials || "AS"}</span><button className="mobile-signout" type="button" onClick={() => void handleSignOut()}>Sign out</button></div></header>
        <div className="owner-mobile-nav"><nav className="owner-nav" aria-label="Society Vendor mobile navigation">{pages.map((item) => <button key={item} type="button" className={`owner-nav-item ${page === item ? "owner-nav-active" : ""}`} aria-current={page === item ? "page" : undefined} onClick={() => setPage(item)}><span>{item}</span></button>)}</nav></div>
        <div className="owner-content">
          <ValidationNotice error={error} />
          {notice && <div className="notice notice-success" role="status">{notice}</div>}
          {profile && !profile.onboardingComplete && page !== "Profile" && <div className="detailer-onboarding">
            <p className="section-kicker">PROFILE SETUP</p>
            <h1>Finish your vendor profile.</h1>
            <p>Add a contact phone number to complete setup. Phone numbers are not verified by SMS.</p>
            <button className="primary-button" type="button" onClick={() => setPage("Profile")}>Complete profile <Icon name="arrow-up-right" size={16} /></button>
          </div>}
          <div className="society-toolbar"><label>Current society<select aria-label="Current society" value={societyId} onChange={(event) => setSocietyId(event.target.value)}><option value="">Select a society</option>{societies.map((item) => <option key={item.id} value={item.id}>{text(item, "name")}</option>)}</select></label></div>
          {loading ? <div className="loading-panel" role="status">Loading Society Vendor workspace…</div> : selectedPage()}
        </div>
      </main>
    </div>
  );
}

function PageHeading({ title, description }: { title: string; description: string }) {
  return <div className="owner-page-heading"><div><p className="section-kicker">SOCIETY OPERATIONS</p><h1>{title}</h1><p>{description}</p></div></div>;
}

function Empty({ title, text: description }: { title: string; text: string }) {
  return <div className="empty-state"><div className="empty-icon"><Icon name="grid" size={21} /></div><h2>{title}</h2><p>{description}</p></div>;
}

function VehicleRow({
  session,
  vehicle,
  washers,
  saving,
  onAssign,
  onUpdate,
  onValidationError,
}: {
  session: AuthSession;
  vehicle: SocietyRecord;
  washers: SocietyRecord[];
  saving: boolean;
  onAssign: (washerId: string) => void;
  onUpdate: (input: { registrationNumber?: string; monthlyRatePaise?: number; status?: "ACTIVE" | "INACTIVE" }) => void;
  onValidationError: (error: unknown) => void;
}) {
  const assignments = Array.isArray(vehicle.assignments) ? vehicle.assignments as SocietyRecord[] : [];
  const active = assignments[0];
  const activeWasher = object(active ?? {}, "washer");
  return <div className="society-vehicle-row">
    <div><span className="registration-chip">{text(vehicle, "registrationNumber")}</span><small>{text(vehicle, "type").replaceAll("_", " ").toLowerCase()} · {paise(number(vehicle, "monthlyRatePaise"))}/month · {activeWasher ? text(activeWasher, "name") : "No washer"}</small></div>
    <div className="society-actions">
      <form className="society-attendance" onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const parsed = SocietyVehicleUpdateSchema.safeParse({
          registrationNumber: form.get("registrationNumber"),
          monthlyRatePaise: Math.round(Number(form.get("rate") ?? 0) * 100),
        });
        if (!parsed.success) { onValidationError(parsed.error); return; }
        onUpdate(parsed.data);
      }}><label>Registration<input name="registrationNumber" defaultValue={text(vehicle, "registrationNumber")} maxLength={32} /></label><label>Monthly ₹<input name="rate" type="number" min="0" step="0.01" defaultValue={(number(vehicle, "monthlyRatePaise") / 100).toFixed(2)} /></label><button className="secondary-button" disabled={saving}>Save vehicle</button></form>
      <button className="secondary-button" disabled={saving} onClick={() => onUpdate({ status: text(vehicle, "status") === "ACTIVE" ? "INACTIVE" : "ACTIVE" })}>{text(vehicle, "status") === "ACTIVE" ? "Deactivate" : "Reactivate"}</button>
      <label>Assign / reassign<select aria-label={`Assign washer to ${text(vehicle, "registrationNumber")}`} value="" disabled={!washers.length || saving} onChange={(event) => { if (event.target.value) onAssign(event.target.value); }}><option value="">Choose washer</option>{washers.filter((washer) => text(washer, "status") === "ACTIVE").map((washer) => <option key={washer.id} value={String(washer.id)}>{text(washer, "name")}</option>)}</select></label>
    </div>
    <SocietyScheduleEditor session={session} vehicleId={String(vehicle.id)} />
  </div>;
}

const societyScheduleActivities: { id: SocietyScheduleActivity; label: string }[] = [
  { id: "EXTERIOR_WASH", label: "Exterior wash" },
  { id: "INTERIOR_CLEANING", label: "Interior cleaning" },
  { id: "TYRE_POLISH", label: "Tyre polish" },
];
const weekdayOptions = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 7, label: "Sun" },
];

function SocietyScheduleEditor({ session, vehicleId }: { session: AuthSession; vehicleId: string }) {
  const [schedules, setSchedules] = useState<SocietyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingActivity, setSavingActivity] = useState<SocietyScheduleActivity | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setSchedules(await getSocietyVehicleSchedules(session, vehicleId));
      setRevision((value) => value + 1);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setLoading(false);
    }
  }, [session, vehicleId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function saveSchedule(
    event: FormEvent<HTMLFormElement>,
    activity: SocietyScheduleActivity,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const frequency = String(form.get("frequency") ?? "");
    const parsed = SocietyWashScheduleInputSchema.safeParse({
      frequency,
      weekdays: frequency === "DAILY" ? [] : form.getAll("weekday").map(Number),
      effectiveFrom: form.get("effectiveFrom"),
      effectiveTo: form.get("effectiveTo") || null,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" "));
      return;
    }
    setSavingActivity(activity);
    setError("");
    setNotice("");
    try {
      const saved = await saveSocietyVehicleSchedule(session, vehicleId, activity, parsed.data);
      setSchedules((current) => [...current.filter((item) => text(item, "activity") !== activity), saved]);
      setRevision((value) => value + 1);
      setNotice(`${societyScheduleActivities.find((item) => item.id === activity)?.label} schedule saved.`);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setSavingActivity(null);
    }
  }

  async function changeStatus(schedule: SocietyRecord, status: "ACTIVE" | "PAUSED" | "STOPPED") {
    setSavingActivity(text(schedule, "activity") as SocietyScheduleActivity);
    setError("");
    setNotice("");
    try {
      const updated = await updateSocietyScheduleStatus(session, String(schedule.id), status);
      setSchedules((current) => current.map((item) => item.id === updated.id ? updated : item));
      setRevision((value) => value + 1);
      setNotice(`Schedule ${status.toLowerCase()}.`);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setSavingActivity(null);
    }
  }

  return <section className="society-schedules" aria-label="Vehicle service schedules">
    <h3>Service schedules</h3>
    {loading && <p role="status">Loading schedules…</p>}
    {error && <p className="society-schedule-error" role="alert">{error}</p>}
    {notice && <p className="society-schedule-notice" role="status">{notice}</p>}
    {!loading && societyScheduleActivities.map(({ id: activity, label }) => {
      const schedule = schedules.find((item) => text(item, "activity") === activity);
      const status = text(schedule ?? {}, "status");
      const weekdays = Array.isArray(schedule?.weekdays) ? schedule.weekdays as number[] : [];
      return <details className="society-schedule" key={`${activity}-${revision}`}>
        <summary>{label}<span>{schedule ? status.toLowerCase() : "not scheduled"}</span></summary>
        <form className="society-schedule-form" onSubmit={(event) => void saveSchedule(event, activity)}>
          <label>Frequency<select name="frequency" defaultValue={text(schedule ?? {}, "frequency") || "DAILY"}>
            <option value="DAILY">Every day</option>
            <option value="SELECTED_DAYS">Selected weekdays</option>
          </select></label>
          <fieldset>
            <legend>Weekdays (used when selected weekdays is chosen)</legend>
            <div className="society-weekdays">{weekdayOptions.map(({ day, label: weekday }) => <label key={day}>
              <input type="checkbox" name="weekday" value={day} defaultChecked={weekdays.includes(day)} />
              {weekday}
            </label>)}</div>
          </fieldset>
          <label>Starts<input name="effectiveFrom" type="date" defaultValue={text(schedule ?? {}, "effectiveFrom") || todayInIndia()} required /></label>
          <label>Ends (optional)<input name="effectiveTo" type="date" defaultValue={text(schedule ?? {}, "effectiveTo")} /></label>
          <div className="society-actions">
            <button className="secondary-button" disabled={savingActivity !== null || loading}>
              {savingActivity === activity ? "Saving…" : status === "STOPPED" ? "Restart schedule" : schedule ? "Save schedule" : "Create schedule"}
            </button>
            {schedule && status === "ACTIVE" && <button type="button" className="secondary-button" disabled={savingActivity !== null || loading} onClick={() => void changeStatus(schedule, "PAUSED")}>Pause</button>}
            {schedule && status === "PAUSED" && <button type="button" className="secondary-button" disabled={savingActivity !== null || loading} onClick={() => void changeStatus(schedule, "ACTIVE")}>Resume</button>}
            {schedule && status !== "STOPPED" && <button type="button" className="secondary-button" disabled={savingActivity !== null || loading} onClick={() => void changeStatus(schedule, "STOPPED")}>Stop</button>}
          </div>
        </form>
      </details>;
    })}
  </section>;
}
