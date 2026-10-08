import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { setupAuth } from "./auth.js?v=36";
import { DN, loadDictNames } from "./dict-names.js?v=1";
import { populateSelect } from "./filters.js?v=1";
import { enableTapToExpandCells, enableScrollButtons } from "./ui.js?v=4";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MN_FULL = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MN_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

// Точная палитра из repair-log-mockup.html / fleet-status-mockup.html / availability-mockup.html.
const MOCK_EM = "#d23a2f", MOCK_PL = "#3a5bd9", MOCK_TO = "#2e9d4f";
const TYPE_COLOR = { em: MOCK_EM, pl: MOCK_PL, to: MOCK_TO };
const TYPE_LABEL = { em: "Аварийный", pl: "Плановый", to: "ТО" };
// Названия типов берутся из справочника по ключу (dict-names.js) перед запуском страницы.
let EMERGENCY_TYPE = DN.em;
let MAINTENANCE_TYPE = DN.to;
function typeKey(raw) {
  if (raw === EMERGENCY_TYPE) return "em";
  if (raw === MAINTENANCE_TYPE) return "to";
  return "pl";
}

// В исходных данных одно и то же значение встречается в разных языках/с разными пробелами
// (двойные пробелы из выгрузки Access, отдельные английские остатки) — нормализуем при
// отображении, не дожидаясь чистки самих справочников в базе.
const REASON_ALIASES = { "Normal wear": "Нормальный износ", PM: "Регламент (ТО)" };
const SUBSYSTEM_ALIASES = { Maintenance: "ТО", PM50: "ТО" };
function cleanText(raw, aliases) {
  if (!raw) return raw;
  const t = raw.replace(/\s+/g, " ").trim();
  return aliases[t] || t;
}
// Access-выгрузка использует "__", ".", "---" и т.п. как заглушку "нечего писать" вместо
// NULL — такой комментарий формально не пуст, но по факту не несёт информации: не должен
// ни выводиться как текст дня, ни делать пустой день "значимым" в разбивке по дням.
// Тексты из базы (комментарии, подсистемы, запчасти, ФИО) вставляются в HTML — экранируем,
// иначе введённая в форме ремонта разметка выполнится в браузере того, кто открыл журнал.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Стоимость запчасти считается только по цене шахты машины за год наряда (см. remonty.part_cost) — если цены
// этой шахты за этот год в прайсе нет, cost пустой, и вместо суммы показываем «нет цены» (год виден по дате наряда).
const NO_PRICE = '<span style="color:#999" title="В ценовом справочнике нет цены этой запчасти для шахты машины на год наряда">нет цены</span>';
const partCost = (p) => (p.noPrice ? NO_PRICE : money(p.cost));
function isPlaceholderComment(text) {
  return !text || /^[-_.\s]*$/.test(text);
}

let equipmentList = [];
let eqByCod = new Map(); // cod -> v_equipment_full row (for .fs — TR / TR+DR1 / TR+DR1+DR2)
let detailRows = []; // строки v_repair_details для текущего фильтра оборудования, с разобранными датой/часами
let staffByWO = new Map(); // work_order -> [{famaly, hours}]
let staffByWODay = new Map(); // work_order -> Map(дата "YYYY-MM-DD" -> [{famaly, hours}]) — тот же
// исполнитель на многодневном наряде мог реально работать только 1-2 дня из полугода
// простоя (например, ждал доставки узла) — общая сумма часов это скрывает, разбивка по
// дням показывает точно, когда именно кто работал.
let smhByCod = new Map(); // cod -> [{t, dr1total, dr2total}] по возрастанию — заполняется только если
// машина реально отслеживает DR1/DR2 (fs), т.к. v_repair_details.omh уже даёт показание TR напрямую.
let omhByCod = new Map(); // cod -> [{t, omh}] по возрастанию, только omh>0 — резерв для нарядов с omh=0
let repeatByWO = new Map(); // work_order -> bool — из v_repeat_failures (repeat-failures-spec.md), не локальный расчёт
let originByWO = new Map(); // повторный work_order -> [work_order] исходной работы (алгоритм даёт не больше одной)
let repeatWindowByWO = new Map(); // повторный work_order -> "14 дней" / "250 ч наработки TR" и т.п., как настроено у машины
let repeatKindByWO = new Map(); // повторный work_order -> "after_pm" | "after_repair"
let months = []; // отсортированные [{y, m}], встречающиеся в detailRows, по возрастанию
let monthIndex = 0;
// По умолчанию грузим только последние WINDOW_MONTHS_DEFAULT месяцев вместо всей
// истории по фильтру оборудования сразу (было — до 24 тыс. строк при пустом фильтре
// "весь парк"). hasMoreHistory — есть ли в базе ещё более ранняя история за пределами
// текущего окна; при клике "Назад" на границе окна оно расширяется до Infinity
// (грузим всё) один раз — см. stepMonth().
const WINDOW_MONTHS_DEFAULT = 12;
let windowMonthsBack = WINDOW_MONTHS_DEFAULT;
let hasMoreHistory = false;
let typeF = "all";
let openOnly = false;
let initiatorF = null; // "Рудник" | "Sервис" | null
let repeatOnly = false; // включается кликом по карточке "Повторные отказы"
let staffFilter = null; // имя исполнителя | null — включается кликом по строке в "Исполнители"
let subsystemFilter = null; // название подсистемы | null — клик по строке в "Аварийный простой по подсистемам"
let partFilter = null; // название запчасти | null — клик по строке в "Запчасти за месяц"
let focusWO = null;
let dashboardStarted = false;

const $ = (sel) => document.querySelector(sel);

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

// ---------- фильтры ----------
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

let pendingUrlMonth = null; // {y, m}, запрошенный через URL, применяется как только известен `months`
let woFilter = null; // Set<number> | null — точные ID нарядов из ссылки "?wo=",
// переопределяет переключатель месяцев, чтобы число на экране точно совпадало с тем,
// из чего его посчитала исходная страница (например, β-тренд в fleet-status.js), а не
// с "подмножеством этого месяца".
let woSrc = null; // подпись столбца/метрики, откуда пришла ссылка "?wo=" (например,
// "Надёжность"), показывается вместо общей фразы "точный список".

function applyUrlFilters() {
  const params = new URLSearchParams(window.location.search);
  const mine = params.get("mine");
  const model = params.get("model");
  const code = params.get("code");
  const year = params.get("year");
  const month = params.get("month");
  const type = params.get("type");
  const initiator = params.get("initiator");
  const q = params.get("q");
  const src = params.get("src");
  const wo = params.get("wo");
  if (mine) $("#filterMine").value = mine;
  updateModelOptions();
  if (model) $("#filterModel").value = model;
  updateCodeOptions(true);
  if (code) $("#filterCode").value = code;
  if (year && month) pendingUrlMonth = { y: Number(year), m: Number(month) };
  if (type) typeF = typeKey(type);
  if (initiator) initiatorF = initiator;
  if (q) $("#q").value = q;
  if (wo) woFilter = new Set(wo.split(",").map(Number));
  if (src) woSrc = src;
}

