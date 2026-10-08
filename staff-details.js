import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { setupAuth } from "./auth.js?v=36";
import { DN, loadDictNames } from "./dict-names.js?v=1";
import { populateSelect } from "./filters.js?v=1";
import { initCrumbs, applyUrlFilters, urlParam, STAFF_PAGES } from "./crumbs.js?v=2";
import { setupFilterToggle, onFilterChanged, enableScrollButtons, enableStickyTableWrap } from "./ui.js?v=4";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MONTHS_RU_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
// Названия типов берутся из справочника по ключу (dict-names.js) перед запуском страницы.
let EM = DN.em, PL = DN.pl, TO = DN.to;
const MOCK_EM = "#d23a2f", MOCK_PL = "#3a5bd9", MOCK_TO = "#2e9d4f", MOCK_CTR = "#b07a3c", MOCK_STAFF = "#8a97a8";

// Пороги — ТЗ §7.5: все в одном месте.
const THRESH = {
  loadUnder: 0.6, loadOver: 1.15, loadHigh: 1.0, // цвет клетки месяца
  burnoutMonths: 3, burnoutLoadPct: 1.1, // "3 и более месяцев подряд > 110%"
  noWeekendDays: 12, // серия дней подряд без выходного (если график не задан)
  longShiftHours: 12, longShiftAvgPerMonth: 4, // длинные смены (если график не задан)
  overtimePerDay: 2, // ТК РК ст. 78: сверхурочные не более 2 ч в сутки → смена длиннее графика + 2 ч
  vahtaHandoverDays: 1, // пересменка: 16 дней вместо 15 на вахте признаком не считаем
  weekendDaysPerMonth: 2, // 5/2 пн–пт: работа в субботу/воскресенье, дней в месяц (в среднем)
  nightShare: 0.35, // ночная работа (доля часов 22:00–06:00)
  nightShiftMinHours: 3, maxNightsInRow: 4, // ночная смена — ≥3 ч ночью; с 4-й ночи подряд риск +36% (Folkard & Tucker)
  vahtaLoadMonths: 3, // вахта: суммированный учёт за квартал (ТК РК ст. 135) — загрузку берём средней за 3 мес.
  emShareBurnout: 0.5, // аварийная нагрузка
  effGreen: 1.05, effYellow: 1.15,
  repYellowMult: 1.6,
  universalMin: 4, narrowMax: 1, subShareMin: 0.1,
  coverageHoursPer12mo: 150, coverageRed: 2, coverageYellow: 4,
  minOrdersForStaffRow: 20, // "учитываются только сотрудники с ≥20 нарядами за период"
  minOrdersForEff: 10, minOrdersForRep: 10,
  ctrHpoYellowMult: 1.15, ctrHpoRedMult: 1.5,
};

