import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { setupAuth } from "./auth.js?v=36";
import { DN, loadDictNames } from "./dict-names.js?v=1";
import { populateSelect } from "./filters.js?v=1";
import { enableTapToExpandCells } from "./ui.js?v=3";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MONTHS_RU_SHORT = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];
const MONTHS_RU_FULL = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];

// Exact palette from availability-mockup.html / fleet-status-mockup.html — kept as-is
// rather than the app's own --good/--bad/--warn tokens, per explicit request to
// preserve the mockups' color scheme.
const MOCK_G = "#2e9d4f", MOCK_Y = "#e0a81c", MOCK_R = "#d23a2f", MOCK_N = "#d4d4d4";
const MOCK_VEH = "#2563eb", MOCK_SVC = "#16a34a", MOCK_B = "#3a5bd9", MOCK_PL = "#8a97a8";
const MOCK_TG = "#e3f3e7", MOCK_TY = "#fdf2d3", MOCK_TR = "#fbe0dd";
const STATE_COLOR = { g: MOCK_G, y: MOCK_Y, r: MOCK_R, n: MOCK_N };
const STATE_TINT = { g: "cg", y: "cy", r: "cr", n: "" };
// Названия типов берутся из справочника по ключу (dict-names.js) перед запуском страницы.
let EMERGENCY_TYPE = DN.em;
let MAINTENANCE_TYPE = DN.to;

let equipmentList = []; // v_equipment_full rows, active only
let availabilityRows = []; // rows for the CURRENT period only (see loadData)
let repairRows = []; // rows for the CURRENT period only, same
let smhByCod = new Map(); // full raw series, single-machine view only (Crow-AMSAA)
let periodHrs = null; // "Наработка за период" — computed server-side, whole filtered scope
let periods = {};
let currentPeriodKey = "r12";
let urlYearPending = null;
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

// ---------- filters ----------
function currentFilters() {
  return { mine: $("#filterMine").value, model: $("#filterModel").value, code: $("#filterCode").value };
}
function selectedEquipment(f) {
  return equipmentList.filter((eq) => (!f.mine || eq.mine === f.mine) && (!f.model || eq.model === f.model) && (!f.code || eq.local_code === f.code));
}
function updateModelOptions() {
  const mine = $("#filterMine").value;
  const prevModel = $("#filterModel").value;
  const models = [...new Set(equipmentList.filter((e) => !mine || e.mine === mine).map((e) => e.model))].sort();
  populateSelectFresh("#filterModel", models, models.includes(prevModel) ? prevModel : "");
}
function updateCodeOptions(keepCode) {
  const mine = $("#filterMine").value;
  const model = $("#filterModel").value;
  const prevCode = $("#filterCode").value;
  const codes = equipmentList.filter((e) => (!mine || e.mine === mine) && (!model || e.model === model)).map((e) => e.local_code);
  populateSelectFresh("#filterCode", codes, keepCode && codes.includes(prevCode) ? prevCode : "");
}
function populateSelectFresh(sel, values, keepValue) {
  const el = $(sel);
  el.innerHTML = '<option value="">Все</option>';
  populateSelect(sel, [...new Set(values)]);
  el.value = keepValue || "";
}

function applyUrlFilters() {
  const params = new URLSearchParams(window.location.search);
  const mine = params.get("mine");
  const model = params.get("model");
  const code = params.get("code");
  // Accept both `period` (the current, exact-match scheme shared with fleet-status.js's
  // own period keys: r12/<year>/all) and the older `year` links some flows may still
  // send — `period` wins if both are present.
  const period = params.get("period") || params.get("year");
  if (mine) $("#filterMine").value = mine;
  updateModelOptions();
  if (model) $("#filterModel").value = model;
  updateCodeOptions(true);
  if (code) $("#filterCode").value = code;
  // `periods` isn't populated yet at this point (it's built from `years`, fetched
  // later in loadData) — stash the requested period and apply it once loadData knows
  // which period keys actually exist.
  urlYearPending = period;
}

// ---------- запоминание фильтров между перезагрузками ----------
// Шахта, модель, борт и период сохраняются в браузере и возвращаются после обновления страницы.
// Ссылка с параметрами (?mine=…&period=…) главнее сохранённого и его не перезаписывает.
// Выбранная техника (шахта, модель, борт) — общая для «Доступности и надёжности» и «Журнала ремонтов»:
// при переходе между ними (меню, ссылки) выбор не подменяется сохранённым ранее на другой странице.
// Сохранённое возвращается только при обновлении страницы и кнопках «Назад»/«Вперёд»: открытая
// из меню или кнопкой форма начинается со сброшенных фильтров (переносят их только крошки).
const SCOPE_KEY = "equipment-scope";
function saveScope() {
  try { localStorage.setItem(SCOPE_KEY, JSON.stringify({ mine: $("#filterMine").value, model: $("#filterModel").value, code: $("#filterCode").value })); } catch (_) { /* без запоминания */ }
}
function readScope() {
  try { return JSON.parse(localStorage.getItem(SCOPE_KEY) || "null"); } catch (_) { return null; }
}
const STATE_KEY = "availability-state";
let stateReady = false;
function saveState() {
  if (stateReady) saveScope(); // то, что видно на экране, — и при открытии по ссылке с параметрами
  if (!stateReady || window.location.search.length > 1) return;
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ mine: $("#filterMine").value, model: $("#filterModel").value, code: $("#filterCode").value, period: urlYearPending || currentPeriodKey }));
  } catch (_) { /* без запоминания */ }
}
function applySavedState() {
  let st = null;
  try { st = JSON.parse(localStorage.getItem(STATE_KEY) || "null"); } catch (_) { /* без запоминания */ }
  const sc = readScope();
  if (sc) st = { ...(st || {}), mine: sc.mine || "", model: sc.model || "", code: sc.code || "" };
  if (!st) return;
  if (st.mine) $("#filterMine").value = st.mine;
  updateModelOptions();
  if (st.model) $("#filterModel").value = st.model;
  updateCodeOptions(true);
  if (st.code) $("#filterCode").value = st.code;
  urlYearPending = st.period || null; // применится, когда станут известны существующие периоды
}

