import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { setupAuth } from "./auth.js?v=36";
import { loadEquipmentList, populateSelect, updateMineOptions, updateModelAndCodeOptions } from "./filters.js?v=1";
import { initCrumbs, applyUrlFilters, equipmentParams, equipmentSteps, hasUrlFilters, EQUIPMENT_PAGES } from "./crumbs.js?v=2";
import { enableTapToExpandCells, enableScrollButtons, setupFilterToggle, onFilterChanged } from "./ui.js?v=3";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TABLE_PAGE_SIZE = 200;
const TREND_COLORS = { tr: "#2563eb", dr1: "#16a34a", dr2: "#7c3aed" };
const TREND_LABELS = { tr: "TR", dr1: "DR1", dr2: "DR2" };
const MONTHS_RU_FULL = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];

let currentRows = []; // flat rows from v_smh_history — only populated when a Месяц filter is set (small: one machine-month worth of days)
let machineRows = []; // aggregated, one per cod
let currentPage = 1;
let equipmentList = [];
let availablePeriods = []; // [{reporting_year, month}, ...]
let dashboardStarted = false;
// true when the table/chart data comes from the server-aggregated smh_summary() RPC
// (no Месяц selected — was previously a full v_smh_history download, up to ~70k
// строк) instead of the raw per-day fetch (Месяц selected — already small). In this
// mode m.days holds MONTHLY sums, not raw daily rows — daily drill-down modals fetch
// the real per-day rows on demand for just the one clicked machine/month.
let aggregatedMode = true;

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

function updateMonthOptions() {
  const yearSel = $("#filterYear");
  const monthSel = $("#filterMonth");
  const selectedYear = yearSel.value;
  const previousMonth = monthSel.value;

  const months = selectedYear
    ? [...new Set(availablePeriods.filter((p) => String(p.reporting_year) === selectedYear).map((p) => p.month))]
    : [...new Set(availablePeriods.map((p) => p.month))];
  months.sort((a, b) => a - b);

  monthSel.innerHTML = '<option value="">Все</option>';
  for (const m of months) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = MONTHS_RU_FULL[m - 1];
    monthSel.appendChild(opt);
  }
  monthSel.value = months.includes(Number(previousMonth)) ? previousMonth : "";
}

async function loadFilterOptions() {
  // Справочник, годы и месяцы не зависят друг от друга — запрашиваем одновременно,
  // а не тремя последовательными ожиданиями.
  const [eqRes, yearsRes, periodsRes] = await Promise.allSettled([
    loadEquipmentList(supabase),
    supabase.from("v_smh_years").select("reporting_year").order("reporting_year", { ascending: false }),
    supabase.from("v_smh_periods").select("reporting_year, month"),
  ]);
  if (eqRes.status === "rejected") {
    showError("Не удалось загрузить справочники: " + eqRes.reason.message);
    return;
  }
  equipmentList = eqRes.value;
  const objects = [...new Set(equipmentList.map((d) => d.object).filter(Boolean))].sort();
  populateSelect("#filterObject", objects);
  updateMineOptions(equipmentList);
  updateModelAndCodeOptions(equipmentList);

  const { data: years, error: yearsError } = yearsRes.status === "fulfilled" ? yearsRes.value : { error: yearsRes.reason };
  if (yearsError) {
    showError("Не удалось загрузить список лет: " + yearsError.message);
  } else {
    populateSelect("#filterYear", years.map((r) => r.reporting_year));
  }

  const { data: periods, error: periodsError } = periodsRes.status === "fulfilled" ? periodsRes.value : { error: periodsRes.reason };
  if (periodsError) {
    showError("Не удалось загрузить список месяцев: " + periodsError.message);
  } else {
    availablePeriods = periods;
    updateMonthOptions();
  }
}

function periodDateRange() {
  const year = $("#filterYear").value;
  const month = $("#filterMonth").value;
  if (!year) return { from: null, to: null };
  if (!month) return { from: `${year}-01-01`, to: `${Number(year) + 1}-01-01` };
  const m = Number(month);
  const nextYear = m === 12 ? Number(year) + 1 : Number(year);
  const nextMonth = m === 12 ? 1 : m + 1;
  return { from: `${year}-${String(m).padStart(2, "0")}-01`, to: `${nextYear}-${String(nextMonth).padStart(2, "0")}-01` };
}