const $ = (sel) => document.querySelector(sel);
// Тексты из базы вставляются в HTML — экранируем.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fN = (v, d = 0) => (v == null || isNaN(v) ? "—" : Number(v).toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d }));
function money(x) {
  if (x == null) return "—";
  const abs = Math.abs(x);
  if (abs >= 1e6) return (x / 1e6).toFixed(1).replace(".", ",") + " млн";
  if (abs >= 1000) return Math.round(x / 1000).toLocaleString("ru-RU") + " тыс";
  return fN(x);
}
const pct = (v) => (v == null || isNaN(v) ? "—" : Math.round(v * 100) + "%");
function median(arr) {
  const s = arr.filter((x) => x != null && !isNaN(x)).sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// График работы из справочника «Персонал» (null — не задан, признаки по общим порогам).
const SCHEDULE_NAMES = { vahta: "вахта", "5x2": "5/2 пн–пт", "5x2_sliding": "5/2 скользящий", shift: "сменный" };
function scheduleOf(info) {
  const type = info?.work_schedule;
  if (!SCHEDULE_NAMES[type] || !(info.days_on > 0)) return null;
  const on = Number(info.days_on), off = Number(info.days_off) || 0, shiftH = Number(info.shift_hours) || null;
  return {
    type, on, off, shiftH,
    label: `${SCHEDULE_NAMES[type]}${type.startsWith("5x2") && on === 5 && off === 2 ? "" : ` ${on}/${off}`}${shiftH ? ` · ${fN(shiftH, shiftH % 1 ? 1 : 0)} ч` : ""}`,
    tol: type === "vahta" ? THRESH.vahtaHandoverDays : 0,
  };
}
const dayNum = (iso) => Math.round(Date.parse(iso) / 86400000);

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

// ---------- периоды (тот же принцип, что в fleet-status.js/app.js) ----------
let currentPeriodKey = "r12";
function computePeriods(years) {
  const today = new Date();
  const y0 = today.getUTCFullYear(), m0 = today.getUTCMonth();
  const startOfMonth = (y, m) => new Date(Date.UTC(y, m, 1));
  const endOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0, 23, 59, 59));
  const p = {};
  p.r12 = { key: "r12", name: "12 мес", from: startOfMonth(y0, m0 - 11), to: endOfMonth(y0, m0) };
  const sortedYears = [...new Set(years)].sort((a, b) => a - b);
  for (const y of sortedYears) {
    const isCurrent = y === y0;
    p[y] = { key: String(y), name: isCurrent ? `${y} (янв–${MONTHS_RU_SHORT[m0]})` : String(y), from: startOfMonth(y, 0), to: isCurrent ? endOfMonth(y, m0) : endOfMonth(y, 11) };
  }
  return p;
}
function monthsInPeriod(P) {
  const out = [];
  let y = P.from.getUTCFullYear(), m = P.from.getUTCMonth();
  const endY = P.to.getUTCFullYear(), endM = P.to.getUTCMonth();
  while (y < endY || (y === endY && m <= endM)) {
    out.push({ y, m: m + 1 });
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return out;
}
function renderPeriodToggle(periods) {
  const order = ["r12", ...Object.keys(periods).filter((k) => k !== "r12")];
  $("#periodToggle").innerHTML = order.map((k) => `<button type="button" class="${k === currentPeriodKey ? "on" : ""}" data-period="${k}">${periods[k].name}</button>`).join("");
  for (const btn of $("#periodToggle").querySelectorAll("button")) {
    btn.addEventListener("click", () => {
      currentPeriodKey = btn.dataset.period;
      renderPeriodToggle(periods);
      recompute();
    });
  }
}
function monthKeyStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// ---------- загрузка данных ----------
async function withRetry(run) {
  for (let attempt = 0; ; attempt++) {
    const res = await run();
    if (!res.error || attempt >= 2) return res;
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
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
  // подтверждено измерением).
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

let staffMap = new Map(); // staff_id -> {famaly, staff_type, organization, role_pos, norm_hours_month}
let monthRows = []; // v_staff_month, все объекты/шахты (фильтруем в JS)
let dayRows = []; // v_staff_day
let subRows = []; // v_staff_subsystem
let orderRows = []; // v_order_staff (наряд×сотрудник, для эффективности/повторов/drill-through)
let periodQuality = { total_hours: 0, unattr_hours: 0 }; // для баннера качества данных (из staff_page_data)
let objectsList = [], minesList = [];

async function loadStaffMap() {
  const rows = await fetchAllPages((opts) => supabase.from("v_staff_id_map").select("*", opts));
  staffMap = new Map(rows.map((r) => [r.staff_id, r]));
}

async function loadPeriodData(P) {
  const fromStr = P.from.toISOString().slice(0, 10);
  const toStr = P.to.toISOString().slice(0, 10);
  // Все четыре набора (те же строки, колонки и порядок, что и раньше) плюс итоги для
  // баннера качества данных — одним ответом из функции БД staff_page_data, вместо
  // ~70 постраничных запросов (v_order_staff раньше ещё и выгружался дважды, а для
  // баннера тянулся весь журнал ремонтов за период).
  const { data, error } = await withRetry(() => supabase.rpc("staff_page_data", { p_from: fromStr, p_to: toStr }));
  if (error) throw error;
  monthRows = data?.month || [];
  dayRows = data?.day || [];
  subRows = data?.sub || [];
  // orders приходят компактно — {cols, rows: [[...]]} (без повторения названий полей в
  // каждой из ~17 тыс. строк); собираем обратно те же объекты, что давал v_order_staff.
  const oc = data?.orders?.cols || [];
  orderRows = (data?.orders?.rows || []).map((r) => {
    const o = {};
    for (let i = 0; i < oc.length; i++) o[oc[i]] = r[i];
    return o;
  });
  periodQuality = data?.quality || { total_hours: 0, unattr_hours: 0 };
  objectsList = [...new Set(monthRows.map((r) => r.object).filter(Boolean))].sort();
  minesList = [...new Set(monthRows.map((r) => r.mine).filter(Boolean))].sort();
}

// ---------- фильтрация по Объект/Шахта ----------
function currentFilters() {
  return { object: $("#filterObject").value, mine: $("#filterMine").value };
}
function filterRows(rows, f) {
  return rows.filter((r) => (!f.object || r.object === f.object) && (!f.mine || r.mine === f.mine));
}

// ---------- агрегация по сотруднику ----------
function buildStaffAgg(f) {
  const mRows = filterRows(monthRows, f).filter((r) => r.staff_type === "staff");
  const byStaff = new Map();
  for (const r of mRows) {
    if (!byStaff.has(r.staff_id)) byStaff.set(r.staff_id, []);
    byStaff.get(r.staff_id).push(r);
  }
  const dayByStaff = new Map();
  for (const d of dayRows) {
    if (!dayByStaff.has(d.staff_id)) dayByStaff.set(d.staff_id, []);
    dayByStaff.get(d.staff_id).push(d);
  }
  const subByStaff = new Map();
  for (const s of filterRows(subRows, f)) {
    if (s.staff_type !== "staff" || s.work_type === TO) continue;
    if (!subByStaff.has(s.staff_id)) subByStaff.set(s.staff_id, new Map());
    const m = subByStaff.get(s.staff_id);
    m.set(s.subsystem, (m.get(s.subsystem) || 0) + Number(s.hours));
  }
  const ordersByStaff = new Map();
  for (const o of filterRows(orderRows, f)) {
    if (o.staff_type !== "staff") continue;
    if (!ordersByStaff.has(o.staff_id)) ordersByStaff.set(o.staff_id, []);
    ordersByStaff.get(o.staff_id).push(o);
  }

  // Медианы бригады (по типу работ) — считаются один раз по всей отфильтрованной выборке.
  const allOrders = [...filterRows(orderRows, f).filter((o) => o.staff_type === "staff")];
  const rByType = new Map();
  for (const o of allOrders) {
    if (!(o.plan_hours_order > 0)) continue;
    const r = o.fact_hours_order / o.plan_hours_order;
    if (!rByType.has(o.work_type)) rByType.set(o.work_type, []);
    rByType.get(o.work_type).push(r);
  }
  const medByType = new Map([...rByType.entries()].map(([t, arr]) => [t, median(arr)]));
  const allRepOrders = allOrders.filter((o) => o.work_type === EM);
  const MED_REP = median(
    [...new Map([...ordersByStaff.entries()]).entries()].map(([sid, os]) => {
      const em = os.filter((o) => o.work_type === EM);
      return em.length ? em.filter((o) => o.is_repeat).length / em.length : null;
    }).filter((x) => x != null)
  );

  const out = [];
  for (const [staffId, months] of byStaff.entries()) {
    const info = staffMap.get(staffId);
    if (!info) continue;
    const orders = ordersByStaff.get(staffId) || [];
    const totalOrders = new Set(orders.map((o) => o.order_id)).size;
    if (totalOrders < THRESH.minOrdersForStaffRow) continue;

    const hours = months.reduce((a, m) => a + Number(m.hours || 0), 0);
    const hoursEm = months.reduce((a, m) => a + Number(m.hours_em || 0), 0);
    const hoursPl = months.reduce((a, m) => a + Number(m.hours_pl || 0), 0);
    const hoursTo = months.reduce((a, m) => a + Number(m.hours_to || 0), 0);
    const norm = Number(info.norm_hours_month) || 0;
    const monthKeys = [...new Set(months.map((m) => m.month))];
    const load = norm ? hours / (norm * monthKeys.length) : null;

    // Загрузка по каждому месяцу периода (для полосы) — 0 для месяцев без данных.
    const byMonthKey = new Map(months.map((m) => [m.month, m]));
    const P = periods[currentPeriodKey];
    const stripMonths = monthsInPeriod(P).map(({ y, m }) => {
      const key = monthKeyStr(new Date(Date.UTC(y, m - 1, 1)));
      const row = byMonthKey.get(key);
      const h = row ? Number(row.hours) : 0;
      return { y, m, key, hours: h, load: norm ? h / norm : null, orders: row ? row.orders : 0, hasData: !!row };
    });

    // Признаки выгорания — относительно графика сотрудника (справочник «Персонал»).
    const sch = scheduleOf(info);
    const flags = [];
    if (norm) {
      // Вахта — суммированный учёт: месяц с двумя заездами и месяц с одним уравниваются за квартал.
      const win = sch?.type === "vahta" ? Math.min(THRESH.vahtaLoadMonths, stripMonths.length) : 1;
      let run = 0, maxRun = 0, maxAvg = 0;
      for (let i = 0; i < stripMonths.length; i++) {
        if (win > 1) {
          if (i + 1 < win) continue;
          const part = stripMonths.slice(i + 1 - win, i + 1);
          const avg = part.reduce((a, sm) => a + sm.hours, 0) / (norm * win);
          maxAvg = Math.max(maxAvg, avg);
        } else {
          const sm = stripMonths[i];
          run = sm.load != null && sm.load > THRESH.burnoutLoadPct ? run + 1 : 0;
          maxRun = Math.max(maxRun, run);
        }
      }
      if (win > 1 && maxAvg > THRESH.burnoutLoadPct) flags.push(`${win} мес. в среднем ${pct(maxAvg)} нормы`);
      if (win === 1 && maxRun >= THRESH.burnoutMonths) flags.push(`${maxRun} мес. подряд > ${Math.round(THRESH.burnoutLoadPct * 100)}%`);
    }
    // Рабочий день — есть наряд с реальным временем. Запись «00:00-23:59» — наряд, растянутый
    // на сутки, а не присутствие (span_hours её не учитывает); такие дни не считаем рабочими.
    const hasSpan = dayRows.length && dayRows[0].span_hours !== undefined;
    const spanOf = (d) => Number(hasSpan ? d.span_hours : d.hours) || 0;
    const days = (dayByStaff.get(staffId) || []).filter((d) => spanOf(d) > 0).sort((a, b) => (a.day < b.day ? -1 : 1));
    const nums = days.map((d) => dayNum(d.day));
    let streak = 0, maxStreak = 0;
    for (let i = 0; i < nums.length; i++) {
      streak = i && nums[i] - nums[i - 1] === 1 ? streak + 1 : 1;
      maxStreak = Math.max(maxStreak, streak);
    }
    if (!sch) {
      if (maxStreak >= THRESH.noWeekendDays) flags.push(`${maxStreak} дней без выходного`);
    } else {
      // Режим отдыха: дни подряд сверх графика, мало отдыха внутри цикла (окно в длину цикла),
      // для 5/2 пн–пт — выходы в субботу/воскресенье. Один признак, причины — через «; ».
      const why = [];
      const allowed = sch.on + sch.tol;
      if (maxStreak > allowed) why.push(`${maxStreak} дн. подряд`);
      const cycle = sch.on + sch.off;
      if (sch.off > 0 && cycle > 1 && maxStreak <= allowed) {
        let maxIn = 0;
        for (let i = 0, j = 0; i < nums.length; i++) {
          while (nums[i] - nums[j] >= cycle) j++;
          maxIn = Math.max(maxIn, i - j + 1);
        }
        if (maxIn > allowed) why.push(`${maxIn} раб. дн. за ${cycle} дн.`);
      }
      if (sch.type === "5x2") {
        const wk = days.filter((d) => [0, 6].includes(new Date(d.day + "T00:00:00Z").getUTCDay())).length;
        const monthsN = new Set(days.map((d) => d.day.slice(0, 7))).size;
        if (monthsN && wk / monthsN >= THRESH.weekendDaysPerMonth) why.push(`в выходные ${fN(wk / monthsN, 1)} дн./мес`);
      }
      if (why.length) flags.push(`отдых не по графику (${sch.on}/${sch.off}): ${why.join("; ")}`);
    }
    // Длинные смены: длиннее графика больше чем на допустимые 2 ч сверхурочных.
    const longLimit = sch?.shiftH ? sch.shiftH + THRESH.overtimePerDay : THRESH.longShiftHours;
    const monthsSeen = new Map();
    for (const d of days) {
      const mk = d.day.slice(0, 7);
      if (!monthsSeen.has(mk)) monthsSeen.set(mk, 0);
      if (spanOf(d) > longLimit) monthsSeen.set(mk, monthsSeen.get(mk) + 1);
    }
    const longShiftAvg = monthsSeen.size ? [...monthsSeen.values()].reduce((a, b) => a + b, 0) / monthsSeen.size : 0;
    if (longShiftAvg >= THRESH.longShiftAvgPerMonth) flags.push(`${fN(longShiftAvg, 1)} смен > ${fN(longLimit, longLimit % 1 ? 1 : 0)} ч за месяц (в среднем)`);
    // Ночь: доля часов 22:00–06:00 и ночи подряд.
    const nightOf = (d) => Number(hasSpan ? d.night_span_hours : d.night_hours) || 0;
    const totalDayHours = days.reduce((a, d) => a + spanOf(d), 0);
    const nightHours = days.reduce((a, d) => a + nightOf(d), 0);
    const nightShare = totalDayHours ? nightHours / totalDayHours : 0;
    let nRun = 0, maxNights = 0;
    for (let i = 0; i < days.length; i++) {
      const isNight = nightOf(days[i]) >= THRESH.nightShiftMinHours;
      nRun = isNight ? (i && nRun && nums[i] - nums[i - 1] === 1 ? nRun + 1 : 1) : 0;
      maxNights = Math.max(maxNights, nRun);
    }
    const nightWhy = [];
    if (nightShare >= THRESH.nightShare) nightWhy.push(`ночные работы ${pct(nightShare)}`);
    if (maxNights > THRESH.maxNightsInRow) nightWhy.push(`${maxNights} ночей подряд`);
    if (nightWhy.length) flags.push(nightWhy.join(", "));
    const emShare = hours ? hoursEm / hours : 0;
    if (emShare >= THRESH.emShareBurnout) flags.push(`аварийные ${pct(emShare)} часов`);
    const risk = flags.length >= 2 ? "r" : flags.length === 1 ? "y" : "g";

    // Эффективность.
    const ordersWithPlan = orders.filter((o) => o.plan_hours_order > 0);
    let eff = null;
    if (ordersWithPlan.length >= THRESH.minOrdersForEff) {
      let num = 0, den = 0;
      for (const o of ordersWithPlan) {
        const med = medByType.get(o.work_type);
        if (!med) continue;
        const r = o.fact_hours_order / o.plan_hours_order;
        num += o.hours * (r / med);
        den += o.hours;
      }
      eff = den ? num / den : null;
    }

    // Повторные отказы.
    const emOrders = orders.filter((o) => o.work_type === EM);
    const uniqEmOrders = [...new Map(emOrders.map((o) => [o.order_id, o])).values()];
    let rep = null;
    if (uniqEmOrders.length >= THRESH.minOrdersForRep) rep = uniqEmOrders.filter((o) => o.is_repeat).length / uniqEmOrders.length;

    // Предпочтения/универсальность.
    const subH = subByStaff.get(staffId) || new Map();
    const subTotal = [...subH.values()].reduce((a, b) => a + b, 0);
    const shares = [...subH.entries()].map(([name, h]) => [name, subTotal ? h / subTotal : 0]).sort((a, b) => b[1] - a[1]);
    const univN = shares.filter(([, v]) => v >= THRESH.subShareMin).length;
    const univ = univN >= THRESH.universalMin ? "универсал" : univN <= THRESH.narrowMax ? "узкий специалист" : "смешанный";

    out.push({
      staffId, famaly: info.famaly, pos: info.role_pos, norm, hours, hoursEm, hoursPl, hoursTo,
      load, stripMonths, flags, risk, schedule: sch?.label || null, eff, rep, emShare, plShare: hours ? hoursPl / hours : 0, toShare: hours ? hoursTo / hours : 0,
      shares, univ, univN, orders: totalOrders, subH,
    });
  }
  return { rows: out, medByType, MED_REP };
}

// ---------- ссылки-переходы в журнал ремонтов (точный список work_order, как везде в проекте) ----------
// Точные ID нарядов (не текстовый фильтр) — то же правило "exact-count-matching", что и
// у всех drill-through ссылок в проекте: число, которое видит пользователь, всегда равно
// числу строк, которые откроются.
function drillLink(orderIds, desc, innerHtml, style = "") {
  const ids = [...new Set(orderIds)];
  if (!ids.length) return `<span style="${style}">${innerHtml}</span>`;
  const params = new URLSearchParams({ wo: ids.join(","), src: desc });
  return `<a class="jl" href="repair-details.html?${params.toString()}" title="${esc(desc)} — открыть в журнале ремонтов" style="${style}">${innerHtml}</a>`;
}

// ---------- рендер: штат ----------
let sFilterKey = "all";
const SFILTERS = {
  all: { name: "Все сотрудники", test: () => true },
  over: { name: "Перегружены (загрузка > 115%)", test: (s) => s.load != null && s.load > THRESH.loadOver },
  under: { name: "Недогружены (загрузка < 60%)", test: (s) => s.load != null && s.load < THRESH.loadUnder },
  risk: { name: "Риск выгорания (2 и более признаков)", test: (s) => s.risk === "r" },
  key: { name: "Ключевые люди по узким местам (подсистемы с покрытием ≤ 2 чел.)", test: (s, gapNames) => gapNames.some((n) => (s.subH.get(n) || 0) >= coverageHoursThreshold()) },
};
function coverageHoursThreshold() {
  const P = periods[currentPeriodKey];
  const monthsN = monthsInPeriod(P).length;
  return THRESH.coverageHoursPer12mo * (monthsN / 12);
}
function gapSubsystems(staffRows) {
  const allSubs = new Set();
  for (const s of staffRows) for (const name of s.subH.keys()) allSubs.add(name);
  const covThresh = coverageHoursThreshold();
  return [...allSubs].filter((name) => staffRows.filter((s) => (s.subH.get(name) || 0) >= covThresh).length <= THRESH.coverageRed);
}

function cardHtml(k, v, s, style = "", filterKey = null, hint = "") {
  const clickable = filterKey != null;
  const on = clickable && sFilterKey === filterKey;
  return `<div class="card ${clickable ? "click" : ""} ${on ? "on" : ""}" ${clickable ? `data-f="${filterKey}"` : ""}>
    <div class="k">${k}</div><div class="v" style="${style}">${v}</div><div class="s">${s}</div>
    ${clickable ? `<div class="hint">${on ? "✕ снять фильтр" : hint}</div>` : ""}
  </div>`;
}

function renderStaff() {
  const f = currentFilters();
  const { rows, medByType, MED_REP } = buildStaffAgg(f);
  const gapNames = gapSubsystems(rows);
  const over = rows.filter((s) => s.load != null && s.load > THRESH.loadOver).length;
  const under = rows.filter((s) => s.load != null && s.load < THRESH.loadUnder).length;
  const risk = rows.filter((s) => s.risk === "r").length;
  const warnN = rows.filter((s) => s.risk === "y").length;
  const withNorm = rows.filter((s) => s.load != null);
  const avgLoad = withNorm.length ? withNorm.reduce((a, s) => a + s.load, 0) / withNorm.length : null;
  const normSample = rows.find((s) => s.norm)?.norm;
  const keyPeopleN = rows.filter((s) => gapNames.some((n) => (s.subH.get(n) || 0) >= coverageHoursThreshold())).length;

  $("#sCards").innerHTML =
    cardHtml("Активных сотрудников", rows.length, "с ≥20 нарядами за период", "", "all", "показать всех") +
    cardHtml("Средняя загрузка", avgLoad != null ? pct(avgLoad) : "—", normSample ? `норма ${normSample} ч/мес` : "—") +
    cardHtml("Перегружены", over, "загрузка за период > 115%", over ? `color:${MOCK_EM}` : "", "over", "показать →") +
    cardHtml("Недогружены", under, "загрузка < 60%", under ? "color:#5b6f94" : "", "under", "показать →") +
    cardHtml("Риск выгорания", risk, `2 и более признаков · ещё ${warnN} «внимание»`, risk ? `color:${MOCK_EM}` : "", "risk", "показать →") +
    cardHtml("Узкие места", gapNames.length, `подсистемы с покрытием ≤ 2 чел. · ключевых людей: ${keyPeopleN}`, gapNames.length ? `color:${MOCK_EM}` : "", "key", "показать ключевых →");

  const filt = SFILTERS[sFilterKey];
  $("#sFbar").innerHTML = sFilterKey === "all" ? "" : `<div class="fbar">Фильтр: <b>${filt.name}</b> — ${rows.filter((s) => filt.test(s, gapNames)).length} из ${rows.length}<button type="button" data-f="all">Показать всех</button></div>`;
  $("#sLegend").innerHTML = `<span>Загрузка = факт / норма часов:</span><span><i class="sw" style="background:#cfd8e8"></i>&lt;60% недогружен</span><span><i class="sw" style="background:${MOCK_TO}"></i>60–100%</span><span><i class="sw" style="background:#e0a81c"></i>100–115%</span><span><i class="sw" style="background:${MOCK_EM}"></i>&gt;115% перегруз</span><span style="margin-left:12px">Профиль: <i class="sw" style="background:${MOCK_EM}"></i>аварийные <i class="sw" style="background:${MOCK_PL}"></i>плановые <i class="sw" style="background:${MOCK_TO}"></i>ТО</span>`;

  const shown = rows.filter((s) => SFILTERS[sFilterKey].test(s, gapNames)).sort((a, b) => ({ r: 0, y: 1, g: 2 }[a.risk] - { r: 0, y: 1, g: 2 }[b.risk]) || (b.load ?? 0) - (a.load ?? 0));
  const P = periods[currentPeriodKey];
  let h = `<thead><tr><th rowspan="2">Сотрудник</th><th class="grp" colspan="2">Загруженность</th><th class="grp">Риск выгорания</th><th class="grp">Эффективность</th><th class="grp" colspan="3">Предпочтения и универсальность</th></tr>
    <tr><th title="Клетка — месяц, цвет — загрузка к норме. Клик по клетке — журнал с работами сотрудника за этот месяц.">${P.name}</th><th>Итого</th><th>Статус и признаки</th><th>Повторные отказы</th>
    <th title="Доля часов по типам работ: аварийные / плановые / ТО. Клик по сегменту или подписи — журнал только с этим типом работ.">Профиль работ</th>
    <th title="Две подсистемы с наибольшей долей часов (без ТО). Клик — журнал по этой подсистеме.">Основные подсистемы</th>
    <th title="Сколько подсистем занимают ≥10% часов сотрудника (без ТО): ≥4 — универсал, 2–3 — смешанный, 1 — узкий специалист. Наведите на метку, чтобы увидеть распределение.">Универсальность</th></tr></thead><tbody>`;
  for (const s of shown) {
    const orders = filterRows(orderRows, f).filter((o) => o.staff_id === s.staffId);
    const strip = s.stripMonths.map((sm) => {
      if (!sm.hasData) return `<i style="background:#f1eee9" title="${MONTHS_RU_SHORT[sm.m - 1]} ${sm.y}: работ не было"></i>`;
      const col = sm.load == null ? "#cfd8e8" : sm.load < THRESH.loadUnder ? "#cfd8e8" : sm.load <= THRESH.loadHigh ? MOCK_TO : sm.load <= THRESH.loadOver ? "#e0a81c" : MOCK_EM;
      const ids = orders.filter((o) => o.start_day <= new Date(Date.UTC(sm.y, sm.m, 0)).toISOString().slice(0, 10) && o.end_day >= new Date(Date.UTC(sm.y, sm.m - 1, 1)).toISOString().slice(0, 10)).map((o) => o.order_id);
      return drillLink(ids, `${MONTHS_RU_SHORT[sm.m - 1]} ${sm.y}: ${fN(sm.hours, 1)} ч, загрузка ${sm.load != null ? pct(sm.load) : "—"}`, "", `background:${col}`);
    }).join("");
    const rb = { r: `<span class="badge b-r">риск</span>`, y: `<span class="badge b-y">внимание</span>`, g: `<span class="badge b-g">норма</span>` }[s.risk];
    const medRepG = MED_REP ?? 0;
    const rpC = s.rep == null ? "b-n" : s.rep <= medRepG ? "b-g" : s.rep <= medRepG * THRESH.repYellowMult ? "b-y" : "b-r";
    const distTip = s.shares.map(([n, v]) => `${v >= THRESH.subShareMin ? "● " : "   "}${n}: ${pct(v)}`).join("\n");
    const unTip = `Универсальность — сколько подсистем занимают у сотрудника ≥10% часов (без ТО).\n≥4 — универсал · 2–3 — смешанный · 1 — узкий специалист.\n\nРаспределение часов ${s.famaly}:\n${distTip}`;
    const top2 = s.shares.slice(0, 2);
    const allOrderIds = orders.map((o) => o.order_id);
    h += `<tr><td>${drillLink(allOrderIds, `Исполнитель: ${s.famaly} · все наряды за период`, `<b>${esc(s.famaly)}</b>`)}<div class="small">${esc(s.pos || "—")} · ${fN(s.orders)} нарядов</div><div class="small" title="График из справочника «Персонал». Признаки выгорания считаются относительно него; если не задан — по общим порогам (12 дней подряд, смены > 12 ч).">${s.schedule ? esc(s.schedule) : "график не задан"}</div></td>
      <td><div class="strip">${strip}</div></td>
      <td class="pct" style="color:${s.load != null && s.load > THRESH.loadOver ? MOCK_EM : s.load != null && s.load < THRESH.loadUnder ? "#5b6f94" : "inherit"}">${s.load != null ? pct(s.load) : "—"}<div class="small" style="font-weight:normal">${fN(s.hours)} ч</div></td>
      <td>${rb}${s.flags.length ? `<div class="why">${s.flags.join("<br>")}</div>` : ""}</td>
      <td><span class="badge ${rpC}">${s.rep != null ? pct(s.rep) : "мало данных"}</span>${s.rep != null ? `<div class="small">медиана ${pct(MED_REP)}</div>` : ""}</td>
      <td><div class="prof">${[["em", s.emShare, MOCK_EM], ["pl", s.plShare, MOCK_PL], ["to", s.toShare, MOCK_TO]].map(([t, v, c]) => {
        const ids = orders.filter((o) => (t === "em" ? o.work_type === EM : t === "pl" ? o.work_type === PL : o.work_type === TO)).map((o) => o.order_id);
        return drillLink(ids, `${s.famaly} · ${t === "em" ? EM : t === "pl" ? PL : TO} (${pct(v)} часов)`, "", `width:${v * 100}%;background:${c}`);
      }).join("")}</div>
        <div class="small">${["em", "pl", "to"].map((t) => {
          const label = t === "em" ? "авар." : t === "pl" ? "план." : "ТО";
          const share = t === "em" ? s.emShare : t === "pl" ? s.plShare : s.toShare;
          const ids = orders.filter((o) => (t === "em" ? o.work_type === EM : t === "pl" ? o.work_type === PL : o.work_type === TO)).map((o) => o.order_id);
          return drillLink(ids, `${s.famaly} · ${t === "em" ? EM : t === "pl" ? PL : TO}`, `${label} ${pct(share)}`);
        }).join(" · ")}</div></td>
      <td>${top2.map(([name, v]) => {
        const ids = orders.filter((o) => o.subsystem === name).map((o) => o.order_id);
        return drillLink(ids, `${s.famaly} · подсистема «${name}» (${pct(v)} часов)`, `${esc(name)} <span class="small">${pct(v)}</span>`);
      }).join("<br>") || "—"}</td>
      <td><span class="badge ${s.univN >= THRESH.universalMin ? "b-g" : s.univN <= THRESH.narrowMax ? "b-y" : "b-n"}" title="${esc(unTip)}">${s.univ}</span><div class="small">${s.univN} подсист. ≥10%</div></td></tr>`;
  }
  $("#sTbl").innerHTML = h + "</tbody>";
  renderSkillMatrix(rows, f, gapNames);
}

function renderSkillMatrix(rows, f, gapNames) {
  const subs = new Set();
  for (const s of rows) for (const n of s.subH.keys()) subs.add(n);
  const sortedSubs = [...subs].sort((a, b) => {
    const ta = rows.reduce((s, r) => s + (r.subH.get(a) || 0), 0), tb = rows.reduce((s, r) => s + (r.subH.get(b) || 0), 0);
    return tb - ta;
  });
  const mx = Math.max(1, ...rows.flatMap((s) => [...s.subH.values()]));
  const covThresh = coverageHoursThreshold();
  const ctrSubTotals = new Map();
  for (const s of filterRows(subRows, f)) {
    if (s.staff_type !== "contractor" || s.work_type === TO) continue;
    ctrSubTotals.set(s.subsystem, (ctrSubTotals.get(s.subsystem) || 0) + Number(s.hours));
  }
  let m = `<table><tr><th></th>${rows.map((s) => `<th class="v ${sFilterKey !== "all" && SFILTERS[sFilterKey].test(s, gapNames) ? "sel" : ""}">${esc(s.famaly)}</th>`).join("")}<th class="v" style="color:#8a5a20">Подрядчики, ч</th><th>Покрытие штатом</th></tr>`;
  for (const sb of sortedSubs) {
    const cov = rows.filter((s) => (s.subH.get(sb) || 0) >= covThresh).length;
    const ch = ctrSubTotals.get(sb) || 0;
    m += `<tr class="${cov <= THRESH.coverageRed ? "gap" : ""}"><td class="l">${esc(sb)}${cov <= THRESH.coverageRed ? " ⚠" : ""}</td>`;
    for (const s of rows) {
      const v = s.subH.get(sb) || 0;
      const a = v < covThresh ? 0.06 : 0.15 + 0.8 * (v / mx);
      const orders = filterRows(orderRows, f).filter((o) => o.staff_id === s.staffId && o.subsystem === sb).map((o) => o.order_id);
      const params = orders.length ? new URLSearchParams({ wo: [...new Set(orders)].join(","), src: `${s.famaly} · ${sb}` }) : null;
      m += `<td class="c" style="background:rgba(122,74,30,${a.toFixed(2)});color:${a > 0.55 ? "#fff" : "#333"}" title="${esc(s.famaly)} · ${esc(sb)}: ${fN(v)} ч${orders.length ? "\nОткрыть журнал →" : ""}" ${params ? `data-href="repair-details.html?${params.toString()}"` : ""}>${v >= 100 ? fN(v / 100, 0) : ""}</td>`;
    }
    m += `<td class="c" style="background:rgba(176,122,60,${ch ? (0.15 + 0.6 * Math.min(1, ch / 1500)).toFixed(2) : 0})" title="Подрядчики · ${esc(sb)}: ${fN(ch)} ч">${ch ? fN(ch) : ""}</td>`;
    m += `<td class="cov"><span class="badge ${cov <= THRESH.coverageRed ? "b-r" : cov <= THRESH.coverageYellow ? "b-y" : "b-g"}">${cov} чел.</span></td></tr>`;
  }
  $("#skill").innerHTML = m + "</table><p class=\"note\">Цифра в клетке — сотни часов.</p>";
}

// ---------- рендер: подрядчики ----------
let cFilterKey = "all";
function renderCtr() {
  const f = currentFilters();
  const cRows = filterRows(monthRows, f).filter((r) => r.staff_type === "contractor");
  const byOrg = new Map();
  for (const r of cRows) {
    if (!byOrg.has(r.organization)) byOrg.set(r.organization, []);
    byOrg.get(r.organization).push(r);
  }
  const orgOrders = new Map();
  for (const o of filterRows(orderRows, f).filter((o) => o.staff_type === "contractor")) {
    if (!orgOrders.has(o.organization)) orgOrders.set(o.organization, []);
    orgOrders.get(o.organization).push(o);
  }
  const staffOrders = filterRows(orderRows, f).filter((o) => o.staff_type === "staff");
  const staffByType = new Map();
  for (const o of staffOrders) {
    if (!staffByType.has(o.work_type)) staffByType.set(o.work_type, new Map());
    const m = staffByType.get(o.work_type);
    m.set(o.order_id, o.hours + (m.get(o.order_id) || 0));
  }
  const STAFF_HPO = staffOrders.length ? staffOrders.reduce((a, o) => a + o.hours, 0) / new Set(staffOrders.map((o) => o.order_id)).size : null;
  const emOrdersStaff = staffOrders.filter((o) => o.work_type === EM);
  const uniqEmStaff = [...new Map(emOrdersStaff.map((o) => [o.order_id, o])).values()];
  const MED_REP = uniqEmStaff.length ? uniqEmStaff.filter((o) => o.is_repeat).length / uniqEmStaff.length : null;

  const staffInfo = [...staffMap.values()].filter((v) => v.staff_type === "contractor");
  const orgs = [...byOrg.keys()].map((org) => {
    const months = byOrg.get(org);
    const hours = months.reduce((a, m) => a + Number(m.hours || 0), 0);
    const hoursEm = months.reduce((a, m) => a + Number(m.hours_em || 0), 0);
    const orders = orgOrders.get(org) || [];
    const uniqOrders = [...new Map(orders.map((o) => [o.order_id, o])).values()];
    const emOrders = uniqOrders.filter((o) => o.work_type === EM);
    const rep = emOrders.length ? emOrders.filter((o) => o.is_repeat).length / emOrders.length : null;
    const hpo = uniqOrders.length ? hours / uniqOrders.length : null;
    const info = staffInfo.find((s) => s.organization === org) || {};
    const rate = info.rate_per_hour ? Number(info.rate_per_hour) : null;
    const subsSet = new Set(uniqOrders.map((o) => o.subsystem).filter(Boolean));
    const monthKeys = [...new Set(months.map((m) => m.month))].sort();
    return { org, hours, hoursEm, orders: uniqOrders, uniqOrdersN: uniqOrders.length, rep, hpo, rate, cost: rate ? hours * rate : null, subs: [...subsSet], lastMonth: monthKeys[monthKeys.length - 1], months };
  });

  const totCtr = orgs.reduce((a, o) => a + o.hours, 0);
  const totStaff = staffOrders.reduce((a, o) => a + o.hours, 0);
  const cost = orgs.reduce((a, o) => a + (o.cost || 0), 0);
  const emH = orgs.reduce((a, o) => a + o.hoursEm, 0);
  const worse = orgs.filter((o) => o.hpo != null && STAFF_HPO && (o.hpo > STAFF_HPO * THRESH.ctrHpoRedMult || (o.rep != null && MED_REP != null && o.rep > MED_REP * THRESH.repYellowMult))).length;
  const emN = orgs.filter((o) => o.hours && o.hoursEm / o.hours >= 0.5).length;
  const P = periods[currentPeriodKey];
  const monthsN = monthsInPeriod(P).length;
  const avgNorm = [...staffMap.values()].filter((s) => s.staff_type === "staff" && s.norm_hours_month).reduce((a, s, _, arr) => a + Number(s.norm_hours_month) / arr.length, 0);

  const CFILTERS = {
    all: { name: "Все подрядчики", test: () => true },
    em: { name: `${EM} ≥50% часов`, test: (o) => o.hours && o.hoursEm / o.hours >= 0.5 },
    worse: { name: "Хуже штата: часов на наряд > штат × 1,5 или повторов > медиана × 1,6", test: (o) => (o.hpo != null && STAFF_HPO && o.hpo > STAFF_HPO * THRESH.ctrHpoRedMult) || (o.rep != null && MED_REP != null && o.rep > MED_REP * THRESH.repYellowMult) },
  };
  $("#cCards").innerHTML =
    cardHtml("Подрядчиков", orgs.length, "работали за период", "", "all", "показать всех") +
    cardHtml("Часы подрядчиков", fN(totCtr), `${pct(totCtr / (totCtr + totStaff || 1))} всех часов`) +
    cardHtml("Стоимость", money(cost), cost && totCtr ? `средняя ставка ${fN(cost / totCtr)} за час` : "ставки не заданы") +
    cardHtml(EM, totCtr ? pct(emH / totCtr) : "—", `доля в часах · у ${emN} подрядчиков ≥50%`, "", "em", "показать →") +
    cardHtml("Хуже штата", worse, "дольше на наряд или больше повторов", worse ? `color:${MOCK_EM}` : "", "worse", "показать →") +
    cardHtml("Эквивалент штата", avgNorm ? fN(totCtr / (avgNorm * monthsN), 1) + " чел." : "—", avgNorm ? `при норме ${Math.round(avgNorm)} ч/мес` : "—");

  $("#cFbar").innerHTML = cFilterKey === "all" ? "" : `<div class="fbar">Фильтр: <b>${CFILTERS[cFilterKey].name}</b> — ${orgs.filter(CFILTERS[cFilterKey].test).length} из ${orgs.length}<button type="button" data-f="all">Показать всех</button></div>`;

  renderCtrChart(f);
  renderCtrSubShare(f);

  const shownC = cFilterKey === "all" ? orgs : orgs.filter(CFILTERS[cFilterKey].test);
  let h = `<thead><tr><th>Организация</th><th title="Клетка — месяц, насыщенность — часы подрядчика. Клик — журнал работ подрядчика за месяц.">${P.name}</th><th>Часы</th><th>Нарядов</th><th>Ставка</th><th>Стоимость</th><th title="Доля часов по типам работ. Клик по сегменту или подписи — журнал только с этим типом работ.">Профиль работ</th><th title="Подсистемы, по которым работал подрядчик. Клик — журнал по подсистеме.">Подсистемы</th><th title="Средние часы на один наряд. Сравнение со штатом на тех же типах работ: зелёный ≤ штат × 1,15, жёлтый ≤ × 1,5, красный — больше.">Часов на наряд</th><th title="Доля аварийных нарядов подрядчика, после которых тот же узел той же машины отказал снова в течение 14 дней. Сравнение с медианой штата.">Повторные отказы</th><th>Последняя работа</th></tr></thead><tbody>`;
  const mxMonth = Math.max(1, ...orgs.flatMap((o) => o.months.map((m) => Number(m.hours))));
  for (const o of shownC.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0))) {
    const strip = monthsInPeriod(P).map(({ y, m }) => {
      const key = monthKeyStr(new Date(Date.UTC(y, m - 1, 1)));
      const row = o.months.find((mm) => mm.month === key);
      if (!row || !row.hours) return `<i style="background:#f1eee9" title="${MONTHS_RU_SHORT[m - 1]} ${y}: работ не было"></i>`;
      const bg = `rgba(176,122,60,${(0.2 + 0.8 * (row.hours / mxMonth)).toFixed(2)})`;
      const ids = o.orders.filter((ord) => ord.start_day <= new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) && ord.end_day >= new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10)).map((ord) => ord.order_id);
      return drillLink(ids, `${MONTHS_RU_SHORT[m - 1]} ${y}: ${fN(row.hours)} ч — все работы месяца`, "", `background:${bg}`);
    }).join("");
    const hC = o.hpo == null || !STAFF_HPO ? "b-n" : o.hpo <= STAFF_HPO * THRESH.ctrHpoYellowMult ? "b-g" : o.hpo <= STAFF_HPO * THRESH.ctrHpoRedMult ? "b-y" : "b-r";
    const rC = o.rep == null || MED_REP == null ? "b-n" : o.rep <= MED_REP ? "b-g" : o.rep <= MED_REP * THRESH.repYellowMult ? "b-y" : "b-r";
    const allIds = o.orders.map((ord) => ord.order_id);
    h += `<tr><td>${drillLink(allIds, `Подрядчик: ${o.org} · все наряды за период`, `<b>${esc(o.org)}</b>`)}</td><td><div class="strip">${strip}</div></td><td>${fN(o.hours)}</td><td>${fN(o.uniqOrdersN)}</td><td>${o.rate ? fN(o.rate) : "—"}</td><td><b>${money(o.cost)}</b></td>
      <td><div class="prof">${[["em", o.hours ? o.hoursEm / o.hours : 0, MOCK_EM], ["pl", o.hours ? 1 - o.hoursEm / o.hours : 0, MOCK_PL]].map(([t, v, c]) => {
        const ids = o.orders.filter((ord) => (t === "em" ? ord.work_type === EM : ord.work_type !== EM)).map((ord) => ord.order_id);
        return drillLink(ids, `${o.org} · ${t === "em" ? EM : "прочие работы"} (${pct(v)} часов)`, "", `width:${v * 100}%;background:${c}`);
      }).join("")}</div>
        <div class="small">${drillLink(o.orders.filter((ord) => ord.work_type === EM).map((ord) => ord.order_id), `${o.org} · ${EM}`, `авар. ${pct(o.hours ? o.hoursEm / o.hours : 0)}`)} · ${drillLink(o.orders.filter((ord) => ord.work_type !== EM).map((ord) => ord.order_id), `${o.org} · прочие`, `план. ${pct(o.hours ? 1 - o.hoursEm / o.hours : 0)}`)}</div></td>
      <td>${o.subs.map((sb) => drillLink(o.orders.filter((ord) => ord.subsystem === sb).map((ord) => ord.order_id), `${o.org} · подсистема «${sb}»`, esc(sb))).join("<br>") || "—"}</td>
      <td><span class="badge ${hC}">${o.hpo != null ? fN(o.hpo, 1) : "—"}</span>${STAFF_HPO ? `<div class="small">штат ${fN(STAFF_HPO, 1)}</div>` : ""}</td>
      <td><span class="badge ${rC}">${o.rep != null ? pct(o.rep) : "мало данных"}</span>${MED_REP != null ? `<div class="small">штат ${pct(MED_REP)}</div>` : ""}</td>
      <td>${o.lastMonth ? MONTHS_RU_SHORT[new Date(o.lastMonth).getUTCMonth()] + " " + new Date(o.lastMonth).getUTCFullYear() : "—"}</td></tr>`;
  }
  $("#cTbl").innerHTML = h + "</tbody>";
}