// ---------- запоминание фильтров между перезагрузками ----------
// Все выбранные фильтры (шахта, модель, борт, месяц, тип, «только открытые», инициатор, повторы, исполнитель,
// подсистема, запчасть, поиск) сохраняются в браузере и возвращаются после обновления страницы.
// Ссылка с параметрами (?mine=…&wo=…) по-прежнему главнее сохранённого.
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
const STATE_KEY = "repair-details-state";
let stateReady = false;
function saveState() {
  if (stateReady) saveScope(); // то, что видно на экране, — и при открытии по ссылке с параметрами
  if (!stateReady || window.location.search.length > 1) return; // страницы по ссылке с параметрами сохранённое не перезаписывают
  try {
    const mo = months[monthIndex];
    localStorage.setItem(STATE_KEY, JSON.stringify({
      mine: $("#filterMine").value, model: $("#filterModel").value, code: $("#filterCode").value,
      y: mo?.y, m: mo?.m, typeF, openOnly, initiatorF, repeatOnly, staffFilter, subsystemFilter, partFilter, q: $("#q").value,
    }));
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
  if (st.y && st.m) pendingUrlMonth = { y: Number(st.y), m: Number(st.m) };
  typeF = st.typeF || "all";
  openOnly = !!st.openOnly;
  initiatorF = st.initiatorF || null;
  repeatOnly = !!st.repeatOnly;
  staffFilter = st.staffFilter || null;
  subsystemFilter = st.subsystemFilter || null;
  partFilter = st.partFilter || null;
  $("#q").value = st.q || "";
}

// ---------- загрузка данных ----------
// Пулер иногда отдаёт 500 при параллельной нагрузке — повторяем временные ошибки
// несколько раз, прежде чем сдаться, вместо того чтобы проваливать всю загрузку.
async function withRetry(run) {
  for (let attempt = 0; ; attempt++) {
    const res = await run();
    if (!res.error || attempt >= 2) return res;
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
}

async function fetchAllPages(buildQuery) {
  const PAGE_SIZE = 1000;
  // Первая страница и общий count — одним запросом (count приходит в заголовке
  // Content-Range), а не отдельным head-запросом перед выгрузкой: минус одно
  // последовательное ожидание, а для ≤1000 строк — вообще один запрос.
  const first = await withRetry(() => buildQuery({ count: "exact" }).range(0, PAGE_SIZE - 1));
  if (first.error) throw first.error;
  const firstData = first.data || [];
  const total = first.count ?? firstData.length;
  const pageCount = Math.ceil(total / PAGE_SIZE);
  if (pageCount <= 1) return firstData;
  // Пул подключений увеличен пользователем с 15 до 48 (Dashboard, 2026-09-28), но
  // именно эта страница ещё делает несколько параллельных fetchAllPages-вызовов
  // одновременно (детали + подсчёт более ранней истории + повторы + SMH + персонал) —
  // на практике 8 воркеров здесь давали повторяющиеся 500 от pooler'а (замаскированные
  // retry, но раздувающие загрузку до ~20 c). 4 — эмпирически проверенный баланс.
  const CONCURRENCY = 4;
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
  eqByCod = new Map(equipmentList.map((e) => [e.cod, e]));
  populateSelectFresh("#filterMine", equipmentList.map((e) => e.mine).filter(Boolean).sort(), "");
  updateModelOptions();
  updateCodeOptions(false);
}

// "DD.MM.YY HH:MM-HH:MM" -> {date (UTC полночь), startH, endH}. Каждая строка
// v_repair_details — это уже один календарный день (возможно, многодневного) наряда,
// так что дополнительно дробить его здесь не нужно.
function parseWorkday(workday) {
  if (!workday) return null;
  const [datePart, timePart] = workday.split(" ");
  if (!datePart) return null;
  const [dd, mm, yy] = datePart.split(".").map(Number);
  if (!dd || !mm || !yy) return null;
  const year = yy < 100 ? 2000 + yy : yy;
  const date = new Date(Date.UTC(year, mm - 1, dd));
  let startH = 0, endH = 24;
  if (timePart) {
    const [a, b] = timePart.split("-");
    const toH = (t) => {
      const [h, mi] = t.split(":").map(Number);
      return h + (mi || 0) / 60;
    };
    if (a) startH = toH(a);
    if (b) endH = Math.max(startH, toH(b));
  }
  return { date, y: year, m: mm, startH, endH };
}

function eqFilter(q, f) {
  if (f.mine) q = q.eq("mine", f.mine);
  if (f.model) q = q.eq("model", f.model);
  if (f.code) q = q.eq("local_code", f.code);
  return q;
}

// v_staff_details больше, чем v_repair_details (~44 тыс. против ~24 тыс. строк), и нужен
// только для Трудозатрат/Исполнителей текущего месяца — загрузка его целиком при каждой
// смене фильтра оборудования (как для detailRows) давала ~46 постраничных запросов на
// одну только "холодную" загрузку всего парка. Ограничиваем текущим видимым месяцем,
// перезагружая только при реальной смене месяца.
async function loadStaffForMonth(f, mo) {
  staffByWO = new Map();
  staffByWODay = new Map();
  if (!mo) return;
  const staff = await fetchAllPages((selectOpts) =>
    eqFilter(supabase.from("v_staff_details").select("work_order,famaly,hours,work_date", selectOpts), f).eq("reporting_year", mo.y).eq("work_month", mo.m)
  );
  fillStaffByWO(staff);
}

// Та же идея, но для ссылки "точный список" (?wo=) — точный, возможно межмесячный
// набор нарядов, поэтому фильтр по году/месяцу здесь не применяется.
async function fetchStaffForWO(ids) {
  if (!ids.length) return [];
  return fetchAllPages((selectOpts) => supabase.from("v_staff_details").select("work_order,famaly,hours,work_date", selectOpts).in("work_order", ids));
}
function applyStaffRows(staff) {
  staffByWO = new Map();
  staffByWODay = new Map();
  fillStaffByWO(staff);
}

// Строки журнала за окно (или точный список нарядов) — одним ответом из функции БД
// repair_details_window (json-массив нужных странице колонок, порядок work_order,
// spare_index), вместо ~20 постраничных запросов к v_repair_details.
async function fetchRepairRows({ from = null, f = null, wo = null }) {
  const { data, error } = await withRetry(() =>
    supabase.rpc("repair_details_window", {
      p_from: from,
      p_mine: f?.mine || null,
      p_model: f?.model || null,
      p_code: f?.code || null,
      p_wo: wo,
    })
  );
  if (error) throw error;
  return data || [];
}

// Накопленные показания DR1/DR2 есть только в v_smh_history (13wza_details.omh — всегда
// показание TR) — загружаем их только для тех cod, которые реально отслеживают DR1/DR2
// по настройке .fs в карточке оборудования, чтобы для обычного TR-парка не было лишнего запроса.
async function fetchSmhRows(cods) {
  if (!cods.length) return [];
  return fetchAllPages((selectOpts) =>
    supabase.from("v_smh_history").select("cod,reading_date,dr1total,dr2total", selectOpts).in("cod", cods).order("reading_date").order("cod")
  );
}
function applySmhRows(rows) {
  smhByCod = new Map();
  for (const r of rows) {
    if (!smhByCod.has(r.cod)) smhByCod.set(r.cod, []);
    smhByCod.get(r.cod).push({ t: new Date(r.reading_date).getTime(), dr1total: r.dr1total, dr2total: r.dr2total });
  }
  for (const arr of smhByCod.values()) arr.sort((a, b) => a.t - b.t);
}
function valueAtOrBefore(series, t, key) {
  let val = null;
  for (const p of series) {
    if (p.t > t) break;
    if (p[key] != null) val = p[key];
  }
  return val;
}
// Тот же поиск, но дополнительно сообщает, взято ли показание ровно за запрошенный
// день (свежее) или за более ранний — нулевое/отсутствующее показание за этот день
// пропускается точно так же, как незаписанная наработка, и так же уходит в резерв со
// статусом "устаревшее".
function entryAtOrBefore(series, t, key) {
  let chosen = null;
  for (const p of series) {
    if (p.t > t) break;
    if (p[key] != null && p[key] !== 0) chosen = p;
  }
  if (!chosen) return null;
  return { value: chosen[key], stale: chosen.t !== t };
}

function fillStaffByWO(staff) {
  for (const s of staff) {
    if (!s.famaly || NO_STAFF_VALUES.includes(s.famaly)) continue;
    if (!staffByWO.has(s.work_order)) staffByWO.set(s.work_order, []);
    staffByWO.get(s.work_order).push(s);
    if (!staffByWODay.has(s.work_order)) staffByWODay.set(s.work_order, new Map());
    const dayMap = staffByWODay.get(s.work_order);
    if (!dayMap.has(s.work_date)) dayMap.set(s.work_date, []);
    dayMap.get(s.work_date).push(s);
  }
}

// Нижняя граница по умолчанию — последние WINDOW_MONTHS_DEFAULT (или больше, если
// windowMonthsBack уже расширен кнопкой "Назад", или если ссылка ведёт на месяц
// старше окна по умолчанию — окно расширяется, чтобы целевой месяц точно попал в
// загруженные данные). null — грузить без ограничения (после полного расширения).
function currentWindowFromStr() {
  if (windowMonthsBack === Infinity) return null;
  const today = new Date();
  let from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - windowMonthsBack + 1, 1));
  if (pendingUrlMonth) {
    const target = new Date(Date.UTC(pendingUrlMonth.y, pendingUrlMonth.m - 1, 1));
    if (target < from) from = target;
  }
  return from.toISOString().slice(0, 10);
}