function buildQuery(selectOpts) {
  const { from, to } = periodDateRange();
  const object = $("#filterObject").value;
  const mine = $("#filterMine").value;
  const model = $("#filterModel").value;
  const code = $("#filterCode").value;

  // Secondary sort key is required for correct range-based pagination — without it,
  // Postgres's tie order among same-date rows isn't guaranteed stable across the
  // parallel page requests below, which silently drops/duplicates rows at page
  // boundaries (caught via a direct SQL sum() mismatch against the rendered total).
  let q = supabase.from("v_smh_history").select("*", selectOpts).order("reading_date", { ascending: true }).order("cod", { ascending: true });
  if (from) q = q.gte("reading_date", from);
  if (to) q = q.lt("reading_date", to);
  if (object) q = q.eq("object", object);
  if (mine) q = q.eq("mine", mine);
  if (model) q = q.eq("model", model);
  if (code) q = q.eq("local_code", code);
  return q;
}

// A day only has 24 hours, so any single day's TR/DR1/DR2 reading above this is not
// a real daily delta — it's almost always the odometer's initial absolute reading,
// dumped into the first-ever SMH_IN row for that machine/subsystem instead of a true
// day-1 delta. Excluded everywhere (averages, totals, trend), not just chart scaling.
const MAX_PLAUSIBLE_DAILY_HOURS = 24;

function avg(values) {
  return values.length ? values.reduce((a, v) => a + v, 0) / values.length : null;
}
function sum(values) {
  return values.length ? values.reduce((a, v) => a + v, 0) : null;
}

function buildMachineRows(rows, isFullHistory) {
  const byCod = new Map();
  for (const r of rows) {
    if (!byCod.has(r.cod)) {
      byCod.set(r.cod, {
        cod: r.cod,
        local_code: r.local_code,
        model: r.model,
        mine: r.mine,
        object: r.object,
        fs: r.fs,
        commissioningDate: r.commissioning_date,
        days: [],
      });
    }
    byCod.get(r.cod).days.push({
      date: r.reading_date,
      tr: r.tr,
      dr1: r.dr1,
      dr2: r.dr2,
      trtotal: r.trtotal,
      dr1total: r.dr1total,
      dr2total: r.dr2total,
    });
  }

  // "Общая наработка" comes from the running cumulative column (trtotal/dr1total/
  // dr2total), not from re-summing daily deltas — a machine's first-ever record
  // often carries a one-time catch-up value (accumulated hours from before daily
  // tracking began), which MAX_PLAUSIBLE_DAILY_HOURS correctly excludes from the
  // average/trend (it's not one real day's work) but must still count toward the
  // total (it's real accumulated hours). Confirmed against a real machine where
  // summing filtered deltas undercounted the total by exactly that catch-up value.
  // periodStart/lastRow.trtotal - firstRow's "baseline before the window" (trtotal
  // minus its own tr) needs no extra query — trtotal[i] = trtotal[i-1] + tr[i] always.
  // Exception: with no date filter at all, `days` already covers the machine's
  // entire history, so the total is simply the latest trtotal reading — using the
  // delta formula there would subtract a tiny residual some machines carry on their
  // very first-ever row (a pre-existing baseline vs. that row's own tr not matching
  // to the hour, a leftover Access migration quirk), undercounting a real machine's
  // total by a few hours versus the live odometer reading.
  function periodTotal(first, last, key, totalKey) {
    if (first == null || last == null) return null;
    const lastTotal = last[totalKey];
    if (lastTotal == null) return null;
    if (isFullHistory) return lastTotal;
    const firstTotal = first[totalKey];
    if (firstTotal == null) return null;
    return lastTotal - firstTotal + (Number(first[key]) || 0);
  }

  return [...byCod.values()]
    .map((m) => {
      const trVals = m.days.filter((d) => d.tr != null && Number(d.tr) <= MAX_PLAUSIBLE_DAILY_HOURS).map((d) => Number(d.tr));
      const dr1Vals = m.days.filter((d) => d.dr1 != null && Number(d.dr1) <= MAX_PLAUSIBLE_DAILY_HOURS).map((d) => Number(d.dr1));
      const dr2Vals = m.days.filter((d) => d.dr2 != null && Number(d.dr2) <= MAX_PLAUSIBLE_DAILY_HOURS).map((d) => Number(d.dr2));
      const firstDay = m.days[0];
      const lastDay = m.days[m.days.length - 1];
      return {
        ...m,
        recordCount: m.days.length,
        trAvg: avg(trVals),
        trTotal: periodTotal(firstDay, lastDay, "tr", "trtotal"),
        dr1Avg: avg(dr1Vals),
        dr1Total: periodTotal(firstDay, lastDay, "dr1", "dr1total"),
        dr2Avg: avg(dr2Vals),
        dr2Total: periodTotal(firstDay, lastDay, "dr2", "dr2total"),
        ageYears: m.commissioningDate ? (Date.now() - new Date(m.commissioningDate).getTime()) / (365.25 * 24 * 3600 * 1000) : null,
      };
    })
    .sort((a, b) => (a.object ?? "").localeCompare(b.object ?? "", "ru") || String(a.local_code).localeCompare(String(b.local_code), "ru", { numeric: true }));
}
// Guards against a slower, older request (e.g. a broader unfiltered fetch) resolving
// after a newer, narrower one and silently overwriting the UI with stale data —
// rapid successive filter changes can race the paginated fetches below out of order.
let loadRequestId = 0;

