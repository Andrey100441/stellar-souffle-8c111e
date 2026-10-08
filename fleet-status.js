import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { setupAuth } from "./auth.js?v=36";
import { DN, loadDictNames } from "./dict-names.js?v=1";
import { populateSelect, updateMineOptions, updateModelAndCodeOptions } from "./filters.js?v=1";
import { enableTapToExpandCells, enableScrollButtons, setupFilterToggle, onFilterChanged } from "./ui.js?v=3";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MONTHS_RU_SHORT = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];

// Exact palette from the design mockups (fleet-status-mockup.html /
// availability-mockup.html) — kept as-is rather than the app's own --good/--bad/--warn
// tokens, per explicit request to preserve the mockups' color scheme on both pages.
const MOCK_G = "#2e9d4f", MOCK_Y = "#e0a81c", MOCK_R = "#d23a2f", MOCK_N = "#c9c9c9", MOCK_B = "#3a5bd9", MOCK_PL = "#8a97a8";

// "Время простоя" collapses the DB's open-ended repair types into the 3 buckets the
// mockup uses: emergency / planned (everything else) / maintenance.
// Названия типов и инициаторов берутся из справочника по ключу (dict-names.js) перед запуском страницы.
let EMERGENCY_TYPE = DN.em;
let MAINTENANCE_TYPE = DN.to;
const DOWNTIME_COLORS = { emergency: MOCK_R, planned: MOCK_B, maintenance: MOCK_G };
const DOWNTIME_LABELS = { emergency: "Аварийный", planned: "Плановый/капитальный", maintenance: "ТО" };

let DAMAGE_LABELS = { [DN.mine]: DN.mine, [DN.service]: DN.service };
let DAMAGE_COLORS = { [DN.mine]: "#3aa0c8", [DN.service]: "#56606b" };

const CRIT_NAMES = ["Готовность (КТГ машины)", "Надёжность (MTBF)", "Ремонт (MTTR)", "Сервис (КТГ сервиса)", "Экономика (бюджет)"];
const CRIT_LETTERS = ["Г", "Н", "Р", "С", "Э"];
const STATE_COLOR = { g: MOCK_G, y: MOCK_Y, r: MOCK_R, n: MOCK_N };

const TABLE_PAGE_SIZE = 30;
let equipmentList = []; // v_equipment_full rows, active only, respects Объект/Шахта/Модель/Борт filters
let availabilityRows = []; // full history for the filtered equipment, sliced client-side per period
let pageAggByCod = new Map(); // cod -> fleet_page_data() row, only for machines on the current table page
let prevSpendByCod = new Map(); // cod -> затраты за предыдущий период (fleet_period_spend), весь отфильтрованный парк
let fleetMetricsByCod = new Map(); // cod -> {t_hours, beta, event_count, top_subsystem, ..., repeat_configured,
  // repeat_pct, repeat_wo} — fleet_dashboard_data() RPC, computed server-side for the
  // WHOLE filtered fleet regardless of table page, so summary cards (and every row's
  // β/наработка/сигналы) stay accurate even though pageAggByCod above is
  // scoped to only the currently displayed page (see loadPageRepairs).
let fleetRows = []; // aggregated, one per cod, for the current period
let currentPage = 1;
let periods = {}; // computed once per load, keyed by period key
let currentPeriodKey = "r12";
let urlPeriodPending = null;
let periodsLoaded = false; // v_available_years fetched once, not on every filter change
let dashboardStarted = false;

const $ = (sel) => document.querySelector(sel);
// Тексты из базы вставляются в HTML — экранируем.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function showError(msg) {
  const el = $("#errorBanner");
  el.textContent = msg;
  el.hidden = false;
}
function clearError() {
  $("#errorBanner").hidden = true;
}
function setLoading(on) {
  $("#loadingIndicator").style.display = on ? "block" : "none";
}

function currentFilters() {
  return {
    object: $("#filterObject").value,
    mine: $("#filterMine").value,
    model: $("#filterModel").value,
    code: $("#filterCode").value,
  };
}

function filteredEquipment(f) {
  return equipmentList.filter(
    (eq) =>
      (!f.object || eq.object === f.object) &&
      (!f.mine || eq.mine === f.mine) &&
      (!f.model || eq.model === f.model) &&
      (!f.code || eq.local_code === f.code)
  );
}
// Same order the table renders in — computed once here so pagination (which cod set
// counts as "page N") and the final row order always agree.
function sortedFilteredEquipment(f) {
  return filteredEquipment(f)
    .slice()
    .sort(
      (x, y) =>
        (x.object ?? "").localeCompare(y.object ?? "", "ru") ||
        String(x.local_code).localeCompare(String(y.local_code), "ru", { numeric: true })
    );
}
function currentPageCods(f) {
  const all = sortedFilteredEquipment(f);
  const start = (currentPage - 1) * TABLE_PAGE_SIZE;
  return all.slice(start, start + TABLE_PAGE_SIZE).map((e) => e.cod);
}

async function loadFilterOptions() {
  const { data, error } = await supabase.from("v_equipment_full").select("*").eq("notrun", false);
  if (error) {
    showError("Не удалось загрузить справочники: " + error.message);
    return;
  }
  equipmentList = data;
  const objects = [...new Set(equipmentList.map((d) => d.object).filter(Boolean))].sort();
  populateSelect("#filterObject", objects);
  updateMineOptions(equipmentList);
  updateModelAndCodeOptions(equipmentList);
}

// Pre-fills Шахта/Модель/Борт + period from ?mine=&model=&code=&period= — the mirror
// image of index.html's own applyUrlFilters(), so navigating back here (breadcrumb or
// nav menu) from "Доступность и надёжность" lands on the same scope instead of
// resetting to the full fleet. `period` is applied later, once `periods` exists (see
// loadData) — it isn't populated yet at this point.
function applyUrlFilters() {
  const params = new URLSearchParams(window.location.search);
  const mine = params.get("mine");
  const model = params.get("model");
  const code = params.get("code");
  if (mine) $("#filterMine").value = mine;
  updateModelAndCodeOptions(equipmentList);
  if (model) $("#filterModel").value = model;
  updateModelAndCodeOptions(equipmentList);
  if (code) $("#filterCode").value = code;
  urlPeriodPending = params.get("period");
}

// ---------- periods ----------
// Default is a rolling last-12-months window ("what's happening with the fleet right
// now" — a multi-year average would mask a machine that degraded only in recent
// months). Calendar years are for annual/budget review; "весь период" for long-term
// capital-repair/write-off decisions. See the design discussion this mirrors.
function computePeriods(years) {
  const today = new Date();
  const y0 = today.getUTCFullYear();
  const m0 = today.getUTCMonth();
  const startOfMonth = (y, m) => new Date(Date.UTC(y, m, 1));
  const endOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0, 23, 59, 59));

  const p = {};
  p.r12 = {
    key: "r12",
    name: "12 мес",
    from: startOfMonth(y0, m0 - 11),
    to: endOfMonth(y0, m0),
    prevFrom: startOfMonth(y0, m0 - 23),
    prevTo: endOfMonth(y0, m0 - 12),
  };
  const sortedYears = [...new Set(years)].sort((a, b) => a - b);
  for (const y of sortedYears) {
    const isCurrent = y === y0;
    const to = isCurrent ? endOfMonth(y, m0) : endOfMonth(y, 11);
    const prevTo = isCurrent ? endOfMonth(y - 1, m0) : endOfMonth(y - 1, 11);
    p[y] = {
      key: String(y),
      name: isCurrent ? `${y} (янв–${MONTHS_RU_SHORT[m0]})` : String(y),
      from: startOfMonth(y, 0),
      to,
      prevFrom: startOfMonth(y - 1, 0),
      prevTo,
    };
  }
  p.all = { key: "all", name: "Весь период", from: null, to: null, prevFrom: null, prevTo: null };
  return p;
}