// Удобочитаемый номер наряда (А-000123) — из функции БД wo_labels; ключом остаётся числовой номер.
const woLabel = new Map();
const lbl = (no) => woLabel.get(Number(no)) || no;
async function loadWoLabels(orders) {
  const need = [...new Set(orders.filter((o) => o != null && !woLabel.has(Number(o))).map(Number))];
  const chunks = [];
  for (let i = 0; i < need.length; i += 2000) chunks.push(need.slice(i, i + 2000));
  const res = await Promise.all(chunks.map((c) => supabase.rpc("wo_labels", { p_orders: c })));
  for (const { data, error } of res) {
    if (error) continue; // без номеров — показываем числовые
    for (const [k, v] of Object.entries(data || {})) woLabel.set(Number(k), v);
  }
}

function buildDetailRows(details) {
  return details
    .map((r) => {
      const p = parseWorkday(r.workday);
      if (!p) return null;
      return { ...r, _date: p.date, _y: p.y, _m: p.m, _startH: p.startH, _endH: p.endH };
    })
    .filter(Boolean);
}

async function loadData() {
  const myRequestId = ++loadRequestId;
  clearError();
  setLoading(true);
  try {
    const f = currentFilters();

    // Повторы и показания DR1/DR2 нужны по машинам из журнала — их набор заранее почти
    // всегда известен из фильтра оборудования, поэтому запускаем обе загрузки сразу,
    // параллельно с самим журналом, а не после него. Машины, которых нет в справочнике
    // фильтра (списанные, notrun), но чьи наряды попали в журнал, догружаются ниже.
    const selCods = selectedEquipment(f).map((e) => e.cod);
    const isDr = (cod) => {
      const fs = eqByCod.get(cod)?.fs;
      return fs === "DR1" || fs === "DR2";
    };
    const repeatsP = fetchRepeatPairs(selCods);
    const smhP = fetchSmhRows(selCods.filter(isDr));
    // Исполнители точного списка (?wo=) не зависят от журнала — тоже сразу (только
    // загрузка; применяются ниже, после проверки, что загрузка всё ещё актуальна).
    const staffWOP = woFilter ? fetchStaffForWO([...woFilter]) : null;
    // Если журнал упадёт раньше, эти промисы уже никто не дождётся — гасим "unhandled
    // rejection" (сама ошибка всё равно всплывёт через await ниже, если до него дойдёт).
    for (const p of [repeatsP, smhP, staffWOP]) p?.catch(() => {});

    if (woFilter) {
      // Точный список нарядов по ссылке (?wo=) не зависит от периода — сами наряды
      // могут лежать в любой точке истории, поэтому тянем только их, а не всю
      // историю по фильтру оборудования (и вообще без учёта окна по датам).
      const details = await fetchRepairRows({ wo: [...woFilter] });
      if (myRequestId !== loadRequestId) return;
      detailRows = buildDetailRows(details);
      hasMoreHistory = false;
    } else {
      const windowFromStr = currentWindowFromStr();
      const [details, older] = await Promise.all([
        fetchRepairRows({ from: windowFromStr, f }),
        // Есть ли история раньше окна — достаточно одной строки, а не count по всем
        // (count заставлял базу вычислить весь вид по всей старой истории).
        windowFromStr
          ? eqFilter(supabase.from("v_repair_details").select("cod"), f).lt("reporting_month", windowFromStr).limit(1)
          : Promise.resolve({ data: [] }),
      ]);
      if (myRequestId !== loadRequestId) return;
      detailRows = buildDetailRows(details);
      hasMoreHistory = !older.error && (older.data || []).length > 0;
    }

    await loadWoLabels(detailRows.map((r) => r.work_order));
    if (myRequestId !== loadRequestId) return;
    const detailCods = [...new Set(detailRows.map((r) => r.cod))];
    const selSet = new Set(selCods);
    const extraCods = detailCods.filter((cod) => !selSet.has(cod));
    const [pairs, extraPairs, smhRows, extraSmh] = await Promise.all([
      repeatsP,
      fetchRepeatPairs(extraCods),
      smhP,
      fetchSmhRows(extraCods.filter(isDr)),
    ]);
    if (myRequestId !== loadRequestId) return;
    applyRepeatPairs([...pairs, ...extraPairs]);

    // У некоторых свежих нарядов наработка (omh) ещё не введена и стоит голый 0 — вместо
    // ложного "0" берём последнее реально записанное показание машины, по каждому cod,
    // по возрастанию времени записи. Резерв строится только по уже загруженному окну
    // (см. windowMonthsBack) — для самых первых месяцев окна показание чуть раньше его
    // границы не учитывается (крайне редкий случай: наряд с omh=0 без более раннего
    // показания уже внутри окна).
    omhByCod = new Map();
    for (const r of detailRows) {
      if (!(Number(r.omh) > 0)) continue;
      if (!omhByCod.has(r.cod)) omhByCod.set(r.cod, []);
      omhByCod.get(r.cod).push({ t: r._date.getTime() + r._endH * 3.6e6, omh: Number(r.omh) });
    }
    for (const arr of omhByCod.values()) arr.sort((a, b) => a.t - b.t);

    applySmhRows([...smhRows, ...extraSmh]);

    const monthKey = (y, m) => y * 12 + m;
    const seen = new Map();
    for (const r of detailRows) seen.set(monthKey(r._y, r._m), { y: r._y, m: r._m });
    months = [...seen.values()].sort((a, b) => monthKey(a.y, a.m) - monthKey(b.y, b.m));

    if (pendingUrlMonth) {
      const idx = months.findIndex((mo) => mo.y === pendingUrlMonth.y && mo.m === pendingUrlMonth.m);
      monthIndex = idx >= 0 ? idx : months.length - 1;
    } else {
      monthIndex = Math.max(0, months.length - 1);
    }
    pendingUrlMonth = null;

    if (staffWOP) {
      const staff = await staffWOP;
      if (myRequestId !== loadRequestId) return;
      applyStaffRows(staff);
    } else await loadStaffForMonth(f, months[monthIndex]);
    if (myRequestId !== loadRequestId) return;
    await loadWoLabels([...originByWO.values()].flat());
    if (myRequestId !== loadRequestId) return;

    render();
  } catch (e) {
    if (myRequestId !== loadRequestId) return;
    showError("Ошибка загрузки данных: " + e.message);
  } finally {
    if (myRequestId === loadRequestId) setLoading(false);
  }
}
let loadRequestId = 0;
const NO_STAFF_VALUES = ["нет данных", "Нет данных"];

// Повторы больше не считаются на клиенте — единый алгоритм (окно по машине/FS из
// "Оборудование → Изменить", ТО или ремонт той же подсистемы) считается в БД одинаково
// для Журнала, Состояния парка и Персонала (repeat-failures-spec.md). Тянем результат
// по всем машинам текущего фильтра оборудования — как и раньше, по всей загруженной
// истории, т.к. исходная работа повтора может лежать в другом месяце.
async function fetchRepeatPairs(cods) {
  if (!cods.length) return [];
  return fetchAllPages((selectOpts) => supabase.from("v_repeat_failures").select("*", selectOpts).in("machine_id", cods).order("repeat_order_id").order("source_order_id"));
}
function applyRepeatPairs(pairs) {
  repeatByWO = new Map();
  originByWO = new Map();
  repeatWindowByWO = new Map();
  repeatKindByWO = new Map();
  for (const p of pairs) {
    repeatByWO.set(p.repeat_order_id, true);
    originByWO.set(p.repeat_order_id, [p.source_order_id]);
    repeatWindowByWO.set(p.repeat_order_id, p.window_used);
    repeatKindByWO.set(p.repeat_order_id, p.repeat_kind);
  }
}