function renderCtrChart(f) {
  const P = periods[currentPeriodKey];
  const months = monthsInPeriod(P);
  const staffByMonth = new Map(), ctrByMonth = new Map();
  for (const r of filterRows(monthRows, f)) {
    const target = r.staff_type === "contractor" ? ctrByMonth : r.staff_type === "staff" ? staffByMonth : null;
    if (!target) continue;
    target.set(r.month, (target.get(r.month) || 0) + Number(r.hours));
  }
  const st = months.map(({ y, m }) => staffByMonth.get(monthKeyStr(new Date(Date.UTC(y, m - 1, 1)))) || 0);
  const ct = months.map(({ y, m }) => ctrByMonth.get(monthKeyStr(new Date(Date.UTC(y, m - 1, 1)))) || 0);
  const W = 640, H = 230, L = 46, T = 16, B = 26, pw = W - L - 12, ph = H - T - B, bw = pw / Math.max(1, months.length);
  const max = Math.max(1, ...st.map((v, k) => v + ct[k])) * 1.12;
  const Y = (v) => T + ph - (v / max) * ph;
  let s = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    s += `<line x1="${L}" x2="${W - 12}" y1="${Y(v)}" y2="${Y(v)}" stroke="#eee"/><text x="${L - 6}" y="${Y(v) + 3}" text-anchor="end">${fN(v)}</text>`;
  }
  months.forEach(({ y, m }, k) => {
    const x = L + bw * k + bw * 0.18, w = bw * 0.64;
    const tot = st[k] + ct[k];
    s += `<g><title>${MONTHS_RU_SHORT[m - 1]} ${y}: штат ${fN(st[k])} ч, подрядчики ${fN(ct[k])} ч</title><rect x="${x}" y="${Y(st[k])}" width="${w}" height="${Y(0) - Y(st[k])}" fill="${MOCK_STAFF}"/><rect x="${x}" y="${Y(tot)}" width="${w}" height="${Y(st[k]) - Y(tot)}" fill="${MOCK_CTR}"/></g>`;
    if (tot) s += `<text x="${x + w / 2}" y="${Y(tot) - 4}" text-anchor="middle" fill="#8a5a20">${pct(ct[k] / tot)}</text>`;
    s += `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${MONTHS_RU_SHORT[m - 1]}</text>`;
  });
  $("#cChart").innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}">${s}</svg>`;
}