// Строка/месяц таблицы полностью определяются "Год"+"Месяц": только когда оба
// заданы, диапазон дат реально узкий (≤31 день) и сырой построчный запрос остаётся
// дешёвым — во всех остальных случаях (год без месяца, месяц без года, ничего не
// выбрано) используем серверную агрегацию smh_summary() вместо скачивания всей
// подходящей истории на клиент (было — до ~70к строк при полностью пустом фильтре).
function hasBoundedMonth() {
  return Boolean($("#filterYear").value && $("#filterMonth").value);
}

function machineRowsFromSummary(rows) {
  return rows
    .map((r) => ({
      cod: r.cod,
      local_code: r.local_code,
      model: r.model,
      mine: r.mine,
      object: r.object,
      fs: r.fs,
      commissioningDate: r.commissioning_date,
      days: (r.trend_json || []).map((d) => ({ date: d.date, tr: d.tr, dr1: d.dr1, dr2: d.dr2, count: d.count })),
      recordCount: r.record_count,
      trAvg: r.tr_avg,
      trTotal: r.tr_total,
      dr1Avg: r.dr1_avg,
      dr1Total: r.dr1_total,
      dr2Avg: r.dr2_avg,
      dr2Total: r.dr2_total,
      ageYears: r.commissioning_date ? (Date.now() - new Date(r.commissioning_date).getTime()) / (365.25 * 24 * 3600 * 1000) : null,
    }))
    .sort((a, b) => (a.object ?? "").localeCompare(b.object ?? "", "ru") || String(a.local_code).localeCompare(String(b.local_code), "ru", { numeric: true }));
}

async function loadData() {
  const myRequestId = ++loadRequestId;
  clearError();
  setLoading(true);
  try {
    aggregatedMode = !hasBoundedMonth();

    if (aggregatedMode) {
      const { from, to } = periodDateRange();
      const { data, error } = await supabase.rpc("smh_summary", {
        p_from: from,
        p_to: to,
        p_object: $("#filterObject").value || null,
        p_mine: $("#filterMine").value || null,
        p_model: $("#filterModel").value || null,
        p_code: $("#filterCode").value || null,
      });
      if (error) throw error;
      if (myRequestId !== loadRequestId) return;
      currentRows = [];
      machineRows = machineRowsFromSummary(data || []);
    } else {
      const PAGE_SIZE = 1000;
      // Первая страница и общий count — одним запросом (count в заголовке Content-Range),
      // а не отдельным head-запросом перед выгрузкой: минус одно последовательное ожидание.
      const first = await buildQuery({ count: "exact" }).range(0, PAGE_SIZE - 1);
      if (first.error) throw first.error;

      let data = first.data || [];
      const total = first.count ?? data.length;
      if (total > PAGE_SIZE) {
        const pageCount = Math.ceil(total / PAGE_SIZE);
        // Год+Месяц оба заданы здесь — диапазон уже узкий (≤31 день). Пул подключений
        // увеличен пользователем с 15 до 48 (Dashboard, 2026-09-28).
        const CONCURRENCY = 8;
        const pages = new Array(pageCount);
        pages[0] = first;
        let nextIndex = 1;
        async function worker() {
          while (nextIndex < pageCount) {
            const i = nextIndex++;
            const from = i * PAGE_SIZE;
            pages[i] = await buildQuery().range(from, from + PAGE_SIZE - 1);
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pageCount - 1) }, worker));
        data = [];
        for (const { data: page, error } of pages) {
          if (error) throw error;
          data = data.concat(page);
        }
      }

      if (myRequestId !== loadRequestId) return;
      currentRows = data;
      machineRows = buildMachineRows(currentRows, false);
    }

    currentPage = 1;
    renderSummary(machineRows);
    renderTable(machineRows);
  } catch (e) {
    if (myRequestId !== loadRequestId) return;
    showError("Ошибка загрузки данных: " + e.message);
  } finally {
    if (myRequestId === loadRequestId) setLoading(false);
  }
}