// ---------- агрегация нарядов по месяцу ----------
const partOf = (r) => ({ name: r.spare_descr || "", sp: r.spare || "", idx: r.spare_index, qty: Number(r.spare_qty) || 0, cost: r.cost == null ? null : Number(r.cost) || 0, noPrice: r.cost == null });
function buildWorkOrders(rows) {
  const byWO = new Map();
  for (const r of rows) {
    if (!byWO.has(r.work_order)) byWO.set(r.work_order, []);
    byWO.get(r.work_order).push(r);
  }
  return [...byWO.entries()].map(([no, rs]) => {
    rs.sort((a, b) => a._date - b._date || a._startH - b._startH);
    const first = rs[0];
    // Не обязательно комментарий именно первого дня — если он окажется заглушкой
    // ("__", ".") — берём первый день, где реально что-то написано.
    const meaningfulComment = rs.map((r) => r.comment).find((c) => !isPlaceholderComment(c));
    // v_repair_details отдаёт по строке на каждую запчасть дня, и в каждой — простой всего
    // дня: при двух запчастях день повторяется дважды. Склеиваем строки одного дня
    // (workday) в один день с его запчастями, чтобы простой считался один раз на день.
    const dayMap = new Map();
    for (const r of rs) {
      if (!dayMap.has(r.workday)) dayMap.set(r.workday, { r, parts: [] });
      if (r.spare_descr || r.spare) dayMap.get(r.workday).parts.push(partOf(r));
    }
    const dayList = [...dayMap.values()];
    const hrs = dayList.reduce((s, d) => s + (Number(d.r.downtime_hours) || 0), 0);
    const cost = rs.reduce((s, r) => s + (Number(r.cost) || 0), 0);
    const parts = dayList.flatMap((d) => d.parts);
    const staff = staffByWO.get(no) || [];
    const staffByName = new Map();
    for (const s of staff) staffByName.set(s.famaly, (staffByName.get(s.famaly) || 0) + (Number(s.hours) || 0));
    const lastRow = rs[rs.length - 1];
    const endTime = lastRow._date.getTime() + lastRow._endH * 3.6e6;
    // Если наряд внесён раньше, чем записана его наработка, поле стоит голым 0 —
    // вместо ложного "0" берём последнее реально известное показание машины, но
    // помечаем это (бейдж в красном цвете "Аварийный"), чтобы было видно, что это
    // старые/перенесённые данные, а не свежее показание именно на момент этого наряда.
    const rawOmh = Number(lastRow.omh) > 0 ? Number(lastRow.omh) : null;
    const omhStale = rawOmh == null;
    const omh = rawOmh ?? valueAtOrBefore(omhByCod.get(first.cod) || [], endTime, "omh");
    // Сколько счётчиков отслеживает машина, задаётся один раз в карточке "Оборудование"
    // (.fs каскадом: TR -> TR+DR1 -> TR+DR1+DR2) — для машины только с TR (обычный
    // случай) показываем только её показание omh, без лишних запросов и подписей.
    const fs = eqByCod.get(first.cod)?.fs;
    const smhParts = [];
    if (omh != null) smhParts.push({ label: `TR-${fN(omh)}`, stale: omhStale });
    if (fs === "DR1" || fs === "DR2") {
      // v_smh_history — по дням (reading_date, без времени суток) — сравниваем с
      // календарным днём наряда, а не с точным временем окончания, чтобы показание
      // за тот же день считалось свежим.
      const dayT = lastRow._date.getTime();
      const series = smhByCod.get(first.cod) || [];
      const dr1 = entryAtOrBefore(series, dayT, "dr1total");
      if (dr1) smhParts.push({ label: `DR1-${fN(dr1.value)}`, stale: dr1.stale });
      if (fs === "DR2") {
        const dr2 = entryAtOrBefore(series, dayT, "dr2total");
        if (dr2) smhParts.push({ label: `DR2-${fN(dr2.value)}`, stale: dr2.stale });
      }
    }
    // Тот же дизайн пилюли, что и у бейджа инициатора Рудник/Сервис — TR стоит рядом
    // с ним на одной строке; DR1/DR2 (если машина их отслеживает) выстраиваются под
    // ним отдельными строками. Устаревшее (перенесённое) показание красится в тот же
    // красный, что и пилюля типа "Аварийный".
    const smhBadges = smhParts.map(
      (p) =>
        `<span class="tag" style="margin:0;background:${p.stale ? "#fbe3e1" : "#eceae6"};color:${p.stale ? "#a52a21" : "#555"}"${p.stale ? ' title="Наработка на момент наряда не записана — показано последнее известное значение"' : ""}>${p.label}</span>`
    );
    return {
      no,
      mine: first.mine,
      model: first.model,
      code: first.local_code,
      cod: first.cod,
      type: typeKey(first.type),
      typeRaw: first.type,
      sub: cleanText(first.subsystem, SUBSYSTEM_ALIASES) || "—",
      unit: cleanText(first.failure, {}) || "—",
      cause: cleanText(first.reason, REASON_ALIASES) || "—",
      damage: first.damage,
      init: first.damage ? first.damage.split(" ")[0] : null,
      status: first.status,
      comment: meaningfulComment ? cleanText(meaningfulComment, {}) : null,
      hrs,
      cost,
      noPrice: parts.some((p) => p.noPrice),
      parts,
      staff: [...staffByName.entries()],
      staffHours: [...staffByName.values()].reduce((a, b) => a + b, 0),
      // Каждый день несёт СВОЙ комментарий/запчасти/исполнителей — на многодневном
      // наряде (машина может простоять полгода в ожидании узла) это совсем другая
      // картина, чем общая сумма выше: видно, что именно происходило и кто именно
      // работал в конкретный день, а не что все 7 исполнителей "работали" все 198 часов.
      days: dayList.map(({ r, parts: dayParts }) => {
        const dateKey = r._date.toISOString().slice(0, 10);
        const dayStaffRaw = staffByWODay.get(no)?.get(dateKey) || [];
        const dayStaffByName = new Map();
        for (const s of dayStaffRaw) dayStaffByName.set(s.famaly, (dayStaffByName.get(s.famaly) || 0) + (Number(s.hours) || 0));
        return {
          date: r._date,
          startH: r._startH,
          endH: r._endH,
          hrs: Number(r.downtime_hours) || 0,
          comment: !isPlaceholderComment(r.comment) ? cleanText(r.comment, {}) : null,
          parts: dayParts,
          staff: [...dayStaffByName.entries()],
        };
      }),
      startDay: first._date,
      endDay: lastRow._date,
      repeat: !!repeatByWO.get(no),
      omh,
      smhBadges,
    };
  });
}

// ---------- форматирование ----------
function fN(v, d = 0) {
  return v == null || isNaN(v) ? "—" : Number(v).toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d });
}
// Стоимость запчастей — полная сумма с копейками (1 234,56), без сокращений «тыс/млн»:
// цены в прайсе с точностью до 0,01, и в журнале их нужно видеть как есть.
function money(x) {
  return fN(x, 2);
}
function dayLabel(d) {
  return String(d.getUTCDate()).padStart(2, "0") + "." + String(d.getUTCMonth() + 1).padStart(2, "0") + "." + d.getUTCFullYear();
}
function hhmm(h) {
  const H = Math.floor(h), M = Math.round((h - H) * 60);
  return String(H).padStart(2, "0") + ":" + String(M === 60 ? 59 : M).padStart(2, "0");
}

// ---------- переключатель месяца ----------
function renderMonthNav() {
  if (woFilter) {
    $("#mName").textContent = `${woFilter.size} наряд${woFilter.size === 1 ? "" : woFilter.size < 5 ? "а" : "ов"} — ${woSrc || "точный список"}`;
    $("#mPrev").disabled = true;
    $("#mNext").disabled = true;
    return;
  }
  const mo = months[monthIndex];
  $("#mName").textContent = mo ? `${MN_FULL[mo.m - 1]} ${mo.y}` : "—";
  $("#mPrev").disabled = monthIndex <= 0 && !hasMoreHistory;
  $("#mNext").disabled = monthIndex >= months.length - 1;
}