function renderCtrSubShare(f) {
  const ctr = new Map(), staff = new Map();
  for (const r of filterRows(subRows, f)) {
    if (r.work_type === TO) continue;
    const target = r.staff_type === "contractor" ? ctr : r.staff_type === "staff" ? staff : null;
    if (!target) continue;
    target.set(r.subsystem, (target.get(r.subsystem) || 0) + Number(r.hours));
  }
  const subs = new Set([...ctr.keys(), ...staff.keys()]);
  const rows = [...subs].map((sb) => {
    const c = ctr.get(sb) || 0, s = staff.get(sb) || 0;
    const staffCov = new Set(filterRows(orderRows, f).filter((o) => o.staff_type === "staff" && o.subsystem === sb).map((o) => o.staff_id)).size;
    return { sb, c, s, sh: c + s ? c / (c + s) : 0, staffCov };
  }).sort((a, b) => b.sh - a.sh);
  $("#cSub").innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12.5px">${rows.map((r) => `<tr><td style="padding:4px 0;width:160px">${esc(r.sb)}</td><td><div style="display:flex;height:12px;border-radius:3px;overflow:hidden;background:#eee" title="подрядчики ${fN(r.c)} ч · штат ${fN(r.s)} ч"><i style="display:block;width:${r.sh * 100}%;background:${MOCK_CTR}"></i><i style="display:block;width:${(1 - r.sh) * 100}%;background:${MOCK_STAFF}"></i></div></td><td style="width:60px;text-align:right;font-weight:600">${pct(r.sh)}</td><td style="width:100px;text-align:right"><span class="badge ${r.staffCov <= THRESH.coverageRed ? "b-r" : r.staffCov <= THRESH.coverageYellow ? "b-y" : "b-g"}">штат ${r.staffCov} чел.</span></td></tr>`).join("")}</table>`;
}

