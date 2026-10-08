// Правила словаря разбора ремонтов — одна логика для формы ввода ремонтов и страницы «Словарь разбора».
// Правила площадки (рудника) берутся из repair_parse_rules(): свои правила рудника или общие «*».
// Порядок для типа работ: слова (первая подходящая строка) → период ЕО по времени открытия работы,
// если слов типа в тексте нет → не определён (решают ИИ или пользователь). Время и слова равноценны:
// время ЕО не перебивает слова другого типа («кпп не переключается» в 8:00 — аварийные). Подсистема/отказ и причина — по словам,
// инициатор — по таблице «тип + причина».

// Текст для поиска: нижний регистр, ё → е, всё кроме букв и цифр — пробелы, пробелы по краям.
export const normText = (s) => " " + String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim() + " ";

// Расстояние Левенштейна, не больше 2 (дальше считать не нужно).
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// Одно слово словаря подходит к слову текста:
// до 2 знаков — только целиком («то», «ео»);
// 3–5 знаков — основа (у слова от 4 букв без последней гласной, «ь» или «й») + окончание падежа: начинается
//   с гласной или «ь», не длиннее 3 букв: «шланг» → «шланга/шлангов», «масло» → «масла», «шина» → «шины»,
//   «течь» → «течи/течью», «руль» → «руля», «вал» → «вала», но «рама» ≠ «рамка», «фара» ≠ «фаркоп»,
//   «план» ≠ «планетарный», «течь» ≠ «течение»;
// от 6 знаков — по основе не короче 5 букв (без двух последних у длинных слов): «двигател-я/-ем»,
//   «колесо» ≠ «колено», «провод» ≠ «проверка», «прокол» ≠ «прокачка»;
// слову от 8 букв прощается одна опечатка во всём слове: «перключается» = «переключается»,
// «охлождение» = «охлаждение» (по началу слова с опечаткой — нет: «повторно» ≠ «поворот», «переключается» ≠ «переключатель»).
const ENDING = /^[аеиоуыэюяь][а-я]{0,2}$/;
function wordFits(tok, k) {
  if (k.length <= 2) return tok === k;
  if (k.length < 6) {
    if (tok === k) return true;
    const stem = /[аеиоуыэюяьй]$/.test(k) && k.length > 3 ? k.slice(0, -1) : k;
    return tok.startsWith(stem) && ENDING.test(tok.slice(stem.length));
  }
  if (tok.startsWith(k.slice(0, Math.max(5, k.length - 2)))) return true;
  return k.length >= 8 && lev(tok, k) <= 1;
}
// Слово или фраза словаря встречается в тексте (text — из normText). Фраза — слова подряд, каждое по правилу выше.
export function hasWord(text, word) {
  const k = normText(word).trim();
  if (!k) return false;
  const kw = k.split(" "), tw = text.trim().split(" ");
  for (let i = 0; i + kw.length <= tw.length; i++) if (kw.every((w, j) => wordFits(tw[i + j], w))) return true;
  return false;
}
const matched = (text, words) => (words || []).filter((w) => hasWord(text, w));

// Правила, действующие для рудника: свои или общие.
export const rulesForMine = (sites, mine) => (mine && sites?.[mine]) || sites?.["*"] || { eo: [], type: [], sub: [], reason: [], dmg: [], model: [] };

// Модель машины подходит под строку словаря «Модели техники»: название из словаря (марка или модель)
// входит в модель машины без учёта регистра, пробелов, дефисов и точек (KOMATSU → «KOMATSU HD785-7»).
const modelKey = (s) => String(s || "").toLowerCase().replace(/[\s\-_.]+/g, "");
export const modelFits = (machineModel, ruleModel) => !!modelKey(ruleModel) && modelKey(machineModel).includes(modelKey(ruleModel));

// Период ЕО, в который попадает время «ЧЧ:ММ», или null.
export const eoPeriod = (rules, time) => (time ? (rules.eo || []).find((p) => p.on && p.type && time >= p.from && time < p.to) : null) || null;

// Разбор текста по правилам. Возвращает найденное и пояснение «почему» для каждого поля.
export function applyRules(rules, text, time) {
  const t = normText(text);
  const out = { type: null, typeWhy: "", subs: [], reason: null, reasonWhy: "", dmg: null, dmgWhy: "", models: [] };
  const p = eoPeriod(rules, time);
  for (const r of rules.type || []) {
    const m = matched(t, r.words);
    if (m.length) { out.type = r.type; out.typeWhy = `слово «${m[0]}»` + (p && p.type !== r.type ? ` (работа открыта в период ЕО ${p.from}–${p.to}, но слова важнее)` : ""); break; }
  }
  if (!out.type && p) { out.type = p.type; out.typeWhy = `слов типа нет, работа открыта в ${time} — период ЕО ${p.from}–${p.to}`; out.byEO = true; }
  for (const r of rules.sub || []) {
    const m = matched(t, r.words);
    if (m.length) out.subs.push({ sub: r.sub, fail: r.fail ?? null, words: m });
  }
  for (const r of rules.reason || []) {
    const m = matched(t, r.words);
    if (m.length) { out.reason = r.reason; out.reasonWhy = `слово «${m[0]}»`; break; }
  }
  for (const r of rules.model || []) {
    const m = matched(t, r.words);
    if (m.length) out.models.push({ model: r.model, words: m });
  }
  const d = out.type && out.reason ? (rules.dmg || []).find((x) => x.type === out.type && x.reason === out.reason) : null;
  if (d) { out.dmg = d.dmg; out.dmgWhy = "таблица «тип + причина»"; }
  return out;
}

// Правила текстом для ИИ (короткая инструкция по названиям из справочников).
export function rulesPrompt(rules, names) {
  const n = (k, id) => names[k]?.get(id) || `#${id}`;
  const lines = [];
  for (const r of rules.type || []) lines.push(`Тип работ «${n("types", r.type)}», если есть слова: ${r.words.join(", ")}.`);
  for (const r of rules.sub || []) lines.push(`Подсистема «${n("subs", r.sub)}»${r.fail ? ` / отказ «${n("fails", r.fail)}»` : ""}, если есть слова: ${r.words.join(", ")}.`);
  for (const r of rules.reason || []) lines.push(`Причина «${n("reasons", r.reason)}», если есть слова: ${r.words.join(", ")}.`);
  for (const r of rules.model || []) lines.push(`Модель или марка «${r.model}» пишут также: ${r.words.join(", ")}.`);
  for (const r of rules.dmg || []) lines.push(`Тип «${n("types", r.type)}» + причина «${n("reasons", r.reason)}» → инициатор «${n("damages", r.dmg)}».`);
  return lines.join("\n");
}