// ---------- рендер ----------
// Переносит Шахту/Модель/Борт + период в каждую ссылку на fleet-status.html и
// index.html (крошки и пункты верхнего меню) — fleet-status.js/app.js понимают один и
// тот же ключ "period" (r12/<год>/all); конкретный месяц здесь превращается в его
// календарный год — ближайшее, что понимают обе страницы.
function updateBackLinks(f, mo, eqSel) {
  const params = new URLSearchParams();
  if (mo) params.set("period", String(mo.y));
  if (f.mine) params.set("mine", f.mine);
  if (f.model) params.set("model", f.model);
  if (f.code) params.set("code", f.code);
  const q = params.toString();
  for (const link of document.querySelectorAll('a[href^="fleet-status.html"]')) link.href = "fleet-status.html" + (q ? `?${q}` : "");
  for (const link of document.querySelectorAll('a[href^="index.html"]')) link.href = "index.html" + (q ? `?${q}` : "");
  // Тот же индикатор контекста, что и на самой index.html в её крошках — машина, а не
  // просто название страницы, чтобы сразу было понятно, куда ведёт "назад".
  const availLink = $("#availLink");
  if (availLink) availLink.textContent = eqSel.length === 1 ? `${eqSel[0].model} · борт ${eqSel[0].local_code}` : "Доступность и надёжность";
}

function render() {
  saveState();
  const f = currentFilters();
  const eqSel = selectedEquipment(f);
  const single = eqSel.length === 1;
  const mo = months[monthIndex];
  renderMonthNav();
  updateBackLinks(f, mo, eqSel);

  const monthRows = woFilter ? detailRows.filter((r) => woFilter.has(r.work_order)) : mo ? detailRows.filter((r) => r._y === mo.y && r._m === mo.m) : [];
  const base = buildWorkOrders(monthRows);
  const q = $("#q").value.trim().toLowerCase();
  // skip — фильтр, который не применять: список запчастей справа строится по нарядам со
  // всеми остальными фильтрами, иначе в нём есть запчасти, клик по которым даёт пустой список.
  const passesFilters = (w, skip) =>
    (typeF === "all" || w.type === typeF) &&
    (!openOnly || w.status === "ОТКРЫТ") &&
    (!initiatorF || w.init === initiatorF) &&
    (!staffFilter || w.staff.some(([name]) => name === staffFilter)) &&
    // Панель подсистем считает только аварийный простой ("Аварийный простой по
    // подсистемам") — плановый/ТО-наряд с тем же названием подсистемы не должен
    // попадать в отфильтрованный список, иначе его часы всплывут здесь, хотя итог
    // самой панели (только em) их никогда не учитывал.
    (!subsystemFilter || (w.sub === subsystemFilter && w.type === "em")) &&
    (skip === "part" || !partFilter || w.parts.some((p) => (p.sp || p.name) === partFilter)) &&
    (!q || [w.no, lbl(w.no), w.sub, w.unit, w.cause, w.comment, ...w.parts.map((p) => (p.sp || "") + " " + p.name + " " + (p.idx || ""))].join(" ").toLowerCase().includes(q));
  const passesCommonFilters = (w) => passesFilters(w);

  // Список с учётом всех фильтров, КРОМЕ самого repeatOnly — то, что видно в таблице,
  // если бы карточка "Повторные отказы" была выключена. Именно из него, а не из
  // необработанного base, нужно считать, сколько повторов есть СЕЙЧАС — иначе число на
  // карточке не зависит от выбранной подсистемы/исполнителя/запчасти, как просил пользователь.
  const filteredBase = base.filter(passesCommonFilters);
  // "Повторным" помечается только БОЛЕЕ ПОЗДНИЙ отказ — более ранний, который он
  // повторяет, может целиком лежать вне текущего месяца/точного списка (например,
  // ссылка "🔁" из fleet-status.js несёт только ID поздних повторов). Подтягиваем
  // исходные наряды из полной истории, чтобы была видна обе половины пары, и снова
  // прогоняем через те же фильтры — так число на карточке всегда точно совпадает с
  // тем, что реально появится в таблице по клику.
  function repeatFilteredList(candidates, pass = passesCommonFilters) {
    const relevantIds = new Set();
    for (const w of candidates) {
      if (!w.repeat) continue;
      relevantIds.add(w.no);
      const origins = originByWO.get(w.no);
      if (origins) for (const id of origins) relevantIds.add(id);
    }
    const relevantRows = detailRows.filter((r) => relevantIds.has(r.work_order));
    return buildWorkOrders(relevantRows).filter(pass);
  }
  const repeatList = repeatFilteredList(filteredBase);
  const list = repeatOnly ? repeatList : filteredBase;
  const partPass = (w) => passesFilters(w, "part");
  const partPool = repeatOnly ? repeatFilteredList(base.filter(partPass), partPass) : base.filter(partPass);

  const scopeLabel = woFilter ? ` — ${woFilter.size} наряд${woFilter.size === 1 ? "" : "ов"} (${woSrc || "точный список"})` : mo ? ` — ${MN_FULL[mo.m - 1]} ${mo.y}` : "";
  $("#pageTitle").textContent = (single ? `${eqSel[0].model} · борт ${eqSel[0].local_code}` : `${eqSel.length} машин${f.model ? " · " + f.model : ""}${f.mine ? " · " + f.mine : ""}`) + scopeLabel;

  renderCards(base, eqSel, woFilter ? null : mo, repeatList);
  renderGantt(base, eqSel, single, woFilter ? null : mo);
  renderChips(base);
  renderJournal(list);
  renderSide(base, list, partPool);

  if (focusWO) {
    const row = document.getElementById("wo" + focusWO);
    if (row) {
      row.scrollIntoView({ block: "center" });
      const det = document.getElementById("det" + focusWO);
      if (det) det.classList.add("on");
      const caret = row.querySelector(".caret");
      if (caret) caret.textContent = "▾";
    }
    focusWO = null;
  }
}

function renderCards(base, eqSel, mo, repeatList) {
  const by = (t) => base.filter((w) => w.type === t);
  const sumH = (a) => a.reduce((s, w) => s + w.hrs, 0);
  const em = by("em"), pl = by("pl"), to = by("to");
  // Именно то число, что реально появится в таблице по клику на карточку (наряды
  // repeatList уже прогнаны через текущие фильтры подсистемы/исполнителя/запчасти —
  // см. render()), а не сырое количество повторов по всему месяцу.
  const rep = repeatList;
  const open = base.filter((w) => w.status === "ОТКРЫТ");
  const calH = mo ? new Date(Date.UTC(mo.y, mo.m, 0)).getUTCDate() * 24 : 0;
  const cal = calH * eqSel.length;
  const down = sumH(base);
  const ps = base.reduce((s, w) => s + w.cost, 0);
  const pe = em.reduce((s, w) => s + w.cost, 0);
  const staffH = base.reduce((s, w) => s + w.staffHours, 0);
  const people = new Set(base.flatMap((w) => w.staff.map(([name]) => name)));

  const card = (k, v, s, c = "") => `<div class="card"><div class="k">${k}</div><div class="v" style="${c}">${v}</div><div class="s">${s}</div></div>`;
  // Кликабельна, только если есть что фильтровать — за нулевым числом повторов нечего
  // сужать в списке.
  const repeatCard = rep.length
    ? `<div class="card card-click${repeatOnly ? " on" : ""}" data-filter="repeat" title="Показать только повторяющиеся отказы"><div class="k">Повторные отказы</div><div class="v" style="color:${MOCK_EM}">${rep.length}</div><div class="s">после ТО или ремонта той же подсистемы</div></div>`
    : card("Повторные отказы", 0, "после ТО или ремонта той же подсистемы");
  $("#cards").innerHTML =
    card("Нарядов", base.length, `аварийных ${em.length} · плановых ${pl.length} · ТО ${to.length}`) +
    card("Простой", fN(down) + " ч", `аварийный ${fN(sumH(em))} · плановый ${fN(sumH(pl))} · ТО ${fN(sumH(to))}`) +
    card("Доступность за месяц", cal ? ((1 - down / cal) * 100).toFixed(1).replace(".", ",") + "%" : "—", `${fN(cal)} календарных часов`) +
    card("Запчасти", money(ps), `на аварийные ${money(pe)} (${ps ? Math.round((pe / ps) * 100) : 0}%)`) +
    card("Трудозатраты", fN(staffH, 1) + " чел·ч", `${people.size} исполнителей`) +
    repeatCard +
    (open.length ? card("Открытые наряды", open.length, "не закрыты", "color:#b8860b") : "");
}