// ---------- баннер качества данных ----------
async function renderDataQualityBanner() {
  // Итоги считаются в БД (staff_page_data -> quality): всего часов по журналу за период
  // и часов по нарядам без исполнителя в v_order_staff — та же логика, что раньше
  // считалась здесь по выгруженному целиком журналу.
  const totalHours = Number(periodQuality.total_hours) || 0;
  const unattrHours = Number(periodQuality.unattr_hours) || 0;
  const unattrPct = totalHours ? Math.round((unattrHours / totalHours) * 100) : 0;

  const overCalendar = monthRows.filter((r) => {
    const days = new Date(Date.UTC(new Date(r.month).getUTCFullYear(), new Date(r.month).getUTCMonth() + 1, 0)).getUTCDate();
    return Number(r.hours) > days * 24;
  }).length;

  const el = $("#dataWarning");
  if (unattrPct > 0 || overCalendar > 0) {
    el.hidden = false;
    el.textContent = `⚠ Качество данных: ${unattrPct}% часов в журнале без привязки к исполнителю, ${overCalendar} сотрудник-месяцев с часами больше календарного фонда. Показатели по людям считаются только по привязанным и корректным часам.`;
  } else {
    el.hidden = true;
  }
  // Критерий §7.1: сотрудник-месяцы с нарушением календарного фонда не входят в расчёты.
  monthRows = monthRows.filter((r) => {
    const days = new Date(Date.UTC(new Date(r.month).getUTCFullYear(), new Date(r.month).getUTCMonth() + 1, 0)).getUTCDate();
    return Number(r.hours) <= days * 24 && Number(r.hours) >= 0;
  });
}