function renderPeriodToggle() {
  const order = ["r12", ...Object.keys(periods).filter((k) => k !== "r12" && k !== "all"), "all"];
  $("#periodToggle").innerHTML = order
    .map((k) => `<button type="button" class="${k === currentPeriodKey ? "on" : ""}" data-period="${k}">${periods[k].name}</button>`)
    .join("");
  for (const btn of $("#periodToggle").querySelectorAll("button")) {
    btn.addEventListener("click", async () => {
      currentPeriodKey = btn.dataset.period;
      // итоги страницы (pageAggByCod) считаются в БД под конкретный период (см.
      // loadPageRepairs) — при смене периода нужен новый запрос, а не просто
      // пересчёт по уже загруженным данным.
      setLoading(true);
      try {
        await Promise.all([loadFleetMetrics(), loadPageRepairs()]);
      } catch (e) {
        showError("Ошибка загрузки данных: " + (e.message || "нет ответа от сервера, попробуйте ещё раз"));
        return;
      } finally {
        setLoading(false);
      }
      recompute();
    });
  }
}

// ---------- date helpers ----------
// reporting_month приходит как "timestamp without time zone" ("2026-01-01T00:00:00", без
// суффикса зоны) — так `new Date(...)` в JS разбирает его как ЛОКАЛЬНОЕ время браузера
// зрителя, а не UTC (для чистой даты "2026-01-01" тот же JS уже считает её UTC — разное
// поведение для двух похожих форматов). Из-за этого какой аварийный отказ попадёт в
// период (а значит и β Кроу-АМСАА) мог отличаться в зависимости от часового пояса
// зрителя. Принудительно читаем как UTC, как и везде в проекте для workday/дат.
function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  const isBareLocalTimestamp = dateStr.includes("T") && !/[Zz]|[+-]\d\d:\d\d$/.test(dateStr);
  const d = new Date(isBareLocalTimestamp ? dateStr + "Z" : dateStr);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}
