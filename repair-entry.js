import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { setupAuth } from "./auth.js?v=36";
import { rulesForMine, applyRules, eoPeriod, normText, hasWord, modelFits } from "./parse-rules-engine.js?v=4";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Форма ввода ремонтов (ТЗ «форма ввода ремонтов», прототип согласован 29.09).
// Наряды пишутся в схему remonty через функции public.repair_*; все правила ТЗ (один открытый
// наряд, пересечения машины и персонала, шаблон, причины, FS, досоздание дней, закрытие)
// проверяет база при сохранении, форма лишь подсказывает заранее.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad = (n) => String(n).padStart(2, "0");
const TYPE_PM = 3;
const SUB_PM = 114;
// ЕО (ежедневный осмотр): у машины с признаком «ЕО» в карточке — первая кнопка в «Шаге ТО». Сохраняется как ТО
// без шага цикла (pm_pos пустой, отказ 185 «ЕО», причина 4 «Нормальный износ»): в цикл ТО не входит.
const EO_POS = 0, EO_FAIL = 185, EO_REASON = 4, EO_LABEL = "ЕО";
const hasEo = (f) => !!M(f.cod)?.has_eo || !!f.keepEo;
const CLS = ["type", "sub", "fail", "dmg", "reason"];
const CLS_LAB = { type: "Тип работ", sub: "Подсистема", fail: "Отказ", dmg: "Инициатор", reason: "Причина" };
const CHIP_LIMIT = 8; // длиннее — плитки с поиском

let D = null; // справочники
let PR = null; // словарь разбора (Настройки → «Словарь разбора ремонтов»): правила по площадкам
let skew = 0; // «сейчас» по серверу (Asia/Almaty) минус часы устройства
let V = { name: "list" }; // экран
let F = null; // форма (новый наряд или день)
let W = null; // открытый наряд
let LIST = [];
let notice = null;
let closing = false;
let busy = false;
const partDescr = new Map(); // парт номер (верхний регистр) → описание
const partHist = new Map(); // "cod|номер" → [{idx,last}]
const pmCache = new Map(); // cod → next_pm
let started = false;
let objKey = "repair-entry-obj";
const sortRu = (a) => [...new Set(a.filter(Boolean))].sort((x, y) => x.localeCompare(y, "ru"));
const objects = () => sortRu(D.machines.map((m) => m.object));
const minesOf = (obj) => sortRu(D.machines.filter((m) => !obj || m.object === obj).map((m) => m.mine));
const inObj = () => true;
// Объект и шахта — в шапке, только для информации: доступные машины задаются правами пользователя
// (страница «Пользователи»), база сама отдаёт только их. Вид — как плашка «Прототип · демо-данные».
let ACCESS = null;
function renderScope() {
  const el = $("#reScope");
  if (!el || !D) return;
  let obj, mine;
  if (!ACCESS || ACCESS.all_equipment) { obj = "Все объекты"; mine = "все шахты"; }
  else {
    obj = (ACCESS.objects || []).join(", ") || sortRu(D.machines.map((m) => m.object)).join(", ") || "—";
    mine = (ACCESS.mines || []).join(", ") || "все шахты";
  }
  el.innerHTML = `<span class="re-scope-pill" title="Объект · шахта из прав пользователя">${esc(obj)} · ${esc(mine)}</span>`;
  el.hidden = false;
}
let draftKey = "repair-entry-draft";

// ---------- время: всё в местном времени рудника, как в базе ----------
const parseDT = (s) => { const [a, b = "00:00"] = String(s).split("T"); const [y, m, d] = a.split("-").map(Number); const [h, mi] = b.split(":").map(Number); return new Date(y, m - 1, d, h, mi); };
const fmtDT = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const nowD = () => new Date(Date.now() + skew);
const nowS = () => fmtDT(nowD());
const todayS = () => nowS().slice(0, 10);
const dateOf = (s) => String(s).slice(0, 10);
const timeOf = (s) => String(s).slice(11, 16);
const ru = (s) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const ruY = (s) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(2, 4)}`;
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const wd = (s) => WD[parseDT(dateOf(s)).getDay()];

// ---------- справочники ----------
// Реальная машина справочника (или undefined) и запасной вариант для нарядов, чьей машины в справочнике нет.
const Mx = (cod) => D.machByCod.get(Number(cod));
const MISSING = new Map();
const M = (cod) => cod == null ? undefined : Mx(cod) || (MISSING.has(Number(cod)) ? MISSING.get(Number(cod))
  : (MISSING.set(Number(cod), { cod: Number(cod), code: `машина не найдена (cod ${cod})`, model: "", mine: "", object: "", fs: "TR", missing: true, inactive: false }), MISSING.get(Number(cod))));
const offPill = (m) => (m.inactive ? '<span class="pill off">списана</span>' : "");
const nameOf = (list, id) => list.get(Number(id)) ?? "—";
const typeName = (id) => nameOf(D.typeName, id);
const subName = (id) => nameOf(D.subName, id);
const failName = (id) => nameOf(D.failName, id);
const dmgName = (id) => nameOf(D.dmgName, id);
const reasonName = (id) => nameOf(D.reasonName, id);
const fsName = (id) => nameOf(D.fsName, id);
const staffName = (id) => D.staffById.get(Number(id))?.name ?? `№ ${id}`;

function prepDicts(raw) {
  const d = { ...raw };
  d.machByCod = new Map(raw.machines.map((m) => [m.cod, m]));
  d.typeName = new Map(raw.types.map((x) => [x.id, x.name]));
  d.subName = new Map(raw.subsystems.map((x) => [x.id, x.name]));
  d.failName = new Map(raw.failures.map((x) => [x.id, x.name]));
  d.dmgName = new Map(raw.damages.map((x) => [x.id, x.name]));
  d.reasonName = new Map(raw.reasons.map((x) => [x.id, x.name]));
  d.fsName = new Map(raw.fs.map((x) => [x.id, x.name]));
  d.fsByName = new Map(raw.fs.map((x) => [x.name, x.id]));
  d.staffById = new Map(raw.staff.map((x) => [x.id, x]));
  d.exc = new Map();
  for (const [cod, t, s, f, a] of raw.exceptions) {
    if (!d.exc.has(cod)) d.exc.set(cod, { add: new Set(), hide: new Set() });
    d.exc.get(cod)[a].add(`${t}|${s}|${f}`);
  }
  d.combosCache = new Map();
  // Скрытые в «Словаре разбора» значения (галочка «В форме» снята) — не предлагаются в списках формы.
  const hid = (list) => new Set((list || []).filter((x) => x.hidden).map((x) => x.id));
  d.hid = { type: hid(raw.types), sub: hid(raw.subsystems), fail: hid(raw.failures), dmg: hid(raw.damages), reason: hid(raw.reasons) };
  return d;
}

// Действующий шаблон машины = шаблон модели + исключения машины.
function combos(cod) {
  if (D.combosCache.has(cod)) return D.combosCache.get(cod);
  const m = M(cod);
  const ex = D.exc.get(cod) || { add: new Set(), hide: new Set() };
  const res = [];
  const seen = new Set();
  for (const [t, s, f] of D.templates[m?.model] || []) {
    const k = `${t}|${s}|${f}`;
    if (ex.hide.has(k) || seen.has(k)) continue;
    seen.add(k);
    res.push([t, s, f]);
  }
  for (const k of ex.add) if (!seen.has(k)) { seen.add(k); res.push(k.split("|").map(Number)); }
  D.combosCache.set(cod, res);
  return res;
}
const hasRules = (t) => D.rules.some((r) => r[0] === t);
const byName = (ids, nameFn) => [...new Set(ids)].sort((a, b) => nameFn(a).localeCompare(nameFn(b), "ru"));

// Скрытое значение не предлагается, кроме уже записанного в открытом наряде (f.keep) — чтобы наряд не ломался.
// Строки шаблона со скрытыми значениями база не отдаёт, поэтому строка записанного наряда добавляется отдельно.
const visible = (k, f) => (id) => !D.hid?.[k]?.has(id) || f.keep?.[k] === id;
const combosF = (f) => {
  const c = combos(f.cod), k = f.keep?.combo;
  return k && f.cod === f.keep.cod && !c.some((x) => x[0] === k[0] && x[1] === k[1] && x[2] === k[2]) ? [...c, k] : c;
};
const OPTS = {
  type: (f) => {
    if (!f.cod) return [];
    const ts = new Set(combosF(f).map((c) => c[0]));
    if ((pmCache.get(f.cod)?.steps || []).length || hasEo(f)) ts.add(TYPE_PM);
    return D.types.map((t) => t.id).filter((t) => ts.has(t) && hasRules(t)).filter(visible("type", f));
  },
  sub: (f) => {
    if (!f.type) return [];
    if (f.type === TYPE_PM) return [SUB_PM];
    return byName(combosF(f).filter((c) => c[0] === f.type).map((c) => c[1]), subName).filter(visible("sub", f));
  },
  fail: (f) => {
    if (!f.type || !f.sub) return [];
    if (f.type === TYPE_PM) return [...(hasEo(f) ? [EO_POS] : []), ...(pmCache.get(f.cod)?.steps || []).map((s) => s.pos)];
    return byName(combosF(f).filter((c) => c[0] === f.type && c[1] === f.sub).map((c) => c[2]), failName).filter(visible("fail", f));
  },
  dmg: (f) => (f.type ? [...new Set(D.rules.filter((r) => r[0] === f.type).map((r) => r[1]))].sort().filter(visible("dmg", f)) : []),
  reason: (f) => (f.type && f.dmg ? D.rules.filter((r) => r[0] === f.type && r[1] === f.dmg).map((r) => r[2]).sort().filter(visible("reason", f)) : []),
};
function optLabel(k, v) {
  if (k === "type") return typeName(v);
  if (k === "sub") return subName(v);
  if (k === "fail") return F.type === TYPE_PM ? pmLabel(F.cod, v) : failName(v);
  if (k === "dmg") return dmgName(v);
  return reasonName(v);
}
const pmLabel = (cod, pos) => Number(pos) === EO_POS ? EO_LABEL : (pmCache.get(cod)?.steps || []).find((s) => s.pos === Number(pos))?.label ?? `шаг ${pos}`;

// Каскад: всё, что стало недопустимым, очищается; единственный вариант выбирается сам;
// для ТО подставляется следующее ТО по циклу (правило 8).
function normalize() {
  for (const k of CLS) {
    const o = OPTS[k](F);
    if (F[k] != null && !o.includes(F[k])) F[k] = null;
    if (F[k] == null && o.length === 1 && k !== "type") F[k] = o[0];
    if (k === "fail" && F.type === TYPE_PM && F.fail == null && F.cod) {
      const n = pmCache.get(F.cod);
      if (n?.next_pos && o.includes(n.next_pos)) F.fail = n.next_pos;
    }
  }
}
function fsIdOfMachine(cod) { return D.fsByName.get(M(cod)?.fs) ?? 1; }
const machineFsLocked = (cod) => (M(cod)?.fs || "TR") === "TR";

async function loadPm(cod) {
  if (!cod || (pmCache.has(cod) && !pmCache.get(cod).failed)) return;
  let data = null;
  try { data = await rpc("repair_next_pm", { p_cod: cod }); } catch (_) { /* ниже */ }
  // Сбой не запоминаем: иначе шаги ТО пропадут до перезагрузки страницы, а не до следующего открытия машины.
  if (data) pmCache.set(cod, data);
  else pmCache.set(cod, { steps: [], failed: true });
}

// ---------- сервер ----------
// Ошибки сервера — как есть (это проверки ТЗ), но таймаут и обрыв связи — понятным текстом.
// e.unsure: ответ не дошёл, и сервер мог успеть записать — перед повтором надо проверить.
async function rpc(name, args) {
  let res;
  try { res = await supabase.rpc(name, args); } catch (e) { res = { error: { message: String(e?.message || e) } }; }
  const { data, error } = res;
  if (error) {
    const m = String(error.message || "");
    const e = new Error(m);
    if (error.code === "57014" || /statement timeout/i.test(m)) e.message = "Сервер не успел ответить (превышено время ожидания). Данные не сохранены, попробуйте ещё раз через минуту.";
    else if (!error.code && /fetch|network|load failed|abort/i.test(m)) { e.message = "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз."; e.unsure = true; }
    else if (/^5\d\d$/.test(String(res.status || "")) && !error.code) { e.message = "Ошибка сервера. Попробуйте ещё раз через минуту."; e.unsure = true; }
    throw e;
  }
  return data;
}
function showError(msg) { const el = $("#errorBanner"); el.textContent = msg; el.hidden = false; }
function clearError() { $("#errorBanner").hidden = true; }
function setLoading(on) { $("#loadingIndicator").style.display = on ? "block" : "none"; }
let toastT;
function toast(msg) { const t = $("#reToast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 4500); }
function setStick(html) { $("#reStick").hidden = !html; $("#reStickIn").innerHTML = html || ""; }
function setTitle(t) { $("#pageTitle").textContent = t; document.title = t; $("#reBack").hidden = V.name === "list"; }

// ---------- экраны ----------
const app = () => $("#reApp");
// #new, #wo-<наряд>, #day-<наряд>-<день> (#day-<наряд> = последний день наряда)
const hashOf = (v) => (v.name === "list" ? "" : v.name + (v.id ? "-" + v.id : "") + (v.name === "day" && v.dayId ? "-" + v.dayId : ""));
function parseHash() {
  const m = location.hash.replace(/^#/, "").match(/^(new|wo|day)(?:-(\d+))?(?:-(\d+))?$/);
  if (!m || (m[1] !== "new" && !m[2])) return null;
  return { name: m[1], id: m[2] ? Number(m[2]) : null, dayId: m[3] ? Number(m[3]) : null };
}
let holdDraft = true; // пока пользователь ничего не нажал, переход по ссылке не стирает сохранённый черновик
function go(v, push = true) {
  V = v;
  closing = false;
  if (push) history.pushState(v, "", "#" + hashOf(v));
  render();
  saveDraft();
  window.scrollTo(0, 0);
}
function render() {
  if (V.name === "list") renderList();
  else if (V.name === "new" || V.name === "day") renderForm();
  else if (V.name === "wo") renderWO();
}

function idleText(startS) {
  const h = Math.max(0, Math.floor((nowD() - parseDT(startS)) / 36e5));
  return h >= 24 ? `${Math.floor(h / 24)} д ${h % 24} ч` : `${h} ч`;
}
const clsLine = (x) => x.type_id === TYPE_PM
  ? `${typeName(x.type_id)} · ${esc(x.pm_label || "")}`
  : `${esc(typeName(x.type_id))} · ${esc(subName(x.subsys_id))} · ${esc(failName(x.failure_id))}`;

async function loadList() {
  const r = await rpc("repair_list");
  LIST = r.items;
}
// Наряд этой машины с тем же началом: второго такого быть не может (один открытый на машину, пересечения запрещены),
// значит он создан только что запросом, ответ на который не дошёл.
async function findCreated(p) {
  try { await loadList(); } catch (_) { return null; }
  return LIST.find((w) => Number(w.cod) === Number(p.cod) && String(w.started_at || "").replace(" ", "T").slice(0, 16) === p.start_at) || null;
}
function renderList() {
  setTitle("Service job");
  const q = (V.q || "").trim().toLowerCase();
  const match = (w) => { const m = Mx(w.cod); return !q || String(w.label || "").toLowerCase().includes(q) || String(w.order_no).includes(q) || (m && (String(m.code).toLowerCase().includes(q) || String(m.model).toLowerCase().includes(q))); };
  const open = LIST.filter((w) => w.status === "open" && inObj(w.cod) && match(w));
  const closed = LIST.filter((w) => w.status === "closed" && inObj(w.cod) && match(w)).slice(0, 15);
  app().innerHTML = `
  <div class="bar"><input class="search" id="q" data-bind="listq" placeholder="Машина, модель или № наряда" value="${esc(V.q || "")}" aria-label="Поиск"><button class="btn primary" data-act="new">+ Новый наряд</button></div>
  <h2>Открытые наряды · ${open.length}</h2>
  ${open.length ? `<div class="grid">${open.map((w) => { const m = M(w.cod); return `
    <button class="card" data-act="openwo" data-id="${w.id}">
      <div class="l1"><span class="code">${esc(m.code)}</span><span class="model">${esc(m.model)}</span>${offPill(m)}<span class="pill open">Открыт</span></div>
      <div>${clsLine(w.last)}</div>
      <div class="meta">${[m.missing ? `наряд № ${w.label || w.order_no}` : "", esc(m.mine || ""), "FS " + esc(fsName(w.last.fs_id))].filter(Boolean).join(" · ")}</div>
      <div class="meta">№ <span class="mono">${w.label || w.order_no}</span> · с ${ru(w.started_at)} ${timeOf(w.started_at)} · <span class="idle">стоит ${idleText(w.started_at)}</span></div>
    </button>`; }).join("")}</div>` : `<div class="list"><div class="empty">Открытых нарядов нет</div></div>`}
  <h2>Недавно закрытые</h2>
  <div class="list">${closed.length ? closed.map((w) => { const m = M(w.cod); return `
    <button class="lrow" data-act="openwo" data-id="${w.id}"><span class="code">${esc(m.code)}</span>
      <span><b>${esc(m.model)}</b>${offPill(m)} · ${clsLine(w.last)}<br><span class="meta">${ru(w.started_at)} ${timeOf(w.started_at)} – ${ru(w.finished_at)} ${timeOf(w.finished_at)} · № <span class="mono">${w.label || w.order_no}</span></span></span>
      <span class="pill closed">Закрыт</span></button>`; }).join("") : `<div class="empty">Ничего не найдено</div>`}</div>