// Работает и для одного календарного месяца (mo задан), и для ссылки "точный список"
// (?wo=), которая может охватывать много месяцев — раньше ось X понимала только
// фиксированный 1-месячный диапазон, и полосы за его пределами молча не отображались.
function ganttRange(base, mo) {
  if (mo) {
    const days = new Date(Date.UTC(mo.y, mo.m, 0)).getUTCDate();
    return { start: new Date(Date.UTC(mo.y, mo.m - 1, 1)), days };
  }
  let min = null, max = null;
  for (const w of base) for (const d of w.days) {
    if (min == null || d.date < min) min = d.date;
    if (max == null || d.date > max) max = d.date;
  }
  if (min == null) return { start: new Date(), days: 1 };
  const start = new Date(Date.UTC(min.getUTCFullYear(), min.getUTCMonth(), min.getUTCDate()));
  const days = Math.round((max - start) / 864e5) + 1;
  return { start, days };
}

function renderGantt(base, eqSel, single, mo) {
  const { start, days } = ganttRange(base, mo);
  const H = days * 24;
  const rowsG = single ? [{ key: "em", label: "Аварийный" }, { key: "pl", label: "Плановый" }, { key: "to", label: "ТО" }] : eqSel.map((e) => ({ key: e.cod, label: `${e.model} · ${e.local_code}` }));
  $("#ganttTitle").textContent = single ? "Простой по дням — по типам ремонта" : "Простой по дням — по машинам";
  const W = 1000;
  const X = (h) => (h / H) * W;
  const dense = days <= 31; // one label/gridline per day only while it stays readable
  let axis = "", grid = "";
  if (dense) {
    for (let d = 0; d < days; d++) {
      const dt = new Date(start.getTime() + d * 864e5);
      const we = dt.getUTCDay() === 0 || dt.getUTCDay() === 6;
      axis += `<text x="${X((d + 0.5) * 24)}" y="12" text-anchor="middle" font-size="10" fill="${we ? "#c0392b" : "#888"}">${dt.getUTCDate()}</text>`;
    }
    for (let d = 0; d <= days; d++) grid += `<line x1="${X(d * 24)}" x2="${X(d * 24)}" y1="0" y2="20" stroke="#eee"/>`;
  } else {
    // Длинный/многомесячный диапазон: подписываем границы календарных месяцев вместо
    // каждого дня — но при ширине ~1000px больше ~12 подписей уже накладываются друг
    // на друга, поэтому прореживаем их (каждый N-й месяц), когда подписей слишком много.
    let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    if (d < start) d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const ticks = [];
    while (d.getTime() < start.getTime() + days * 864e5) {
      ticks.push(d);
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    }
    const stride = Math.max(1, Math.ceil(ticks.length / 12));
    ticks.forEach((dt, i) => {
      const h = (dt - start) / 3.6e6;
      grid += `<line x1="${X(h)}" x2="${X(h)}" y1="0" y2="20" stroke="#eee"/>`;
      if (i % stride === 0) axis += `<text x="${X(h) + 2}" y="12" font-size="10" fill="#888">${MN_FULL[dt.getUTCMonth()].slice(0, 3)} ${String(dt.getUTCFullYear()).slice(2)}</text>`;
    });
  }
  let g = `<div class="lab"></div><div class="axis"><svg viewBox="0 0 ${W} 18" preserveAspectRatio="none">${axis}</svg></div>`;
  for (const row of rowsG) {
    const ws = single ? base.filter((w) => w.type === row.key) : base.filter((w) => w.cod === row.key);
    let bars = "";
    for (const w of ws) {
      for (const d of w.days) {
        const dayIdx = Math.round((d.date - start) / 864e5);
        const x0 = dayIdx * 24 + d.startH, x1 = dayIdx * 24 + d.endH;
        bars += `<rect data-no="${w.no}" x="${X(x0).toFixed(1)}" y="3" width="${Math.max(2, X(x1) - X(x0)).toFixed(1)}" height="14" rx="2" fill="${TYPE_COLOR[w.type]}" style="cursor:pointer"><title>№ ${lbl(w.no)} · ${TYPE_LABEL[w.type]}\n${dayLabel(d.date)} ${hhmm(d.startH)}–${hhmm(d.endH)} · ${fN(d.hrs, 1)} ч\n${esc(w.sub)} › ${esc(w.unit)}\n${esc(w.cause)}</title></rect>`;
      }
    }
    const sumH = ws.reduce((s, w) => s + w.hrs, 0);
    g += `<div class="lab" title="${esc(row.label)}">${esc(row.label)} <small>${fN(sumH)} ч</small></div><div><svg viewBox="0 0 ${W} 20" preserveAspectRatio="none"><rect x="0" y="3" width="${W}" height="14" fill="#f5f2ee"/>${grid}${bars}</svg></div>`;
  }
  $("#gantt").innerHTML = g;
}

function renderChips(base) {
  const cnt = (t) => (t === "all" ? base.length : base.filter((w) => w.type === t).length);
  const open = base.filter((w) => w.status === "ОТКРЫТ").length;
  let html = [
    ["all", "Все"],
    ["em", "Аварийные"],
    ["pl", "Плановые"],
    ["to", "ТО"],
  ]
    .map(([k, t]) => `<button class="tchip ${typeF === k ? "on" : ""}" data-t="${k}">${t} · ${cnt(k)}</button>`)
    .join("");
  html += `<button class="tchip ${openOnly ? "on" : ""}" data-open="1">Только открытые · ${open}</button>`;
  if (initiatorF) html += `<button class="tchip on" data-init-clear="1">Инициатор: ${esc(initiatorF)} ✕</button>`;
  if (staffFilter) html += `<button class="tchip on" data-clear="staff">Исполнитель: ${esc(staffFilter)} ✕</button>`;
  if (subsystemFilter) html += `<button class="tchip on" data-clear="sub">Подсистема: ${esc(subsystemFilter)} ✕</button>`;
  if (partFilter) html += `<button class="tchip on" data-clear="part">Запчасть: ${esc(partFilter)} ✕</button>`;
  $("#typeChips").innerHTML = html;
}

function ruDayGenitive(m) {
  return MN_GEN[m - 1];
}

// Разбивка многодневного наряда по дням — свёрнута по умолчанию (кнопка-раскрыватель),
// технические дни без комментария/запчастей/исполнителей схлопываются в одну строку
// "N дн. без записей", чтобы полугодовой простой не превращался в 150+ пустых строк.
function dayBreakdownHtml(w) {
  const items = [];
  let emptyRun = 0;
  const flushGap = () => {
    if (emptyRun) {
      items.push(`<div class="daygap">… ${emptyRun} ${emptyRun === 1 ? "день" : "дн."} без записей …</div>`);
      emptyRun = 0;
    }
  };
  for (const d of w.days) {
    if (!d.comment && !d.parts.length && !d.staff.length) {
      emptyRun++;
      continue;
    }
    flushGap();
    items.push(`<div class="day daysub">
      <div class="dayh"><b>${dayLabel(d.date)}</b><span>${fN(d.hrs, 1)} ч</span></div>
      ${d.comment ? `<div class="cm">${esc(d.comment)}</div>` : ""}
      ${
        d.parts.length
          ? `<table class="mini"><tr><th>Запчасть</th><th style="text-align:right">Кол-во</th><th style="text-align:right">Сумма</th></tr>${d.parts
              .map((p) => `<tr><td>${p.sp ? `<span class="mono">${esc(p.sp)}</span> · ` : ""}${esc(p.name)}${p.idx ? " · " + esc(p.idx) : ""}</td><td style="text-align:right">${fN(p.qty)}</td><td style="text-align:right">${partCost(p)}</td></tr>`)
              .join("")}</table>`
          : ""
      }
      ${d.staff.length ? `<div class="daystaff">${d.staff.map(([n, h]) => `${esc(n)} (${fN(h, 1)} ч)`).join(", ")}</div>` : ""}
    </div>`);
  }
  flushGap();
  return `<button type="button" class="btn-secondary daybreak-toggle" data-no="${w.no}" data-total="${w.days.length}">▸ Показать по дням (${w.days.length})</button>
    <div class="daybreak" id="daybreak${w.no}" hidden>${items.join("") || '<div class="note">записей по дням нет</div>'}</div>`;
}