function parseWorkday(workday) {
  // "DD.MM.YY..." — same prefix-parse v_repair_summary's own SQL uses.
  if (!workday || workday.length < 8) return null;
  const dd = Number(workday.slice(0, 2));
  const mm = Number(workday.slice(3, 5));
  let yy = Number(workday.slice(6, 8));
  if (isNaN(dd) || isNaN(mm) || isNaN(yy)) return null;
  const yyyy = yy < 100 ? 2000 + yy : yy;
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

// ---------- SMH cumulative-hours lookup (for Crow-AMSAA) ----------
function hoursAtOrBefore(series, date) {
  if (!series || !series.length || !date) return null;
  let lo = 0,
    hi = series.length - 1,
    ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) {
      ans = series[mid].h;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
function hoursAtOrAfter(series, date) {
  if (!series || !series.length || !date) return null;
  let lo = 0,
    hi = series.length - 1,
    ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date >= date) {
      ans = series[mid].h;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

const hiState = (v, n) => (v == null || n == null || n <= 0 ? "n" : v >= n ? "g" : v >= n * 0.9 ? "y" : "r");
const loState = (v, n) => (v == null || n == null || n <= 0 ? "n" : v <= n ? "g" : v <= n * 1.1 ? "y" : "r");

// Пустое поле из базы — пустое значение, а не 0 (Number(null) === 0 искажал средние).
const num = (v) => (v == null || v === "" ? null : Number(v));
function avg(vals) {
  const v = vals.filter((x) => x != null && !isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function sum(vals) {
  return vals.reduce((a, b) => a + (Number(b) || 0), 0);
}

// ---------- per-machine aggregation for a given [from,to] window ----------
function aggMachine(eq, avail, repairs, smhSeries, from, to) {
  // A machine added mid-period only counts from its own commissioning date onward.
  const effFrom = eq.commissioning_date && (!from || new Date(eq.commissioning_date) > from) ? new Date(eq.commissioning_date) : from;

  const availIn = avail.filter((r) => inRange(r.reporting_month, effFrom, to));
  const repairsIn = repairs.filter((r) => inRange(r.reporting_month, effFrom, to));

  const ktg = avg(availIn.map((r) => num(r.vehicle_availability)));
  const ktgPlan = avg(availIn.map((r) => num(r.plan_availability)));
  const svc = avg(availIn.map((r) => num(r.service_availability)));
  const mtbf = avg(availIn.map((r) => num(r.mtbf_actual)));
  const mtbfPlan = avg(availIn.map((r) => num(r.mtbf_plan)));
  const mttr = avg(availIn.map((r) => num(r.mttr_actual)));
  const mttrPlan = avg(availIn.map((r) => num(r.mttr_plan)));
  const budgetPlan = sum(availIn.map((r) => r.budget));
  const budgetFact = sum(availIn.map((r) => r.sum_cost));

  // Наработка за период берётся из кумулятивного счётчика SMH (trtotal), а не из суммы
  // smh_actual по месяцам v_availability_dashboard — та таблица начинается позже, чем
  // реальная эксплуатация машины (например, с дек. 2023), и при "Весь период" даёт
  // заниженное число. trtotal — абсолютный счётчик с завода (первая запись в базе уже
  // может быть не нулевой), поэтому для "Весь период" (from = null) точка отсчёта — 0,
  // а не первое известное показание.
  const H0 = effFrom ? hoursAtOrBefore(smhSeries, effFrom) ?? hoursAtOrAfter(smhSeries, effFrom) : 0;
  const HEnd = to ? hoursAtOrBefore(smhSeries, to) : smhSeries.length ? smhSeries[smhSeries.length - 1].h : null;
  const T = H0 != null && HEnd != null ? HEnd - H0 : null;
  const hrs = T != null ? T : sum(availIn.map((r) => r.smh_actual));
  const cph = hrs ? budgetFact / hrs : null;
  // Общая наработка машины с завода (последнее известное показание trtotal) — не
  // зависит от выбранного периода, в отличие от hrs выше. Показываем рядом, иначе
  // непонятно, это наработка за месяц/год или за всю жизнь машины.
  const totalHrs = smhSeries.length ? smhSeries[smhSeries.length - 1].h : null;

  let emDT = 0,
    plDT = 0,
    toDT = 0,
    mineHours = 0,
    serviceHours = 0;
  const partsByDescr = new Map(); // spare_descr -> {qty, cost}
  // Distinct work-order IDs behind each downtime/initiator bucket — so a drill-through
  // link can show the journal filtered to exactly these naряды, not "this type, this
  // month" (which silently drops everything outside the one month the link lands on).
  const emWO = new Set(), plWO = new Set(), toWO = new Set(), mineWO = new Set(), serviceWO = new Set();
  let emSpend = 0,
    plSpend = 0;
  for (const r of repairsIn) {
    const h = Number(r.downtime_hours) || 0;
    if (r.type === EMERGENCY_TYPE) { emDT += h; if (r.work_order != null) emWO.add(r.work_order); }
    else if (r.type === MAINTENANCE_TYPE) { toDT += h; if (r.work_order != null) toWO.add(r.work_order); }
    else { plDT += h; if (r.work_order != null) plWO.add(r.work_order); }

    const who = r.damage ? r.damage.split(" ")[0] : null;
    if (who === DN.mine) { mineHours += h; if (r.work_order != null) mineWO.add(r.work_order); }
    else if (who === DN.service) { serviceHours += h; if (r.work_order != null) serviceWO.add(r.work_order); }

    if (r.cost) {
      if (r.type === EMERGENCY_TYPE) emSpend += Number(r.cost) || 0;
      else plSpend += Number(r.cost) || 0;
      if (r.spare_descr) {
        if (!partsByDescr.has(r.spare_descr)) partsByDescr.set(r.spare_descr, { qty: 0, cost: 0 });
        const p = partsByDescr.get(r.spare_descr);
        p.qty += Number(r.spare_qty) || 0;
        p.cost += Number(r.cost) || 0;
      }
    }
  }

  // "Сигналы": доля исходных работ машины с повтором за период — единый алгоритм из
  // БД (repeat-failures-spec.md), окно настраивается по машине/FS в "Оборудование →
  // Изменить". Полностью считается в fleet_dashboard_data() (см. applyFleetMetrics) —
  // repeatPct остаётся null (серая "⚙ не настроено") по умолчанию до применения оттуда,
  // 0% означало бы "настроена, повторов не было", это другое состояние.
  const repeatConfigured = false;
  let repeatPct = null;
  const repeatWO = []; // work_order ID самих повторов (не исходных работ)
  // topSubsystem/topSubsystemPct/topSubsystemWO приходят из fleet_dashboard_data
  // (см. applyFleetMetrics) — считаются там же, откуда и β, на тех же событиях
  // (events_t, без "замороженных" по SMH артефактов).
  let topSubsystem = null,
    topSubsystemPct = null,
    topSubsystemWO = [];

  // Monthly spend split (for the mini bar chart), keyed by calendar month.
  const monthsInRange = [];
  if (effFrom && to) {
    let cursor = new Date(Date.UTC(effFrom.getUTCFullYear(), effFrom.getUTCMonth(), 1));
    const last = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
    while (cursor <= last) {
      monthsInRange.push(cursor.toISOString().slice(0, 7));
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    }
  }
  const monthly = monthsInRange.map((key) => {
    // План по месяцу — не из avail (client-side страница больше не тянет
    // v_availability_dashboard, самое тяжёлое и нестабильное звено загрузки, см. историю
    // правок ниже); "|| planAvg" в monthsCell() уже подстраховывал большинство месяцев
    // средним планом, теперь так делают все месяцы — на мини-графике почти не заметно.
    const planMonth = 0;
    const monthRepairs = repairsIn.filter((r) => (r.reporting_month || "").slice(0, 7) === key);
    let em = 0,
      pl = 0;
    for (const r of monthRepairs) {
      const c = Number(r.cost) || 0;
      if (r.type === EMERGENCY_TYPE) em += c;
      else pl += c;
    }
    return { key, em, pl, plan: planMonth };
  });

  return {
    ktg,
    ktgPlan,
    svc,
    mtbf,
    mtbfPlan,
    mttr,
    mttrPlan,
    budgetPlan,
    budgetFact,
    hrs,
    totalHrs,
    cph,
    emDT,
    plDT,
    toDT,
    mineHours,
    serviceHours,
    emWO: [...emWO],
    plWO: [...plWO],
    toWO: [...toWO],
    mineWO: [...mineWO],
    serviceWO: [...serviceWO],
    emSpend,
    plSpend,
    spend: emSpend + plSpend,
    partsByDescr,
    T,
    repeatPct,
    repeatWO,
    repeatConfigured,
    topSubsystem,
    topSubsystemPct,
    topSubsystemWO,
    monthly,
    monthsActive: availIn.length,
  };
}

// Замена полей a на посчитанные в БД (fleet_machine_metrics) — по всему отфильтрованному
// парку разом, а не из локально загруженных (только текущая страница) repairs/avail.
// Без этого карточки сверху и рейтинг были бы верны только для видимой страницы.
function applyFleetMetrics(a, fm) {
  if (!fm) return;
  a.beta = fm.beta;
  a.topSubsystem = fm.top_subsystem ?? a.topSubsystem;
  a.topSubsystemPct = fm.top_subsystem_pct ?? a.topSubsystemPct;
  if (fm.ktg != null) a.ktg = fm.ktg;
  if (fm.ktg_plan != null) a.ktgPlan = fm.ktg_plan;
  if (fm.svc != null) a.svc = fm.svc;
  if (fm.mtbf != null) a.mtbf = fm.mtbf;
  if (fm.mtbf_plan != null) a.mtbfPlan = fm.mtbf_plan;
  if (fm.mttr != null) a.mttr = fm.mttr;
  if (fm.mttr_plan != null) a.mttrPlan = fm.mttr_plan;
  a.budgetPlan = fm.budget_plan ?? 0;
  a.budgetFact = fm.budget_fact ?? 0;
  a.emSpend = fm.em_spend ?? 0;
  a.plSpend = fm.pl_spend ?? 0;
  a.spend = a.emSpend + a.plSpend;
  a.cph = a.hrs ? a.budgetFact / a.hrs : null;
  a.repeatConfigured = fm.repeat_configured ?? false;
  a.repeatPct = fm.repeat_pct ?? null;
  a.repeatWO = fm.repeat_wo ?? [];
  a.eventCount = fm.event_count ?? 0;
  a.monthlyEvents = fm.monthly_events ?? [];
  a.eventWO = fm.event_wo ?? [];
  a.topSubsystemWO = fm.top_subsystem_wo ?? [];
}

function crit(a) {
  return [
    [hiState(a.ktg, a.ktgPlan), a.ktg == null ? "нет данных" : !a.ktgPlan ? "план не задан" : `КТГ ${fmtPct(a.ktg)} при плане ${fmtPct(a.ktgPlan)}`],
    [hiState(a.mtbf, a.mtbfPlan), a.mtbf == null ? "нет отказов" : !a.mtbfPlan ? "план не задан" : `MTBF ${fmtNum(a.mtbf, 0)} ч при плане ${fmtNum(a.mtbfPlan, 0)} ч`],
    [loState(a.mttr, a.mttrPlan), a.mttr == null ? "нет ремонтов" : !a.mttrPlan ? "план не задан" : `MTTR ${fmtNum(a.mttr, 1)} ч при плане ${fmtNum(a.mttrPlan, 1)} ч`],
    [hiState(a.svc, a.ktgPlan), a.svc == null ? "нет данных" : !a.ktgPlan ? "план не задан" : `КТГ сервиса ${fmtPct(a.svc)} при плане ${fmtPct(a.ktgPlan)}`],
    // budgetFact === 0 reads as "нет факта в базе" (unpopulated), not "уложились в
    // бюджет" — a real 0%-executed month is indistinguishable from missing data here,
    // and treating it as "good" would be actively misleading.
    [a.budgetPlan && a.budgetFact > 0 ? loState(a.budgetFact / a.budgetPlan, 1) : "n", !a.budgetPlan ? "план не задан" : a.budgetFact > 0 ? `факт ${fmtMoney(a.budgetFact)} / план ${fmtMoney(a.budgetPlan)} (${Math.round((a.budgetFact / a.budgetPlan) * 100)}%)` : "нет факта бюджета в базе"],
  ];
}
function critScore(c) {
  const k = c.filter((x) => x[0] !== "n");
  return { ok: k.filter((x) => x[0] === "g").length, of: k.length };
}

// ---------- formatting ----------
function fmtNum(v, digits = 1) {
  return v == null || isNaN(v) ? "—" : Number(v).toLocaleString("ru-RU", { maximumFractionDigits: digits });
}
function fmtPct(v) {
  return v == null ? "—" : (v * 100).toFixed(1) + "%";
}
function fmtMoney(v) {
  if (v == null) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e6) return (v / 1e6).toFixed(1).replace(".", ",") + " млн";
  if (abs >= 1000) return Math.round(v / 1000).toLocaleString("ru-RU") + " тыс";
  return Math.round(v).toLocaleString("ru-RU");
}
function monthLabel(key) {
  const [y, m] = key.split("-");
  return `${MONTHS_RU_SHORT[Number(m) - 1]} ${y}`;
}

// ---------- recompute + render for the currently selected period ----------
// Синхронный рендер-шаг — сама загрузка данных (полная по парку для avail/repeat-конфига,
// постраничная для repairs/SMH, см. loadPageRepairs) происходит отдельно, до вызова этой
// функции. avail — по всему отфильтрованному парку (v_availability_dashboard небольшая,
// ~3 тыс. строк), поэтому КТГ/MTBF/MTTR/бюджет и статус "в норме"/"хуже" корректны для
// каждой строки независимо от текущей страницы. repairs/smh — только текущая страница,
// поэтому "сырые" события (для мини-графика Кроу-АМСАА и точных ссылок в журнал) есть
// только у видимых строк — но сам β и топ-подсистема берутся из fleetMetricsByCod
// (fleet_machine_metrics, посчитан в БД по всему парку), а не из этих "сырых" данных —
// поэтому карточки сверху и колонка "Сигналы" точны для всего парка, а не только страницы.
function recompute() {
  const P = periods[currentPeriodKey];
  const f = currentFilters();
  const equipment = sortedFilteredEquipment(f);
  const availByCod = new Map();
  for (const r of availabilityRows) {
    if (!availByCod.has(r.cod)) availByCod.set(r.cod, []);
    availByCod.get(r.cod).push(r);
  }
  fleetRows = equipment.map((eq) => {
    const avail = availByCod.get(eq.cod) || [];
    const pa = pageAggByCod.get(eq.cod);
    // Сырых repairs/SMH на экране больше нет — aggMachine даёт каркас (окна, месяцы),
    // а цифры по ремонтам/наработке подставляет applyPageAgg из fleet_page_data.
    const a = aggMachine(eq, avail, [], [], P.from, P.to);
    applyPageAgg(a, pa);
    applyFleetMetrics(a, fleetMetricsByCod.get(eq.cod));
    const prev = P.prevFrom ? aggMachine(eq, avail, [], [], P.prevFrom, P.prevTo) : null;
    if (prev) prev.spend = prevSpendByCod.get(eq.cod) || 0;
    const c = crit(a);
    const pc = prev ? crit(prev) : null;
    return { eq, a, prev, c, pc };
  });

  $("#ratingHeader").textContent = `Рейтинг (${P.name})`;
  renderPeriodToggle();
  renderSummary();
  renderTable();
  updateNavLink(f, P);
}

// Carries the current Шахта/Модель/Борт + period filters into the top-nav link to
// "Доступность и надёжность", so navigating there via the menu (not just via a row's
// Рейтинг cell) lands on the same machine/scope instead of resetting to the full fleet.
function updateNavLink(f, P) {
  const link = document.querySelector('#navTabs a[href^="index.html"]');
  if (!link) return;
  const params = new URLSearchParams();
  params.set("period", P.key);
  if (f.mine) params.set("mine", f.mine);
  if (f.model) params.set("model", f.model);
  if (f.code) params.set("code", f.code);
  const q = params.toString();
  link.href = "index.html" + (q ? `?${q}` : "");
}

// ---------- summary tiles ----------
function renderSummary() {
  const spend = sum(fleetRows.map((r) => r.a.spend));
  const plan = sum(fleetRows.map((r) => r.a.budgetPlan));
  const em = sum(fleetRows.map((r) => r.a.emSpend));
  const worse = fleetRows.filter((r) => r.a.beta != null && r.a.beta > 1.2).length;
  const allOk = fleetRows.filter((r) => {
    const s = critScore(r.c);
    return s.of && s.ok === s.of;
  }).length;
  const prevSpend = periods[currentPeriodKey].prevFrom ? sum(fleetRows.map((r) => (r.prev ? r.prev.spend : 0))) : null;

  const spendChange =
    prevSpend != null && prevSpend > 0
      ? `${spend >= prevSpend ? "+" : "−"}${Math.abs(Math.round((spend / prevSpend - 1) * 100))}%`
      : "—";
  const spendChangeSub = prevSpend != null ? `было ${fmtMoney(prevSpend)}` : "нет предыдущего периода";

  $("#summaryCards").innerHTML = `
    <div class="summary-card"><div class="label">Бюджет парка, факт/план</div><div class="value">${plan ? Math.round((spend / plan) * 100) + "%" : "—"}</div><div class="s">${fmtMoney(spend)} из ${fmtMoney(plan)}</div></div>
    <div class="summary-card"><div class="label">Запчасти на аварийные ремонты</div><div class="value">${spend ? Math.round((em / spend) * 100) + "%" : "—"}</div><div class="s">чем выше доля, тем дороже обходится ненадёжность</div></div>
    <div class="summary-card"><div class="label">Затраты к предыдущему периоду</div><div class="value">${spendChange}</div><div class="s">${spendChangeSub}</div></div>
    <div class="summary-card"><div class="label">Машины с ухудшением (β&nbsp;&gt;&nbsp;1,2)</div><div class="value">${worse} из ${fleetRows.length}</div><div class="s">в норме по всем критериям: ${allOk}</div></div>
  `;
}

// ---------- table cells ----------
function availabilityUrl(eq, P) {
  const params = new URLSearchParams();
  params.set("period", P.key);
  if (eq.object) params.set("object", eq.object);
  if (eq.mine) params.set("mine", eq.mine);
  if (eq.model) params.set("model", eq.model);
  if (eq.local_code) params.set("code", eq.local_code);
  const q = params.toString();
  return "index.html" + (q ? `?${q}` : "");
}
function repairUrl(eq, P, opts = {}) {
  const params = new URLSearchParams();
  // The journal opens on one specific month (its own month-stepper doesn't understand
  // a multi-month period) — land on the last month of the selected period, closest to
  // what's actually being looked at; "Весь период" has no `to` bound, so fall back to
  // the journal's own default (its most recent month with data).
  if (P.to) {
    params.set("year", String(P.to.getUTCFullYear()));
    params.set("month", String(P.to.getUTCMonth() + 1));
  }
  if (eq.mine) params.set("mine", eq.mine);
  if (eq.model) params.set("model", eq.model);
  if (eq.local_code) params.set("code", eq.local_code);
  if (opts.type) params.set("type", opts.type);
  if (opts.initiator) params.set("initiator", opts.initiator);
  if (opts.q) params.set("q", opts.q);
  // Exact work-order IDs — used when the link must show precisely the same set of
  // records a number on this page was computed from (e.g. the β-trend's failure
  // count), rather than "whatever this machine had in one particular month".
  if (opts.wo && opts.wo.length) params.set("wo", opts.wo.join(","));
  // Which column/metric this link came from — the journal shows it in place of the
  // generic "точный список" label, so it's clear what the exact list is confirming.
  if (opts.src) params.set("src", opts.src);
  return "repair-details.html?" + params.toString();
}

// Дата ввода в эксплуатацию + возраст в годах — не зависит от выбранного периода P,
// в отличие от остальных ячеек таблицы, поэтому не принимает P.
function ageCell(eq) {
  if (!eq.commissioning_date) return "—";
  const d = new Date(eq.commissioning_date);
  const years = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
  return `${d.toLocaleDateString("ru-RU")}<br><small>${years.toFixed(1).replace(".", ",")} лет</small>`;
}

function ratingCell(row, P) {
  const { c, pc, eq } = row;
  const s = critScore(c);
  let delta = "";
  if (pc) {
    const ps = critScore(pc);
    if (ps.of) {
      const diff = s.ok - ps.ok;
      const col = diff > 0 ? MOCK_G : diff < 0 ? MOCK_R : "#999";
      const sign = diff > 0 ? `▲${diff}` : diff < 0 ? `▼${-diff}` : "=";
      delta = `<span class="rating-delta" style="color:${col}" title="было ${ps.ok}/${ps.of}">${sign}</span>`;
    }
  }
  const dots = c.map((x, i) => `<span class="rating-dot" style="background:${STATE_COLOR[x[0]]}" title="${CRIT_NAMES[i]}: ${x[1]}"></span>`).join("");
  const scoreText = s.of ? `${s.ok}/${s.of}` : "—";
  return `
    <a class="rating-cell" href="${availabilityUrl(eq, P)}" title="Открыть в «Доступность и надёжность»">
      <div class="rating-dots">${dots}<span class="rating-score">${scoreText}</span>${delta}</div>
      <div class="rating-dotlbl"><span>${CRIT_LETTERS.join("</span><span>")}</span></div>
    </a>`;
}

const TREND_W = 110,
  TREND_H = 32;
function reliabilityTrendCell(eq, a, P) {
  // Клик по графику открывает журнал именно с теми нарядами, что вошли в расчёт β
  // (event_wo из fleet_dashboard_data) — счётчик на экране и список в журнале всегда
  // совпадают, для проверки.
  const href = repairUrl(eq, P, { type: EMERGENCY_TYPE, wo: a.eventWO, src: "Надёжность" });
  if (a.beta == null) {
    return `<a class="reliability-trend-link" href="${href}" title="Открыть в журнале ремонтов"><span class="badge badge-neutral" title="Меньше 5 аварийных отказов за период — тренд не считается">мало данных · ${a.eventCount} отк.</span></a>`;
  }
  const b = a.beta;
  let col, bg, txt;
  if (b > 1.2) {
    col = MOCK_R;
    bg = "#fbe3e1";
    txt = `β ${fmtNum(b, 1)} ↗ хуже`;
  } else if (b < 0.8) {
    col = MOCK_G;
    bg = "#e2f3e7";
    txt = `β ${fmtNum(b, 1)} ↘ лучше`;
  } else {
    col = "#666";
    bg = "#eee";
    txt = `β ${fmtNum(b, 1)} → стабильно`;
  }
  // Столбцы — отказы по календарным месяцам (сразу видна частота и провалы в данных,
  // например простой техники или сбой датчика SMH — раньше это было незаметно на
  // ступенчатой кривой "накопленные отказы/наработка"), поверх — линия накопленных
  // отказов тем же цветом, что и бейдж β. Месяцы берём из самого периода (P), а не
  // только из тех, где есть отказы, — чтобы "тихие" месяцы были видны как провалы,
  // а не просто отсутствовали.
  let months = (a.monthlyEvents || []).map((m) => m.month);
  if (P.from && P.to) {
    months = [];
    let cur = new Date(Date.UTC(P.from.getUTCFullYear(), P.from.getUTCMonth(), 1));
    const last = new Date(Date.UTC(P.to.getUTCFullYear(), P.to.getUTCMonth(), 1));
    while (cur <= last) {
      months.push(cur.toISOString().slice(0, 7));
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    }
  }
  const countByMonth = new Map((a.monthlyEvents || []).map((m) => [m.month, m.count]));
  const values = months.map((mk) => countByMonth.get(mk) || 0);
  const maxV = Math.max(1, ...values);
  const n = Math.max(1, months.length);
  const barW = TREND_W / n;
  const barTop = 3;
  let bars = "";
  let cum = 0;
  const cumPts = [];
  values.forEach((v, i) => {
    const h = (v / maxV) * (TREND_H - barTop);
    if (h > 0) bars += `<rect x="${(i * barW + 0.5).toFixed(1)}" y="${(TREND_H - h).toFixed(1)}" width="${Math.max(1, barW - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="#ddd"/>`;
    cum += v;
    cumPts.push(cum);
  });
  const maxCum = Math.max(1, cum);
  const lineY = (c) => TREND_H - 2 - (c / maxCum) * (TREND_H - 4);
  const lineX = (i) => (i + 0.5) * barW;
  let path = "";
  cumPts.forEach((c, i) => {
    path += (i === 0 ? "M" : "L") + lineX(i).toFixed(1) + "," + lineY(c).toFixed(1) + " ";
  });
  const tip = `${a.eventCount} аварийных отказов, β = ${fmtNum(b, 1)}`;
  const svg = `<svg width="${TREND_W}" height="${TREND_H}">${bars}<path d="${path}" fill="none" stroke="${col}" stroke-width="1.6"/></svg>`;
  return `<a class="reliability-trend-link" href="${href}" title="${tip} — открыть в журнале ремонтов"><div class="reliability-trend">${svg}<span class="badge" style="background:${bg};color:${col}">${txt}</span></div></a>`;
}

function signalsCell(eq, a, P) {
  if (!a.eventCount) return `<span class="small">—</span>`;
  const parts = [];
  if (!a.repeatConfigured) {
    parts.push(
      `<span class="chip chip-muted" title="Окно повторного отказа не задано — настроить: Оборудование → Изменить">⚙ не настроено</span>`
    );
  } else if (a.repeatPct != null) {
    // The repeat chip must open only the naряды actually flagged as a repeat (the
    // journal's own "🔁 повтор" tag) — not the whole event set the percentage was
    // computed from, which is what the trend link already shows.
    const repHref = repairUrl(eq, P, { type: EMERGENCY_TYPE, wo: a.repeatWO, src: "Повторные отказы" });
    parts.push(
      `<a class="chip ${a.repeatPct > 20 ? "chip-bad" : ""}" href="${repHref}" title="Повторные отказы (после ТО или ремонта той же подсистемы — окно из настроек машины) — открыть в журнале ремонтов">🔁 ${Math.round(a.repeatPct)}%</a>`
    );
  }
  if (a.topSubsystem != null) {
    // Exact IDs for this subsystem, same as the repeat chip — a text search here (the
    // old approach) could disagree with the count if the subsystem string had a stray
    // whitespace/case difference from what the journal displays, silently hiding rows
    // while the card still claimed the full count.
    const subHref = repairUrl(eq, P, { type: EMERGENCY_TYPE, wo: a.topSubsystemWO, src: `Подсистема: ${a.topSubsystem}` });
    parts.push(
      `<a class="chip ${a.topSubsystemPct > 50 ? "chip-bad" : ""}" href="${subHref}" title="Доля самой частой подсистемы среди аварийных отказов — открыть в журнале ремонтов">⚙ ${esc(a.topSubsystem)} ${Math.round(a.topSubsystemPct)}%</a>`
    );
  }
  return parts.join("") || `<span class="small">—</span>`;
}

function downtimeCell(eq, a, P) {
  const t = a.emDT + a.plDT + a.toDT;
  if (!t) return `<span class="small">—</span>`;
  const seg = (key, hours, label, wo, type) => {
    const pct = (hours / t) * 100;
    const href = repairUrl(eq, P, { type, wo, src: "Время простоя" });
    return `<a class="seg-bar-seg" href="${href}" style="width:${pct}%;background:${DOWNTIME_COLORS[key]}" data-label="${label}" data-hours="${fmtNum(hours)}"></a>`;
  };
  const segs = [
    a.emDT > 0 ? seg("emergency", a.emDT, DOWNTIME_LABELS.emergency, a.emWO, EMERGENCY_TYPE) : "",
    a.plDT > 0 ? seg("planned", a.plDT, DOWNTIME_LABELS.planned, a.plWO) : "",
    a.toDT > 0 ? seg("maintenance", a.toDT, DOWNTIME_LABELS.maintenance, a.toWO, MAINTENANCE_TYPE) : "",
  ].join("");
  return `<div class="seg-bar-wrap"><div class="seg-bar">${segs}</div><div class="seg-bar-total">${fmtNum(t)} ч</div></div>`;
}

function initiatorCell(eq, a, P) {
  const t = a.mineHours + a.serviceHours;
  if (!t) return `<span class="small">—</span>`;
  const seg = (label, hours, wo) => {
    const pct = (hours / t) * 100;
    const href = repairUrl(eq, P, { initiator: label, wo, src: "Инициатор" });
    return `<a class="seg-bar-seg" href="${href}" style="width:${pct}%;background:${DAMAGE_COLORS[label]}" data-label="${label}" data-hours="${fmtNum(hours)}"></a>`;
  };
  const segs = [a.mineHours > 0 ? seg(DN.mine, a.mineHours, a.mineWO) : "", a.serviceHours > 0 ? seg(DN.service, a.serviceHours, a.serviceWO) : ""].join("");
  return `<div class="seg-bar-wrap"><div class="seg-bar">${segs}</div></div>`;
}

function budgetCell(row) {
  const { a, prev, eq } = row;
  if (!a.budgetPlan) return `<span class="small">план не задан</span>`;
  if (!a.budgetFact) return `<span class="small">нет факта бюджета в базе</span>`;
  const r = a.budgetFact / a.budgetPlan;
  const st = loState(r, 1);
  const col = STATE_COLOR[st];
  const top = [...a.partsByDescr.entries()]
    .sort((x, y) => y[1].cost - x[1].cost)
    .slice(0, 3)
    .map(([name, v]) => `${name}: ${fmtNum(v.qty, 0)} шт, ${fmtMoney(v.cost)}`)
    .join("\n");
  const emShare = a.spend ? Math.round((a.emSpend / a.spend) * 100) : 0;
  const annualPlan = a.monthsActive ? (a.budgetPlan / a.monthsActive) * 12 : null;
  const tip = `Факт ${fmtMoney(a.budgetFact)} / план за ${a.monthsActive} мес ${fmtMoney(a.budgetPlan)}${annualPlan ? ` (годовой ~${fmtMoney(annualPlan)})` : ""}\nНа аварийные ремонты: ${emShare}%\nТоп запчастей (по сумме):\n${top || "—"}`;
  let cph = "";
  if (a.cph != null) {
    let d = "";
    if (prev && prev.cph) {
      const ch = (a.cph / prev.cph - 1) * 100;
      d = Math.abs(ch) < 5 ? ` <span style="color:#999">→</span>` : ch > 0 ? ` <span style="color:${MOCK_R}">▲${Math.round(ch)}%</span>` : ` <span style="color:${MOCK_G}">▼${Math.round(-ch)}%</span>`;
    }
    cph = `<div class="cph">${fmtNum(a.cph, 1)} / моточас${d}</div>`;
  }
  const barPct = Math.min(r, 1.3) / 1.3 * 100;
  return `
    <div class="bud" title="${esc(tip)}"><i style="width:${barPct}%;background:${col}"></i><b style="left:${(100 / 1.3).toFixed(1)}%"></b></div>
    <div class="budtxt"><b style="color:${st === "g" ? "inherit" : col}">${Math.round(r * 100)}%</b> · ${fmtMoney(a.budgetFact)} / ${fmtMoney(a.budgetPlan)}</div>${cph}`;
}

function monthsCell(a) {
  if (!a.monthly.length || (!a.budgetPlan && !a.spend)) return `<span class="small">—</span>`;
  const ms = a.monthly;
  const W = 160,
    H = 36,
    n = ms.length,
    gap = n > 20 ? 0.5 : 2,
    bw = (W - gap * (n - 1)) / n;
  const planAvg = a.monthsActive ? a.budgetPlan / a.monthsActive : 0;
  const max = Math.max(planAvg, ...ms.map((x) => x.em + x.pl)) * 1.1 || 1;
  const Y = (v) => H - (v / max) * H;
  let s = "";
  ms.forEach((x, i) => {
    const X = i * (bw + gap);
    s += `<g><title>${monthLabel(x.key)}: ${fmtMoney(x.pl + x.em)} (аварийные ${fmtMoney(x.em)}, плановые ${fmtMoney(x.pl)})</title>`;
    s += `<rect x="${X.toFixed(1)}" y="${Y(x.pl).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - Y(x.pl)).toFixed(1)}" fill="${MOCK_PL}"/>`;
    const monthPlan = x.plan || planAvg;
    s += `<rect x="${X.toFixed(1)}" y="${Y(x.pl + x.em).toFixed(1)}" width="${bw.toFixed(1)}" height="${(Y(x.pl) - Y(x.pl + x.em)).toFixed(1)}" fill="${x.pl + x.em > monthPlan ? MOCK_R : "#e8908a"}"/></g>`;
  });
  if (planAvg) s += `<line x1="0" x2="${W}" y1="${Y(planAvg).toFixed(1)}" y2="${Y(planAvg).toFixed(1)}" stroke="#333" stroke-dasharray="3 2"/>`;
  return `<svg width="${W}" height="${H}">${s}</svg><div class="mlbl"><span>${monthLabel(ms[0].key)}</span><span>${monthLabel(ms[n - 1].key)}</span></div>`;
}

function renderTable() {
  const P = periods[currentPeriodKey];
  const totalPages = Math.max(1, Math.ceil(fleetRows.length / TABLE_PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const start = (currentPage - 1) * TABLE_PAGE_SIZE;
  const pageRows = fleetRows.slice(start, start + TABLE_PAGE_SIZE);

  $("#dataTableBody").innerHTML = pageRows
    .map(
      (row) => `
    <tr>
      <td>${esc(row.eq.object ?? "—")}</td>
      <td>${esc(row.eq.mine ?? "—")}</td>
      <td title="${esc(row.eq.model ?? "")}">${esc(row.eq.model ?? "—")}</td>
      <td>${esc(row.eq.local_code ?? "—")}</td>
      <td>${ageCell(row.eq)}</td>
      <td>${ratingCell(row, P)}</td>
      <td>${reliabilityTrendCell(row.eq, row.a, P)}</td>
      <td>${signalsCell(row.eq, row.a, P)}</td>
      <td>${downtimeCell(row.eq, row.a, P)}</td>
      <td>${initiatorCell(row.eq, row.a, P)}</td>
      <td>${budgetCell(row)}</td>
      <td>${monthsCell(row.a)}</td>
      <td class="num">${fmtNum(row.a.hrs, 0)} / ${fmtNum(row.a.totalHrs, 0)}</td>
    </tr>`
    )
    .join("");

  renderPagination(totalPages, fleetRows.length);
}

function renderPagination(totalPages, totalRows) {
  const el = $("#pagination");
  if (totalRows === 0) {
    el.innerHTML = "";
    return;
  }
  const start = (currentPage - 1) * TABLE_PAGE_SIZE + 1;
  const end = Math.min(currentPage * TABLE_PAGE_SIZE, totalRows);
  el.innerHTML = `
    <button id="pagePrev" class="btn-secondary" ${currentPage <= 1 ? "disabled" : ""}>← Назад</button>
    <span class="page-info">${start}–${end} из ${totalRows} (стр. ${currentPage} из ${totalPages})</span>
    <button id="pageNext" class="btn-secondary" ${currentPage >= totalPages ? "disabled" : ""}>Вперёд →</button>
  `;
  const goToPage = async (delta) => {
    currentPage += delta;
    // Переход по страницам — новая выгрузка repairs/SMH под новый набор из 50 машин
    // (avail/β/метрики по всему парку не меняются, см. loadPageRepairs).
    setLoading(true);
    try {
      await loadPageRepairs();
    } catch (e) {
      showError("Ошибка загрузки данных: " + (e.message || "нет ответа от сервера, попробуйте ещё раз"));
      return;
    } finally {
      setLoading(false);
    }
    recompute();
  };
  $("#pagePrev")?.addEventListener("click", () => goToPage(-1));
  $("#pageNext")?.addEventListener("click", () => goToPage(1));
}

function renderLegend() {
  const items = [
    ...Object.entries(DOWNTIME_LABELS).map(([key, label]) => ({ color: DOWNTIME_COLORS[key], label: `Простой: ${label}` })),
    ...Object.entries(DAMAGE_COLORS).map(([label, color]) => ({ color, label: `Инициатор: ${label}` })),
    { color: MOCK_G, label: "Рейтинг: в норме" },
    { color: MOCK_Y, label: "отклонение до 10%" },
    { color: MOCK_R, label: "хуже" },
    { color: "#c9c9c9", label: "нет данных" },
  ];
  $("#pageLegend").innerHTML = items.map((i) => `<span class="legend-item"><span class="legend-swatch" style="background:${i.color}"></span>${i.label}</span>`).join("");
}

// Shared tooltip for downtime/initiator bar segments (reliability trend and budget
// bar already carry native title="" tooltips, which is enough detail for them).
function setupBarTooltip() {
  const tooltip = $("#barTooltip");
  const tbody = $("#dataTableBody");
  tbody.addEventListener("mousemove", (e) => {
    const seg = e.target.closest(".seg-bar-seg");
    if (!seg) {
      tooltip.hidden = true;
      return;
    }
    tooltip.innerHTML = `<div><strong>${seg.dataset.label}</strong>: ${seg.dataset.hours} ч</div>`;
    tooltip.style.left = `${e.clientX + 14}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
    tooltip.hidden = false;
  });
  tbody.addEventListener("mouseleave", () => {
    tooltip.hidden = true;
  });
}

// Итоги ремонтов/SMH на экране (pageAggByCod) — только текущая страница (см. loadPageRepairs);
// экспорт покрывает весь отфильтрованный парк — те же итоги из fleet_page_data, но сразу
// по всем машинам (один запрос, ~1 с в БД), поэтому цифры в Excel и на экране совпадают.
async function exportExcel() {
  const P = periods[currentPeriodKey];
  const f = currentFilters();
  const btn = $("#exportExcel");
  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⬇ Формирую…";
  try {
    const equipment = sortedFilteredEquipment(f);
    const cods = equipment.map((e) => e.cod);
    let aggByCod = new Map();
    if (cods.length) {
      const { data, error } = await supabase.rpc("fleet_page_data", {
        p_cods: cods,
        p_from: P.from ? P.from.toISOString() : null,
        p_to: P.to ? P.to.toISOString() : null,
      });
      if (error) throw error;
      aggByCod = new Map((data || []).map((r) => [r.cod, r]));
    }

    const wsData = equipment.map((eq) => {
      const a = aggMachine(eq, [], [], [], P.from, P.to);
      applyPageAgg(a, aggByCod.get(eq.cod));
      applyFleetMetrics(a, fleetMetricsByCod.get(eq.cod));
      const c = crit(a);
      const s = critScore(c);
      return {
        Объект: eq.object,
        Шахта: eq.mine,
        Модель: eq.model,
        Борт: eq.local_code,
        "Дата ввода": eq.commissioning_date ? new Date(eq.commissioning_date).toLocaleDateString("ru-RU") : "",
        "Возраст, лет": eq.commissioning_date ? Number(((Date.now() - new Date(eq.commissioning_date).getTime()) / (365.25 * 24 * 3600 * 1000)).toFixed(1)) : "",
        "Рейтинг": s.of ? `${s.ok}/${s.of}` : "",
        "β (Кроу-АМСАА)": a.beta != null ? Number(a.beta.toFixed(2)) : "",
        "Повторные отказы, %": a.repeatPct != null ? Math.round(a.repeatPct) : "",
        "Частая подсистема": a.topSubsystem ?? "",
        "Простой аварийный, ч": Number(a.emDT.toFixed(1)),
        "Простой плановый, ч": Number(a.plDT.toFixed(1)),
        "Простой ТО, ч": Number(a.toDT.toFixed(1)),
        "Инициатор: рудник, ч": Number(a.mineHours.toFixed(1)),
        "Инициатор: сервис, ч": Number(a.serviceHours.toFixed(1)),
        "Бюджет план": Number(a.budgetPlan.toFixed(0)),
        "Бюджет факт": Number(a.budgetFact.toFixed(0)),
        "Стоимость моточаса": a.cph != null ? Number(a.cph.toFixed(1)) : "",
        "Наработка за период, ч": Number(a.hrs.toFixed(0)),
        "Наработка общая, ч": a.totalHrs != null ? Number(a.totalHrs.toFixed(0)) : "",
      };
    });
    const ws = XLSX.utils.json_to_sheet(wsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Состояние парка");
    XLSX.writeFile(wb, `fleet_status_${P.key}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) {
    showError("Ошибка экспорта: " + (e.message || "нет ответа от сервера, попробуйте ещё раз"));
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
}

// Guards against a slower, older request resolving after a newer, narrower one and
// silently overwriting the UI with stale data — rapid successive filter changes can
// race the paginated fetches below out of order.
let loadRequestId = 0;

// Итоги по ремонтам/SMH для машин текущей страницы (30 машин) — считаются в БД
// (fleet_page_data): простои по типу/инициатору, наряды, помесячные затраты, топ-3
// запчасти, показания SMH на границах периода. Раньше сюда постранично выгружались
// тысячи строк v_repair_details/v_smh_history (~2,7 МБ, ~15 запросов) и сворачивались
// в браузере; теперь — один запрос, 30 строк. Простой считается один раз на наряд,
// а не на каждую строку-запчасть (раньше при двух запчастях удваивался).
// avail/repeat-конфиг остаются по всему парку (см. loadFleetMetrics) — от них
// зависят карточки сверху, которые должны быть точны независимо от страницы.
async function loadPageRepairs() {
  const f = currentFilters();
  const pageCods = currentPageCods(f);
  availabilityRows = [];
  if (!pageCods.length) {
    pageAggByCod = new Map();
    return;
  }
  const P = periods[currentPeriodKey];
  const iso = (d) => (d ? d.toISOString() : null);
  const { data, error } = await supabase.rpc("fleet_page_data", {
    p_cods: pageCods,
    p_from: iso(P.from),
    p_to: iso(P.to),
  });
  if (error) throw error;
  pageAggByCod = new Map((data || []).map((r) => [r.cod, r]));
}

// Подстановка итогов fleet_page_data в результат aggMachine() (который для экрана
// считается без сырых repairs/SMH и даёт нули) — вызывать ДО applyFleetMetrics, т.к.
// тот пересчитывает стоимость моточаса из a.hrs.
function applyPageAgg(a, pa) {
  if (!pa) return;
  a.emDT = pa.em_dt;
  a.plDT = pa.pl_dt;
  a.toDT = pa.to_dt;
  a.mineHours = pa.mine_hours;
  a.serviceHours = pa.service_hours;
  a.emWO = pa.em_wo || [];
  a.plWO = pa.pl_wo || [];
  a.toWO = pa.to_wo || [];
  a.mineWO = pa.mine_wo || [];
  a.serviceWO = pa.service_wo || [];
  a.emSpend = pa.em_spend;
  a.plSpend = pa.pl_spend;
  a.spend = a.emSpend + a.plSpend;
  a.partsByDescr = new Map((pa.top_parts || []).map((p) => [p.name, { qty: Number(p.qty) || 0, cost: Number(p.cost) || 0 }]));
  const monthly = pa.monthly || {};
  for (const m of a.monthly) {
    const v = monthly[m.key];
    if (v) {
      m.em = Number(v.em) || 0;
      m.pl = Number(v.pl) || 0;
    }
  }
  a.T = pa.h0 != null && pa.hend != null ? pa.hend - pa.h0 : null;
  if (a.T != null) a.hrs = a.T;
  a.totalHrs = pa.total_hrs;
  a.cph = a.hrs ? a.budgetFact / a.hrs : null;
}

// β/топ-подсистема, КТГ/MTBF/MTTR/бюджет/затраты И статус/процент повторов — для ВСЕГО
// ОТФИЛЬТРОВАННОГО парка разом (а не только текущей страницы — см. §"оставить по всему
// парку"), ОДНИМ запросом к БД (fleet_dashboard_data — слияние прежних
// fleet_machine_metrics + v_repeat_machine_month + v_repeat_failures +
// v_equipment_repeat_status в один round-trip, по просьбе пользователя 2026-09-28).
// p_cods — тот же список машин, что и в остальных фильтрах страницы: без него функция
// считала бы ВСЕ 217 машин даже при сужении фильтра до одной.
async function loadFleetMetrics() {
  const P = periods[currentPeriodKey];
  const f = currentFilters();
  const cods = filteredEquipment(f).map((e) => e.cod);
  // Затраты прошлого периода — для карточки «Затраты к предыдущему периоду»: по тем же
  // машинам и той же формулой (fleet_period_spend = spend_agg из fleet_dashboard_data),
  // что и текущий период, параллельно с основным запросом. Раньше прошлый период брался
  // только по 30 машинам видимой страницы и сравнивался с затратами всего парка.
  const [cur, prev] = await Promise.all([
    supabase.rpc("fleet_dashboard_data", {
      p_from: P.from ? P.from.toISOString() : null,
      p_to: P.to ? P.to.toISOString() : null,
      p_cods: cods,
    }),
    P.prevFrom
      ? supabase.rpc("fleet_period_spend", { p_cods: cods, p_from: P.prevFrom.toISOString(), p_to: P.prevTo.toISOString() })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (cur.error) throw cur.error;
  if (prev.error) throw prev.error;
  fleetMetricsByCod = new Map((cur.data || []).map((r) => [r.cod, r]));
  prevSpendByCod = new Map((prev.data || []).map((r) => [r.cod, (Number(r.em_spend) || 0) + (Number(r.pl_spend) || 0)]));
}

// v_available_years не зависит от v_equipment_full — запускаем его сразу при
// открытии, параллельно со справочником (см. initDashboard), а loadData только
// дожидается уже летящего запроса. .then() нужен, чтобы запрос реально ушёл сразу:
// построитель запросов supabase ленивый и сам по себе ничего не отправляет.
let yearsPromise = null;
function loadYears() {
  if (!yearsPromise) yearsPromise = supabase.from("v_available_years").select("work_year").then((res) => res);
  return yearsPromise;
}

async function loadData() {
  const myRequestId = ++loadRequestId;
  clearError();
  setLoading(true);
  try {
    currentPage = 1;
    // v_available_years не зависит от фильтра Объект/Шахта/Модель/Борт — раньше
    // перезапрашивался на КАЖДУЮ смену фильтра впустую (лишний round-trip на пустом
    // месте, как раз то, что делало смену фильтра медленнее старой версии). Грузим
    // один раз за сессию страницы.
    if (!periodsLoaded) {
      const years = await loadYears();
      if (myRequestId !== loadRequestId) return;
      if (years.error) {
        yearsPromise = null; // следующая попытка загрузки перезапросит годы
        throw years.error;
      }
      periods = computePeriods(years.data.map((r) => r.work_year));
      if (urlPeriodPending && periods[urlPeriodPending]) currentPeriodKey = urlPeriodPending;
      urlPeriodPending = null;
      periodsLoaded = true;
    }

    await Promise.all([loadPageRepairs(), loadFleetMetrics()]);
    if (myRequestId !== loadRequestId) return;
    recompute();
  } catch (e) {
    if (myRequestId !== loadRequestId) return;
    showError("Ошибка загрузки данных: " + (e.message || e.details || e.hint || "нет ответа от сервера, попробуйте ещё раз"));
  } finally {
    if (myRequestId === loadRequestId) setLoading(false);
  }
}

function initDashboard() {
  if (dashboardStarted) return;
  dashboardStarted = true;
  enableTapToExpandCells();
  enableScrollButtons();
  renderLegend();
  setupBarTooltip();

  setupFilterToggle(loadData);
  $("#filterObject").addEventListener("change", () => {
    updateMineOptions(equipmentList);
    updateModelAndCodeOptions(equipmentList);
    onFilterChanged(loadData);
  });
  $("#filterMine").addEventListener("change", () => {
    updateModelAndCodeOptions(equipmentList);
    onFilterChanged(loadData);
  });
  $("#filterModel").addEventListener("change", () => {
    updateModelAndCodeOptions(equipmentList);
    onFilterChanged(loadData);
  });
  $("#filterCode").addEventListener("change", () => onFilterChanged(loadData));
  $("#resetFilters").addEventListener("click", () => {
    $("#filterObject").value = "";
    $("#filterMine").value = "";
    $("#filterModel").value = "";
    $("#filterCode").value = "";
    updateMineOptions(equipmentList);
    updateModelAndCodeOptions(equipmentList);
    // Сброс формы сам по себе не трогал URL — если страница была открыта по ссылке
    // с ?mine=&model=&code=, эти параметры оставались в адресной строке навсегда, и
    // applyUrlFilters() подставляла тот же фильтр обратно при каждой перезагрузке.
    const url = new URL(window.location.href);
    url.search = "";
    window.history.replaceState({}, "", url);
    loadData();
    $("#filterPanel").classList.remove("open");
  });
  $("#exportExcel").addEventListener("click", exportExcel);

  loadYears();
  loadFilterOptions().then(() => {
    applyUrlFilters();
    loadData();
  });
}

setupAuth(supabase, "fleet-status.html", () =>
  loadDictNames(supabase).then(() => {
    EMERGENCY_TYPE = DN.em; MAINTENANCE_TYPE = DN.to;
    DAMAGE_LABELS = { [DN.mine]: DN.mine, [DN.service]: DN.service };
    DAMAGE_COLORS = { [DN.mine]: "#3aa0c8", [DN.service]: "#56606b" };
    initDashboard();
  })
);
