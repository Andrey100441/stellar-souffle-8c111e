// Хлебные крошки между связанными формами (как на «Доступности и надёжности» и «Журнале
// ремонтов»): ссылки несут текущие фильтры страницы в адресе (?object=…&mine=…), а форма,
// открытая по такой ссылке, выставляет их у себя (applyUrlFilters).
// Фильтры переносятся только крошками и подставляются в момент перехода, поэтому значения
// всегда текущие. Верхнее меню и другие кнопки открывают форму без фильтров.

export const STAFF_PAGES = [
  { href: "staff-details.html", label: "Персонал" },
  { href: "staff-objects.html", label: "Персонал по объектам" },
  { href: "staff-roster.html", label: "Справочник персонала" },
];

export const EQUIPMENT_PAGES = [
  { href: "equipment.html", label: "Оборудование" },
  { href: "plan-indicators.html", label: "Плановые показатели" },
  { href: "to-forecast.html", label: "Прогноз ТО" },
  { href: "pm-history.html", label: "История ТО" },
  { href: "smh-history.html", label: "Наработка (SMH)" },
];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function urlParam(name) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

// pages — цепочка форм, current — href этой страницы,
// params — { имя параметра: () => текущее значение фильтра } (пустое значение не передаётся).
export function initCrumbs(container, pages, current, params) {
  container.classList.add("crumbs", "crumbs-form");
  container.innerHTML = pages
    .map((p) => (p.href === current ? `<b>${esc(p.label)}</b>` : `<a href="${p.href}">${esc(p.label)}</a>`))
    .join(" › ");

  const hrefs = new Set(pages.map((p) => p.href).filter((h) => h !== current));
  const withFilters = (a) => {
    const page = (a.getAttribute("href") || "").split("?")[0];
    if (!hrefs.has(page) || !container.contains(a)) return;
    const q = new URLSearchParams();
    for (const [name, get] of Object.entries(params)) {
      const v = get();
      if (v) q.set(name, v);
    }
    const qs = q.toString();
    a.setAttribute("href", qs ? `${page}?${qs}` : page);
  };
  // click — обычный и Ctrl-клик, auxclick — средняя кнопка, contextmenu — «Открыть в новой вкладке».
  for (const type of ["click", "auxclick", "contextmenu"]) {
    document.addEventListener(type, (e) => {
      const a = e.target.closest?.("a[href]");
      if (a) withFilters(a);
    }, true);
  }
}

// Выставляет фильтры из адреса один раз — при первой загрузке формы.
// steps — [[имя параметра, селектор, после установки?], …] по порядку каскада
// (объект → шахта → модель → борт): после каждого шага форма перестраивает зависимые списки.
// Значение, которого нет среди вариантов, пропускается. Возвращает true, если что-то выставлено.
let urlApplied = false;
export function applyUrlFilters(steps) {
  if (urlApplied) return false;
  urlApplied = true;
  if (!steps.some(([name]) => urlParam(name))) return false;
  let any = false;
  for (const [name, sel, after] of steps) {
    const v = urlParam(name);
    const el = document.querySelector(sel);
    if (v && el && [...el.options].some((o) => o.value === v)) {
      el.value = v;
      any = true;
      after?.();
    }
  }
  return any;
}

// Формы «Оборудования»: объект, шахта, модель, борт (#filterCode, на «Оборудовании» — #filterLocalCode).
export function equipmentParams(codeSel = "#filterCode") {
  const val = (sel) => () => document.querySelector(sel).value;
  return { object: val("#filterObject"), mine: val("#filterMine"), model: val("#filterModel"), code: val(codeSel) };
}
// cascade(уровень) — перестроить зависимые списки после выбора объекта/шахты/модели
// (на формах с каскадом из filters.js); без каскада — не передавать.
export function equipmentSteps(codeSel = "#filterCode", cascade) {
  const after = (level) => (cascade ? () => cascade(level) : undefined);
  return [["object", "#filterObject", after("object")], ["mine", "#filterMine", after("mine")], ["model", "#filterModel", after("model")], ["code", codeSel]];
}
export function hasUrlFilters(names = ["object", "mine", "model", "code"]) {
  return names.some((n) => urlParam(n));
}