function renderJournal(list) {
  // При фильтре "Повторные отказы" в список также подмешивается исходный (более
  // ранний) отказ каждого повтора, чтобы пара читалась явно — помечаем эти исходные
  // наряды отдельно от самого повтора, иначе они выглядят как обычный наряд в списке.
  // "Исходным" считается только настоящий корень цепочки (сам ничего не повторяет) —
  // в цепочке А→Б→В отказ Б сам уже помечен "повтор" и не должен ВТОРЫМ тегом
  // называться "исходным", даже если от него, в свою очередь, начат отсчёт для В.
  const originIds = new Set();
  if (repeatOnly) {
    for (const w of list) {
      if (!w.repeat) continue;
      const origins = originByWO.get(w.no);
      if (origins) for (const id of origins) if (!repeatByWO.get(id)) originIds.add(id);
    }
  }
  // Ключ — полная дата (а не просто число месяца) — ссылка "точный список" (?wo=)
  // может охватывать несколько месяцев/лет, где одно число месяца дало бы коллизии.
  const days = new Map();
  list
    .slice()
    .sort((a, b) => b.startDay - a.startDay || b.days[0].startH - a.days[0].startH)
    .forEach((w) => {
      const key = w.startDay.toISOString().slice(0, 10);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(w);
    });
  const sortedDays = [...days.keys()].sort((a, b) => (a < b ? 1 : -1));
  let j = "";
  if (!list.length) j = '<div class="note" style="padding:20px">Нет нарядов по выбранным условиям.</div>';
  for (const key of sortedDays) {
    const ws = days.get(key);
    const dt = ws[0].startDay;
    const sumH = ws.reduce((s, w) => s + w.hrs, 0);
    const sumCost = ws.reduce((s, w) => s + w.cost, 0);
    j += `<div class="day"><div class="dayh"><b>${WD[dt.getUTCDay()]}, ${dt.getUTCDate()} ${ruDayGenitive(dt.getUTCMonth() + 1)} ${dt.getUTCFullYear()}</b><span>${ws.length} нар. · простой ${fN(sumH, 1)} ч · запчасти ${money(sumCost)}</span></div>`;
    for (const w of ws) {
      const ps = w.cost;
      const repKind = repeatKindByWO.get(w.no) === "after_pm" ? "после ТО" : "после ремонта той же подсистемы";
      const repWin = repeatWindowByWO.get(w.no);
      const repSrc = (originByWO.get(w.no) || [])[0];
      const repTitle = `Повтор ${repKind}${repSrc ? ` (наряд № ${lbl(repSrc)})` : ""}${repWin ? ` — окно: ${repWin}` : ""}`;
      const tags =
        (w.repeat ? `<span class="tag rep" title="${esc(repTitle)}">🔁 повтор</span>` : "") +
        (originIds.has(w.no) ? `<span class="tag origin" title="Исходная работа — от её окончания отсчитывается окно повторного отказа">⏱ исходный отказ</span>` : "") +
        (w.status === "ОТКРЫТ" ? `<span class="tag open">открыт</span>` : "");
      const timeLabel = w.days.length ? `${hhmm(w.days[0].startH)}–${w.startDay.getTime() !== w.endDay.getTime() ? dayLabel(w.endDay) + " " : ""}${hhmm(w.days[w.days.length - 1].endH)}` : "—";
      j += `<div class="wo" data-no="${w.no}" id="wo${w.no}"><span class="caret">▸</span>
        <span class="t">${timeLabel}</span>
        <span class="h">${fN(w.hrs, 1)} ч</span>
        <span><span class="type t-${w.type}">${TYPE_LABEL[w.type]}</span>${tags}</span>
        <span>${esc(w.sub)} › <b>${esc(w.unit)}</b><div class="sub">${esc(w.cause)}${w.type !== "to" && w.comment ? " · " + esc(w.comment) : ""}</div></span>
        <span>${esc(w.model)} · ${esc(w.code)}<br><span class="tag ${w.init === DN.mine ? "mine" : ""}" style="margin:0;${w.init === DN.mine ? "" : "background:#eceae6;color:#555"}">${esc(w.init || "—")}</span> ${w.smhBadges[0] || ""}${w.smhBadges
          .slice(1)
          .map((b) => `<br>${b}`)
          .join("")}</span>
        <span class="num">${ps ? money(ps) : "—"}<div class="sub">${w.parts.length ? w.parts.length + " поз." : ""}${w.noPrice ? " · " + NO_PRICE : ""}</div></span>
        <span class="num">${fN(w.staffHours, 1)} ч<div class="sub">${w.staff.length} чел.</div></span></div>
        <div class="det" id="det${w.no}">
          <div class="cm"><b>Наряд № ${esc(lbl(w.no))}</b> · ${esc(w.status || "—")}${w.comment ? "<br>" + esc(w.comment) : ""}</div>
          <div class="row">
            <table><tr><th>Парт номер</th><th>Запасная часть</th><th>Индекс</th><th style="text-align:right">Кол-во</th><th style="text-align:right">Сумма</th></tr>
              ${
                w.parts.length
                  ? w.parts.map((p) => `<tr><td class="mono">${esc(p.sp || "—")}</td><td>${esc(p.name)}</td><td>${esc(p.idx ?? "—")}</td><td style="text-align:right">${fN(p.qty)}</td><td style="text-align:right">${partCost(p)}</td></tr>`).join("") +
                    `<tr><td colspan="4"><b>Итого</b></td><td style="text-align:right"><b>${money(ps)}</b></td></tr>`
                  : '<tr><td colspan="4" style="color:#999">запчасти не устанавливались</td></tr>'
              }</table>
            <table><tr><th>Исполнитель</th><th style="text-align:right">Часы</th></tr>${w.staff.length ? w.staff.map(([name, h]) => `<tr><td>${esc(name)}</td><td style="text-align:right">${fN(h, 1)}</td></tr>`).join("") : '<tr><td colspan="2" style="color:#999">персонал не назначен</td></tr>'}</table>
          </div>${w.days.length > 1 ? dayBreakdownHtml(w) : ""}</div>`;
    }
    j += "</div>";
  }
  $("#journal").innerHTML = j;
}

function renderSide(base, list, partPool) {
  const em = base.filter((w) => w.type === "em");
  const subH = new Map();
  for (const w of em) subH.set(w.sub, (subH.get(w.sub) || 0) + w.hrs);
  const sh = [...subH.entries()].sort((a, b) => b[1] - a[1]);
  const smax = sh[0] ? sh[0][1] : 1;
  $("#sideSub").innerHTML = sh.length
    ? sh
        .map(
          ([k, v]) =>
            `<tr class="side-row${k === subsystemFilter ? " on" : ""}" data-kind="sub" data-value="${esc(k)}" title="Показать только эту подсистему"><td>${esc(k)}</td><td class="r" style="width:140px"><div class="hb"><i style="width:${(v / smax) * 80}px"></i>${fN(v)} ч</div></td></tr>`
        )
        .join("")
    : '<tr><td class="note">аварийных ремонтов нет</td></tr>';

  const pa = new Map();
  for (const w of partPool) for (const p of w.parts) {
    const pk = p.sp || p.name;
    if (!pa.has(pk)) pa.set(pk, { q: 0, s: 0, np: false, sp: p.sp || "", name: p.name });
    const e = pa.get(pk);
    e.q += p.qty;
    e.s += p.cost || 0;
    if (p.noPrice) e.np = true;
  }
  const parts = [...pa.entries()].sort((a, b) => b[1].s - a[1].s).slice(0, 10);
  $("#sideParts").innerHTML = parts.length
    ? parts
        .map(
          ([k, v]) =>
            `<tr class="side-row${k === partFilter ? " on" : ""}" data-kind="part" data-value="${esc(k)}" title="Показать только наряды с этой запчастью"><td>${v.sp ? `<span class="mono">${esc(v.sp)}</span><br>` : ""}${esc(v.name)}</td><td class="r">${fN(v.q)}&nbsp;шт</td><td class="r sum">${v.np && !v.s ? NO_PRICE : money(v.s)}</td></tr>`
        )
        .join("")
    : '<tr><td class="note">нет</td></tr>';

  // В отличие от подсистем (фильтр-переключатель, остаётся полным списком за месяц) и
  // запчастей (все фильтры, кроме самой запчасти), список исполнителей должен отражать уже
  // отфильтрованный результат — по всем активным фильтрам (подсистема, запчасть, повторы, тип и т.д.).
  const st = new Map();
  for (const w of list) for (const [name, h] of w.staff) st.set(name, (st.get(name) || 0) + h);
  const staff = [...st.entries()].sort((a, b) => b[1] - a[1]);
  $("#sideStaff").innerHTML = staff.length
    ? staff.map(([k, v]) => `<tr class="side-row${k === staffFilter ? " on" : ""}" data-kind="staff" data-value="${esc(k)}" title="Показать только работы этого исполнителя"><td>${esc(k)}</td><td class="r">${fN(v, 1)} ч</td></tr>`).join("")
    : '<tr><td class="note">нет</td></tr>';
}