// Считает по machineRows, а не по сырым строкам — m.days содержит либо реальные
// построчные записи (Год+Месяц заданы), либо уже готовые помесячные суммы
// (агрегированный режим), в обоих случаях сумма d.tr/d.dr1/d.dr2 по всем машинам
// равна сумме по всем исходным строкам.
function renderSummary(machines) {
  let totalRecords = 0, totalTr = 0, totalDr1 = 0, totalDr2 = 0;
  for (const m of machines) {
    totalRecords += m.recordCount || 0;
    for (const d of m.days) {
      totalTr += Number(d.tr) || 0;
      totalDr1 += Number(d.dr1) || 0;
      totalDr2 += Number(d.dr2) || 0;
    }
  }
  $("#summaryCards").innerHTML = `
    <div class="summary-card"><div class="label">Записей</div><div class="value">${totalRecords}</div></div>
    <div class="summary-card"><div class="label">Машин</div><div class="value">${machines.length}</div></div>
    <div class="summary-card"><div class="label">TR за период, ч</div><div class="value">${fmtNum(totalTr)}</div></div>
    <div class="summary-card"><div class="label">DR1 за период, ч</div><div class="value">${fmtNum(totalDr1)}</div></div>
    <div class="summary-card"><div class="label">DR2 за период, ч</div><div class="value">${fmtNum(totalDr2)}</div></div>
  `;
}

function dateLabel(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

function fmtNum(v) {
  return v == null ? "—" : Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 1) return sortedValues[0];
  const idx = (sortedValues.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo);
}

// Tukey-fence style robust range: the chart's vertical scale comes from the
// "normal" spread of points (IQR around the median), not the raw min/max — a single
// huge value (the one-time catch-up entry some machines carry, now correctly kept in
// the sums/totals) gets clamped to the top of the chart instead of stretching the
// scale so far that every other point flattens into an invisible line at the bottom.
function robustRange(sortedValues) {
  const q1 = percentile(sortedValues, 0.25);
  const q3 = percentile(sortedValues, 0.75);
  const iqr = q3 - q1;
  const min = sortedValues[0];
  const max = sortedValues[sortedValues.length - 1];
  return {
    lo: Math.max(min, q1 - 1.5 * iqr),
    hi: Math.min(max, q3 + 1.5 * iqr),
  };
}

// A mean-based moving average lets one huge neighbour (the catch-up spike) drag
// several nearby points up with it, which can even flip their visual order (e.g. a
// smaller month right next to the spike outranking a genuinely larger month further
// away). A rolling median instead picks the middle value of the window, so a single
// extreme neighbour is ignored rather than blended in — the requested `window` is
// nudged to odd so there's always one clean middle value, not an average of two.
function movingMedian(values, window) {
  const oddWindow = window % 2 === 0 ? window - 1 : window;
  const half = Math.floor(oddWindow / 2);
  return values.map((_, i) => {
    const start = Math.max(0, i - half);
    const end = Math.min(values.length, i + half + 1);
    const slice = [...values.slice(start, end)].sort((a, b) => a - b);
    const mid = Math.floor(slice.length / 2);
    return slice.length % 2 ? slice[mid] : (slice[mid - 1] + slice[mid]) / 2;
  });
}

// Small inline SVG sparkline: each of TR/DR1/DR2 is drawn as its own polyline,
// independently normalized to its own range (they're different scales — the goal
// is to show each series' own trend shape, not to compare magnitudes across series).
const TREND_W = 120;
const TREND_H = 32;
function monthLabel(yyyyMm) {
  const [y, m] = yyyyMm.split("-");
  return `${MONTHS_RU_FULL[Number(m) - 1]} ${y}`;
}