// ---------- общая перерисовка ----------
let periods = {};
async function recompute() {
  setLoading(true);
  clearError();
  try {
    const P = periods[currentPeriodKey];
    await loadPeriodData(P);
    await renderDataQualityBanner();
    populateSelect("#filterObject", objectsList);
    populateSelect("#filterMine", minesList);
    applyUrlFilters([["object", "#filterObject"], ["mine", "#filterMine"]]); // пришли по крошкам с другой формы
    renderStaff();
    renderCtr();
  } catch (e) {
    showError("Ошибка загрузки данных: " + e.message);
  } finally {
    setLoading(false);
  }
}

// ---------- экспорт ----------
function exportExcel() {
  const f = currentFilters();
  const { rows } = buildStaffAgg(f);
  const wsData = rows.map((s) => ({
    ФИО: s.famaly, Должность: s.pos, Нарядов: s.orders, "Загрузка, %": s.load != null ? Math.round(s.load * 100) : "",
    "Часы за период": Number(s.hours.toFixed(1)), График: s.schedule || "не задан", Риск: { r: "риск", y: "внимание", g: "норма" }[s.risk], Признаки: s.flags.join("; "),
    "Повторные отказы, %": s.rep != null ? Math.round(s.rep * 100) : "",
    "Аварийные, %": Math.round(s.emShare * 100), "Плановые, %": Math.round(s.plShare * 100), "ТО, %": Math.round(s.toShare * 100), Универсальность: s.univ,
  }));
  const ws = XLSX.utils.json_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Персонал");
  XLSX.writeFile(wb, `staff_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// ---------- события ----------
let dashboardStarted = false;
function initDashboard() {
  if (dashboardStarted) return;
  dashboardStarted = true;

  document.addEventListener("click", (e) => {
    // Ссылки <a class="jl" href="..."> (drillLink) переходят сами, без JS. Ячейки
    // матрицы компетенций — обычные <td data-href="...">, не <a> (иначе имя сотрудника
    // в шапке вертикальной колонки визуально сливалось бы со ссылкой) — для них клик
    // обрабатываем вручную.
    const cell = e.target.closest("td[data-href]");
    if (cell) {
      window.location.href = cell.dataset.href;
      return;
    }
    const f = e.target.closest("[data-f]");
    if (f) {
      const inStaff = f.closest("#staffTab");
      if (inStaff) { sFilterKey = sFilterKey === f.dataset.f ? "all" : f.dataset.f; renderStaff(); }
      else { cFilterKey = cFilterKey === f.dataset.f ? "all" : f.dataset.f; renderCtr(); }
      return;
    }
  });

  $("#staffTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-t]");
    if (!b) return;
    document.querySelectorAll("#staffTabs button").forEach((x) => x.classList.toggle("on", x === b));
    $("#staffTab").hidden = b.dataset.t !== "staff";
    $("#ctrTab").hidden = b.dataset.t !== "ctr";
  });

  $("#filterObject").addEventListener("change", () => onFilterChanged(recompute));
  $("#filterMine").addEventListener("change", () => onFilterChanged(recompute));
  $("#resetFilters").addEventListener("click", () => {
    $("#filterObject").value = "";
    $("#filterMine").value = "";
    recompute();
  });
  setupFilterToggle(recompute);
  // Стрелки ▲/▼ — к началу и концу таблицы открытой вкладки (штат или подрядчики).
  enableScrollButtons(() => ($("#ctrTab").hidden ? $("#sTbl") : $("#cTbl")));
  enableStickyTableWrap($("#sTbl").parentElement);
  enableStickyTableWrap($("#cTbl").parentElement);
  $("#exportExcel")?.addEventListener("click", exportExcel);
  $("#exportPdf")?.addEventListener("click", () => window.print());
  // Крошки: год (кроме «12 мес» — он по умолчанию), объект и шахта переходят на связанные формы.
  initCrumbs($("#crumbs"), STAFF_PAGES, "staff-details.html", {
    year: () => (currentPeriodKey !== "r12" ? currentPeriodKey : ""),
    object: () => $("#filterObject").value,
    mine: () => $("#filterMine").value,
  });

  (async () => {
    setLoading(true);
    // Справочник сотрудников и список лет не зависят друг от друга — одновременно.
    const [, { data: yearsData }] = await Promise.all([loadStaffMap(), supabase.from("v_staff_years").select("*")]);
    const years = (yearsData || []).map((r) => r.year ?? r.reporting_year ?? Object.values(r)[0]).filter(Boolean);
    periods = computePeriods(years.length ? years : [new Date().getUTCFullYear()]);
    if (periods[urlParam("year")]) currentPeriodKey = urlParam("year");
    renderPeriodToggle(periods);
    await recompute();
  })();
}

setupAuth(supabase, "staff-details.html", () =>
  loadDictNames(supabase).then(() => { EM = DN.em; PL = DN.pl; TO = DN.to; initDashboard(); })
);