// ---------- data loading ----------
// The pooler occasionally 500s a request under concurrent load — retry transient
// failures a few times before giving up, instead of failing the whole load.
async function withRetry(run) {
  for (let attempt = 0; ; attempt++) {
    const res = await run();
    if (!res.error || attempt >= 2) return res;
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
}

// v_available_years не зависит от фильтра оборудования — запрос уходит сразу при
// открытии (параллельно со справочником, см. initDashboard), и один раз за сессию
// страницы. .then() нужен, чтобы запрос реально ушёл сразу: построитель запросов
// supabase ленивый и сам по себе ничего не отправляет.
let yearsPromise = null;
function loadYears() {
  if (!yearsPromise) yearsPromise = supabase.from("v_available_years").select("work_year").then((res) => res);
  return yearsPromise;
}

async function fetchAllPages(buildQuery) {
  const PAGE_SIZE = 1000;
  // Первая страница и общий count — одним запросом (count в заголовке Content-Range),
  // а не отдельным head-запросом перед выгрузкой: минус одно последовательное ожидание.
  const first = await withRetry(() => buildQuery({ count: "exact" }).range(0, PAGE_SIZE - 1));
  if (first.error) throw first.error;
  const firstData = first.data || [];
  const total = first.count ?? firstData.length;
  const pageCount = Math.ceil(total / PAGE_SIZE);
  if (pageCount <= 1) return firstData;
  // Пул подключений увеличен пользователем с 15 до 48 (Dashboard, 2026-09-28,
  // проверено — заметной разницы в обычной загрузке страниц нет, т.к. они уже не
  // гоняют большие объёмы; выигрыш именно здесь, где ещё возможна постраничная
  // выгрузка — например, экспорт).
  // v_repair_details теперь живая (из work), строк стало больше (43к vs 24к) — при
  // CONCURRENCY=8 наблюдались частые 500/503 от pooler'а на полной выборке по парку.
  const CONCURRENCY = 5;
  const pages = new Array(pageCount);
  pages[0] = first;
  let nextIndex = 1;
  async function fetchPage(from) {
    return withRetry(() => buildQuery().range(from, from + PAGE_SIZE - 1));
  }
  async function worker() {
    while (nextIndex < pageCount) {
      const i = nextIndex++;
      pages[i] = await fetchPage(i * PAGE_SIZE);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pageCount - 1) }, worker));
  let data = [];
  for (const { data: page, error } of pages) {
    if (error) throw error;
    data = data.concat(page);
  }
  return data;
}

async function loadFilterOptions() {
  const { data, error } = await supabase.from("v_equipment_full").select("*").eq("notrun", false);
  if (error) {
    showError("Не удалось загрузить справочники: " + error.message);
    return;
  }
  equipmentList = data.sort((a, b) => (a.mine ?? "").localeCompare(b.mine ?? "", "ru") || String(a.local_code).localeCompare(String(b.local_code), "ru", { numeric: true }));
  populateSelectFresh("#filterMine", equipmentList.map((e) => e.mine).filter(Boolean).sort(), "");
  updateModelOptions();
  updateCodeOptions(false);
}