function trendSvg(days, groupByMonth, preAggregated) {
  const series = [
    { key: "tr", color: TREND_COLORS.tr },
    { key: "dr1", color: TREND_COLORS.dr1 },
    { key: "dr2", color: TREND_COLORS.dr2 },
  ];
  const polylines = [];
  const hoverSeries = {}; // key -> { dates: [label,...], values: [...] } for the tooltip
  for (const s of series) {
    // If this series' very first-ever record is the implausible catch-up value
    // (>24h in one "day"), drop its whole calendar month from the trend entirely —
    // smoothing/scaling could only soften it, not remove the distortion it spreads
    // to nearby points, and the totals/modals are unaffected since they don't use
    // this function at all. `days` is already one point per MONTH when preAggregated
    // (server-side smh_summary — see aggregatedMode) — a real month's total routinely
    // exceeds 24h, so this daily-value heuristic doesn't apply there; robustRange's
    // own IQR clamp below still softens any genuine one-off spike month.
    const firstValid = !preAggregated && days.find((d) => d[s.key] != null && !isNaN(Number(d[s.key])));
    const excludeMonthKey =
      firstValid && Number(firstValid[s.key]) > MAX_PLAUSIBLE_DAILY_HOURS ? firstValid.date.slice(0, 7) : null;

    let rawPts, rawLabels;
    if (groupByMonth) {
      // No month filter — the period can span years, so one point per day is mostly
      // noise. Sum into one point per calendar month instead (chronological order
      // falls out of Map insertion order since `days` is already date-sorted). Sums
      // every real value with no per-day plausibility filter — a "day > 24h" check
      // doesn't apply to a monthly sum, and this way a month's total here always
      // matches the same month's row in the "Наработка по месяцам" modal instead of
      // silently disagreeing with it (the one excluded leading month aside).
      const validDayPoints = days
        .map((d) => ({ date: d.date, value: d[s.key] != null ? Number(d[s.key]) : null }))
        .filter((p) => p.value != null && !isNaN(p.value) && p.date.slice(0, 7) !== excludeMonthKey);
      const byMonth = new Map();
      for (const p of validDayPoints) {
        const key = p.date.slice(0, 7);
        byMonth.set(key, (byMonth.get(key) || 0) + p.value);
      }
      rawLabels = [...byMonth.keys()].map(monthLabel);
      rawPts = [...byMonth.values()];
    } else {
      // One point per day — here a >24h reading really is implausible for a single
      // day (almost always that same one-time catch-up value), so it's excluded.
      const validDayPoints = days
        .map((d) => ({ date: d.date, value: d[s.key] != null ? Number(d[s.key]) : null }))
        .filter((p) => p.value != null && !isNaN(p.value) && p.value <= MAX_PLAUSIBLE_DAILY_HOURS);
      rawLabels = validDayPoints.map((p) => dateLabel(p.date));
      rawPts = validDayPoints.map((p) => p.value);
    }

    // Skip subsystems this machine doesn't really have (fewer than 2 points, or a
    // constant value like an all-zero DR1/DR2 column) — a flat line at the bottom
    // would just be noise, not a trend.
    if (rawPts.length < 2 || rawPts.every((v) => v === rawPts[0])) continue;
    // Smooth day-to-day noise with a centered moving average (window scales with
    // series length) so a glance at the line shows whether the machine's workload is
    // trending up or down, not the jagged raw daily values.
    const window = Math.max(3, Math.min(30, Math.round(rawPts.length / 15)));
    const pts = movingMedian(rawPts, window);
    // The tooltip shows the real (unsmoothed) value for that point, matching the
    // "Наработка по месяцам"/"по дням" modals exactly — only the drawn line itself
    // is smoothed, so hovering doesn't show a different number than the modals do.
    hoverSeries[s.key] = { dates: rawLabels, values: rawPts.map((v) => Math.round(v * 10) / 10) };
    const sorted = [...pts].sort((a, b) => a - b);
    const { lo, hi } = robustRange(sorted);
    const range = hi - lo || 1;
    const stepX = TREND_W / (pts.length - 1);
    const coords = pts
      .map((v, i) => {
        const norm = Math.min(1, Math.max(0, (v - lo) / range));
        return `${(i * stepX).toFixed(1)},${(TREND_H - norm * TREND_H).toFixed(1)}`;
      })
      .join(" ");
    polylines.push(`<polyline points="${coords}" fill="none" stroke="${s.color}" stroke-width="1.6" />`);
  }
  if (!polylines.length) return "—";
  const meta = JSON.stringify(hoverSeries).replace(/'/g, "&#39;");
  return `<span class="trend-wrap" data-trend='${meta}'><svg width="${TREND_W}" height="${TREND_H}" viewBox="0 0 ${TREND_W} ${TREND_H}">${polylines.join("")}</svg></span>`;
}

function renderTable(rows) {
  const totalPages = Math.max(1, Math.ceil(rows.length / TABLE_PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const start = (currentPage - 1) * TABLE_PAGE_SIZE;
  const pageRows = rows.slice(start, start + TABLE_PAGE_SIZE);
  // В агрегированном режиме m.days — уже помесячные суммы (см. aggregatedMode),
  // поэтому график всегда группируется по месяцу вне зависимости от значения самого
  // фильтра "Месяц" (тот мог быть выбран без "Года" — см. hasBoundedMonth()).
  const groupTrendByMonth = aggregatedMode || !$("#filterMonth").value;

  $("#dataTableBody").innerHTML = pageRows
    .map(
      (m) => `
    <tr>
      <td>${esc(m.object ?? "—")}</td>
      <td>${esc(m.mine ?? "—")}</td>
      <td title="${esc(m.model ?? "")}">${esc(m.model ?? "—")}</td>
      <td>${esc(m.local_code ?? "—")}</td>
      <td>${esc(m.fs ?? "—")}</td>
      <td>${fmtNum(m.trAvg)}</td>
      <td>${fmtNum(m.trTotal)}</td>
      <td>${fmtNum(m.dr1Avg)}</td>
      <td>${fmtNum(m.dr1Total)}</td>
      <td>${fmtNum(m.dr2Avg)}</td>
      <td>${fmtNum(m.dr2Total)}</td>
      <td>${dateLabel(m.commissioningDate)}</td>
      <td>${m.ageYears != null ? m.ageYears.toFixed(1).replace(".", ",") : "—"}</td>
      <td>${trendSvg(m.days, groupTrendByMonth, aggregatedMode)}</td>
      <td><button class="detail-btn" data-cod="${m.cod}">+${m.recordCount}</button></td>
    </tr>`
    )
    .join("");

  for (const btn of $("#dataTableBody").querySelectorAll(".detail-btn")) {
    btn.addEventListener("click", () => openDetailEntry(Number(btn.dataset.cod)));
  }

  renderPagination(totalPages, rows.length);
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
  $("#pagePrev")?.addEventListener("click", () => {
    currentPage--;
    renderTable(machineRows);
  });
  $("#pageNext")?.addEventListener("click", () => {
    currentPage++;
    renderTable(machineRows);
  });
}

let dailyModalRows = []; // currently-shown daily rows, kept for its own Excel export
let monthModalRows = []; // currently-shown monthly rows, kept for its own Excel export

// "+N" on the main table: with no Месяц filter, N spans several months, so drill down
// through a month list first; with Месяц already set, there's only one month in view
// anyway, so go straight to the daily breakdown (matches the trend chart's same
// month-filter-dependent grouping).
function openDetailEntry(cod) {
  if (!aggregatedMode) {
    openDailyModal(cod, null);
  } else {
    openMonthModal(cod);
  }
}

function openMonthModal(cod) {
  const m = machineRows.find((r) => r.cod === cod);
  if (!m) return;
  $("#monthDetailModalTitle").textContent = `Наработка по месяцам — Борт ${esc(m.local_code ?? "—")} (${esc(m.model ?? "—")})`;

  const byMonth = new Map();
  for (const d of m.days) {
    const key = d.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, { key, tr: 0, dr1: 0, dr2: 0, hasDr1: false, hasDr2: false, count: 0 });
    const e = byMonth.get(key);
    e.tr += Number(d.tr) || 0;
    if (d.dr1 != null) {
      e.dr1 += Number(d.dr1);
      e.hasDr1 = true;
    }
    if (d.dr2 != null) {
      e.dr2 += Number(d.dr2);
      e.hasDr2 = true;
    }
    // В агрегированном режиме d — уже готовая помесячная сумма (одна запись на
    // месяц) и несёт настоящее число исходных строк в d.count; в сыром режиме
    // каждый d — одна реальная запись, считаем построчно как раньше.
    e.count += d.count ?? 1;
  }

  monthModalRows = [...byMonth.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  $("#monthDetailTableBody").innerHTML = monthModalRows
    .map(
      (e) => `
    <tr>
      <td>${monthLabel(e.key)}</td>
      <td>${fmtNum(e.tr)}</td>
      <td>${e.hasDr1 ? fmtNum(e.dr1) : "—"}</td>
      <td>${e.hasDr2 ? fmtNum(e.dr2) : "—"}</td>
      <td>${e.count}</td>
      <td><button class="detail-btn month-drill-btn" data-month="${e.key}">Детали</button></td>
    </tr>`
    )
    .join("");

  for (const btn of $("#monthDetailTableBody").querySelectorAll(".month-drill-btn")) {
    btn.addEventListener("click", () => {
      closeMonthModal();
      openDailyModal(cod, btn.dataset.month);
    });
  }

  $("#monthDetailModal").hidden = false;
}

function closeMonthModal() {
  $("#monthDetailModal").hidden = true;
}

// В агрегированном режиме m.days — помесячные суммы, а не реальные строки, поэтому
// построчная разбивка по дням тянется отдельно и только для одной кликнутой машины
// (+ месяца, если он уже известен из модалки "по месяцам") — вместо того чтобы
// держать всю сырую историю каждой из ~217 машин загруженной заранее.
async function fetchMachineDays(cod, monthKey) {
  let q = supabase
    .from("v_smh_history")
    .select("reading_date,tr,trtotal,dr1,dr1total,dr2,dr2total")
    .eq("cod", cod)
    .order("reading_date", { ascending: true });
  if (monthKey) {
    const [y, mo] = monthKey.split("-").map(Number);
    const from = `${y}-${String(mo).padStart(2, "0")}-01`;
    const nextY = mo === 12 ? y + 1 : y;
    const nextMo = mo === 12 ? 1 : mo + 1;
    const to = `${nextY}-${String(nextMo).padStart(2, "0")}-01`;
    q = q.gte("reading_date", from).lt("reading_date", to);
  }
  const { data, error } = await q;
  if (error) {
    showError("Ошибка загрузки дневных данных: " + error.message);
    return [];
  }
  return data.map((r) => ({ date: r.reading_date, tr: r.tr, trtotal: r.trtotal, dr1: r.dr1, dr1total: r.dr1total, dr2: r.dr2, dr2total: r.dr2total }));
}

async function openDailyModal(cod, monthKey) {
  const m = machineRows.find((r) => r.cod === cod);
  if (!m) return;
  $("#detailModalTitle").textContent = monthKey
    ? `Наработка по дням — Борт ${esc(m.local_code ?? "—")} (${esc(m.model ?? "—")}), ${monthLabel(monthKey)}`
    : `Наработка по дням — Борт ${esc(m.local_code ?? "—")} (${esc(m.model ?? "—")})`;

  const days = aggregatedMode ? await fetchMachineDays(cod, monthKey) : m.days;

  dailyModalRows = days
    .filter((d) => !monthKey || d.date.slice(0, 7) === monthKey)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Cumulative columns read the DB's own running total (trtotal/dr1total/dr2total)
  // directly instead of re-summing from zero — that stays correct however the daily
  // rows are sliced (a single month included), unlike a local running sum which
  // would restart at 0 for whatever the first shown row happens to be.
  $("#detailTableBody").innerHTML = dailyModalRows
    .map(
      (d) => `
    <tr>
      <td>${dateLabel(d.date)}</td>
      <td>${fmtNum(d.tr)}</td>
      <td>${fmtNum(d.trtotal)}</td>
      <td>${d.dr1 != null ? fmtNum(d.dr1) : "—"}</td>
      <td>${d.dr1total != null ? fmtNum(d.dr1total) : "—"}</td>
      <td>${d.dr2 != null ? fmtNum(d.dr2) : "—"}</td>
      <td>${d.dr2total != null ? fmtNum(d.dr2total) : "—"}</td>
    </tr>`
    )
    .join("");

  $("#detailModal").hidden = false;
}

function closeDetailModal() {
  $("#detailModal").hidden = true;
}

function exportMonthModal() {
  const wsData = monthModalRows.map((e) => ({
    Месяц: monthLabel(e.key),
    "TR общая": e.tr,
    "DR1 общая": e.hasDr1 ? e.dr1 : "",
    "DR2 общая": e.hasDr2 ? e.dr2 : "",
    Записей: e.count,
  }));
  const ws = XLSX.utils.json_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Наработка по месяцам");
  XLSX.writeFile(wb, `smh_months_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function exportDailyModal() {
  const wsData = dailyModalRows.map((d) => ({
    Дата: dateLabel(d.date),
    "TR сутки": d.tr,
    "TR нараст.": d.trtotal,
    "DR1 сутки": d.dr1 ?? "",
    "DR1 нараст.": d.dr1total ?? "",
    "DR2 сутки": d.dr2 ?? "",
    "DR2 нараст.": d.dr2total ?? "",
  }));
  const ws = XLSX.utils.json_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Наработка по дням");
  XLSX.writeFile(wb, `smh_days_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function exportExcel() {
  const wsData = machineRows.map((m) => ({
    Объект: m.object,
    Шахта: m.mine,
    Модель: m.model,
    Борт: m.local_code,
    FS: m.fs,
    "TR ср./сутки": m.trAvg,
    "TR общая": m.trTotal,
    "DR1 ср./сутки": m.dr1Avg,
    "DR1 общая": m.dr1Total,
    "DR2 ср./сутки": m.dr2Avg,
    "DR2 общая": m.dr2Total,
    "Дата ввода в эксплуатацию": dateLabel(m.commissioningDate),
    "Возраст оборудования, лет": m.ageYears != null ? Number(m.ageYears.toFixed(1)) : "",
    Записей: m.recordCount,
  }));
  const ws = XLSX.utils.json_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Наработка SMH");
  XLSX.writeFile(wb, `smh_history_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function setupTrendTooltip() {
  const tooltip = $("#trendTooltip");
  const tbody = $("#dataTableBody");
  tbody.addEventListener("mousemove", (e) => {
    const wrap = e.target.closest(".trend-wrap");
    if (!wrap) {
      tooltip.hidden = true;
      return;
    }
    let meta;
    try {
      meta = JSON.parse(wrap.dataset.trend);
    } catch {
      tooltip.hidden = true;
      return;
    }
    const rect = wrap.getBoundingClientRect();
    const fraction = rect.width ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
    const lines = [];
    for (const key of ["tr", "dr1", "dr2"]) {
      const s = meta[key];
      if (!s || !s.values.length) continue;
      const idx = Math.round(fraction * (s.values.length - 1));
      lines.push(`<div><strong>${TREND_LABELS[key]}</strong>: ${fmtNum(s.values[idx])} ч <span class="trend-tooltip-date">(${s.dates[idx]})</span></div>`);
    }
    if (!lines.length) {
      tooltip.hidden = true;
      return;
    }
    tooltip.innerHTML = lines.join("");
    tooltip.style.left = `${e.clientX + 14}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
    tooltip.hidden = false;
  });
  tbody.addEventListener("mouseleave", () => {
    tooltip.hidden = true;
  });
}

// Каскад списков после выбора объекта/шахты/модели (как в обработчиках change ниже).
const cascade = (level) => {
  if (level === "object") updateMineOptions(equipmentList);
  updateModelAndCodeOptions(equipmentList);
};

function initDashboard() {
  if (dashboardStarted) return;
  dashboardStarted = true;
  enableTapToExpandCells();
  enableScrollButtons();
  setupTrendTooltip();

  setupFilterToggle(loadData);
  initCrumbs($("#crumbs"), EQUIPMENT_PAGES, "smh-history.html", equipmentParams());
  $("#filterYear").addEventListener("change", () => {
    updateMonthOptions();
    onFilterChanged(loadData);
  });
  $("#filterMonth").addEventListener("change", () => onFilterChanged(loadData));
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
    $("#filterYear").value = "";
    $("#filterMonth").value = "";
    $("#filterObject").value = "";
    $("#filterMine").value = "";
    $("#filterModel").value = "";
    $("#filterCode").value = "";
    updateMonthOptions();
    updateMineOptions(equipmentList);
    updateModelAndCodeOptions(equipmentList);
    loadData();
    $("#filterPanel").classList.remove("open");
  });

  $("#exportExcel").addEventListener("click", exportExcel);

  $("#detailModalClose").addEventListener("click", closeDetailModal);
  $("#detailModal").addEventListener("click", (e) => {
    if (e.target.id === "detailModal") closeDetailModal();
  });
  $("#detailExportBtn").addEventListener("click", exportDailyModal);

  $("#monthDetailModalClose").addEventListener("click", closeMonthModal);
  $("#monthDetailModal").addEventListener("click", (e) => {
    if (e.target.id === "monthDetailModal") closeMonthModal();
  });
  $("#monthDetailExportBtn").addEventListener("click", exportMonthModal);

  // При открытии все фильтры пустые (весь парк, весь период) — сводке не нужны ни
  // справочник, ни списки лет/месяцев, поэтому она грузится одновременно с ними.
  // Пришли по крошкам с фильтрами — сначала справочник, чтобы выставить их, потом сводка.
  if (hasUrlFilters()) {
    loadFilterOptions().then(() => {
      applyUrlFilters(equipmentSteps("#filterCode", cascade));
      return loadData();
    });
  } else {
    loadFilterOptions();
    loadData();
  }
}

setupAuth(supabase, "smh-history.html", () => initDashboard());