`;
  setStick("");
}

// ---------- форма ----------
function blankForm() {
  const n = nowS();
  return { mode: "new", cod: null, date: n.slice(0, 10), time: n.slice(11, 16), done: false, endDate: n.slice(0, 10), endTime: n.slice(11, 16),
    type: null, sub: null, fail: null, dmg: null, reason: null, fs: null, staff: [], parts: [], comment: "", asRepair: false, q: "", touched: false, serverErr: "", meter: { tr: "", dr1: "", dr2: "" }, mInfo: null };
}
async function startNew(cod) {
  F = blankForm();
  if (cod) await selectMachine(cod);
  go({ name: "new" });
}
async function selectMachine(cod) {
  F.cod = Number(cod);
  F.cands = null;
  F.mInfo = null;
  F.fs = fsIdOfMachine(F.cod);
  await loadPm(F.cod);
  normalize();
  // Новый наряд, открытый в период ЕО площадки, — сразу тип из словаря разбора; слова типа в описании его заменят.
  if (F.mode === "new" && F.type == null) {
    const R = dictRules(), p = R && eoPeriod(R, F.time);
    if (p && OPTS.type(F).includes(p.type)) { F.type = p.type; normalize(); }
    // Период ЕО площадки дал тип «ТО», а у машины есть ЕО — это ежедневный осмотр, а не шаг цикла.
    if (F.type === TYPE_PM && hasEo(F)) pickEo();
  }
}
function pickEo() {
  F.fail = EO_POS;
  normalize();
  if (OPTS.reason(F).includes(EO_REASON)) F.reason = EO_REASON;
}

// Правила словаря разбора для машины формы: свои правила её рудника или общие.
function dictRules() {
  if (!PR?.sites) return null;
  return rulesForMine(PR.sites, F?.cod ? Mx(F.cod)?.mine : null);
}
// Словарь разбора главнее ответа ИИ и встроенного разбора: тип по периоду ЕО и словам, подсистема/отказ,
// причина по словам, инициатор по «тип + причина». Всё дальше проходит те же проверки, что и ручной ввод.
function applyDictRules(p, text) {
  const R = dictRules();
  if (!R || !F.cod || clsLocked()) return p;
  const time = F.mode === "new" || dayPos() === "only" || dayPos() === "first" ? p.start_time || F.time : null;
  const r = applyRules(R, text, time);
  if (r.type && OPTS.type({ cod: F.cod }).includes(r.type)) p.type = r.type;
  const type = p.type ?? F.type;
  // Тип ещё не известен (нет периода ЕО и слов типа) — подсистему, причину и инициатор из словаря
  // подставим, как только пользователь выберет тип (applyDictPending).
  F.dictPending = r.subs.length || r.reason ? { subs: r.subs, reason: r.reason } : null;
  if (type != null && type !== TYPE_PM && r.subs.length) {
    const subs = OPTS.sub({ cod: F.cod, type });
    const cand = r.subs.filter((x) => subs.includes(x.sub));
    const ids = [...new Set(cand.map((x) => x.sub))];
    if (ids.length === 1 && p.sub !== ids[0]) p.sub = ids[0];
    const sub = p.sub ?? F.sub;
    const pick = cand.find((x) => x.sub === sub && x.fail != null && OPTS.fail({ cod: F.cod, type, sub }).includes(x.fail));
    if (pick) p.fail = pick.fail;
  }
  if (r.reason) p.reason = r.reason;
  const d = type != null && p.reason != null ? (R.dmg || []).find((x) => x.type === type && x.reason === p.reason) : null;
  if (d) p.dmg = d.dmg;
  return p;
}
// Выбран тип работ — подставить отложенное из словаря: подсистему (если для этого типа она одна
// из найденных), отказ из той же строки словаря, инициатора по «тип + причина» и причину.
function applyDictPending() {
  const P = F.dictPending, R = dictRules();
  if (!P || !R || !F.cod || F.type == null || F.type === TYPE_PM || clsLocked()) return;
  if (F.sub == null && P.subs.length) {
    const subs = OPTS.sub(F);
    const ids = [...new Set(P.subs.filter((x) => subs.includes(x.sub)).map((x) => x.sub))];
    if (ids.length === 1) { F.sub = ids[0]; normalize(); }
  }
  if (F.sub != null && F.fail == null) {
    const pick = P.subs.find((x) => x.sub === F.sub && x.fail != null && OPTS.fail(F).includes(x.fail));
    if (pick) { F.fail = pick.fail; normalize(); }
  }
  if (P.reason != null && F.reason == null) {
    const d = (R.dmg || []).find((x) => x.type === F.type && x.reason === P.reason);
    if (F.dmg == null) {
      const dm = d ? [d.dmg] : [...new Set(D.rules.filter((x) => x[0] === F.type && x[2] === P.reason).map((x) => x[1]))];
      if (dm.length === 1 && OPTS.dmg(F).includes(dm[0])) { F.dmg = dm[0]; normalize(); }
    }
    if (OPTS.reason(F).includes(P.reason)) F.reason = P.reason;
    else F.pendingReason = P.reason; // применится после выбора инициатора
  }
}
const openWOFor = (cod) => LIST.find((w) => w.cod === Number(cod) && w.status === "open");

function dayPos() {
  if (F.mode !== "day" || !W) return null;
  const i = W.days.findIndex((d) => d.id === F.dayId);
  if (W.days.length < 2) return "only";
  if (F.makeLast) return i === 0 ? "only" : "last";
  return i === 0 ? "first" : i === W.days.length - 1 ? "last" : "mid";
}
const laterDays = () => (W && F?.dayId ? W.days.filter((d) => d.start_at > curDay().start_at) : []);
const clsLocked = () => F.mode === "day" && (dayPos() === "first" || dayPos() === "mid");
const isClosedView = () => F.mode === "day" && W?.status === "closed";
const curDay = () => W?.days.find((d) => d.id === F.dayId);

function startDay(dayId) {
  const d = W.days.find((x) => x.id === Number(dayId));
  F = { mode: "day", dayId: d.id, cod: W.cod, date: dateOf(d.start_at), time: timeOf(d.start_at), endTime: d.end_at ? timeOf(d.end_at) : null,
    type: d.type_id, sub: d.subsys_id, fail: d.type_id === TYPE_PM ? (d.pm_pos ?? (d.failure_id === EO_FAIL ? EO_POS : null)) : d.failure_id, dmg: d.damage_id, reason: d.reason_id, fs: d.fs_id,
    pmLabelSaved: d.pm_label, staff: d.staff.map((s) => ({ id: s.staff_id, from: s.from, to: s.to })),
    parts: d.parts.map((p) => ({ spare: p.spare, idx: p.idx || "", qty: p.qty })), comment: d.comment || "", asRepair: d.staff_as_repair, touched: false, serverErr: "", meter: { tr: "", dr1: "", dr2: "" }, mInfo: null,
    dayEnd: d.end_at ? timeOf(d.end_at) : "" }; // открытый день: окончание пустое (день идёт), время подставляется только в режиме закрытия
  // Значения записанного дня остаются в списках, даже если их потом скрыли в «Словаре разбора».
  F.keepEo = d.type_id === TYPE_PM && d.pm_pos == null && d.failure_id === EO_FAIL; // записанное ЕО остаётся, даже если ЕО у машины выключили
  F.keep = { cod: W.cod, type: d.type_id, sub: d.subsys_id, fail: d.type_id === TYPE_PM ? null : d.failure_id, dmg: d.damage_id, reason: d.reason_id,
    combo: d.type_id !== TYPE_PM && d.type_id && d.subsys_id && d.failure_id ? [d.type_id, d.subsys_id, d.failure_id] : null };
  if (W.status === "open") F.meter = { tr: d.meter?.tr ?? "", dr1: d.meter?.dr1 ?? "", dr2: d.meter?.dr2 ?? "" }; // сохранённое на сервере показание
  go({ name: "day", id: W.id, dayId: d.id });
  loadPm(W.cod).then(() => { if (V.name === "day") rerenderCls(); });
  describeParts(F.parts.map((p) => p.spare));
}

// Время «с–по» ремонта в этом дне — для галочки «время персонала как время ремонта» и подсказок.
function repairSpan() {
  if (F.mode === "new") {
    if (F.done) return { from: F.endDate === F.date ? F.time : "00:00", to: F.endTime, closed: true };
    if (F.date !== todayS()) return { why: "Доступно только в последнем дне простоя." };
    return { from: F.time, to: nowS().slice(11, 16), closed: false };
  }
  const p = dayPos();
  if (p === "first" || p === "mid") return { why: "Доступно только в последнем дне простоя." };
  const d = curDay();
  const ce = closingEnd();
  return { from: F.time, to: ce || (d.end_at ? timeOf(d.end_at) : nowS().slice(11, 16)), closed: !!d.end_at || !!ce };
}
function ongoingEnd() { return !F.makeLast && !F.dayEnd; }
// Закрытие — только явное действие (режим makeLast). Вписанное вручную окончание в обычном режиме наряд не закрывает:
// при сохранении форма спросит (см. H.saveDay).
function closingEnd() {
  if (F.mode !== "day" || W?.status !== "open") return null;
  return F.makeLast ? F.dayEnd || null : null;
}
// Окончание, вписанное в обычном режиме в открытый последний день (наряд при этом не закрывается).
function typedEnd() {
  if (F.mode !== "day" || W?.status !== "open" || F.makeLast || !F.dayEnd || curDay()?.end_at) return null;
  return dayPos() === "last" || dayPos() === "only" ? F.dayEnd : null;
}
function dayBounds() {
  // Границы, в которые должно попасть время персонала этого дня.
  if (F.mode === "new") {
    if (F.done) return { lo: F.endDate === F.date ? F.time : "00:00", hi: F.endTime };
    return { lo: F.time, hi: F.date < todayS() ? "23:59" : nowS().slice(11, 16) };
  }
  const d = curDay();
  return { lo: F.time, hi: closingEnd() || (d.end_at ? timeOf(d.end_at) : F.date < todayS() ? "23:59" : nowS().slice(11, 16)) };
}
function syncStaff() {
  const r = repairSpan();
  if (!r.from) F.asRepair = false;
  if (F.asRepair) F.staff.forEach((s) => { s.from = r.from; s.to = r.to; });
}

function validate() {
  const E = {};
  if (F.mode === "new") {
    if (!F.cod) E.code = "Выберите машину";
    else if (openWOFor(F.cod) && !F.done) E.code = "На машину уже открыт наряд";
    if (!F.date || !F.time) E.time = "Укажите дату и время начала";
    else {
      const st = F.date + "T" + F.time;
      if (st > nowS()) E.time = "Это время ещё не наступило";
      else if (F.done) {
        const en = F.endDate && F.endTime ? F.endDate + "T" + F.endTime : null;
        if (!en) E.time = "Укажите дату и время окончания";
        else if (en <= st) E.time = "Окончание должно быть позже начала";
        else if (en > nowS()) E.time = "Окончание ещё не наступило";
      }
    }
  } else if (!isClosedView() && (dayPos() === "only" || dayPos() === "first")) {
    const d = curDay();
    if (!F.time) E.time = "Укажите время начала";
    else if (dateOf(d.start_at) + "T" + F.time > nowS()) E.time = "Это время ещё не наступило";
    else if (d.end_at && F.time >= timeOf(d.end_at)) E.time = "Начало должно быть раньше окончания дня";
  }
  if (meterShown()) {
    const m = meterPayload(), info = F.mInfo?.key === meterKey() ? F.mInfo.data : null, req = needMeter();
    for (const ch of chansOf()) {
      const v = m[CH_KEYS[ch]];
      if (v == null || Number.isNaN(v)) { if (req) E["meter-" + ch] = "Наработка: введите показание " + ch; }
      else if (v < 0) E["meter-" + ch] = `Наработка ${ch} не может быть отрицательной`;
      else if (info?.err?.[ch]) E["meter-" + ch] = info.err[ch];
    }
  }
  if (F.mBusy && machineSpan()) E.mbusy = "Период пересекается с другой работой: " + F.mBusy;
  const ce = closingEnd();
  const te = typedEnd();
  if (te) {
    if (te <= F.time) E.time = "Окончание должно быть позже начала";
    else if (F.date === todayS() && te > nowS().slice(11, 16)) E.time = "Окончание ещё не наступило";
  }
  if (F.mode === "day" && F.makeLast && !F.dayEnd) E.time = "Укажите время окончания ремонта";
  if (ce) {
    if (ce <= F.time) E.time = "Окончание должно быть позже начала";
    else {
      if (!F.comment.trim()) E.comment = "Наряд закрывается: напишите комментарий, что сделано";
      if (!F.staff.length) E["staff-need"] = "Наряд закрывается: укажите персонал и время работы";
    }
  }
  if (!clsLocked()) {
    for (const k of CLS) if (F[k] == null) E[k] = "Выберите значение";
    if (!F.fs) E.fs = "Выберите FS";
  }
  const b = dayBounds();
  F.staff.forEach((s, i) => {
    let m = "";
    if (!s.id) m = "Выберите сотрудника";
    else if (!s.from || !s.to) m = "Укажите время работы";
    else if (s.to <= s.from) m = "Окончание должно быть позже начала";
    else if (b.lo && s.from < b.lo) m = `Раньше начала работы (${b.lo})`;
    else if (b.hi && s.to > b.hi) m = `Позже окончания (${b.hi})`;
    else if (F.staff.some((o, j) => j !== i && o.id === s.id && o.from && o.to && o.from < s.to && s.from < o.to)) m = "Этот интервал пересекается со строкой выше";
    else if (F.busy?.[i]) m = F.busy[i];
    if (m) E["staff-" + i] = m;
  });
  if (F.mode === "new" && F.done) {
    if (!F.comment.trim()) E.comment = "Работа закрывается: напишите комментарий, что сделано";
    if (!F.staff.length) E["staff-need"] = "Работа закрывается: укажите персонал и время работы";
  }
  if (!E["staff-need"] && F.parts.some((p) => (p.spare || "").trim()) && !F.staff.length) E["staff-need"] = "Установлены запчасти: укажите, кто их ставил, и время работы";
  F.parts.forEach((p, i) => {
    const pn = (p.spare || "").trim().toUpperCase(), ix = (p.idx || "").trim();
    const same = F.parts.filter((o) => (o.spare || "").trim().toUpperCase() === pn);
    if (!pn) E["part-" + i] = "Введите парт номер";
    else if (partDescr.has(pn) && partDescr.get(pn) === null) E["part-" + i] = "Такого номера нет в справочнике";
    else if (!(+p.qty > 0)) E["part-" + i] = "Количество должно быть больше нуля";
    else if (same.length > 1 && !ix) E["part-" + i] = "Номер повторяется: укажите индекс, чтобы различать места установки";
    else if (ix && same.filter((o) => (o.idx || "").trim() === ix).length > 1) E["part-" + i] = `Индекс ${ix} для ${pn} уже указан в строке выше`;
  });
  return E;
}

function renderForm() {
  const isNew = F.mode === "new";
  if (isNew) setTitle("Новый наряд");
  else { const m = M(W.cod); setTitle(`${m.missing ? "№ " + (W.label || W.order_no) : (m.model ? m.model + " " : "") + m.code} · день ${ru(F.date)}`); }
  const blocked = isNew && F.cod && openWOFor(F.cod) && !F.done;
  const closedView = isClosedView();
  app().innerHTML = `<div class="layout"><div>
      ${!closedView && !clsLocked() ? renderAI() : ""}
      ${isNew ? renderMachine() : ""}
      ${closedView ? `<div class="notice">Наряд закрыт, день открыт только для просмотра. Чтобы что-то изменить, переоткройте наряд.</div>` : ""}
      ${F.makeLast ? (laterDays().length
        ? `<div class="blocker"><b>День ${ru(F.date)} станет последним: наряд закроется в этот день.</b><div>Дни после него (${laterDays().length}) будут удалены. Укажите время окончания, персонал и комментарий и нажмите «Сохранить и закрыть наряд».</div><div class="bar"><button class="btn" data-act="cancelMakeLast">Отменить</button></div></div>`
        : `<div class="blocker"><b>Закрытие наряда</b><div>Укажите время окончания работ, персонал и комментарий и нажмите «Сохранить и закрыть наряд».</div><div class="bar"><button class="btn" data-act="cancelMakeLast">Отменить</button></div></div>`) : ""}
      <div id="formBody">${closedView ? `<fieldset class="rofs" disabled>${renderBody()}</fieldset>` : blocked ? renderBlocker() : renderBody()}</div>
      <div class="servererr" id="serverErr">${esc(F.serverErr || "")}</div>
    </div>
    <aside class="aside"><div class="checks" id="checks"></div></aside></div>`;
  if (closedView) setStick(`<button class="btn" data-act="back">← К наряду</button>`);
  else setStick(blocked ? `<button class="btn" data-act="back">Отмена</button>`
    : `<span class="stick-err" id="stickErr" role="alert"></span><button class="btn ghost" data-act="back">Отмена</button><button class="btn primary" data-act="${isNew ? "saveNew" : "saveDay"}" ${busy ? "disabled" : ""}>${isNew ? (F.done ? "Закрыть работу" : "Открыть наряд") : F.makeLast ? "Сохранить и закрыть наряд" : "Сохранить день"}</button>`);
  if (F.cod) { afterPartsRender(); checkBusy(); checkMachineBusy(); checkMeter(); }
  refresh();
}
function renderMachine() {
  const q = (F.q || "").trim().toLowerCase();
  // После разбора текста с неоднозначным номером показываем только подходящие машины.
  const cands = !F.cod && !q && F.cands?.length ? new Set(F.cands) : null;
  const only = F.cod && F.onlyCod === F.cod; // машину нашёл разбор описания — показываем только её
  const list = D.machines.filter((m) => !m.inactive && inObj(m.cod)).filter((m) => (only ? m.cod === F.cod : cands ? cands.has(m.cod) : !q || String(m.code).toLowerCase().includes(q) || String(m.model).toLowerCase().includes(q) || String(m.mine || "").toLowerCase().includes(q)));
  const shown = list;
  return `<section class="sec" id="sec-code"><h3><span class="num">1</span> Машина</h3>
    <div class="field"><input class="inp" id="mq" data-bind="mq" placeholder="Бортовой номер, модель или рудник" value="${esc(F.q || "")}" aria-label="Поиск машины">
    ${only ? `<div class="hint">Машина найдена по описанию. Нужна другая — измените поиск.</div>` : ""}
    ${cands ? `<div class="hint">${F.candsByModel ? "Номер в описании не найден — показаны машины названной модели, выберите нужную." : "С таким бортовым номером несколько машин — выберите нужную (в описании можно указать модель или рудник)."}</div>` : ""}
    <div class="mgrid">${shown.map((m) => { const o = openWOFor(m.cod); return `<button class="chip m" data-act="machine" data-v="${m.cod}" aria-pressed="${F.cod === m.cod}"><b>${esc(m.code)}</b><small>${esc(m.model)}${cands ? " · " + esc(m.mine || "") : ""} · FS ${esc(m.fs)}</small>${o ? '<span class="pill open">Открыт наряд</span>' : ""}</button>`; }).join("") || '<span class="hint">Машина не найдена</span>'}</div>
    <div class="err" data-err="code"></div></div></section>`;
}
function renderBlocker() {
  const w = openWOFor(F.cod), m = M(F.cod);
  return `<div class="blocker"><b>На ${esc(m.code)} ${esc(m.model)} уже открыт наряд № <span class="mono">${w.label || w.order_no}</span></b>
    <div>${clsLine(w.last)} · с ${ru(w.started_at)} ${timeOf(w.started_at)}. Второй наряд на одну машину открыть нельзя, продолжите работу в открытом.</div>
    <div class="bar"><button class="btn primary" data-act="openwo" data-id="${w.id}">Продолжить наряд</button><button class="btn" data-act="histmode">Внести закончённый ремонт</button></div>
    <span class="hint">Закончённый ремонт из прошлого можно внести, если он закончился до начала открытого наряда.</span></div>`;
}
function renderBody() {
  // Раздел «Когда» — как в прототипе: два поля одинакового размера; промежуточный день — без раздела.
  const isNew = F.mode === "new", dp = dayPos(), hideTime = dp === "mid", n = (isNew ? 1 : 0) - (hideTime ? 1 : 0);
  const noMachine = isNew && !F.cod;
  let when = "";
  if (isNew) {
    when = `<div class="row2"><label class="field"><span class="lab">Дата начала</span><input class="inp" type="date" data-bind="date" value="${F.date}" max="${todayS()}"></label>
      <label class="field"><span class="lab">Время</span><input class="inp" type="time" data-bind="time" value="${F.time}"></label></div>
      <span class="hint">Подставлены текущие дата и время.</span>
      <label class="chk"><input type="checkbox" data-bind="done" ${F.done ? "checked" : ""}><span>Ремонт уже закончен, вношу задним числом. Наряд сохранится сразу закрытым.</span></label>
      ${F.done ? `<div class="row2"><label class="field"><span class="lab">Дата окончания</span><input class="inp" type="date" data-bind="endDate" value="${F.endDate}" max="${todayS()}"></label>
      <label class="field"><span class="lab">Время</span><input class="inp" type="time" data-bind="endTime" value="${F.endTime}"></label></div>` : ""}`;
  } else if (!hideTime) {
    const d = curDay();
    const startEditable = dp === "only" || dp === "first";
    const start = `<label class="field"><span class="lab">Начало</span><input class="inp" type="time" data-bind="time" value="${startEditable ? F.time : "00:00"}" ${startEditable ? "" : "readonly"}></label>`;
    let end;
    if (dp === "first") end = `<div class="field"><span class="lab">Окончание</span><div class="locked">23:59 <small>день не последний</small></div></div>`;
    else if ((!d.end_at || F.makeLast) && W.status === "open") end = `<label class="field"><span class="lab">Окончание${ongoingEnd() ? " (день идёт)" : ""}</span><input class="inp" type="time" data-bind="dayEnd" value="${F.dayEnd}"></label>`;
    else end = `<label class="field"><span class="lab">Окончание</span><input class="inp" type="time" value="${d.end_at ? timeOf(d.end_at) : ""}" readonly></label>`;
    when = `<div class="row2">${start}${end}</div>${dp === "first" ? '<span class="hint">Первый день простоя: меняется только начало, день идёт до 23:59.</span>' : ""}${!isNew && W.status === "open" && !d.end_at && !F.makeLast && (dp === "last" || dp === "only") ? '<span class="hint">«Сохранить день» наряд не закрывает. Чтобы закрыть, нажмите «Закрыть наряд» на экране наряда.</span>' : ""}`;
  }
  return `${hideTime ? `<div class="notice">Промежуточный день простоя: время фиксировано, 00:00–23:59.</div>` : `<section class="sec"><h3><span class="num">${n + 1}</span> Когда</h3><div class="field">${when}<div class="err" data-err="time"></div><div class="err" data-err="mbusy"></div></div></section>`}
  <section class="sec"><h3><span class="num">${n + 2}</span> Что случилось</h3><div id="cls">${noMachine ? '<span class="hint">Сначала выберите машину.</span>' : renderCls()}</div></section>
  <section class="sec"><h3><span class="num">${n + 3}</span> Персонал</h3><div id="staff">${noMachine ? '<span class="hint">Сначала выберите машину.</span>' : renderStaff()}</div></section>
  <section class="sec"><h3><span class="num">${n + 4}</span> Запчасти</h3><div id="parts">${noMachine ? '<span class="hint">Сначала выберите машину.</span>' : renderParts()}</div></section>
  <section class="sec"><h3><span class="num">${n + 5}</span> Комментарий</h3>
    <div class="field"><label class="lab" for="fComment">Что сделано за день</label><textarea class="inp" id="fComment" data-bind="comment" rows="3">${esc(F.comment)}</textarea>
    <span class="hint">Комментарий в новые дни не копируется.</span><div class="err" data-err="comment"></div></div></section>`;
}
function chipGroup(k) {
  const o = OPTS[k](F);
  if (!o.length) {
    const need = { sub: "тип работ", fail: "подсистему", dmg: "тип работ", reason: "инициатора", type: "машину" }[k];
    const empty = k === "type" && F.cod ? "Для этой машины в шаблоне нет ни одного типа работ — напишите администратору" : `Сначала выберите ${need}`;
    return `<div class="field"><span class="lab">${CLS_LAB[k]}</span><span class="hint">${empty}</span><div class="err" data-err="${k}"></div></div>`;
  }
  const flt = (F.flt || {})[k] || "";
  const long = o.length > CHIP_LIMIT;
  const shown = long && flt ? o.filter((v) => optLabel(k, v).toLowerCase().includes(flt.toLowerCase()) || v === F[k]) : o;
  const lab = k === "fail" && F.type === TYPE_PM ? "Шаг ТО" : CLS_LAB[k];
  return `<div class="field" id="f-${k}"><span class="lab">${lab}${o.length === 1 && k !== "type" ? ' <span class="hint">единственный вариант</span>' : ""}</span>
    ${long ? `<input class="inp" data-bind="flt" data-k="${k}" value="${esc(flt)}" placeholder="Поиск: ${o.length} вариантов" aria-label="Поиск: ${lab}">` : ""}
    <div class="chips" role="group" aria-label="${lab}">${shown.map((v) => `<button class="chip${k === "fail" && F.type === TYPE_PM && v === EO_POS ? " eo" : ""}" data-act="pick" data-f="${k}" data-v="${v}" aria-pressed="${F[k] === v}"${k === "fail" && F.type === TYPE_PM && v === EO_POS ? ' title="Ежедневный осмотр — в цикл ТО не входит"' : ""}>${esc(optLabel(k, v))}</button>`).join("") || '<span class="hint">Ничего не найдено</span>'}</div>
    <div class="err" data-err="${k}"></div></div>`;
}
function renderCls() {
  if (clsLocked()) {
    const last = W.days[W.days.length - 1];
    const kv = [["Тип работ", typeName(F.type)], ["Подсистема", subName(F.sub)], [F.type === TYPE_PM ? "Шаг ТО" : "Отказ", F.type === TYPE_PM ? F.pmLabelSaved : failName(F.fail)],
      ["Инициатор", dmgName(F.dmg)], ["Причина", reasonName(F.reason)], ["FS", fsName(F.fs)]];
    return `<div class="ro">${kv.map(([k, v]) => `<div class="kv"><span>${k}</span><b>${esc(v || "—")}</b></div>`).join("")}</div>
      <span class="hint">Это не последний день простоя: тип работ, подсистема, отказ, инициатор, причина и FS меняются в последнем дне (${ru(last.start_at)}) и применяются ко всем дням наряда.</span>
      ${isClosedView() ? "" : `<div class="bar"><button class="btn add" data-act="day" data-id="${last.id}">Открыть последний день</button><button class="btn add" data-act="makeLast">Сделать последним днём</button></div>`}`;
  }
  const m = M(F.cod);
  let fs;
  if (machineFsLocked(F.cod)) fs = `<div class="locked">TR <small>из настроек машины</small></div>`;
  else {
    const first = fsIdOfMachine(F.cod);
    fs = `<div class="chips">${[first, ...D.fs.map((x) => x.id).filter((x) => x !== first)].map((v) => `<button class="chip" data-act="pickfs" data-v="${v}" aria-pressed="${F.fs === v}">${esc(fsName(v))}</button>`).join("")}</div><span class="hint">В настройках машины ${esc(m.fs)}, поэтому FS выбирается из трёх систем; значение из карточки предложено первым.</span>`;
  }
  let pm = "";
  if (F.type === TYPE_PM) {
    const n = pmCache.get(F.cod);
    if (F.fail === EO_POS) pm = `<div class="pm"><b>ЕО — ежедневный осмотр.</b> В цикл ТО не входит: последнее закрытое ТО (${n?.last_label ? `${esc(n.last_label)} от ${ruY(String(n.last_date))}` : "нет данных"}) и следующее по циклу (${esc(n?.next_label || "—")}) не меняются.</div>`;
    else if (!n) pm = `<div class="pm">Загружаю цикл ТО…</div>`;
    else if (!(n.steps || []).length) pm = `<div class="pm">У машины не задан цикл ТО (поле «период» в карточке оборудования).</div>`;
    else pm = `<div class="pm">Последнее закрытое: ${n.last_label ? `<b>${esc(n.last_label)}</b> от ${ruY(String(n.last_date))}` : "нет данных"}. Следующее по циклу: <b>${esc(n.next_label || "—")}</b>${F.fail && F.fail !== n.next_pos ? ` · выбрано вручную <b>${esc(pmLabel(F.cod, F.fail))}</b>` : ""}.</div>`;
  }
  const multi = F.mode === "day" && W.days.length > 1;
  return chipGroup("type") + chipGroup("sub") + pm + chipGroup("fail") + chipGroup("dmg") + chipGroup("reason")
    + `<div class="field"><span class="lab">FS</span>${fs}<div class="err" data-err="fs"></div></div>`
    + `<div id="meter">${renderMeter()}</div>`
    + `<div id="sug">${renderSug()}</div>`
    + (multi ? `<span class="hint">Это последний день простоя: изменения здесь применятся ко всем дням наряда.</span>` : "");
}
const MAIL = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>';
function sugCtx() {
  const m = M(F.cod);
  return [m && `${m.code} ${m.model}`, F.type && typeName(F.type), F.sub && subName(F.sub), F.fail != null && optLabel("fail", F.fail), F.dmg && dmgName(F.dmg), F.reason && reasonName(F.reason)].filter(Boolean).join(" → ");
}
function renderSug() {
  if (!F.sugOpen) return `<button class="btn add ghost" data-act="suggest">${MAIL} Нет нужного варианта? Написать админу</button>`;
  return `<div class="sugbox"><b>Предложение администратору</b><span class="hint">Уйдёт вместе с выбранным: ${esc(sugCtx() || "машина не выбрана")}</span>
    <textarea class="inp" id="sugText" rows="3" placeholder="Например: у этой машины нет отказа «Гидроцилиндр рулевого» в подсистеме «Рабочее оборудование»"></textarea>
    <div class="err" id="sugErr"></div>
    <div class="bar"><button class="btn primary" data-act="sendsug">${MAIL} Отправить</button><button class="btn ghost" data-act="cancelsug">Отмена</button></div></div>`;
}
// ---------- поле с поиском (персонал, запчасти): первые буквы → совпадения, «▾» → весь список ----------
let CB = { key: null, q: "", all: false, items: [], more: false, offset: 0 };
const startsWord = (text, q) => { const t = String(text || "").toLowerCase(); return t.startsWith(q) || t.split(/[\s.,()\/-]+/).some((w) => w.startsWith(q)); };
function staffRank(s) { const m = M(F.cod); return s.mine && s.mine === m?.mine ? 0 : s.object === m?.object ? 1 : 2; }
// Только рабочие шахты выбранной машины (колонка «рудник» в справочнике персонала);
// если по шахте никого нет — рабочие её объекта.
function staffPool(cod = F.cod) {
  const m = M(cod);
  if (!m || m.missing) return [];
  const byMine = D.staff.filter((s) => s.mine === m.mine);
  return byMine.length ? byMine : D.staff.filter((s) => s.object === m.object);
}
function staffList(q, all) {
  const qq = q.trim().toLowerCase();
  if (!qq && !all) return [];
  return staffPool().filter((s) => !qq || startsWord(s.name, qq)).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}
function comboHtml(key, value, placeholder, cls = "") {
  return `<div class="cbx" data-cbx="${key}"><div class="cbx-row"><input class="inp ${cls}" data-bind="cbq" data-key="${key}" value="${esc(value)}" placeholder="${placeholder}" autocomplete="off" aria-label="${placeholder}">
    <button type="button" class="btn small ghost cbx-all" data-act="cball" data-key="${key}" title="Весь список" aria-label="Весь список">▾</button></div>
    <div class="cbl" data-cbl="${key}" hidden></div></div>`;
}
function renderCB() {
  document.querySelectorAll("[data-cbl]").forEach((el) => { if (el.dataset.cbl !== CB.key) { el.hidden = true; el.innerHTML = ""; } });
  if (!CB.key) return;
  const el = document.querySelector(`[data-cbl="${CB.key}"]`);
  if (!el) return;
  const [kind] = CB.key.split("-");
  let html = "";
  if (kind === "staff") {
    const m = M(F.cod);
    let group = -1;
    for (const x of CB.items.slice(0, 300)) {
      const g = staffRank(x);
      if (CB.all && g !== group) { group = g; html += `<div class="cbg">${g === 0 ? `Шахта ${esc(m?.mine || "")}` : `Объект ${esc(m?.object || "")}`}</div>`; }
      html += `<button type="button" class="cbi" data-act="cbpick" data-key="${CB.key}" data-v="${x.id}">${esc(x.name)}<small>${esc([x.pos && x.pos !== "нет данных" ? x.pos : "", x.mine || x.object].filter(Boolean).join(" · "))}</small></button>`;
    }
  } else {
    html = CB.items.map((x) => `<button type="button" class="cbi" data-act="cbpick" data-key="${CB.key}" data-v="${esc(x.spare)}"><span class="mono">${esc(x.spare)}</span><small>${esc(x.descr || "")}</small></button>`).join("");
    if (CB.more) html += `<button type="button" class="cbi more" data-act="cbmore" data-key="${CB.key}">Показать ещё…</button>`;
  }
  el.innerHTML = html || `<div class="cbg">${CB.q ? "Нет совпадений" : "Начните вводить или нажмите ▾"}</div>`;
  el.hidden = false;
}
let cbTimer;
async function loadCB(key, q, all, offset = 0) {
  const [kind] = key.split("-");
  CB = { ...CB, key, q, all, offset };
  if (kind === "staff") { CB.items = staffList(q, all); CB.more = false; renderCB(); return; }
  if (!all && q.trim().length < 1) { CB.items = []; CB.more = false; renderCB(); return; }
  clearTimeout(cbTimer);
  cbTimer = setTimeout(async () => {
    try {
      const r = await rpc("repair_find_parts", { p_q: all ? "" : q, p_offset: offset, p_limit: 50 });
      if (CB.key !== key) return;
      for (const x of r.items) partDescr.set(x.spare.toUpperCase(), x.descr);
      CB.items = offset ? CB.items.concat(r.items) : r.items;
      CB.more = r.items.length === 50;
      renderCB();
    } catch (_) { /* без подсказок */ }
  }, offset ? 0 : 250);
}
function closeCB() { if (CB.key) { CB = { key: null, q: "", all: false, items: [], more: false, offset: 0 }; renderCB(); } }

// Правило 10 сразу: занят ли сотрудник в это время в других работах (проверяет база).
let busyTimer;
const busyKey = () => JSON.stringify([F.cod, F.mode, F.dayId, F.mode === "new" ? (F.done ? F.endDate : F.date) : F.date, F.staff.map((x) => [x.id, x.from, x.to])]);
function checkBusy() {
  clearTimeout(busyTimer);
  busyTimer = setTimeout(async () => {
    if (!F || !F.cod) return;
    // Перерисовка формы вызывает проверку заново: если сотрудники и время не менялись, повторно базу не спрашиваем.
    const key = busyKey();
    if (F.busyKey === key) return;
    const date = F.mode === "new" ? (F.done ? F.endDate : F.date) : F.date;
    const res = await Promise.all(F.staff.map((x) => (x.id && x.from && x.to && x.to > x.from
      ? rpc("repair_staff_busy", { p_staff: Number(x.id), p_date: date, p_from: x.from, p_to: x.to, p_skip_day: F.mode === "day" ? F.dayId : null }).catch(() => null)
      : Promise.resolve(null))));
    if (!F || busyKey() !== key) return; // пока ждали ответ, персонал или время поменяли
    F.busy = res;
    F.busyKey = key;
    refresh();
  }, 300);
}
// ---------- наработка машины (TR/DR1/DR2): при закрытии вводится общая наработка (показание счётчика), прирост считает сервер ----------
const CH_KEYS = { TR: "tr", DR1: "dr1", DR2: "dr2" };
const fmtH = (n) => { const [i, f] = String(Math.round(Number(n) * 10) / 10).split("."); return i.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + (f ? "," + f : ""); };
const machineChans = (cod) => { const fs = Mx(cod)?.fs || "TR"; return fs === "DR2" ? ["TR", "DR1", "DR2"] : fs === "DR1" ? ["TR", "DR1"] : ["TR"]; };
// Поле показывается сразу при открытии последнего дня открытого наряда (и в «ремонт закончен» нового наряда); в промежуточных днях его нет.
// Обязательно оно только при закрытии наряда: сохранить день можно и без него, показание сохраняется вместе с закрытием.
function meterShown() {
  if (!F || !F.cod) return false;
  if (F.mode === "new") return !!F.done;
  return F.mode === "day" && W?.status === "open" && (!!F.makeLast || ["last", "only"].includes(dayPos()));
}
function needMeter() {
  if (!meterShown()) return false;
  return F.mode === "new" ? !!F.done : !!F.makeLast;
}
const meterEntered = () => Object.values(meterPayload()).some((v) => v != null && !Number.isNaN(v));
function meterAt() {
  if (F.mode === "new") return F.done && F.endDate && F.endTime ? F.endDate + "T" + F.endTime : null;
  return F.dayEnd ? F.date + "T" + F.dayEnd : nowS(); // день идёт: сверяем с текущим моментом
}
const chansOf = () => F.mInfo?.data?.chans || machineChans(F.cod);
function meterPayload() {
  const o = {};
  for (const ch of chansOf()) { const v = String(F.meter?.[CH_KEYS[ch]] ?? "").trim().replace(",", "."); o[CH_KEYS[ch]] = v === "" ? null : Number(v); }
  return o;
}
const meterKey = () => `${F.cod}|${meterShown() ? meterAt() : null}|${meterShown() ? JSON.stringify(meterPayload()) : null}`;
const prevText = (p) => !p ? "предыдущего показания нет"
  : p.src === "smh" ? `пред.: ${fmtH(p.total)} ч · ${ruY(String(p.at))} · данные Access`
  : `пред.: ${fmtH(p.total)} ч · ${ru(String(p.at))} ${timeOf(String(p.at))} · наряд № ${p.wo || ""}`;
function renderMeter() {
  if (!meterShown()) return "";
  const info = F.mInfo?.data;
  return `<div class="field meter"><span class="lab">Наработка машины, ч <span class="hint">общая (показание счётчика), не за сутки${needMeter() ? "" : ". Сохраняется вместе с днём, обязательна при закрытии наряда"}</span></span>`
    + chansOf().map((ch) => { const k = CH_KEYS[ch]; return `<label class="field"><span class="lab">${ch}</span>
      <input class="inp mono" type="number" min="0" step="any" inputmode="decimal" data-bind="meter" data-ch="${k}" value="${esc(F.meter?.[k] ?? "")}" aria-label="Наработка ${ch}, ч">
      <span class="hint" data-mprev="${ch}">${esc(prevText(info?.prev?.[ch]))}</span><div class="err" data-err="meter-${ch}"></div></label>`; }).join("")
    + `</div>`;
}
let meterTimer;
function checkMeter() {
  clearTimeout(meterTimer);
  meterTimer = setTimeout(async () => {
    if (!F || !F.cod) return;
    const key = meterKey();
    if (F.mInfo?.key === key) return;
    try {
      const data = await rpc("repair_meter_last", { p_cod: F.cod, p_at: meterShown() ? meterAt() : null, p_meter: meterShown() && (needMeter() || meterEntered()) ? meterPayload() : null });
      if (!F || meterKey() !== key) return; // пока ждали ответ, значения поменяли
      F.mInfo = { key, data };
      document.querySelectorAll("[data-mprev]").forEach((el) => (el.textContent = prevText(data.prev?.[el.dataset.mprev])));
      renderIx();
      refresh();
    } catch (_) { /* без подсказки: решает сервер при сохранении */ }
  }, 300);
}
// Наработка детали = текущее показание TR минус показание при прошлой установке; без введённого показания считаем от последнего известного (≈)
function curTr() {
  const v = String(F.meter?.tr ?? "").trim().replace(",", ".");
  if (meterShown() && v !== "" && !Number.isNaN(Number(v))) return { v: Number(v), approx: false };
  const p = F.mInfo?.data?.prev?.TR;
  return p ? { v: Number(p.total), approx: true } : null;
}
const partHours = (x) => { const c = curTr(); return x?.tr != null && c ? `${c.approx ? "≈" : ""}${fmtH(Math.max(0, c.v - Number(x.tr)))} ч` : ""; };

// Пересечение по машине заранее (RPC repair_machine_busy, решает всё равно сервер). Если RPC нет — подсказки просто нет.
let mbTimer;
function machineSpan() {
  if (!F || !F.cod) return null;
  let from, to;
  if (F.mode === "new") {
    if (!F.date || !F.time) return null;
    from = F.date + "T" + F.time;
    to = F.done ? (F.endDate && F.endTime ? F.endDate + "T" + F.endTime : null) : nowS();
  } else {
    if (!W || isClosedView()) return null;
    const dp = dayPos();
    // Только та часть, которую правят в этом дне (не весь многодневный наряд): иначе чужие работы посреди долгого простоя дают ложные пересечения.
    if (F.makeLast) { from = F.date + "T" + (dp === "only" ? F.time : "00:00"); to = F.dayEnd ? F.date + "T" + F.dayEnd : null; }
    else if (dp === "only") { from = F.date + "T" + F.time; to = W.status === "closed" ? W.finished_at.slice(0, 16) : nowS(); }
    else if (dp === "first") { from = F.date + "T" + F.time; to = F.date + "T23:59"; }
    else return null;
  }
  return from && to && to > from ? { from, to } : null;
}
function checkMachineBusy() {
  clearTimeout(mbTimer);
  mbTimer = setTimeout(async () => {
    if (!F) return;
    const sp = machineSpan();
    if (!sp) { if (F.mBusy || F.mBusyKey) { F.mBusy = ""; F.mBusyKey = ""; refresh(); } return; }
    const key = `${F.cod}|${sp.from}|${sp.to}`;
    if (F.mBusyKey === key) return;
    let msg = null, ok = true;
    try { msg = await rpc("repair_machine_busy", { p_cod: F.cod, p_from: sp.from, p_to: sp.to, p_skip_wo: F.mode === "day" ? W.id : null }); } catch (_) { ok = false; }
    if (!F || !ok) return;
    const now = machineSpan();
    if (!now || `${F.cod}|${now.from}|${now.to}` !== key) return; // пока ждали ответ, время поменяли
    F.mBusyKey = key;
    F.mBusy = msg || "";
    refresh();
  }, 300);
}
function renderStaff() {
  syncStaff();
  const r = repairSpan(), lock = F.asRepair ? "disabled" : "", dp = dayPos();
  // Время окончания ремонта в этом дне — подсказка для «по» (как repairEnd() в прототипе).
  const end = F.mode === "day" ? (curDay()?.end_at ? timeOf(curDay().end_at) : closingEnd() || nowS().slice(11, 16)) : F.done && F.endDate === F.date ? F.endTime : null;
  const asRep = dp === "mid" || dp === "first" ? "" : `<label class="chk"><input type="checkbox" data-bind="asRepair" ${F.asRepair ? "checked" : ""} ${r.from ? "" : "disabled"}><span>Время работы персонала как время ремонта${r.from ? ` (${r.from}–${r.to})` : ""}${r.from ? (r.closed ? "" : `<br><span class="hint">Простой ещё не закрыт. Если он продолжится на следующий день, персонал и время этого дня будут удалены, а день отмечен «нет людей»: время ремонта изменится.</span>`) : `<br><span class="hint">${r.why}</span>`}</span></label>`;
  return asRep + F.staff.map((s, i) => `<div class="item-wrap"><div class="item">
      ${comboHtml(`staff-${i}`, s.id ? staffName(s.id) : s.q || "", "Сотрудник…")}
      <input class="inp" type="time" data-bind="staff.from" data-i="${i}" value="${s.from || ""}" aria-label="С" ${lock}>
      <input class="inp" type="time" list="tEnd" data-bind="staff.to" data-i="${i}" value="${s.to || ""}" aria-label="По" ${lock}>
      <button class="x" data-act="delstaff" data-i="${i}" aria-label="Убрать">×</button></div>
      <div class="err" data-err="staff-${i}"></div></div>`).join("")
    + `<datalist id="tEnd">${end ? `<option value="${end}" label="окончание ремонта">` : ""}</datalist><div class="err" data-err="staff-need"></div><button class="btn add" data-act="addstaff">+ Сотрудник</button><span class="hint">Укажите исполнителя. Один сотрудник не может пересекаться в разных работах в одно и то же время, стык минута в минуту допустим.</span>`;
}

// ---------- верхний модуль «Опишите работу» ----------
let AI_ON = false; // Claude доступен (Edge Function repair-ai отвечает)
let aiBusy = false;
// Голосовой ввод описания (Web Speech API браузера): одна фраза — пока человек не замолчит,
// распознанный текст добавляется в описание и сразу отправляется на разбор (как «Разложить по полям»).
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, micOn = false;
const MIC_ERR = {
  "not-allowed": "Нет доступа к микрофону — разрешите микрофон для этого сайта в настройках браузера.",
  "service-not-allowed": "Распознавание речи запрещено в этом браузере.",
  "no-speech": "Ничего не услышал — нажмите и говорите ещё раз.",
  "audio-capture": "Микрофон не найден.",
  network: "Распознавание речи недоступно — нет связи с интернетом.",
};
function micBtn() {
  if (!SR) return `<button class="btn ghost" disabled title="Этот браузер не поддерживает голосовой ввод (работает в Chrome, Edge, Safari)">Голосовой ввод недоступен</button>`;
  return `<button class="btn ${micOn ? "mic-rec" : "ghost"}" id="micBtn" data-act="mic" ${aiBusy ? "disabled" : ""} aria-pressed="${micOn}">${micOn ? "🔴 Запись..." : "Нажать и говорить"}</button>`;
}
const renderMic = () => { const b = $("#micBtn"); if (b) b.outerHTML = micBtn(); };
function startMic() {
  rec = new SR();
  rec.lang = "ru-RU";
  rec.continuous = false;      // остановка, когда пользователь замолчал
  rec.interimResults = false;  // только окончательный текст
  rec.maxAlternatives = 1;
  let said = "";
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) said += e.results[i][0].transcript;
  };
  rec.onerror = (e) => {
    if (e.error === "aborted") return;
    F.aiRes = esc(MIC_ERR[e.error] || "Голосовой ввод не сработал: " + e.error);
    const r = $("#aiRes"); if (r) r.innerHTML = F.aiRes;
  };
  rec.onend = () => {
    micOn = false; rec = null; renderMic();
    said = said.trim();
    if (!said || !F || V.name === "list") return;
    // Добавляем к уже написанному описанию и сразу отправляем на разбор — без лишних нажатий.
    F.aitext = ((F.aitext || "").trim() + " " + said).trim();
    const t = $("#aiText"); if (t) t.value = F.aitext;
    saveDraft();
    H.ai();
  };
  try { rec.start(); micOn = true; F.aiRes = ""; const r = $("#aiRes"); if (r) r.innerHTML = ""; }
  catch (_) { rec = null; micOn = false; }
  renderMic();
}
// Вызов repair-ai с ограничением ожидания: функция сама ждёт ИИ не дольше 25 с (с одним повтором),
// но если ответа нет совсем (сеть, платформа сняла функцию), форма не должна висеть на «Разбираю…».
// Весь разбор (один или два вызова ИИ) — не дольше AI_TOTAL_MS (Андрей, 2026-10-06: не более 6 с);
// не успел — поля заполняет внутренний разбор по справочникам.
const AI_TOTAL_MS = 6_000;
const AI_CLIENT_TIMEOUT_MS = AI_TOTAL_MS;
const AI_TIMEOUT_MSG = "ИИ не ответил. Попробуйте ещё раз или заполните поля вручную";
async function aiInvoke(body, ms = AI_CLIENT_TIMEOUT_MS) {
  const ctl = new AbortController();
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new Error(AI_TIMEOUT_MSG)); }, ms); });
  try {
    const { data, error } = await Promise.race([supabase.functions.invoke("repair-ai", { body, signal: ctl.signal }), timeout]);
    if (error) {
      // Текст ошибки функции (ok:false, error) — в теле ответа; иначе — общий текст ошибки вызова.
      let msg = "";
      try { msg = (await error.context?.json?.())?.error || ""; } catch (_) { /* тело не JSON */ }
      throw new Error(msg || (ctl.signal.aborted ? AI_TIMEOUT_MSG : "ИИ недоступен: " + (error.message || "ошибка сети")));
    }
    if (!data || data.ok === false) throw new Error(data?.error || "ИИ недоступен");
    return data;
  } catch (e) {
    throw new Error(ctl.signal.aborted ? AI_TIMEOUT_MSG : e?.name === "TypeError" ? "Нет связи с сервером ИИ. Попробуйте ещё раз или заполните поля вручную" : e?.message || "ИИ недоступен");
  } finally { clearTimeout(timer); }
}
async function checkAI() {
  try {
    const { data, error } = await Promise.race([
      supabase.functions.invoke("repair-ai", { body: { ping: true } }),
      new Promise((res) => setTimeout(() => res({ error: new Error("timeout") }), AI_TOTAL_MS)),
    ]);
    AI_ON = !error && data?.ok === true;
  } catch (_) { AI_ON = false; }
  const el = $("#aiStatus");
  if (el) el.outerHTML = `<div class="ai-status ${AI_ON ? "on" : "off"}" id="aiStatus">${AI_ON ? "Powered by AI" : "AI disconnected"}<span class="hint"> · ${AI_ON ? "разбор через AI, с проверкой по справочникам" : "работает разбор по словарю синонимов и справочникам"}</span></div>`;
}
// Разбор через Claude (Edge Function repair-ai со справочниками машины); ответ всё равно проходит каскад и проверки формы.
async function aiParse(text, ms = AI_TOTAL_MS, cod = F.cod) {
  const data = await aiInvoke({ text, cod, mode: F.mode, today: todayS() }, ms);
  const r = { ...data.result };
  // ИИ может вернуть null вместо пустого списка («parts»: null) — форме нужны списки.
  r.staff = Array.isArray(r.staff) ? r.staff : [];
  r.parts = Array.isArray(r.parts) ? r.parts : [];
  // Время от ИИ — к виду «ЧЧ:ММ» («8:30» → «08:30»): иначе не сработают периоды ЕО и поле времени.
  const t = (v) => { const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(v ?? "").trim()); return m ? hm(m[1], m[2]) : null; };
  r.start_time = t(r.start_time);
  r.mrange = Array.isArray(r.mrange) && t(r.mrange[0]) && t(r.mrange[1]) ? [t(r.mrange[0]), t(r.mrange[1])] : null;
  return r;
}
// Пока нет ключа ИИ — разбор по словарю синонимов и справочникам (ТЗ, раздел 6, п. 4).
// Всё найденное проходит тот же каскад и те же проверки, что и ручной ввод; сохраняет всегда человек.
function renderAI() {
  return `<section class="ai-box" aria-labelledby="aiLab">
    <label id="aiLab" for="aiText">Опишите работу своими словами, форма разложит по полям</label>
    <textarea class="inp" id="aiText" data-bind="aitext" rows="3" placeholder="Введите описание ремонта">${esc(F.aitext || "")}</textarea>
    <div class="bar"><button class="btn" data-act="ai" ${aiBusy ? "disabled" : ""}>${aiBusy ? "Разбираю…" : "Разложить по полям"}</button>${micBtn()}</div>
    <div class="ai-status ${AI_ON ? "on" : "off"}" id="aiStatus">${AI_ON ? "Powered by AI" : "AI disconnected"}<span class="hint"> · ${AI_ON ? "разбор через AI, с проверкой по справочникам" : "работает разбор по словарю синонимов и справочникам"}</span></div>
    <div class="ai-res" id="aiRes">${F.aiRes || ""}</div>
  </section>`;
}
const SYN = [
  [/шланг|рукав|рвд|штуцер/, ["рукав", "гидрорукав", "штуцер"]],
  [/гидравл|течь масла|гидронасос/, ["гидравл"]],
  [/колес|шин|покрышк|прокол|камер/, ["шин", "колес"]],
  [/двигател|мотор|двс|движок/, ["двс", "двигател"]],
  [/не заводит|не запуска|запуск|стартер/, ["стартер", "двс"]],
  [/генератор/, ["генератор"]],
  [/акб|аккумулятор|батаре/, ["акб", "батаре"]],
  [/кпп|коробк|трансмисс/, ["трансмисс", "коробк"]],
  [/кардан|крестовин/, ["кардан"]],
  [/мост/, ["мост"]],
  [/тормоз|колодк/, ["тормоз"]],
  [/руль|рулев/, ["рулев"]],
  [/стрел/, ["стрел"]],
  [/ковш|зуб/, ["ковш"]],
  [/кузов/, ["кузов"]],
  [/рам[аеуы]|трещин/, ["рам"]],
  [/капот|крыл|огражд/, ["капот"]],
  [/кондиц|климат/, ["кондиц", "вентиляц"]],
  [/сиден|кресл/, ["сиден"]],
  [/стекл|зеркал|двер/, ["стекл", "двер"]],
  [/фар|свет|освещ|маяк/, ["освещ", "фар", "маяк"]],
  [/провод|кабел|разъ[её]м|датчик/, ["кабел", "провод", "датчик"]],
  [/радиатор|перегрев|охлажд|патрубок/, ["охлажд"]],
  [/топлив|форсунк|тнвд/, ["топлив"]],
  [/смазк|масл/, ["смазк"]],
  [/подвеск/, ["подвеск"]],
  [/запчаст|зч/, ["запас"]],
  [/оператор/, ["оператор"]],
  [/фронт работ/, ["фронт"]],
];
const stems = (s) => String(s || "").toLowerCase().split(/[^a-zа-яё0-9]+/).filter((w) => w.length >= 3).map((w) => w.slice(0, 5));
const hm = (h, m) => pad(Math.min(23, +h)) + ":" + pad(+(m || 0));
// Госномер в тексте механики пишут как слышат: «430 бт 03», «289 аи 03» вместо 430BT03 / 289AI03.
// Латинская буква номера принимает свои русские написания, между цифрами и буквами допускаются пробел или дефис.
const PLATE_RU = { a: "а", b: "бв", c: "сц", d: "д", e: "еэ", f: "ф", g: "г", h: "хн", i: "иіы", j: "жй", k: "к", l: "л", m: "м", n: "н",
  o: "о", p: "рп", q: "к", r: "р", s: "с", t: "т", u: "у", v: "в", w: "в", x: "х", y: "уый", z: "з" };
function plateRe(code) {
  // Борт без цифр («NO») — только как написан, иначе совпадёт с обычным словом («но»).
  if (!/\d/.test(code)) return code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let s = "";
  for (let i = 0; i < code.length; i++) {
    const c = code[i], prev = code[i - 1];
    if (i && /\d/.test(c) !== /\d/.test(prev)) s += "[\\s\\-]*";
    s += PLATE_RU[c] ? `[${c}${PLATE_RU[c]}]` : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return s;
}
// Машина по тексту: бортовые номера повторяются у разных моделей и рудников, поэтому номер + модель (+ рудник).
// Ровно одна подходящая → { cod }, несколько → { candidates }, номер не найден, но названа модель →
// { candidates: машины модели, byModel: true }, ничего не найдено → {}.
function detectMachine(text) {
  const t = String(text || "").toLowerCase();
  const tt = t.replace(/(\d)\s+(\d)/g, "$1$2");
  const norm = (s) => String(s || "").toLowerCase().replace(/[\s\-_.]+/g, "");
  const tn = norm(t);
  // Время («до 09:00», «в 8:05») — не борт.
  const zeroNums = new Set((t.match(/(^|[^0-9a-zа-яё:])(0\d+)(?=$|[^0-9a-zа-яё])(?![:.]\d)/g) || []).map((x) => String(Number(x.replace(/\D/g, "")))));
  const hits = D.machines.filter((x) => !x.inactive && inObj(x.cod)).filter((m) => {
    const code = String(m.code || "").toLowerCase().replace(/\s+/g, "");
    if (code.length < 2) return false;
    const re = new RegExp("(^|[^0-9a-zа-яё])" + plateRe(code) + "($|[^0-9a-zа-яё])");
    if (re.test(t) || re.test(tt)) return true; // «4 30BT03» склеиваем, но «DL 321 001» — нет
    // Числовой борт, записанный с другим числом ведущих нулей: «01» = «001». Только числа с ведущим нулём,
    // чтобы время и количества («с 8 до 10», «2 шт») не принимались за борт.
    return /^\d+$/.test(code) && zeroNums.has(String(Number(code)));
  });
  // Модель названа: латиницей как в справочнике или словами из словаря «Модели техники» рудника машины («камацу» = KOMATSU).
  const tw = normText(t);
  const modelSaid = (m) => tn.includes(norm(m.model)) || String(m.model || "").split(/\s+/).some((w) => norm(w).length >= 3 && tn.includes(norm(w)))
    || (PR?.sites ? (rulesForMine(PR.sites, m.mine).model || []).some((r) => modelFits(m.model, r.model) && r.words.some((w) => hasWord(tw, w))) : false);
  // Номер не найден, но модель названа — предлагаем машины этой модели (их меньше, чем весь парк).
  // Берём самое точное название: «тойота хайлюкс» → только Hilux, просто «тойота» → все Toyota.
  if (!hits.length) {
    const said = (m) => Math.max(0,
      tn.includes(norm(m.model)) ? norm(m.model).length : 0,
      ...String(m.model || "").split(/\s+/).map((w) => (norm(w).length >= 3 && tn.includes(norm(w)) ? norm(w).length : 0)),
      ...(PR?.sites ? (rulesForMine(PR.sites, m.mine).model || []).filter((r) => modelFits(m.model, r.model) && r.words.some((w) => hasWord(tw, w))).map((r) => norm(r.model).length) : []));
    const scored = D.machines.filter((x) => !x.inactive && inObj(x.cod)).map((m) => [m, said(m)]).filter(([, s]) => s > 0);
    const best = Math.max(0, ...scored.map(([, s]) => s));
    let ms = scored.filter(([, s]) => s === best).map(([m]) => m);
    const mn = ms.filter((m) => m.mine && t.includes(String(m.mine).toLowerCase()));
    if (mn.length) ms = mn;
    return ms.length ? { candidates: ms.map((m) => m.cod), byModel: true } : {};
  }
  const byModel = hits.filter(modelSaid);
  const pick = byModel.length ? byModel : hits;
  const byMine = pick.filter((m) => m.mine && t.includes(String(m.mine).toLowerCase()));
  let fin = byMine.length ? byMine : pick;
  // Несколько машин с этим бортом одной марки — уточняем по числу из модели в тексте («кат 773» → CAT773E, а не CAT 777D).
  if (fin.length > 1) {
    const byNum = fin.filter((m) => (String(m.model || "").match(/\d{2,}/g) || []).some((d) => new RegExp("(^|\\D)" + d + "(\\D|$)").test(t)));
    if (byNum.length) fin = byNum;
  }
  if (fin.length === 1) return { cod: fin[0].cod };
  if (fin.length > 1) return { candidates: fin.map((m) => m.cod) };
  return {};
}
// Снять выбор машины (текст описания назвал другую): классификация привязана к шаблону машины — тоже сбрасываем.
function clearMachine() {
  Object.assign(F, { cod: null, fs: null, mInfo: null, type: null, sub: null, fail: null, dmg: null, reason: null, q: "", flt: {}, onlyCod: null });
}
function localParse(text) {
  const t = text.toLowerCase(), r = { staff: [], parts: [] };
  if (F.mode === "new") Object.assign(r, detectMachine(t));
  // Диапазоны «с X до Y»: «стоял/встал/простой» — время простоя машины, остальные («меняли», «Пилипенко») — время работы людей.
  const rangeRe = /с\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:ч\S*\s*)?(?:до|по|-)\s*(\d{1,2})(?:[:.](\d{2}))?/g;
  const machineWord = /(стоял|стояла|стоит|встал|встала|простоя|простой|простоял|не работал|остановил|время ремонта|ремонтировал)\S*[^,.;]*$/;
  let t2 = t;
  for (const mm of [...t.matchAll(rangeRe)]) {
    const clauseStart = Math.max(...[",", ".", ";", "\n"].map((c) => t.lastIndexOf(c, mm.index))) + 1;
    const rg = [hm(mm[1], mm[2]), hm(mm[3], mm[4])];
    if (machineWord.test(t.slice(clauseStart, mm.index + 1)) && !r.mrange) r.mrange = rg;
    else if (!r.range) r.range = rg;
    t2 = t2.replace(mm[0], " ");
  }
  const MON = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const dm = t.match(new RegExp("(\\d{1,2})\\s*(" + MON.join("|") + ")")) || null;
  if (dm) {
    let y = +todayS().slice(0, 4);
    const ds = () => `${y}-${pad(MON.indexOf(dm[2]) + 1)}-${pad(+dm[1])}`;
    if (ds() > todayS()) y--;
    r.date = ds();
  } else if (/позавчера/.test(t)) r.date = fmtDT(new Date(nowD().getTime() - 2 * 864e5)).slice(0, 10);
  else if (/вчера/.test(t)) r.date = fmtDT(new Date(nowD().getTime() - 864e5)).slice(0, 10);
  const st = t2.match(/(?:^|\s)(?:в|с)\s*(\d{1,2})[:.](\d{2})/) || t2.match(/(?:^|\s)в\s*(\d{1,2})\s*(?:ч|час)/);
  if (st) r.start_time = hm(st[1], st[2]);
  else if (r.mrange) r.start_time = r.mrange[0];
  const typeByName = (re) => D.types.find((x) => !x.hidden && re.test(x.name.toLowerCase()))?.id;
  if (/(^|\s)то[-\s]?\d|техобслуж|тех\.? ?обслуж|обслуживан/.test(t)) r.type = typeByName(/обслуж/);
  else if (/капремонт|капитальн/.test(t)) r.type = typeByName(/капитал/);
  else if (/замен\S* (узла|двигателя|кпп|моста|агрегата)/.test(t)) r.type = typeByName(/замена/);
  else if (/планов/.test(t)) r.type = typeByName(/планов/);
  else if (/авар|слома|оборва|лопн|порва|пробит|пробил|перет[её]р|разорв|поломк|течь|не заводит|не запуска|не тормоз|отказ|встал|стоит|трещин|прокол/.test(t)) r.type = typeByName(/авар/);
  // Подсистема и отказ: лучшая связка шаблона машины по совпадению слов текста и синонимов.
  const cod = r.cod || F.cod;
  if (cod) {
    const words = new Set(stems(t));
    const keys = SYN.filter(([re]) => re.test(t)).flatMap(([, k]) => k);
    let best = null, bestScore = 0;
    for (const [ty, su, fa] of combos(cod)) {
      if (r.type && ty !== r.type) continue;
      const name = (failName(fa) + " " + subName(su)).toLowerCase();
      let score = stems(name).filter((w) => words.has(w)).length * 2 + keys.filter((k) => name.includes(k)).length * 3;
      if (!r.type && ty === 1) score += 0.1;
      if (score > bestScore) { bestScore = score; best = [ty, su, fa]; }
    }
    if (best && bestScore >= 2) { r.type = r.type || best[0]; r.sub = best[1]; r.fail = best[2]; }
  }
  const reasonByName = (re) => D.reasons.find((x) => !x.hidden && re.test(x.name.toLowerCase()))?.id;
  if (/износ/.test(t)) r.reason = reasonByName(/износ/);
  else if (/оператор|неправильн|наехал|удар|эксплуат/.test(t)) r.reason = reasonByName(/эксплуат/);
  else if (/гарант/.test(t)) r.reason = reasonByName(/гарант/);
  else if (/после ремонта|повторно|некачеств/.test(t)) r.reason = reasonByName(/некачеств/);
  if (/рудник/.test(t)) r.dmg = D.damages.find((x) => !x.hidden && /рудник/i.test(x.name))?.id;
  else if (/сервис/.test(t)) r.dmg = D.damages.find((x) => !x.hidden && /сервис/i.test(x.name))?.id;
  // Персонал: фамилия в любом регистре и падеже — по первым 5 буквам («алибекову» = «Алибеков А.»), люди рудника машины.
  const pool = staffPool(cod);
  const tw = new Set(t.split(/[^а-яёa-z]+/).filter((w) => w.length >= 4).map((w) => w.slice(0, 5)));
  for (const s of pool) {
    const sur = s.name.split(/\s+/)[0].toLowerCase();
    // Время людей не названо отдельно — то же, что время ремонта.
    const rg = r.range || r.mrange;
    if (sur.length >= 4 && tw.has(sur.slice(0, 5)) && !r.staff.some((x) => x.id === s.id)) r.staff.push({ id: s.id, from: rg?.[0] || "", to: rg?.[1] || "" });
  }
  // Запчасти: похожие на парт номер слова (буквы+цифры, от 5 символов) и количество «2 шт».
  const U = text.toUpperCase();
  const re = /\b([A-Z0-9]{1,4}[-]?[A-Z0-9]{3,})\b/g; let pm;
  while ((pm = re.exec(U))) {
    if (!/\d/.test(pm[1]) || pm[1].length < 5) continue;
    const after = U.slice(pm.index + pm[0].length, pm.index + pm[0].length + 16);
    const q = after.match(/^\D{0,6}?(\d+)\s*(ШТ|ЕД|PCS)/) || after.match(/^\s*[XХ*]\s*(\d+)/);
    r.parts.push({ spare: pm[1], qty: q ? +q[1] : 1 });
  }
  r.comment = text.trim();
  return r;
}
async function applyParsed(p) {
  const set = [], miss = [];
  if (F.mode === "new" && p.cod && Mx(p.cod) && !Mx(p.cod).inactive && p.cod !== F.cod) { await selectMachine(p.cod); set.push("машина " + M(p.cod).code); }
  if (F.mode === "new" && !F.cod && !p.cod && Array.isArray(p.candidates)) {
    const c = [...new Set(p.candidates.map(Number))].filter((x) => Mx(x) && !Mx(x).inactive && inObj(x));
    if (c.length === 1) { await selectMachine(c[0]); set.push("машина " + M(c[0]).code); }
    else if (c.length > 1) {
      F.cands = c; F.candsByModel = !!p.byModel;
      miss.push(p.byModel ? `машину (номер не найден, машин этой модели ${c.length} — выберите номер в списке)` : `машину (подходит ${c.length} — выберите в списке; можно уточнить модель или рудник)`);
    }
  }
  // В списке машин остаётся только найденная (у одного борта бывает много машин) — пока не изменят поиск.
  if (F.mode === "new" && F.cod) { F.q = Mx(F.cod)?.code ?? F.q; F.onlyCod = F.cod; }
  F.dictPending = null;
  applyDictRules(p, F.aitext || "");
  if (F.mode === "new" && /^\d{4}-\d{2}-\d{2}$/.test(p.date || "") && p.date <= todayS() && p.date >= "2000-01-01" && p.date !== F.date) { F.date = p.date; F.endDate = p.date; set.push("дата " + ru(p.date)); }
  if (p.start_time && (F.mode === "new" || dayPos() === "only" || dayPos() === "first")) { F.time = p.start_time; set.push("время " + p.start_time); }
  if (F.mode === "new" && p.mrange) {
    const [a, b] = p.mrange;
    // «стоял с X до Y», и Y уже прошло — ремонт закончен, вносим задним числом
    if (b > a && F.date + "T" + b <= nowS()) { F.time = a; F.done = true; F.endDate = F.date; F.endTime = b; set.push(`ремонт закончен ${a}–${b}`); }
  }
  if (!clsLocked() && F.cod) {
    for (const k of ["type", "sub", "fail", "dmg", "reason"]) {
      let v = p[k];
      if (k === "reason" && v != null && F.type != null && F.dmg == null) {
        // Инициатор не назван: если причина однозначно определяет его по правилам (тип × инициатор → причина), ставим его.
        const dm = [...new Set(D.rules.filter((x) => x[0] === F.type && x[2] === v).map((x) => x[1]))];
        if (dm.length === 1) { F.dmg = dm[0]; set.push("инициатор"); }
        else if (dm.length > 1) F.pendingReason = v; // применится сразу после выбора инициатора
      }
      if (v != null && OPTS[k](F).includes(v)) { F[k] = v; normalize(); set.push(CLS_LAB[k].toLowerCase()); }
      else normalize();
    }
    applyDictPending(); // тип известен, а подсистема/причина ещё пустые — добрать из словаря
    for (const k of CLS) if (F[k] == null) miss.push(CLS_LAB[k].toLowerCase());
  }
  let ns = 0;
  // Исполнитель — только из персонала рудника машины (ИИ мог взять однофамильца с другого рудника).
  const pool = new Set(staffPool(F.cod).map((s) => s.id));
  p.staff = Array.isArray(p.staff) ? p.staff : [];
  p.parts = Array.isArray(p.parts) ? p.parts : [];
  for (const s of p.staff) if ((!pool.size || pool.has(Number(s.id))) && !F.staff.some((x) => Number(x.id) === Number(s.id))) { F.staff.push({ id: s.id, from: s.from || dayBounds().lo || "", to: s.to || "" }); ns++; }
  if (ns) set.push("персонал: " + ns);
  if (p.parts.length) {
    await describeParts(p.parts.map((x) => x.spare));
    let np = 0;
    for (const x of p.parts) {
      const pn = x.spare.toUpperCase();
      if (partDescr.get(pn) && !F.parts.some((y) => (y.spare || "").toUpperCase() === pn)) { F.parts.push({ spare: pn, idx: "", qty: x.qty }); np++; }
    }
    if (np) set.push("запчасти: " + np);
  }
  if (p.comment && !F.comment.trim()) { F.comment = p.comment; set.push("комментарий"); }
  if (!F.cod && !miss.some((x) => x.startsWith("машину"))) miss.unshift("машина");
  return { set, miss };
}

// ---------- запчасти ----------
const CAM = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>';
// Уменьшенная копия фото для строки запчасти (как в прототипе).
function thumb(file) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 320 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      try { res(c.toDataURL("image/jpeg", 0.6)); } catch (_) { res(null); }
    };
    img.onerror = () => res(null);
    img.src = URL.createObjectURL(file);
  });
}
// Фото бирки/упаковки: с AI номер распознаётся и сверяется со справочником; без AI фото прикладывается, номер — вручную.
async function onPhoto(file) {
  const ph = await thumb(file);
  let found = [], note = "";
  if (AI_ON) {
    const st = $("#photoSt"); if (st) st.textContent = "Распознаю номер на фото…";
    try {
      const data = await aiInvoke({ mode: "photo", cod: F.cod, image: ph });
      found = data.result?.parts || [];
      note = data.result?.note || "";
    } catch (e) { note = "Не удалось распознать фото: " + e.message + "."; }
  } else note = "AI disconnected: фото приложено, номер введите вручную.";
  if (!found.length) F.parts.push({ spare: "", idx: "", qty: 1, photo: ph });
  else for (const x of found) F.parts.push({ spare: String(x.spare || ""), idx: "", qty: +x.qty > 0 ? +x.qty : 1, photo: ph });
  rerenderParts();
  await describeParts(F.parts.map((x) => x.spare));
  const s2 = $("#photoSt");
  if (s2) s2.textContent = found.length ? `С фото: ${found.map((x) => x.spare).join(", ")}. Проверьте и укажите индекс. ${note}` : note;
}
let partTimer;
async function describeParts(list) {
  const need = [...new Set(list.map((s) => (s || "").trim().toUpperCase()).filter((s) => s && !partDescr.has(s)))];
  if (!need.length) return;
  try {
    const r = await rpc("repair_part_info", { p_spares: need });
    for (const s of need) partDescr.set(s, r[s] ?? null);
  } catch (_) { /* описание — только подсказка */ }
  document.querySelectorAll("[data-desc]").forEach((el) => {
    const p = F?.parts[+el.dataset.desc];
    if (p) paintDesc(el, p.spare);
  });
  refresh();
}
function paintDesc(el, spare) {
  const pn = (spare || "").trim().toUpperCase();
  const d = partDescr.get(pn);
  el.textContent = !pn ? "описание подтянется из справочника" : d === undefined ? "проверяю…" : d === null ? "нет в справочнике" : d;
  el.classList.toggle("muted", !d);
}
async function loadPartHist(spare) {
  const pn = (spare || "").trim().toUpperCase();
  const skip = F.mode === "day" ? F.dayId : null; // текущий день в историю не входит: там те же запчасти, что вводятся сейчас
  const key = F.cod + "|" + pn + "|" + (skip ?? "");
  if (!pn || partHist.has(key)) return;
  partHist.set(key, null); // null = ещё загружается (не путать с «ещё не ставилась»)
  try { partHist.set(key, await rpc("repair_part_history", { p_cod: F.cod, p_spare: pn, p_skip_day: skip })); } catch (_) { partHist.delete(key); return; }
  renderIx();
}
// Подсказка по запчасти: все прошлые установки этой детали на этой машине (с индексом и без), с номером наряда и наработкой детали.
function idxInfo(i) {
  const p = F.parts[i], pn = (p.spare || "").trim().toUpperCase();
  if (!pn || !partDescr.get(pn)) return "";
  const all = partHist.get(F.cod + "|" + pn + "|" + (F.mode === "day" ? F.dayId : ""));
  if (all === undefined || all === null) return "";
  if (!all.length) return `<span>На этой машине ещё не ставилась.</span>`;
  const cur = (p.idx || "").trim();
  const taken = new Set(F.parts.filter((q, j) => j !== i && (q.spare || "").trim().toUpperCase() === pn && (q.idx || "").trim()).map((q) => q.idx.trim()));
  const hrs = (x) => (partHours(x) ? `, наработка детали ${partHours(x)}` : "");
  const one = (x) => `${ruY(x.last)}${x.wo ? ", наряд " + esc(x.wo) : ""}${x.idx ? ", индекс <b>" + esc(x.idx) + "</b>" : ", без индекса"}${hrs(x)}`;
  const same = cur ? all.find((x) => x.idx === cur) : null;
  const head = same ? `Этот индекс уже был: ${one(same)}.` : `Уже ставилась на этой машине, последний раз ${one(all[0])}.`;
  const withIdx = all.filter((x) => x.idx);
  return `<span>${head}</span>` + (withIdx.length ? `<span>Индексы, которые уже использовались (нажмите, чтобы подставить):</span>` + withIdx.map((x) => {
    const b = taken.has(x.idx);
    return `<button type="button" class="ixc" data-act="pickidx" data-i="${i}" data-v="${esc(x.idx)}" aria-pressed="${cur === x.idx}" title="Подставить индекс ${esc(x.idx)}">индекс ${esc(x.idx)} · ${b ? "уже в этом дне" : "был " + ruY(x.last) + (x.wo ? ", наряд " + esc(x.wo) : "") + (partHours(x) ? ", наработка " + partHours(x) : "")}</button>`;
  }).join("") : "");
}
function renderIx() { document.querySelectorAll("[data-ix]").forEach((el) => (el.innerHTML = idxInfo(+el.dataset.ix))); }
function renderParts() {
  return `<div class="item part head"><span>Парт номер</span><span>Описание</span><span>Индекс</span><span>Кол-во</span><span></span></div>`
    + F.parts.map((p, i) => `<div class="item-wrap"><div class="item part">
      ${comboHtml(`part-${i}`, p.spare || "", "Парт номер", "mono")}
      <span class="desc">${p.photo ? `<img class="thumb" src="${p.photo}" alt="Фото запчасти">` : ""}<span class="muted" data-desc="${i}">описание подтянется из справочника</span></span>
      <input class="inp mono" data-bind="part.idx" data-i="${i}" value="${esc(p.idx || "")}" placeholder="Инд." aria-label="Индекс (место установки)">
      <input class="inp mono" type="number" min="0" step="any" inputmode="decimal" data-bind="part.qty" data-i="${i}" value="${p.qty ?? 1}" aria-label="Количество">
      <button class="x" data-act="delpart" data-i="${i}" aria-label="Убрать">×</button></div>
      <div class="ix" data-ix="${i}"></div>
      <div class="err" data-err="part-${i}"></div></div>`).join("")
    + `<div class="bar"><button class="btn add" data-act="addpart">+ Запчасть</button><label class="btn add" for="photoIn">${CAM} Сфотографировать</label><input type="file" id="photoIn" accept="image/*" capture="environment" hidden></div>
      <span class="hint" id="photoSt"></span>
      <span class="hint">Индекс различает одинаковые детали на разных местах (например, две крестовины кардана: 1 и 2), по нему считается наработка.</span>`;
}
function afterPartsRender() {
  document.querySelectorAll("[data-desc]").forEach((el) => paintDesc(el, F.parts[+el.dataset.desc]?.spare));
  F.parts.forEach((p) => p.spare && loadPartHist(p.spare));
  renderIx();
}

// ---------- проверки ----------
// Порог «слишком короткий последний день» — предложение, уточнить у заказчика. Только предупреждение, сохранять не мешает.
const MIN_LAST_MIN = 15;
function lastDayMinutes() {
  let a, b;
  if (F.mode === "new") { if (!F.done || !F.date || !F.time || !F.endDate || !F.endTime) return null; a = F.endDate === F.date ? F.time : "00:00"; b = F.endTime; }
  else { const ce = closingEnd(); if (!ce) return null; a = F.time; b = ce; }
  const d = (parseDT("2000-01-01T" + b) - parseDT("2000-01-01T" + a)) / 6e4;
  return d > 0 ? Math.round(d) : null;
}
// Кнопка «ЕО» — той же ширины, что соседняя кнопка шага ТО (подписи шагов разной длины, «ЕО» короче).
function fitEoChip() {
  const eo = document.querySelector(".chip.eo"), next = eo?.nextElementSibling;
  if (eo) eo.style.minWidth = next ? next.offsetWidth + "px" : "";
}
function refresh() {
  if (!F) return;
  fitEoChip();
  const E = validate();
  const lazy = ["type", "sub", "fail", "reason", "dmg", "fs", "code", "comment", "staff-need"];
  document.querySelectorAll("[data-err]").forEach((el) => { const k = el.dataset.err; el.textContent = F.touched || !(lazy.includes(k) || /^Наработка: введите/.test(E[k] || "")) ? E[k] || "" : ""; });
  const se = $("#stickErr");
  if (se) se.textContent = F.serverErr || "";
  const ck = $("#checks");
  if (ck) {
    const has = (p) => Object.keys(E).some((k) => k.startsWith(p));
    const clsDone = clsLocked() || CLS.every((k) => F[k] != null);
    const items = [];
    if (F.serverErr) items.push({ s: "bad", t: "Ответ сервера", sub: F.serverErr });
    const m = M(F.cod);
    if (F.mode === "new") {
      items.push({ s: !F.cod ? "no" : E.code ? "bad" : "ok", t: "Одна открытая работа на машину", sub: F.cod ? E.code || `${m.code} свободна для нового наряда` : "выберите машину" });
      items.push({ s: !F.cod ? "no" : E.time ? "bad" : "ok", t: "Время начала и окончания", sub: E.time || (F.cod ? `начало ${ru(F.date)} ${F.time}${F.done ? `, окончание ${ru(F.endDate)} ${F.endTime}` : ""}` : "") });
    } else items.push({ s: E.time ? "bad" : "ok", t: "Время дня", sub: E.time || `${F.time}–${curDay()?.end_at ? timeOf(curDay().end_at) : "сейчас"}` });
    if (F.cod) items.push({ s: E.mbusy ? "bad" : F.mBusyKey && machineSpan() ? "ok" : "no", t: "Пересечение по машине", sub: E.mbusy || (F.mBusyKey && machineSpan() ? "с другими работами машины не пересекается" : "") });
    const shortMin = lastDayMinutes();
    if (shortMin != null && shortMin < MIN_LAST_MIN) items.push({ s: "warn", t: "Короткий ремонт", sub: `последний день длится ${shortMin} мин — меньше ${MIN_LAST_MIN}. Проверьте время окончания` });
    items.push({ s: clsDone ? "ok" : "no", t: "Классификация по шаблону", sub: clsDone ? [F.type, F.sub, F.fail, F.dmg, F.reason].every((x) => x != null) ? `${typeName(F.type)} → ${subName(F.sub)} → ${optLabel("fail", F.fail)} → ${dmgName(F.dmg)} → ${reasonName(F.reason)}` : "" : "тип, подсистема, отказ, инициатор, причина" });
    if (meterShown()) {
      const me = Object.keys(E).filter((k) => k.startsWith("meter-")).map((k) => E[k]);
      const v = meterPayload(), all = chansOf().every((ch) => v[CH_KEYS[ch]] != null && !Number.isNaN(v[CH_KEYS[ch]]));
      items.push({ s: me.length ? "bad" : all ? "ok" : "no", t: "Наработка",
        sub: me.length ? me.join("; ") : all ? chansOf().map((ch) => `${ch} ${fmtH(v[CH_KEYS[ch]])} ч`).join(", ") + (needMeter() ? "" : " · сохранится при закрытии наряда") : "введите показание при закрытии наряда" });
    }
    items.push({ s: F.fs ? "ok" : "no", t: "FS", sub: m ? (machineFsLocked(F.cod) ? "TR по настройке машины" : `выбрано ${fsName(F.fs)}, в настройках ${m.fs}`) : "" });
    items.push({ s: has("staff") ? "bad" : F.staff.length ? "ok" : "no", t: "Персонал и время работы", sub: E["staff-need"] || (F.staff.length ? (has("staff-") ? "проверьте сотрудников" : "занятость проверит база при сохранении") : "никто не добавлен") });
    items.push({ s: has("part-") ? "bad" : F.parts.length ? "ok" : "no", t: "Запчасти из справочника", sub: F.parts.length ? (has("part-") ? "проверьте номера" : `${F.parts.length} поз.`) : "не добавлены" });
    ck.innerHTML = `<h3>Проверки</h3><ul>${items.map((i) => `<li class="${i.s}"><span class="st">${i.s === "ok" ? "✓" : i.s === "bad" || i.s === "warn" ? "!" : "·"}</span><span><span class="t">${esc(i.t)}</span>${i.sub ? `<span class="sub">${esc(i.sub)}</span>` : ""}</span></li>`).join("")}</ul>`;
  }
  saveDraft();
}
function rerenderCls() { const c = $("#cls"); if (c) c.innerHTML = renderCls(); refresh(); }
function rerenderStaff() { const s = $("#staff"); if (s) s.innerHTML = renderStaff(); refresh(); checkBusy(); }
function rerenderParts() { const p = $("#parts"); if (p) { p.innerHTML = renderParts(); afterPartsRender(); } refresh(); }

// Черновик: не теряется при сворачивании браузера (только новый наряд и день).
function saveDraft() {
  try {
    if (F && (V.name === "new" || V.name === "day") && !isClosedView()) localStorage.setItem(draftKey, JSON.stringify({ V, F, at: Date.now() }));
    else if (!holdDraft) localStorage.removeItem(draftKey);
  } catch (_) { /* без черновика */ }
}

// ---------- наряд ----------
function notesText(n) {
  if (!n) return "";
  const parts = [];
  if ((n.added || []).length) {
    const a = n.added[0], b = n.added[n.added.length - 1];
    parts.push(a === b ? `Добавлен пропущенный день ${ruY(a)}.` : `Добавлены пропущенные дни ${ruY(a)}–${ruY(b)}.`);
  }
  if ((n.fixed || []).length) parts.push(`Окончание исправлено на 23:59, наряд не закрыт: ${n.fixed.map((f) => ru(f.date) + (f.was ? ` (было ${f.was})` : "")).join(", ")}.`);
  if ((n.cleared || []).length) parts.push(`Простой не был закрыт, поэтому персонал, выставленный по времени ремонта, удалён: ${n.cleared.map(ru).join(", ")}. Укажите заново.`);
  return parts.join(" ");
}
async function openWO(id, extraNotice) {
  setLoading(true);
  try {
    W = await rpc("repair_open_wo", { p_wo: Number(id) });
    const t = notesText(W.notes);
    notice = [extraNotice, t].filter(Boolean).join(" ") || null;
    updateListItem(W);
    go({ name: "wo", id: W.id });
  } catch (e) { toast(e.message); } finally { setLoading(false); }
}
// Вид персонала для журнала простоев пересобирается отдельным запросом (он занимает секунды и не должен входить в сохранение,
// у запроса из браузера лимит 8 с). Несколько сохранений подряд объединяются в одну пересборку.
let reportsT;
function scheduleReportsRefresh() {
  clearTimeout(reportsT);
  reportsT = setTimeout(() => { supabase.rpc("repair_refresh_reports").then(() => {}, () => {}); }, 1500);
}
function updateListItem(w) {
  const l = w.days[w.days.length - 1];
  const item = { id: w.id, order_no: w.order_no, label: w.label, cod: w.cod, status: w.status, started_at: w.started_at, finished_at: w.finished_at, days: w.days.length,
    last: { type_id: l.type_id, subsys_id: l.subsys_id, failure_id: l.failure_id, pm_label: l.pm_label, fs_id: l.fs_id, comment: l.comment } };
  const i = LIST.findIndex((x) => x.id === w.id);
  if (i >= 0) LIST[i] = item; else LIST.unshift(item);
}
function renderWO() {
  const m = M(W.cod), f = W.days[0], l = W.days[W.days.length - 1];
  setTitle(m.missing ? `Наряд № ${W.label || W.order_no}` : `Наряд ${m.model ? m.model + " " : ""}${m.code}`);
  const isOpen = W.status === "open";
  const lc = !l.comment.trim(), ls = !l.staff.length;
  app().innerHTML = `
  <div class="wohead"><span class="code">${esc(m.code)}</span>${offPill(m)}
    <div class="kv"><span>Модель</span><b>${esc(m.model || "—")}</b></div>
    <div class="kv"><span>№ наряда</span><b class="mono">${W.label || W.order_no}</b></div>
    <div class="kv"><span>Начало</span><b>${ru(f.start_at)} ${timeOf(f.start_at)}</b></div>
    <div class="kv"><span>${isOpen ? "В простое" : "Окончание"}</span><b>${isOpen ? idleText(f.start_at) : ru(l.end_at) + " " + timeOf(l.end_at)}</b></div>
    <span class="pill ${isOpen ? "open" : "closed"}">${isOpen ? "Открыт" : "Закрыт"}</span></div>
  ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
  ${isOpen && W.notes?.stale ? `<div class="blocker"><b>Наряд не вёлся ${W.notes.stale.days} дн. — последний введённый день ${ruY(String(W.notes.stale.last_day))}</b>
    <div>Если машина всё это время стояла, досоздайте дни до сегодня: тип, подсистема, отказ, причина и FS скопируются, персонал вводится по дням. Если ремонт на самом деле закончился раньше, закройте наряд последним днём, лишние дни простоя не появятся.</div>
    <div class="bar"><button class="btn" data-act="doBackfill">Досоздать ${W.notes.stale.days} дн. до сегодня</button><button class="btn primary" data-act="askClose">Закрыть последним днём</button></div></div>` : ""}
  ${isOpen && (lc || ls) ? `<div class="warns"><span class="pill warn">Последний день ${ru(l.start_at)}: ${[lc && "нет комментария", ls && "нет людей"].filter(Boolean).join(", ")}</span><span class="hint">нужно для закрытия</span></div>` : ""}
  <h2>Дни наряда · ${W.days.length}</h2>
  <div class="days">${[...W.days].reverse().map((d) => `
    <button class="dayrow" data-act="day" data-id="${d.id}">
      <span class="d">${ru(d.start_at)}<small>${wd(d.start_at)} · ${timeOf(d.start_at)}–${d.end_at ? timeOf(d.end_at) : "сейчас"}</small></span>
      <span class="c"><span class="cls">${clsLine(d)}</span><br><span class="meta">${esc(dmgName(d.damage_id))} · ${esc(reasonName(d.reason_id))} · FS ${esc(fsName(d.fs_id))}${d.staff.length ? " · " + d.staff.map((s) => esc(staffName(s.staff_id)) + " " + s.from + "–" + s.to).join(", ") : ""}${d.parts.length ? " · ЗЧ: " + d.parts.map((p) => esc(p.spare) + (p.idx ? " [" + esc(p.idx) + "]" : "") + " ×" + p.qty).join(", ") : ""}</span>
      ${d.comment ? `<div class="cm">${esc(d.comment)}</div>` : ""}</span>
      <span class="b">${d.auto_created ? '<span class="pill auto">авто</span>' : ""}${!d.comment.trim() ? `<span class="pill ${d === l && isOpen ? "warn" : "auto"}">нет комм.</span>` : ""}${!d.staff.length ? `<span class="pill ${d === l && isOpen ? "warn" : "auto"}">нет людей</span>` : ""}</span>
    </button>`).join("")}</div>
  ${closing ? `<div class="closebox" id="closebox"><b>Закрытие наряда</b>
    <label class="field"><span class="lab">Дата и время окончания работ</span><input class="inp" type="datetime-local" id="closeAt" value="${W.notes?.stale ? dateOf(l.start_at) + "T23:59" : nowS()}" min="${l.start_at.slice(0, 16)}" max="${W.notes?.stale ? dateOf(l.start_at) + "T23:59" : nowS()}"></label>
    <div class="hint">Последний день нельзя закрыть без комментария и персонала. В промежуточных днях они не обязательны, запчасти для закрытия не нужны.</div>
    <div class="err" id="closeErr"></div>
    <div class="bar"><button class="btn primary" data-act="doClose">Закрыть наряд</button><button class="btn ghost" data-act="cancelClose">Отмена</button></div></div>` : ""}`;
  setStick(isOpen ? (closing ? `<button class="btn" data-act="back">← К списку</button>` : `<button class="btn" data-act="back">← К списку</button><button class="btn danger" data-act="askClose">Закрыть наряд</button>`)
    : `<button class="btn" data-act="back">← К списку</button><button class="btn" data-act="reopen">Переоткрыть</button>`);
}

// ---------- сохранение ----------
function classPayload() {
  const eo = F.type === TYPE_PM && F.fail === EO_POS;
  return { type_id: F.type, subsys_id: F.sub, failure_id: eo ? EO_FAIL : F.type === TYPE_PM ? null : F.fail, damage_id: F.dmg, reason_id: F.reason, fs_id: F.fs,
    pm_pos: F.type === TYPE_PM && !eo ? F.fail : null, pm_label: F.type === TYPE_PM ? pmLabel(F.cod, F.fail) : null };
}
const staffPayload = () => F.staff.map((s) => ({ staff_id: Number(s.id), from: s.from, to: s.to }));
const partsPayload = () => F.parts.filter((p) => (p.spare || "").trim()).map((p) => ({ spare: p.spare.trim().toUpperCase(), idx: (p.idx || "").trim(), qty: Number(p.qty) }));
function failSave(msg) {
  F.serverErr = msg;
  const el = $("#serverErr");
  if (el) el.textContent = msg;
  refresh();
  toast(msg);
}
function checkBeforeSave() {
  F.touched = true;
  F.serverErr = "";
  const E = validate();
  refresh();
  if (Object.keys(E).length) {
    document.querySelector(".err:not(:empty)")?.scrollIntoView({ behavior: "smooth", block: "center" });
    toast("Проверьте отмеченные поля");
    return false;
  }
  return true;
}
async function withBusy(fn) {
  if (busy) return;
  busy = true;
  // Форма остаётся на экране: кнопка неактивна и показывает ход запроса.
  const btns = [...document.querySelectorAll("#reStickIn .btn.primary")];
  const was = btns.map((b) => b.innerHTML);
  btns.forEach((b) => { b.disabled = true; b.classList.add("busy"); b.innerHTML = `<span class="spin" aria-hidden="true"></span>Сохраняю…`; });
  try { await fn(); } finally {
    busy = false;
    btns.forEach((b, i) => { if (b.isConnected) { b.disabled = false; b.classList.remove("busy"); b.innerHTML = was[i]; } });
  }
}

// Кнопки карточки наряда (закрыть, переоткрыть, досоздать): одна операция за раз, нажатая кнопка неактивна до ответа.
async function guard(el, fn) {
  if (busy) return;
  busy = true;
  setLoading(true);
  const was = el?.innerHTML;
  if (el) { el.disabled = true; el.classList.add("busy"); el.innerHTML = `<span class="spin" aria-hidden="true"></span>${was}`; }
  try { await fn(); } finally {
    busy = false;
    setLoading(false);
    if (el?.isConnected) { el.disabled = false; el.classList.remove("busy"); el.innerHTML = was; }
  }
}

// Вопрос «Закрыть наряд в ЧЧ:ММ?»: по умолчанию (Enter, Esc, фон) — «Только сохранить день».
function askCloseChoice(time) {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "re re-modal";
    box.innerHTML = `<div class="re-modal-in" role="dialog" aria-modal="true" aria-labelledby="cqT"><b id="cqT">Закрыть наряд в ${esc(time)}?</b>
      <span class="hint">В поле «Окончание» указано время. Наряд закроется, машина перестанет числиться в простое.</span>
      <div class="bar"><button class="btn primary" data-r="save">Только сохранить день</button><button class="btn danger" data-r="close">Закрыть наряд</button></div></div>`;
    const done = (v) => { box.remove(); resolve(v); };
    box.addEventListener("click", (e) => { const r = e.target.closest("[data-r]")?.dataset.r; if (r) done(r === "close"); else if (e.target === box) done(false); });
    box.addEventListener("keydown", (e) => { if (e.key === "Escape") done(false); });
    document.body.appendChild(box);
    box.querySelector('[data-r="save"]').focus();
  });
}

// ---------- события ----------
const H = {
  back() {
    if (V.name === "day") { notice = null; go({ name: "wo", id: W.id }); }
    else { notice = null; F = null; go({ name: "list" }); loadList().then(() => V.name === "list" && renderList()).catch(() => {}); }
  },
  new() { startNew(); },
  openwo(el) { openWO(el.dataset.id); },
  async machine(el) {
    const prev = F.cod;
    await selectMachine(el.dataset.v);
    if (prev !== F.cod) F.flt = {};
    // Описание уже написано (машину выбрали после разбора, например из нескольких подходящих) —
    // применить к нему словарь разбора площадки этой машины.
    if (F.mode === "new" && prev !== F.cod && (F.aitext || "").trim() && PR) {
      const r = await applyParsed({ staff: [], parts: [] });
      if (r.set.length) F.aiRes = `<b>По словарю площадки:</b> ${esc(r.set.join(", "))}.${r.miss.length ? ` <b>Выберите вручную:</b> ${esc(r.miss.join(", "))}.` : ""}`;
    }
    renderForm();
  },
  pick(el) {
    if (clsLocked() || isClosedView()) return;
    const k = el.dataset.f;
    F[k] = Number(el.dataset.v);
    if (k === "type") F.pendingReason = null;
    normalize();
    // ЕО — всегда причина «Нормальный износ» (инициатор у ТО один и подставляется сам).
    if (k === "fail" && F.type === TYPE_PM && F[k] === EO_POS && OPTS.reason(F).includes(EO_REASON)) F.reason = EO_REASON;
    if (k === "type") applyDictPending();
    if (F.pendingReason != null && F.reason == null && OPTS.reason(F).includes(F.pendingReason)) F.reason = F.pendingReason;
    if (F.reason != null) F.pendingReason = null;
    rerenderCls();
  },
  pickfs(el) { if (clsLocked()) return; F.fs = Number(el.dataset.v); rerenderCls(); },
  suggest() { F.sugOpen = true; $("#sug").innerHTML = renderSug(); $("#sugText")?.focus(); },
  cancelsug() { F.sugOpen = false; $("#sug").innerHTML = renderSug(); },
  async sendsug() {
    const t = $("#sugText").value.trim();
    if (!t) { $("#sugErr").textContent = "Напишите, какого варианта не хватает"; return; }
    try {
      await rpc("repair_suggest", { p_cod: F.cod, p_context: { text: sugCtx(), type_id: F.type, subsys_id: F.sub, failure_id: F.fail }, p_body: t });
      F.sugOpen = false; $("#sug").innerHTML = renderSug(); toast("Отправлено администратору");
    } catch (e) { $("#sugErr").textContent = e.message; }
  },
  addstaff() { const r = repairSpan(); F.staff.push(F.asRepair ? { id: "", from: r.from, to: r.to } : { id: "", from: dayBounds().lo || "", to: "" }); rerenderStaff(); },
  delstaff(el) { H.clearServerErr(); F.staff.splice(+el.dataset.i, 1); rerenderStaff(); },
  addpart() { F.parts.push({ spare: "", idx: "", qty: 1 }); rerenderParts(); const ins = document.querySelectorAll('[data-bind="part.spare"]'); ins[ins.length - 1]?.focus(); },
  delpart(el) { F.parts.splice(+el.dataset.i, 1); rerenderParts(); },
  pickidx(el) { const i = +el.dataset.i; F.parts[i].idx = el.dataset.v; const inp = document.querySelector(`[data-bind="part.idx"][data-i="${i}"]`); if (inp) inp.value = el.dataset.v; renderIx(); refresh(); },
  histmode() { F.done = true; renderForm(); },
  mic() {
    if (micOn) { rec?.stop(); return; } // повторное нажатие — закончить запись досрочно
    if (aiBusy) return;
    startMic();
  },
  makeLast() {
    F.makeLast = true;
    F.dayEnd = F.date === todayS() ? nowS().slice(11, 16) : "23:59";
    F.touched = false;
    renderForm();
    document.querySelector('[data-bind="dayEnd"]')?.focus();
  },
  cancelMakeLast() { F.makeLast = false; const d = curDay(); F.dayEnd = d.end_at ? timeOf(d.end_at) : ""; F.touched = false; renderForm(); },
  cball(el) { const k = el.dataset.key; if (CB.key === k && CB.all) closeCB(); else loadCB(k, "", true); },
  cbmore(el) { loadCB(el.dataset.key, CB.q, CB.all, CB.items.length); },
  clearServerErr() { if (F?.serverErr) { F.serverErr = ""; const se = $("#serverErr"); if (se) se.textContent = ""; } },
  cbpick(el) {
    H.clearServerErr();
    const [kind, i] = el.dataset.key.split("-");
    if (kind === "staff") { F.staff[+i].id = Number(el.dataset.v); F.staff[+i].q = ""; closeCB(); rerenderStaff(); }
    else { F.parts[+i].spare = el.dataset.v; closeCB(); rerenderParts(); }
  },
  async ai() {
    if (aiBusy) return; // запрос уже идёт — повторное нажатие не запускает второй
    const text = (F.aitext || "").trim();
    if (!text) { $("#aiText")?.focus(); return; } // пустое описание — просто ставим курсор в поле
    // Весь разбор — не дольше AI_TOTAL_MS от нажатия: таймер общий для выбора машины, ИИ и заполнения полей.
    const T0 = performance.now(), deadline = Date.now() + AI_TOTAL_MS;
    const lap = (s) => console.info(`[разбор] ${s}: ${Math.round(performance.now() - T0)} мс`);
    const leftMs = () => deadline - Date.now();
    // Ожидание не дольше оставшегося времени (загрузка машины не должна съедать бюджет).
    const within = (p) => Promise.race([p, new Promise((res) => setTimeout(res, Math.max(0, leftMs())))]);
    aiBusy = true; renderForm();
    let parsed = null, src = "внутренний разбор по справочникам", aiErr = "";
    try {
      // Номер + модель в тексте решают однозначно, без ИИ: если названа другая машина, чем выбранная, — переключаемся.
      // Машина загружается параллельно с ИИ, а не перед ним; ИИ сразу получает её код (шаблон и персонал этой машины).
      const det = F.mode === "new" ? detectMachine(text) : {};
      let selP = null;
      if (det.cod && det.cod !== F.cod) selP = selectMachine(det.cod).then(() => { F.flt = {}; lap("машина по тексту загружена"); });
      else if (det.candidates && F.cod && !det.candidates.includes(F.cod)) clearMachine();
      if (AI_ON) {
        try {
          if (leftMs() < 1_500) throw new Error(AI_TIMEOUT_MSG);
          parsed = await aiParse(text, leftMs(), det.cod || F.cod); src = "AI";
          lap("ответ ИИ");
          if (selP) { await within(selP); selP = null; }
          // Выбор ИИ не должен противоречить номеру и модели в тексте: если по тексту подходит несколько машин,
          // а ИИ взял другую — не принимаем, показываем подходящие.
          // Номера в тексте нет (только модель) — выбор одной машины ИИ был бы догадкой, показываем все машины модели.
          if (det.candidates && parsed.cod && (det.byModel || !det.candidates.includes(Number(parsed.cod)))) { parsed.cod = null; parsed.candidates = det.candidates; }
          if (det.candidates && !parsed.cod && !parsed.candidates) parsed.candidates = det.candidates;
          if (det.byModel && parsed.candidates === det.candidates) parsed.byModel = true;
          // Машина ещё не выбрана: ИИ нашёл её по тексту — подставляем; второй вызов (уже с шаблоном и персоналом
          // этой машины) — только если в бюджете остаётся время на ответ, иначе берём первый ответ.
          const m = F.mode === "new" && !F.cod && parsed.cod ? Mx(parsed.cod) : null;
          if (m && !m.inactive) {
            const first = parsed;
            await within(selectMachine(m.cod));
            lap("машина по ответу ИИ загружена");
            if (leftMs() >= 3_000) {
              try { parsed = { ...(await aiParse(text, leftMs(), m.cod)), cod: m.cod }; lap("второй ответ ИИ"); }
              catch (_) { parsed = { ...first, cod: m.cod }; lap("второй вызов ИИ не успел — взят первый ответ"); }
            } else { parsed = { ...first, cod: m.cod }; lap("второй вызов ИИ пропущен (мало времени)"); }
          }
        } catch (e) { parsed = null; aiErr = e?.message || "ИИ недоступен"; lap("ИИ: " + aiErr); }
      }
      if (selP) await within(selP);
      if (!parsed) parsed = localParse(text);
      else {
        // Чего ИИ не нашёл (или не успел — второй вызов пропущен), добираем внутренним разбором.
        const loc = localParse(text);
        for (const k of ["type", "sub", "fail", "dmg", "reason", "mrange", "start_time", "date"]) if (parsed[k] == null && loc[k] != null) parsed[k] = loc[k];
        if (!(parsed.staff || []).length && loc.staff.length) parsed.staff = loc.staff;
        if (!(parsed.parts || []).length && loc.parts.length) parsed.parts = loc.parts;
      }
      lap("внутренний разбор");
      const r = await applyParsed(parsed);
      // Тип «ТО», у машины есть ЕО и в тексте «ЕО» / «ежедневный» — ставим ЕО, а не шаг цикла.
      if (F.type === TYPE_PM && hasEo(F) && !clsLocked() && /(^|[^а-яё])ео([^а-яё]|$)|ежедневн/i.test(text)) { pickEo(); r.set.push("ЕО"); }
      lap("поля заполнены");
      // ИИ не ответил или ошибся — поля уже заполнены внутренним разбором (словарь площадки + справочники), без ожидания.
      const why = aiErr.replace(/\.?\s*Попробуйте ещё раз или заполните поля вручную\.?$/, "");
      F.aiRes = (aiErr ? `<b style="color:#a52a21">${esc(why)}.</b> Поля заполнены внутренним разбором по справочникам — проверьте их; можно нажать «Разложить по полям» ещё раз. ` : "") + `<b>Заполнено (${src}):</b> ${esc(r.set.join(", ") || "ничего")}.${r.miss.length ? ` <b>Выберите вручную:</b> ${esc(r.miss.join(", "))}.` : ""} Всё проверено теми же правилами, что и ручной ввод.`;
    } catch (e) {
      // Сбой при заполнении полей из ответа ИИ — форма не остаётся пустой: применяем внутренний разбор.
      console.error("[разбор]", e);
      try {
        const r = await applyParsed(localParse(text));
        lap("поля заполнены внутренним разбором после сбоя");
        F.aiRes = `<b style="color:#a52a21">Ответ ИИ не удалось применить.</b> Поля заполнены внутренним разбором по справочникам — проверьте их. <b>Заполнено:</b> ${esc(r.set.join(", ") || "ничего")}.${r.miss.length ? ` <b>Выберите вручную:</b> ${esc(r.miss.join(", "))}.` : ""}`;
      } catch (e2) {
        console.error("[разбор]", e2);
        F.aiRes = `<b style="color:#a52a21">Не удалось разложить по полям: ${esc(e2?.message || e2)}.</b> Заполните поля вручную или нажмите «Разложить по полям» ещё раз.`;
      }
    } finally { aiBusy = false; renderForm(); } // кнопка снова рабочая и после ошибки, и после таймаута
  },
  day(el) { startDay(el.dataset.id); },
  async doBackfill(el) {
    if (busy) return;
    const n = W.notes?.stale?.days;
    if (!confirm(`Досоздать ${n} дн. простоя до сегодня? Они попадут в журнал и в расчёт доступности.`)) return;
    await guard(el, async () => {
      try {
        W = await rpc("repair_backfill", { p_wo: W.id });
        updateListItem(W); scheduleReportsRefresh();
        notice = notesText(W.notes) || null;
        renderWO();
      } catch (e) { toast(e.message); }
    });
  },
  async askClose() {
    if (busy) return;
    const last = W.days[W.days.length - 1];
    let why = "";
    // Всё для закрытия уже введено (комментарий и персонал в сегодняшнем последнем дне, наработка по каналам машины) — закрываем сразу, текущим временем.
    const dr = { tr: last.meter?.tr ?? "", dr1: last.meter?.dr1 ?? "", dr2: last.meter?.dr2 ?? "" };
    const pay = {};
    for (const ch of machineChans(W.cod)) { const v = String(dr[CH_KEYS[ch]] ?? "").trim().replace(",", "."); pay[CH_KEYS[ch]] = v === "" ? null : Number(v); }
    const meterReady = Object.values(pay).every((v) => v != null && !Number.isNaN(v));
    if (meterReady && last.comment.trim() && last.staff.length && dateOf(last.start_at) === todayS() && !last.end_at) {
      const end = nowS();
      busy = true; setLoading(true);
      try {
        W = await rpc("repair_close_wo", { p_wo: W.id, p_end: end, p_meter: pay });
        updateListItem(W); scheduleReportsRefresh();
        notice = `Наряд закрыт ${ru(end)} ${timeOf(end)}.`;
        renderWO();
        window.scrollTo(0, 0);
        return;
      } catch (e) { why = e.message; } finally { busy = false; setLoading(false); }
    }
    // Чего-то не хватает — открываем последний день в режиме закрытия и подсвечиваем, что заполнить.
    startDay(last.id);
    F.makeLast = true;
    F.dayEnd = dateOf(last.start_at) === todayS() ? nowS().slice(11, 16) : "23:59";
    F.touched = true;
    F.serverErr = why;
    renderForm();
    refresh();
    document.querySelector('[data-bind="dayEnd"]')?.focus();
  },
  cancelClose() { closing = false; renderWO(); },
  async saveNew() {
    if (!checkBeforeSave()) return;
    await withBusy(async () => {
      try {
        const p = { cod: F.cod, start_at: F.date + "T" + F.time, done: F.done, end_at: F.done ? F.endDate + "T" + F.endTime : null,
          ...classPayload(), comment: F.comment.trim(), staff_as_repair: !!F.asRepair, staff: staffPayload(), parts: partsPayload() };
        let r;
        try { r = await rpc("repair_create_wo", { p, p_meter: F.done ? meterPayload() : null }); } catch (e) {
          // Ответ не дошёл, но сервер мог успеть создать наряд: повторное нажатие дало бы дубль — сначала ищем созданный.
          const made = e.unsure ? await findCreated(p) : null;
          if (!made) throw e;
          r = await rpc("repair_open_wo", { p_wo: made.id });
        }
        W = r;
        updateListItem(W); scheduleReportsRefresh();
        const days = W.days.length;
        notice = F.done
          ? `Закончённый ремонт внесён: наряд № ${W.label || W.order_no} сохранён закрытым, дней: ${days}.${days > 1 ? " Комментарий, персонал и запчасти записаны в последний день." : ""}`
          : `Наряд № ${W.label || W.order_no} открыт. ${notesText(W.notes)}`.trim();
        F = null;
        go({ name: "wo", id: W.id });
      } catch (e) { failSave(e.message); }
    });
  },
  async saveDay() {
    if (!checkBeforeSave()) return;
    const te = typedEnd();
    if (te && await askCloseChoice(te)) {
      // Явное согласие закрыть: переходим в режим закрытия с теми же проверками (комментарий, персонал).
      F.makeLast = true; F.touched = true; renderForm();
      return;
    }
    await withBusy(async () => {
      try {
        const dp = dayPos();
        const p = { comment: F.comment.trim(), staff_as_repair: !!F.asRepair, staff: staffPayload(), parts: partsPayload() };
        if (meterShown()) p.meter = meterPayload(); // показание сохраняется на сервере вместе с днём, наряд при этом не закрывается
        if (dp === "only" || dp === "first") p.start_time = F.time;
        if (dp === "only" || dp === "last") Object.assign(p, classPayload());
        const keepNotes = W.notes;
        const ce = closingEnd();
        if (F.makeLast) {
          const later = laterDays();
          const withData = later.filter((d) => d.staff.length || d.parts.length || (d.comment || "").trim()).length;
          const n = later.length, w10 = n % 10, w100 = n % 100;
          const dn = w10 === 1 && w100 !== 11 ? "день" : w10 >= 2 && w10 <= 4 && (w100 < 12 || w100 > 14) ? "дня" : "дней";
          if (n && !confirm(`Будут удалены ${n} ${dn} после ${ru(F.date)}.${withData ? ` В ${withData} из них уже есть люди, запчасти или комментарий.` : ""} Продолжить?`)) return;
          Object.assign(p, classPayload());
          W = await rpc("repair_close_at_day", { p_day: F.dayId, p, p_end: F.date + "T" + ce, p_meter: meterPayload() });
          updateListItem(W); scheduleReportsRefresh();
          notice = `Наряд закрыт ${ru(F.date)} ${ce}.` + (later.length ? ` Дней после него удалено: ${later.length}.` : "");
          F = null;
          go({ name: "wo", id: W.id });
          return;
        }
        W = await rpc("repair_save_day", { p_day: F.dayId, p });
        if (!W.notes) W.notes = keepNotes;
        updateListItem(W); scheduleReportsRefresh();
        notice = `Данные дня ${ru(F.date)} сохранены, наряд остаётся открытым.` + (W.days.length > 1 && (dp === "last") ? " Классификация применена ко всем дням наряда." : "");
        if (ce) {
          try {
            W = await rpc("repair_close_wo", { p_wo: W.id, p_end: F.date + "T" + ce, p_meter: meterPayload() });
          } catch (e) {
            // День уже записан, не закрылся только наряд: говорим об этом прямо, повторное «Сохранить» безопасно.
            failSave(`Данные дня ${ru(F.date)} сохранены, но наряд не закрыт: ${e.message}`);
            return;
          }
          updateListItem(W); scheduleReportsRefresh();
          notice += ` Наряд закрыт ${ru(F.date)} ${ce}.`;
        }
        F = null;
        go({ name: "wo", id: W.id });
      } catch (e) { failSave(e.message); }
    });
  },
  async doClose(el) {
    const v = $("#closeAt").value, err = $("#closeErr");
    if (!v) { err.textContent = "Укажите дату и время окончания"; return; }
    await guard(el, async () => {
      try {
        W = await rpc("repair_close_wo", { p_wo: W.id, p_end: v });
        updateListItem(W); scheduleReportsRefresh();
        notice = `Наряд закрыт ${ru(v)} ${timeOf(v)}.`;
        closing = false;
        renderWO();
        window.scrollTo(0, 0);
      } catch (e) { err.textContent = e.message; }
    });
  },
  async reopen(el) {
    if (busy) return;
    if (!confirm("Переоткрыть наряд? Если с даты окончания прошли дни, они будут добавлены до сегодня.")) return;
    await guard(el, async () => {
      try {
        W = await rpc("repair_reopen_wo", { p_wo: W.id });
        updateListItem(W); scheduleReportsRefresh();
        notice = ["Наряд переоткрыт.", notesText(W.notes)].filter(Boolean).join(" ");
        renderWO();
      } catch (e) { toast(e.message); }
    });
  },
};

function onBind(e) {
  const el = e.target, b = el.dataset?.bind;
  if (!b) return;
  if (F?.serverErr) { F.serverErr = ""; const se = $("#serverErr"); if (se) se.textContent = ""; }
  if (b === "listq") { V.q = el.value; const pos = el.selectionStart; renderList(); const q = $("#q"); q.focus(); q.setSelectionRange(pos, pos); return; }
  if (b === "mq") { F.q = el.value; F.cands = null; F.onlyCod = null; const pos = el.selectionStart; renderForm(); const q = $("#mq"); q.focus(); q.setSelectionRange(pos, pos); return; }
  if (b === "flt") { F.flt = F.flt || {}; F.flt[el.dataset.k] = el.value; const k = el.dataset.k, pos = el.selectionStart; rerenderCls(); const inp = document.querySelector(`[data-bind="flt"][data-k="${k}"]`); if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); } return; }
  if (b === "aitext") { F.aitext = el.value; saveDraft(); return; }
  if (b === "cbq") {
    const k = el.dataset.key, [kind, i] = k.split("-");
    if (kind === "staff") { F.staff[+i].id = ""; F.staff[+i].q = el.value; }
    else {
      F.parts[+i].spare = el.value;
      const span = document.querySelector(`[data-desc="${i}"]`);
      if (span) paintDesc(span, el.value);
      clearTimeout(partTimer);
      partTimer = setTimeout(async () => { await describeParts([el.value]); if (span) paintDesc(span, el.value); loadPartHist(el.value); renderIx(); }, 400);
    }
    loadCB(k, el.value, false);
    refresh();
    return;
  }
  if (b === "meter") { (F.meter = F.meter || {})[el.dataset.ch] = el.value; checkMeter(); renderIx(); refresh(); return; }
  if (b === "asRepair") { F.asRepair = el.checked; rerenderStaff(); return; }
  if (b === "done") { F.done = el.checked; renderForm(); return; }
  const i = +el.dataset.i;
  if (b.startsWith("staff.")) { F.staff[i][b.slice(6)] = el.value; checkBusy(); }
  else if (b.startsWith("part.")) {
    const k = b.slice(5);
    F.parts[i][k] = el.value;
    if (k === "idx") renderIx();
  } else {
    F[b] = el.value;
    if (["time", "date", "endTime", "endDate"].includes(b)) { const st = $("#staff"); if (st && F.cod) st.innerHTML = renderStaff(); checkMachineBusy(); checkMeter(); }
    if (b === "dayEnd") {
      const lab = document.querySelector('[data-bind="dayEnd"]')?.previousElementSibling;
      if (lab) lab.textContent = "Окончание" + (ongoingEnd() ? " (день идёт)" : "");
      const bt = document.querySelector('#reStickIn [data-act="saveDay"]');
      if (bt) bt.textContent = F.makeLast ? "Сохранить и закрыть наряд" : "Сохранить день";
      const st = $("#staff"); if (st) st.innerHTML = renderStaff();
      checkMachineBusy();
      checkMeter();
    }
  }
  refresh();
}

async function initPage(session) {
  if (started) return;
  started = true;
  draftKey = "repair-entry-draft:" + session.user.id;
  setLoading(true);
  try {
    const [raw, pr] = await Promise.all([rpc("repair_dicts"), rpc("repair_parse_rules").catch(() => null)]);
    D = prepDicts(raw);
    PR = pr;
    skew = parseDT(raw.now) - Date.now();
    await loadList();
  } catch (e) {
    setLoading(false);
    app().innerHTML = `<div class="sec"><b>Форма недоступна</b><span>${esc(e.message)}</span><span class="hint">Ввод ремонтов доступен ролям «Ввод ремонтов», «Редактор» и «Администратор». Роль назначает администратор на странице «Пользователи».</span></div>`;
    return;
  }
  setLoading(false);
  $("#reBack").addEventListener("click", () => H.back());
  document.addEventListener("click", (e) => { if (CB.key && !e.target.closest(".cbx")) closeCB(); });
  objKey = "repair-entry-obj:" + session.user.id;
  renderScope();
  supabase.rpc("my_access").then(({ data }) => { ACCESS = data || null; renderScope(); });
  checkAI();
  document.addEventListener("click", (e) => { const el = e.target.closest("#reApp [data-act], #reStick [data-act]"); if (!el) return; e.preventDefault(); H[el.dataset.act]?.(el, e); });
  document.addEventListener("input", (e) => { if (e.target.closest("#reApp")) onBind(e); });
  document.addEventListener("change", (e) => { if (e.target.closest("#reApp") && (e.target.tagName === "SELECT" || e.target.type === "checkbox")) onBind(e); });
  document.addEventListener("change", (e) => { if (e.target.id === "photoIn" && e.target.files[0]) { onPhoto(e.target.files[0]); e.target.value = ""; } });
  window.addEventListener("popstate", (e) => {
    const v = e.state || parseHash();
    if (!v || v.name === "list") { F = null; go({ name: "list" }, false); }
    else if (v.name === "new" && F?.mode === "new") go({ name: "new" }, false);
    else if (v.name === "day" && F?.mode === "day" && W && W.id === v.id && F.dayId === v.dayId) go(v, false);
    else if (v.name === "new") { F = null; route(v, false); }
    else if (v.name === "wo" && W && W.id === v.id) { F = null; go(v, false); }
    else route(v, false);
  });
  document.addEventListener("pointerdown", () => { holdDraft = false; }, { once: true });
  document.addEventListener("keydown", () => { holdDraft = false; }, { once: true });
  // Прямой заход и обновление: сначала ссылка (#new, #wo-…, #day-…), иначе последний черновик.
  const h = parseHash();
  history.replaceState({ name: "list" }, "", "#");
  let d = null;
  try { d = JSON.parse(localStorage.getItem(draftKey) || "null"); } catch (_) { /* без черновика */ }
  if (d && Date.now() - d.at >= 3 * 864e5) d = null;
  if (h) { await route(h, true, d); return; }
  if (d && (d.V?.name === "new" || d.V?.name === "day")) { await route(d.V, true, d); if (V.name !== "list") return; }
  render();
}

// Открыть экран по ссылке/истории; черновик (если совпадает с экраном) восстанавливается как раньше.
async function route(v, fresh, d = null) {
  try {
    if (v.name === "new") {
      if (d?.V?.name === "new" && d.F && (!d.F.cod || Mx(d.F.cod))) {
        F = d.F;
        if (F.cod) await loadPm(F.cod);
        go({ name: "new" });
        toast("Черновик восстановлен");
      } else await startNew();
      return;
    }
    if (v.name === "wo" || v.name === "day") {
      await openWO(v.id);
      if (!W || W.id !== v.id) { go({ name: "list" }, false); return; }
      if (v.name === "day") {
        const dayId = v.dayId || (d?.V?.name === "day" && d.V.id === v.id ? d.F?.dayId : null) || W.days[W.days.length - 1].id;
        if (!W.days.some((x) => x.id === dayId)) return;
        const sameDraft = d?.V?.name === "day" && d.F?.dayId === dayId && W.status === "open";
        if (sameDraft) {
          F = d.F;
          if (!F.makeLast && !W.days.find((x) => x.id === dayId)?.end_at) F.dayEnd = ""; // старые черновики хранили подставленное «сейчас»
          await loadPm(F.cod);
          go({ name: "day", id: W.id, dayId });
          toast("Черновик дня восстановлен");
        } else startDay(dayId);
      }
      return;
    }
    go({ name: "list" }, false);
  } catch (e) { toast(e.message); }
}

setupAuth(supabase, "repair-entry.html", (session) => initPage(session));