// ---------- periods (same construction as fleet-status.js, duplicated to keep each
// page self-contained) ----------
function computePeriods(years) {
  const today = new Date();
  const y0 = today.getUTCFullYear();
  const m0 = today.getUTCMonth();
  const startOfMonth = (y, m) => new Date(Date.UTC(y, m, 1));
  const endOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0, 23, 59, 59));
  const p = {};
  p.r12 = { key: "r12", name: "12 мес", from: startOfMonth(y0, m0 - 11), to: endOfMonth(y0, m0) };
  const sortedYears = [...new Set(years)].sort((a, b) => a - b);
  for (const y of sortedYears) {
    const isCurrent = y === y0;
    p[y] = { key: String(y), name: isCurrent ? `${y} (янв–${MONTHS_RU_SHORT[m0]})` : String(y), from: startOfMonth(y, 0), to: isCurrent ? endOfMonth(y, m0) : endOfMonth(y, 11) };
  }
  // "Весь период" spans from the earliest year with data through the current month —
  // kept as concrete dates (not null) so the monthly matrix/Crow-AMSAA math below never
  // needs to special-case an open-ended range.
  p.all = { key: "all", name: "Весь период", from: startOfMonth(sortedYears.length ? sortedYears[0] : y0, 0), to: endOfMonth(y0, m0) };
  return p;
}
function periodMonthKeys(P) {
  const keys = [];
  let cursor = new Date(Date.UTC(P.from.getUTCFullYear(), P.from.getUTCMonth(), 1));
  const last = new Date(Date.UTC(P.to.getUTCFullYear(), P.to.getUTCMonth(), 1));
  while (cursor <= last) {
    keys.push(cursor.toISOString().slice(0, 7));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return keys;
}
function monthLabel(key) {
  const [y, m] = key.split("-");
  return `${MONTHS_RU_SHORT[Number(m) - 1]} ${y.slice(2)}`;
}
function monthFullLabel(key) {
  const [y, m] = key.split("-");
  return `${MONTHS_RU_FULL[Number(m) - 1]} ${y}`;
}

function renderPeriodToggle() {
  const order = ["r12", ...Object.keys(periods).filter((k) => k !== "r12" && k !== "all"), "all"];
  $("#periodToggle").innerHTML = order.map((k) => `<button type="button" class="${k === currentPeriodKey ? "on" : ""}" data-period="${k}">${periods[k].name}</button>`).join("");
  for (const btn of $("#periodToggle").querySelectorAll("button")) {
    btn.addEventListener("click", () => {
      currentPeriodKey = btn.dataset.period;
      // Строки/месяцы вне текущего диапазона больше не хранятся на клиенте (см.
      // loadData) — смена периода теперь требует нового, но узко ограниченного
      // по датам запроса, а не просто перерисовки уже загруженных данных.
      loadData();
    });
  }
}

// ---------- math helpers (mirrors fleet-status.js) ----------
function hoursAtOrBefore(series, date) {
  if (!series || !series.length || !date) return null;
  let lo = 0, hi = series.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) { ans = series[mid].h; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
// Наработка "За период" — вычисляется на сервере (period_hours_for_cods), тем же
// способом (последнее показание trtotal на/до даты), но без скачивания всей истории
// SMH на клиент — см. periodHrs, обновляется в loadData().
function crowBeta(t, T) {
  const n = t.length;
  if (n < 5 || !T || T <= 0) return null;
  const s = t.reduce((a, ti) => a + Math.log(T / Math.max(ti, 0.1)), 0);
  return s > 0 ? (n / s) * ((n - 1) / n) : null;
}
const hiState = (v, n) => (v == null || n == null || n <= 0 ? "n" : v >= n ? "g" : v >= n * 0.9 ? "y" : "r");
const loState = (v, n) => (v == null || n == null || n <= 0 ? "n" : v <= n ? "g" : v <= n * 1.1 ? "y" : "r");
function avg(vals) {
  const v = vals.filter((x) => x != null && !isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function sum(vals) {
  return vals.reduce((a, b) => a + (Number(b) || 0), 0);
}
// Округление до 0,1 — для сумм часов простоя (исходные значения уже с точностью 0,1 ч).
const r1 = (v) => Math.round(v * 10) / 10;
function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return !(from && d < from) && !(to && d > to);
}
function parseWorkday(workday) {
  if (!workday || workday.length < 8) return null;
  const dd = Number(workday.slice(0, 2)), mm = Number(workday.slice(3, 5));
  let yy = Number(workday.slice(6, 8));
  if (isNaN(dd) || isNaN(mm) || isNaN(yy)) return null;
  return new Date(Date.UTC(yy < 100 ? 2000 + yy : yy, mm - 1, dd));
}

// ---------- per-month aggregate ----------
// Пустое поле из базы — пустое значение, а не 0 (Number(null) === 0 тянул средние планов вниз:
// при плане у 3 машин из 120 «план КТГ» выходил 8%).
const num = (v) => (v == null || v === "" ? null : Number(v));
const ratio = (x, y) => (y ? x / y : null);
// MTBF = наработка ÷ отказы, MTTR = среднее время ремонта, взвешенное числом отказов —
// а не среднее помесячных MTBF/MTTR (месяц без отказов давал MTBF = 0 и тянул среднее вниз).
function reliability(rows) {
  const qty = sum(rows.map((r) => r.repair_qty));
  const smh = sum(rows.map((r) => r.smh_actual));
  const withQty = rows.filter((r) => num(r.repair_qty) > 0 && num(r.mttr_actual) != null);
  const mttrQty = sum(withQty.map((r) => r.repair_qty));
  return { qty, smh, mtbf: ratio(smh, qty), mttr: ratio(sum(withQty.map((r) => num(r.mttr_actual) * num(r.repair_qty))), mttrQty) };
}
function aggMonth(avail, repairs) {
  // Факт сравнивается с планом только по машино-месяцам, где план задан; рядом показывается,
  // у скольких машин он есть («план у 3 из 120»).
  const planRows = avail.filter((r) => num(r.plan_availability) != null);
  const mtbfPlanRows = avail.filter((r) => num(r.mtbf_plan) != null);
  const mttrPlanRows = avail.filter((r) => num(r.mttr_plan) != null);
  const all = reliability(avail), onMtbfPlan = reliability(mtbfPlanRows), onMttrPlan = reliability(mttrPlanRows);
  const a = {
    ktg: avg(avail.map((r) => num(r.vehicle_availability))),
    svc: avg(avail.map((r) => num(r.service_availability))),
    plan: avg(planRows.map((r) => num(r.plan_availability))),
    ktgCmp: avg(planRows.map((r) => num(r.vehicle_availability))),
    svcCmp: avg(planRows.map((r) => num(r.service_availability))),
    planN: new Set(planRows.map((r) => r.cod)).size,
    allN: new Set(avail.map((r) => r.cod)).size,
    mtbf: all.mtbf,
    mtbfP: avg(mtbfPlanRows.map((r) => num(r.mtbf_plan))),
    mtbfCmp: onMtbfPlan.mtbf,
    smhCmp: onMtbfPlan.smh,
    mttr: all.mttr,
    mttrP: avg(mttrPlanRows.map((r) => num(r.mttr_plan))),
    mttrCmp: onMttrPlan.mttr,
    smhP: sum(avail.map((r) => r.smh_plan)),
    budgetPlan: sum(avail.map((r) => r.budget)),
    budgetFact: sum(avail.map((r) => r.sum_cost)),
    hrs: sum(avail.map((r) => r.smh_actual)),
  };
  let emDT = 0, plDT = 0, toDT = 0, mineDT = 0, emSpend = 0, plSpend = 0, fails = 0;
  const woSeen = new Set();
  for (const r of repairs) {
    const h = Number(r.downtime_hours) || 0;
    if (r.type === EMERGENCY_TYPE) {
      emDT += h;
      if ((r.damage || "").split(" ")[0] === DN.mine) mineDT += h;
      if (r.work_order != null && !woSeen.has(r.work_order)) { woSeen.add(r.work_order); fails++; }
      emSpend += Number(r.cost) || 0;
    } else {
      if (r.type === MAINTENANCE_TYPE) toDT += h; else plDT += h;
      plSpend += Number(r.cost) || 0;
    }
  }
  // Часы простоя в v_repair_details округлены до 0,1 ч — суммы тоже приводим к 0,1, иначе
  // накопленная погрешность сложения дробей решает, как округлится ровно ,5 на экране
  // (например, 2297,5 показывалось то как 2 297, то как 2 298).
  emDT = r1(emDT); plDT = r1(plDT); toDT = r1(toDT); mineDT = r1(mineDT);
  a.down = r1(emDT + plDT + toDT);
  a.em = emDT; a.pl = plDT; a.to = toDT; a.mineT = mineDT; a.svcT = r1(emDT - mineDT);
  // «Отказов» — то же число, из которого считается MTBF (repair_qty базы: какие работы считать
  // отказом, задаётся по машине), иначе MTBF на экране не делился бы на показанное число отказов.
  a.fails = all.qty;
  a.emOrders = fails;
  a.emCost = emSpend; a.plCost = plSpend; a.cost = emSpend + plSpend;
  a.cph = a.hrs ? a.budgetFact / a.hrs : null;
  return a;
}
// Тот же формат подсказок, что и в fleet-status.js's ratingCell/crit() — одна и та
// же метрика должна объясняться одинаково на обеих страницах.
const CRIT_NAMES = ["Готовность (КТГ машины)", "Надёжность (MTBF)", "Ремонт (MTTR)", "Сервис (КТГ сервиса)", "Экономика (бюджет)"];
// Пояснение к сравнению с планом, когда план задан не у всех машин выборки.
const planScope = (a) => (a.allN > 1 && a.planN < a.allN ? ` (по ${a.planN} из ${a.allN} машин с планом)` : "");
function ratingStates(a) {
  return [
    [hiState(a.ktgCmp, a.plan), `${CRIT_NAMES[0]}: ` + (a.ktg == null ? "нет данных" : a.plan == null ? "план не задан" : `КТГ ${fmtPct(a.ktgCmp)} при плане ${fmtPct(a.plan)}${planScope(a)}`)],
    // Отказов в месяцах с планом не было, а машина работала — надёжность не хуже плана.
    a.mtbfP && a.mtbfCmp == null && a.smhCmp > 0
      ? ["g", `${CRIT_NAMES[1]}: отказов не было (наработка ${fmtNum(a.smhCmp)} ч, план MTBF ${fmtNum(a.mtbfP)} ч)`]
      : [hiState(a.mtbfCmp, a.mtbfP), `${CRIT_NAMES[1]}: ` + (a.mtbfP == null ? (a.mtbf == null ? "нет отказов" : "план не задан") : a.mtbfCmp == null ? "нет данных о наработке" : `MTBF ${fmtNum(a.mtbfCmp)} ч при плане ${fmtNum(a.mtbfP)} ч`)],
    [loState(a.mttrCmp, a.mttrP), `${CRIT_NAMES[2]}: ` + (a.mttrP == null ? (a.mttr == null ? "нет ремонтов" : "план не задан") : a.mttrCmp == null ? "нет ремонтов" : `MTTR ${fmtNum(a.mttrCmp, 1)} ч при плане ${fmtNum(a.mttrP, 1)} ч`)],
    [hiState(a.svcCmp, a.plan), `${CRIT_NAMES[3]}: ` + (a.svc == null ? "нет данных" : a.plan == null ? "план не задан" : a.svcCmp == null ? "нет данных по машинам с планом" : `КТГ сервиса ${fmtPct(a.svcCmp)} при плане ${fmtPct(a.plan)}${planScope(a)}`)],
    [
      a.budgetPlan && a.budgetFact > 0 ? loState(a.budgetFact / a.budgetPlan, 1) : "n",
      `${CRIT_NAMES[4]}: ` +
        (!a.budgetPlan ? "план не задан" : a.budgetFact > 0 ? `факт ${fmtMoney(a.budgetFact)} / план ${fmtMoney(a.budgetPlan)} (${Math.round((a.budgetFact / a.budgetPlan) * 100)}%)` : "нет факта бюджета в базе"),
    ],
  ];
}
function ratingScore(states) {
  const k = states.filter((x) => x[0] !== "n");
  return { ok: k.filter((x) => x[0] === "g").length, of: k.length };
}
function dotsHtml(states) {
  return `<span class="dots">${states.map((x) => `<span class="dot" style="background:${STATE_COLOR[x[0]]}" title="${x[1]}"></span>`).join("")}</span>`;
}

// ---------- formatting ----------
function fmtNum(v, digits = 0) {
  return v == null || isNaN(v) ? "—" : Number(v).toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtPct(v) {
  return v == null ? "—" : (v * 100).toFixed(1).replace(".", ",") + "%";
}
// Денежные суммы — полностью, с копейками (1 234 567,89), без сокращений «тыс/млн».
function fmtMoney(v) {
  return fmtNum(v, 2);
}
// Подписи оси графика затрат — короткие, иначе «1 234 567,89» не помещается слева от графика.
function fmtMoneyAxis(v) {
  if (v == null) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e6) return (v / 1e6).toFixed(1).replace(".", ",") + " млн";
  if (abs >= 1000) return Math.round(v / 1000).toLocaleString("ru-RU") + " тыс";
  return Math.round(v).toLocaleString("ru-RU");
}

// ---------- SVG chart helpers (ported from availability-mockup.html) ----------
function svgChart({ labels, bars = [], lines = [], yFmt = (v) => fmtNum(v), yMax, yMin = 0, H = 230 }) {
  const W = 640, L = 48, R = 12, T = 10, B = 26, pw = W - L - R, ph = H - T - B, n = labels.length, bw = pw / Math.max(n, 1);
  const sm = labels.map((_, i) => bars.reduce((s, b) => s + (b.values[i] || 0), 0));
  const lm = lines.flatMap((l) => l.values.filter((v) => v != null));
  const max = yMax ?? Math.max(1, ...sm, ...lm) * 1.1;
  const Y = (v) => T + ph - ((v - yMin) / (max - yMin)) * ph;
  const X = (i) => L + bw * i + bw / 2;
  let s = "";
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((max - yMin) * i) / 4;
    s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#eee"/><text x="${L - 6}" y="${Y(v) + 3}" text-anchor="end">${yFmt(v)}</text>`;
  }
  labels.forEach((lb, i) => { s += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${lb}</text>`; });
  labels.forEach((lb, i) => {
    let b0 = 0;
    const tip = [lb];
    bars.forEach((b) => {
      const v = b.values[i] || 0;
      if (v > 0) s += `<rect x="${X(i) - bw * 0.33}" y="${Y(b0 + v)}" width="${bw * 0.66}" height="${Y(b0) - Y(b0 + v)}" fill="${b.color}"/>`;
      b0 += v;
      tip.push(`${b.name}: ${(b.fmt || fmtNum)(v)}`);
    });
    lines.forEach((l) => tip.push(`${l.name}: ${l.values[i] == null ? "—" : (l.fmt || yFmt)(l.values[i])}`));
    s += `<rect x="${L + bw * i}" y="${T}" width="${bw}" height="${ph}" fill="transparent"><title>${tip.join("\n")}</title></rect>`;
  });
  const path = (v, Yf) => {
    let d = "", p = false;
    v.forEach((x, i) => {
      if (x == null) { p = false; return; }
      d += (p ? "L" : "M") + X(i).toFixed(1) + "," + Yf(x).toFixed(1) + " ";
      p = true;
    });
    return d;
  };
  lines.forEach((l) => {
    s += `<path d="${path(l.values, Y)}" fill="none" stroke="${l.color}" stroke-width="2" ${l.dash ? 'stroke-dasharray="5 4"' : ""} pointer-events="none"/>`;
    if (l.below) l.values.forEach((v, i) => { const p = l.below[i], c = l.belowCmp ? l.belowCmp[i] : v; if (v != null && p != null && c != null && c < p) s += `<circle cx="${X(i)}" cy="${Y(v)}" r="4" fill="${MOCK_R}" pointer-events="none"/>`; });
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">${s}</svg>`;
}
function crowChart(t, T, monthMarks) {
  const W = 640, H = 230, L = 48, R = 12, Tp = 10, B = 26, pw = W - L - R, ph = H - Tp - B, n = t.length;
  const X = (v) => L + (pw * v) / T, Y = (v) => Tp + ph - (ph * v) / Math.max(n, 1);
  let s = "";
  for (let i = 0; i <= 4; i++) {
    const v = (n * i) / 4;
    s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#eee"/><text x="${L - 6}" y="${Y(v) + 3}" text-anchor="end">${Math.round(v)}</text>`;
  }
  monthMarks.forEach((m) => {
    s += `<line x1="${X(m.x)}" x2="${X(m.x)}" y1="${Tp}" y2="${Tp + ph}" stroke="#f1ece6"/><text x="${X(m.x) + 2}" y="${H - 8}">${m.l}</text>`;
  });
  s += `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(T)}" y2="${Y(n)}" stroke="#aaa" stroke-dasharray="4 4"/>`;
  let d = `M${X(0)},${Y(0)}`;
  t.forEach((x, i) => { d += ` L${X(x).toFixed(1)},${Y(i).toFixed(1)} L${X(x).toFixed(1)},${Y(i + 1).toFixed(1)}`; });
  d += ` L${X(T)},${Y(n)}`;
  s += `<path d="${d}" fill="none" stroke="#5f3a17" stroke-width="2"/>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">${s}</svg>`;
}
function heat(rowNames, months, val, fmtTip) {
  const all = rowNames.flatMap((_, i) => months.map((k) => val(i, k)));
  const mx = Math.max(1, ...all);
  let h = "<table><tr><th></th>" + months.map((k) => `<th>${monthLabel(k)}</th>`).join("") + "<th>Σ</th></tr>";
  rowNames.forEach((nm, i) => {
    let tot = 0;
    h += `<tr><td class="l">${esc(nm)}</td>`;
    months.forEach((k) => {
      const v = val(i, k);
      tot += v;
      const a = v ? 0.12 + (0.78 * v) / mx : 0;
      h += `<td class="c" style="background:rgba(210,58,47,${a.toFixed(2)});color:${a > 0.55 ? "#fff" : "#333"}" title="${esc(nm)}, ${monthLabel(k)}: ${fmtTip(v)}">${v ? fmtNum(v) : ""}</td>`;
    });
    h += `<td class="c" style="font-weight:600">${fmtNum(tot)}</td></tr>`;
  });
  return h + "</table>";
}

// ---------- rendering ----------
function repairUrl(monthKey, f) {
  const [y, m] = monthKey.split("-");
  const params = new URLSearchParams({ year: y, month: String(Number(m)) });
  if (f.mine) params.set("mine", f.mine);
  if (f.model) params.set("model", f.model);
  if (f.code) params.set("code", f.code);
  return "repair-details.html?" + params.toString();
}

// Carries Шахта/Модель/Борт + period back into every link to fleet-status.html (the
// breadcrumb and the top-nav menu item), mirroring fleet-status.js's own
// updateNavLink() — so going back and forth between the two pages keeps the same scope
// instead of resetting to the full fleet each time.
function updateBackLinks(f, P) {
  const params = new URLSearchParams();
  params.set("period", P.key);
  if (f.mine) params.set("mine", f.mine);
  if (f.model) params.set("model", f.model);
  if (f.code) params.set("code", f.code);
  const href = "fleet-status.html?" + params.toString();
  for (const link of document.querySelectorAll('a[href^="fleet-status.html"]')) link.href = href;
}

function render() {
  const P = periods[currentPeriodKey];
  const f = currentFilters();
  const eqSel = selectedEquipment(f);
  const single = eqSel.length === 1;
  const codSet = new Set(eqSel.map((e) => e.cod));
  updateBackLinks(f, P);

  renderPeriodToggle();

  const months = periodMonthKeys(P);
  const availByMonth = new Map(), repairsByMonth = new Map();
  for (const key of months) { availByMonth.set(key, []); repairsByMonth.set(key, []); }
  for (const r of availabilityRows) {
    if (!codSet.has(r.cod)) continue;
    const key = (r.reporting_month || "").slice(0, 7);
    if (availByMonth.has(key)) availByMonth.get(key).push(r);
  }
  for (const r of repairRows) {
    if (!codSet.has(r.cod)) continue;
    const key = (r.reporting_month || "").slice(0, 7);
    if (repairsByMonth.has(key)) repairsByMonth.get(key).push(r);
  }
  const perM = months.map((k) => aggMonth(availByMonth.get(k), repairsByMonth.get(k)));
  const A = aggMonth([].concat(...availByMonth.values()), [].concat(...repairsByMonth.values()));
  if (periodHrs != null) {
    A.hrs = periodHrs;
    A.cph = A.hrs ? A.budgetFact / A.hrs : null;
  }

  // --- title & passport
  $("#pageTitle").textContent = single ? `${eqSel[0].model} · борт ${eqSel[0].local_code}` : `Группа: ${eqSel.length} машин${f.model ? " · " + f.model : ""}${f.mine ? " · " + f.mine : ""}`;

  const r12 = periods.r12;
  const availR12 = availabilityRows.filter((r) => codSet.has(r.cod) && inRange(r.reporting_month, r12.from, r12.to));
  const repairsR12 = repairRows.filter((r) => codSet.has(r.cod) && inRange(r.reporting_month, r12.from, r12.to));
  const last12 = aggMonth(availR12, repairsR12);
  const rt = ratingScore(ratingStates(last12));
  const rtDots = dotsHtml(ratingStates(last12));

  const eq0 = eqSel[0];
  const ageYears = single && eq0.commissioning_date ? (Date.now() - new Date(eq0.commissioning_date).getTime()) / (365.25 * 24 * 3600 * 1000) : null;
  const pf = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
  $("#passport").innerHTML =
    (single
      ? pf("Шахта", eq0.mine ?? "—") + pf("Модель", eq0.model ?? "—") + pf("Борт", eq0.local_code ?? "—") +
        pf("Ввод", eq0.commissioning_date ? `${new Date(eq0.commissioning_date).toLocaleDateString("ru-RU")} · ${ageYears.toFixed(1).replace(".", ",")} лет` : "—")
      : pf("Машин в выборке", eqSel.length)) +
    pf("Наработка за период", fmtNum(A.hrs) + " ч") +
    pf("Отказов за период", fmtNum(A.fails)) +
    `<div><div class="k">Статус за 12 мес (со страницы «Состояние парка»)</div><div class="v">${rtDots} ${rt.of ? `${rt.ok}/${rt.of}` : "—"}</div></div>`;

  // --- matrix
  let h = `<tr><th>Показатель</th><th>План</th>${months.map((k) => `<th><a href="${repairUrl(k, f)}" title="Журнал ремонтов: ${monthFullLabel(k)}">${monthLabel(k)}<small>журнал →</small></a></th>`).join("")}<th class="tot">За период</th></tr>`;
  // Если план задан не у всех машин выборки, в клетке — факт именно по машинам с планом (cmp), со
  // значком *: число, цвет клетки и колонка «План» всегда про одни и те же машины. Факт по всей
  // выборке — в подсказке. Без плана в клетке просто факт по всем машинам.
  const cell = (v, p, hi, fmt, tot, cmp = v, a = null) => {
    const s = hi === undefined || p == null ? "n" : hi ? hiState(cmp, p) : loState(cmp, p);
    if (a && p != null && cmp !== v) {
      const tip = `Факт там, где задан план${planScope(a) || " (по месяцам с планом)"}: ${fmt(cmp)} при плане ${fmt(p)}.\nПо всей выборке: ${fmt(v)}`;
      return `<td class="${tot ? "tot " : ""}${STATE_TINT[s]}" title="${tip}">${fmt(cmp)}*</td>`;
    }
    return `<td class="${tot ? "tot " : ""}${STATE_TINT[s]}">${fmt(v)}</td>`;
  };
  const row = (name, planText, f2, { hi, planOf, cmpOf, fmt = fmtNum, sub = false } = {}) => {
    const c = (a, tot) => cell(f2(a), planOf ? planOf(a) : null, hi, fmt, tot, cmpOf ? cmpOf(a) : f2(a), a);
    return `<tr class="${sub ? "sub" : ""}"><td>${name}</td><td class="plan">${planText}</td>${perM.map((a) => c(a)).join("")}${c(A, true)}</tr>`;
  };
  // Колонка «План»: «не задан», если плана нет ни у одной машины, и «у N из M», если не у всех.
  const planText = (p, fmt) => (p == null ? '<span class="hint-text">не задан</span>' : fmt(p) + (A.allN > 1 && A.planN < A.allN ? `<small> у ${A.planN} из ${A.allN}</small>` : ""));
  const grp = (t) => `<tr class="grp"><td colspan="${months.length + 3}"><span class="grp-label">${t}</span></td></tr>`;
  h += `<tr><td>Рейтинг (Г Н Р С Э)</td><td class="plan">5/5</td>${perM.map((a) => `<td>${dotsHtml(ratingStates(a))}</td>`).join("")}<td class="tot">${(() => { const s = ratingScore(ratingStates(A)); return s.of ? `${s.ok}/${s.of}` : "—"; })()}</td></tr>`;
  h += grp("Готовность");
  h += row("Доступность техники", planText(A.plan, fmtPct), (a) => a.ktg, { hi: 1, planOf: (a) => a.plan, cmpOf: (a) => a.ktgCmp, fmt: fmtPct });
  h += row("Доступность обслуживания", planText(A.plan, fmtPct), (a) => a.svc, { hi: 1, planOf: (a) => a.plan, cmpOf: (a) => a.svcCmp, fmt: fmtPct });
  h += row("Простой всего, ч", "", (a) => a.down);
  h += row("аварийный", "", (a) => a.em, { sub: true });
  h += row("— вина рудника", "", (a) => a.mineT, { sub: true });
  h += row("— вина сервиса", "", (a) => a.svcT, { sub: true });
  h += row("плановый", "", (a) => a.pl, { sub: true });
  h += row("ТО", "", (a) => a.to, { sub: true });
  h += grp("Надёжность");
  h += row("Наработка (SMH), ч", months.length ? fmtNum(A.smhP / months.length) + " / мес" : "—", (a) => a.hrs, { hi: 1, planOf: (a) => a.smhP });
  h += row("Отказов, шт", "", (a) => a.fails);
  h += row("MTBF, ч", planText(A.mtbfP, fmtNum), (a) => a.mtbf, { hi: 1, planOf: (a) => a.mtbfP, cmpOf: (a) => a.mtbfCmp });
  h += row("MTTR, ч", planText(A.mttrP, (v) => fmtNum(v, 1)), (a) => a.mttr, { hi: 0, planOf: (a) => a.mttrP, cmpOf: (a) => a.mttrCmp, fmt: (v) => fmtNum(v, 1) });
  h += grp("Затраты");
  h += row("Запчасти всего (факт)", months.length ? fmtMoney(A.budgetPlan / months.length) + " / мес" : "—", (a) => a.budgetFact, { hi: 0, planOf: (a) => a.budgetPlan, fmt: fmtMoney });
  h += row("— аварийные", "", (a) => a.emCost, { sub: true, fmt: fmtMoney });
  h += row("— плановые и ТО", "", (a) => a.plCost, { sub: true, fmt: fmtMoney });
  h += row("Стоимость моточаса", "", (a) => a.cph, { fmt: fmtMoney });
  $("#matrixTable").innerHTML = h;
  $("#matrixNote").hidden = !h.includes("*</td>");

  // --- charts
  const labels = months.map(monthLabel);
  $("#chAv").innerHTML = svgChart({
    labels, yMin: 0.5, yMax: 1, yFmt: (v) => Math.round(v * 100) + "%",
    lines: [
      { name: "Техники", values: perM.map((a) => a.ktg), color: MOCK_VEH, fmt: fmtPct, below: perM.map((a) => a.plan), belowCmp: perM.map((a) => a.ktgCmp) },
      { name: "Обслуживания", values: perM.map((a) => a.svc), color: MOCK_SVC, fmt: fmtPct },
      { name: "План", values: perM.map((a) => a.plan), color: "#999", dash: true, fmt: fmtPct },
    ],
  });
  $("#chDt").innerHTML = svgChart({
    labels,
    bars: [
      { name: "Аварийный, вина сервиса", values: perM.map((a) => a.svcT), color: MOCK_R },
      { name: "Аварийный, вина рудника", values: perM.map((a) => a.mineT), color: "#f0a29b" },
      { name: "Плановый", values: perM.map((a) => a.pl), color: MOCK_B },
      { name: "ТО", values: perM.map((a) => a.to), color: MOCK_G },
    ],
  });
  $("#chCost").innerHTML = svgChart({
    labels, yFmt: fmtMoneyAxis,
    bars: [
      { name: "На аварийные", values: perM.map((a) => a.emCost), color: "#e8908a", fmt: fmtMoney },
      { name: "На плановые и ТО", values: perM.map((a) => a.plCost), color: MOCK_PL, fmt: fmtMoney },
    ],
    lines: [{ name: "Бюджет", values: perM.map((a) => a.budgetPlan), color: "#333", dash: true, fmt: fmtMoney }],
  });

  // --- Crow-AMSAA (single machine only)
  if (single) {
    const smhSeries = smhByCod.get(eq0.cod) || [];
    const H0 = hoursAtOrBefore(smhSeries, P.from) ?? (smhSeries[0] ? smhSeries[0].h : null);
    const HEnd = hoursAtOrBefore(smhSeries, P.to) ?? (smhSeries.length ? smhSeries[smhSeries.length - 1].h : null);
    const repairsIn = repairRows.filter((r) => r.cod === eq0.cod && inRange(r.reporting_month, P.from, P.to) && r.type === EMERGENCY_TYPE);
    const byWO = new Map();
    for (const r of repairsIn) {
      const d = parseWorkday(r.workday);
      if (d && (!byWO.has(r.work_order) || d < byWO.get(r.work_order))) byWO.set(r.work_order, d);
    }
    const t = H0 != null
      ? [...byWO.values()].map((d) => hoursAtOrBefore(smhSeries, d)).filter((hh) => hh != null).map((hh) => hh - H0).filter((x) => x >= 0).sort((a, b) => a - b)
      : [];
    const T = H0 != null && HEnd != null ? HEnd - H0 : null;
    const beta = crowBeta(t, T);
    const marks = months.map((k) => ({ x: (hoursAtOrBefore(smhSeries, new Date(k + "-01")) ?? H0 ?? 0) - (H0 ?? 0), l: monthLabel(k) }));
    const bs = beta == null ? "" : beta.toFixed(2).replace(".", ",");
    const txt = beta == null ? "мало отказов для расчёта β" : beta > 1.2 ? `β = ${bs} — отказы учащаются` : beta < 0.8 ? `β = ${bs} — отказы становятся реже` : `β = ${bs} — частота отказов стабильна`;
    const col = beta == null ? "#777" : beta > 1.2 ? MOCK_R : beta < 0.8 ? MOCK_G : "#555";
    $("#crowLegend").innerHTML = `<span><i class="ln" style="border-color:#5f3a17"></i>накопленные отказы</span><span><i class="ln ln-dash" style="border-color:#aaa"></i>постоянная частота</span><span style="color:${col};font-weight:600">${txt}</span>`;
    $("#chCrow").innerHTML = T ? crowChart(t, T, marks) : `<div class="hint-text" style="padding:60px 0;text-align:center">Недостаточно данных по наработке для этой машины.</div>`;
  } else {
    $("#crowLegend").innerHTML = "";
    $("#chCrow").innerHTML = `<div class="hint-text" style="padding:60px 0;text-align:center">Выберите одну машину — кривая отказов строится по наработке конкретной единицы.</div>`;
  }

  // --- heatmaps (subsystem / failure reason), emergency repairs only
  const emergencyByMonth = (k) => (repairsByMonth.get(k) || []).filter((r) => r.type === EMERGENCY_TYPE);
  const subsystems = [...new Set([].concat(...months.map((k) => emergencyByMonth(k).map((r) => r.subsystem).filter(Boolean))))].sort();
  const causes = [...new Set([].concat(...months.map((k) => emergencyByMonth(k).map((r) => r.reason).filter(Boolean))))].sort();
  $("#hmSub").innerHTML = subsystems.length
    ? heat(subsystems, months, (i, k) => r1(sum(emergencyByMonth(k).filter((r) => r.subsystem === subsystems[i]).map((r) => r.downtime_hours))), (v) => fmtNum(v) + " ч")
    : `<p class="hint-text">Нет аварийных отказов за выбранный период.</p>`;
  $("#hmCause").innerHTML = causes.length
    ? heat(causes, months, (i, k) => new Set(emergencyByMonth(k).filter((r) => r.reason === causes[i]).map((r) => r.work_order)).size, (v) => fmtNum(v) + " отказов")
    : `<p class="hint-text">Нет аварийных отказов за выбранный период.</p>`;
}

// ---------- machine navigation ----------
function step(direction) {
  const mine = $("#filterMine").value;
  const list = equipmentList.filter((e) => !mine || e.mine === mine);
  if (!list.length) return;
  let idx = list.findIndex((e) => e.model === $("#filterModel").value && e.local_code === $("#filterCode").value);
  idx = ((idx + direction) % list.length + list.length) % list.length;
  const e = list[idx];
  $("#filterModel").value = e.model;
  updateCodeOptions(false);
  $("#filterCode").value = e.local_code;
  // Данные теперь загружаются под конкретный выбранный борт (см. loadData), а не для
  // всего парка сразу — переключение на другую машину требует нового запроса.
  loadData();
}

// ---------- data loading ----------
let loadRequestId = 0;

async function loadData() {
  const myRequestId = ++loadRequestId;
  clearError();
  setLoading(true);
  saveState();
  try {
    const f = currentFilters();
    const eqSel = selectedEquipment(f);
    const codSet = eqSel.map((e) => e.cod);
    const single = eqSel.length === 1;

    // v_available_years — маленькая, независимая от фильтра оборудования таблица,
    // нужна раньше остального: без неё неизвестна граница текущего периода (P), а
    // значит и диапазон дат для остальных запросов ниже. Запрос уходит сразу при
    // открытии страницы (параллельно со справочником, см. initDashboard) и один раз
    // за сессию страницы, а не на каждую смену фильтра.
    const { data: yearsData, error: yearsError } = await loadYears();
    if (myRequestId !== loadRequestId) return;
    if (yearsError) {
      yearsPromise = null; // следующая попытка загрузки перезапросит годы
      throw yearsError;
    }
    periods = computePeriods(yearsData.map((r) => r.work_year));
    if (urlYearPending && periods[urlYearPending]) currentPeriodKey = urlYearPending;
    urlYearPending = null;
    if (!periods[currentPeriodKey]) currentPeriodKey = "r12";
    saveState(); // период мог смениться (сохранённый недоступен или применён из ссылки)

    const P = periods[currentPeriodKey];
    const r12 = periods.r12;
    // Матрица показывает выбранный период, а строка "Статус за 12 мес" в паспорте —
    // всегда последние 12 мес независимо от выбранной вкладки — тянем объединение
    // обоих диапазонов одним запросом вместо всей истории целиком (было: полная
    // выгрузка v_availability_dashboard/v_repair_details/v_smh_history без ограничения
    // по дате, даже когда выбран один месяц/год).
    const fetchFromStr = new Date(Math.min(P.from.getTime(), r12.from.getTime())).toISOString().slice(0, 10);
    const fetchToStr = new Date(Math.max(P.to.getTime(), r12.to.getTime())).toISOString().slice(0, 10);

    // Помесячные показатели и строки журнала — одним ответом из функции БД
    // availability_page_data (только нужные странице колонки, тот же порядок строк),
    // вместо двух постраничных выгрузок по 1000 строк с отдельными count-запросами.
    const [pageData, hrs, smh] = await Promise.all([
      withRetry(() =>
        supabase.rpc("availability_page_data", {
          p_from: fetchFromStr,
          p_to: fetchToStr,
          p_mine: f.mine || null,
          p_model: f.model || null,
          p_code: f.code || null,
        })
      ),
      codSet.length
        ? supabase.rpc("period_hours_for_cods", { p_cods: codSet, p_from: P.from.toISOString(), p_to: P.to.toISOString(), p_all_time: P.key === "all" })
        : Promise.resolve({ data: null, error: null }),
      // Полная история SMH нужна только для тренда Кроу-АМСАА одной выбранной машины
      // (нужны точки до P.from для H0 и метки месяцев) — для группового просмотра
      // "Наработка за период" считается на сервере через period_hours_for_cods выше,
      // без скачивания сырых показаний вообще.
      single ? fetchAllPages((selectOpts) => supabase.from("v_smh_history").select("cod,reading_date,trtotal", selectOpts).eq("cod", eqSel[0].cod).order("reading_date")) : Promise.resolve([]),
    ]);
    if (myRequestId !== loadRequestId) return;
    if (pageData.error) throw pageData.error;
    if (hrs.error) throw hrs.error;

    availabilityRows = pageData.data?.avail || [];
    repairRows = pageData.data?.repairs || [];
    periodHrs = hrs.data;
    smhByCod = new Map();
    for (const r of smh) {
      if (r.trtotal == null) continue;
      if (!smhByCod.has(r.cod)) smhByCod.set(r.cod, []);
      smhByCod.get(r.cod).push({ date: new Date(r.reading_date), h: Number(r.trtotal) });
    }
    for (const series of smhByCod.values()) series.sort((a, b) => a.date - b.date);

    render();
  } catch (e) {
    if (myRequestId !== loadRequestId) return;
    showError("Ошибка загрузки данных: " + e.message);
  } finally {
    if (myRequestId === loadRequestId) setLoading(false);
  }
}

function initDashboard() {
  if (dashboardStarted) return;
  dashboardStarted = true;
  enableTapToExpandCells();

  $("#filterMine").addEventListener("change", () => {
    updateModelOptions();
    updateCodeOptions(false);
    loadData();
  });
  $("#filterModel").addEventListener("change", () => {
    updateCodeOptions(false);
    loadData();
  });
  $("#filterCode").addEventListener("change", loadData);
  $("#prevMachine").addEventListener("click", () => step(-1));
  $("#nextMachine").addEventListener("click", () => step(1));

  loadYears();
  loadFilterOptions().then(() => {
    if (window.location.search.length > 1) applyUrlFilters();
    else if (["reload", "back_forward"].includes(performance.getEntriesByType?.("navigation")?.[0]?.type)) applySavedState();
    stateReady = true;
    loadData();
  });
}

setupAuth(supabase, "index.html", () =>
  loadDictNames(supabase).then(() => { EMERGENCY_TYPE = DN.em; MAINTENANCE_TYPE = DN.to; initDashboard(); })
);