// ---------- экспорт ----------
function exportExcel() {
  const f = currentFilters();
  const eqSel = selectedEquipment(f);
  const mo = months[monthIndex];
  const monthRows = mo ? detailRows.filter((r) => r._y === mo.y && r._m === mo.m) : [];
  const base = buildWorkOrders(monthRows);
  const wsData = base.map((w) => ({
    "№ наряда": lbl(w.no),
    Дата: dayLabel(w.startDay),
    Модель: w.model,
    Борт: w.code,
    Тип: TYPE_LABEL[w.type],
    Подсистема: w.sub,
    Узел: w.unit,
    Причина: w.cause,
    Инициатор: w.init,
    Статус: w.status,
    "Простой, ч": Number(w.hrs.toFixed(1)),
    Запчасти: w.parts.map((p) => `${p.sp ? p.sp + " " : ""}${p.name}${p.idx ? " [" + p.idx + "]" : ""} ×${p.qty}${p.noPrice ? " (нет цены)" : ""}`).join("; "),
    "Стоимость запчастей": Math.round(w.cost * 100) / 100,
    "Трудозатраты, ч": Number(w.staffHours.toFixed(1)),
    Повтор: w.repeat ? "да" : "",
    Комментарий: w.comment,
  }));
  const ws = XLSX.utils.json_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Журнал ремонтов");
  const suffix = mo ? `${mo.y}_${String(mo.m).padStart(2, "0")}` : new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `repair_log_${suffix}.xlsx`);
}

// ---------- события ----------
function initDashboard() {
  if (dashboardStarted) return;
  dashboardStarted = true;
  enableTapToExpandCells();
  // Стрелки ▲/▼ — к шапке и к концу журнала нарядов.
  enableScrollButtons(() => document.querySelector("#journal")?.closest("section"));

  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".tchip");
    if (chip) {
      if (chip.dataset.open) openOnly = !openOnly;
      else if (chip.dataset.initClear) initiatorF = null;
      else if (chip.dataset.clear === "staff") staffFilter = null;
      else if (chip.dataset.clear === "sub") subsystemFilter = null;
      else if (chip.dataset.clear === "part") partFilter = null;
      else typeF = chip.dataset.t;
      render();
      return;
    }
    const bar = e.target.closest("rect[data-no]");
    if (bar) {
      focusWO = bar.dataset.no;
      typeF = "all";
      render();
      return;
    }
    const wo = e.target.closest(".wo");
    if (wo) {
      const det = document.getElementById("det" + wo.dataset.no);
      const on = det.classList.toggle("on");
      wo.querySelector(".caret").textContent = on ? "▾" : "▸";
      return;
    }
    const sideRow = e.target.closest(".side-row");
    if (sideRow) {
      const { kind, value } = sideRow.dataset;
      if (kind === "staff") staffFilter = staffFilter === value ? null : value;
      else if (kind === "sub") subsystemFilter = subsystemFilter === value ? null : value;
      else if (kind === "part") partFilter = partFilter === value ? null : value;
      render();
      return;
    }
    const repeatCard = e.target.closest('[data-filter="repeat"]');
    if (repeatCard) {
      repeatOnly = !repeatOnly;
      render();
      return;
    }
    const dbToggle = e.target.closest(".daybreak-toggle");
    if (dbToggle) {
      const panel = document.getElementById("daybreak" + dbToggle.dataset.no);
      const willShow = panel.hidden;
      panel.hidden = !willShow;
      dbToggle.textContent = `${willShow ? "▾ Скрыть" : "▸ Показать"} по дням (${dbToggle.dataset.total})`;
    }
  });

  // Без этой защиты быстрый повторный клик (например, нетерпеливое двойное нажатие)
  // мог запустить второй stepMonth() поверх ещё не завершённого первого — loadData()
  // обновляет hasMoreHistory и months не одним атомарным присваиванием, а с await
  // между ними (повторы/SMH/персонал), так что "застрявший" второй вызов мог
  // прочитать уже новое hasMoreHistory, но ещё старый months, и залипнуть на границе
  // окна. Пока идёт один шаг, лишние клики просто игнорируются.
  let stepMonthBusy = false;
  async function stepMonth(delta) {
    if (stepMonthBusy) return;
    stepMonthBusy = true;
    try {
      if (delta < 0 && monthIndex <= 0 && hasMoreHistory && !woFilter) {
        // Достигли начала загруженного окна, но в базе есть более ранняя история —
        // одноразово грузим её всю целиком (обычно это редкий, целенаправленный
        // просмотр архива, а не типичный сценарий, так что не усложняем частичным
        // "довыгрузка на месяц" — проще и надёжнее донести всё сразу).
        const oldEarliest = months[0];
        windowMonthsBack = Infinity;
        await loadData();
        if (!oldEarliest) return;
        const oldKey = oldEarliest.y * 12 + oldEarliest.m;
        const idx = months.findIndex((mo) => mo.y * 12 + mo.m >= oldKey);
        monthIndex = idx > 0 ? idx - 1 : 0;
        setLoading(true);
        await loadStaffForMonth(currentFilters(), months[monthIndex]);
        setLoading(false);
        render();
        return;
      }
      monthIndex = Math.max(0, Math.min(months.length - 1, monthIndex + delta));
      setLoading(true);
      await loadStaffForMonth(currentFilters(), months[monthIndex]);
      setLoading(false);
      render();
    } finally {
      stepMonthBusy = false;
    }
  }
  $("#mPrev").addEventListener("click", () => stepMonth(-1));
  $("#mNext").addEventListener("click", () => stepMonth(1));
  // Ручное изменение фильтра означает, что пользователь просматривает данные, а не
  // подтверждает точный список, на который его привела ссылка — возвращаемся к
  // обычному помесячному виду.
  $("#filterMine").addEventListener("change", () => {
    woFilter = null;
    woSrc = null;
    staffFilter = null;
    subsystemFilter = null;
    partFilter = null;
    repeatOnly = false;
    windowMonthsBack = WINDOW_MONTHS_DEFAULT;
    updateModelOptions();
    updateCodeOptions(false);
    loadData();
  });
  $("#filterModel").addEventListener("change", () => {
    woFilter = null;
    woSrc = null;
    staffFilter = null;
    subsystemFilter = null;
    partFilter = null;
    repeatOnly = false;
    windowMonthsBack = WINDOW_MONTHS_DEFAULT;
    updateCodeOptions(false);
    loadData();
  });
  $("#filterCode").addEventListener("change", () => {
    woFilter = null;
    woSrc = null;
    staffFilter = null;
    subsystemFilter = null;
    partFilter = null;
    repeatOnly = false;
    windowMonthsBack = WINDOW_MONTHS_DEFAULT;
    loadData();
  });
  $("#q").addEventListener("input", render);
  $("#expandAll").addEventListener("click", () => {
    const all = [...document.querySelectorAll(".det")];
    const on = !all.every((d) => d.classList.contains("on"));
    all.forEach((d) => d.classList.toggle("on", on));
    document.querySelectorAll(".wo .caret").forEach((c) => (c.textContent = on ? "▾" : "▸"));
  });
  $("#exportExcel").addEventListener("click", exportExcel);

  loadFilterOptions().then(() => {
    if (window.location.search.length > 1) applyUrlFilters();
    else if (["reload", "back_forward"].includes(performance.getEntriesByType?.("navigation")?.[0]?.type)) applySavedState();
    stateReady = true;
    loadData();
  });
}

setupAuth(supabase, "repair-details.html", () =>
  loadDictNames(supabase).then(() => { EMERGENCY_TYPE = DN.em; MAINTENANCE_TYPE = DN.to; initDashboard(); })
);
