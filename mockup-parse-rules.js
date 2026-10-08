// МАКЕТ страницы «Словарь разбора ремонтов»: данные и счётчики использования примерные, в базу ничего не пишется.
(function () {
  const START = {
    ai: { on: true, model: "haiku" },
    // Справочники: uses — в скольких работах значение уже стоит (примерно)
    dict: {
      types: [[1, "Аварийные работы", 31250], [2, "Плановые работы", 8420], [3, "Тех. Обслуживание", 12900], [4, "Замена узла", 610], [5, "Капитальный ремонт", 95]],
      subs: [["Силовая установка", 9100], ["Эл. часть", 5200], ["Гидравлика", 7400], ["Автошина", 3300], ["Тормозная система", 1500], ["Рулевое управление", 900],
        ["Мост", 1100], ["Ходовая часть", 800], ["Рабочее оборудование", 4100], ["Несущая конструкция", 700], ["Рабочее место оператора", 650], ["Воздушная система", 300], ["Прочие", 2100]]
        .map(([n, u], i) => [i + 100, n, u]),
      fails: [["Водяной насос", 410, 100], ["Выхлопная система", 220, 100], ["Топливная система", 530, 100], ["Радиатор", 380, 100], ["АКБ", 640, 101], ["Генераторная установка", 290, 101],
        ["Выключатель/кнопка/Датчик", 720, 101], ["Стартер", 260, 101], ["Гидравлический насос", 880, 102], ["Гидравлический клапан", 450, 102], ["Гидроцилиндр", 600, 102], ["РВД", 2900, 102],
        ["Автошина/камера/флиппер", 3300, 103], ["Ковш", 1300, 108], ["Стрела", 900, 108]].map(([n, u, s], i) => [i + 500, n, u, s]),
      reasons: [[1, "Гарантийный случай", 120], [2, "Некачественный ремонт", 340], [3, "Неправильная эксплуатация", 2600], [4, "Нормальный износ", 38000], [5, "Организационные причины", 900], [9, "Регламент (ТО)", 12500]],
      damages: [[1, "Рудник", 9800], [2, "Сервис", 44000]],
    },
    // [тип, инициатор, причина] — разрешённые сочетания
    rules: [[3, 2, 4], [4, 1, 3], [1, 2, 4], [4, 2, 2], [1, 2, 2], [5, 2, 4], [4, 1, 4], [1, 1, 4], [4, 2, 4], [1, 2, 5], [1, 1, 3], [1, 1, 5], [3, 2, 9], [1, 2, 1], [2, 2, 4]],
    mines: ["Аксу-2", "Аралтобе", "Аралча"], // примерный список рудников
  };
  // Правила площадки: периоды ЕО, тип по умолчанию, слова, инициатор. "*" — общие (все рудники).
  const RULES0 = {
    eo: [{ on: true, from: "07:00", to: "09:00", type: 3 }, { on: false, from: "19:00", to: "21:00", type: 3 }],
    type: [
      [3, "то, то-1, то-2, техобслуживание, тех обслуживание, обслуживание, регламент"],
      [5, "капремонт, капитальный"],
      [4, "замена узла, замена двигателя, замена кпп, замена моста"],
      [2, "план, плановый, плановая, планово, по плану"],
      [1, "авария, аварийный, сломался, поломка, оборвало, лопнул, течь, не заводится, отказ, встал, трещина"],
    ],
    sub: [
      [100, "", "двс, двигатель, мотор, движок, радиатор, антифриз, перегрев, патрубок, топливо, форсунка, тнвд, поршень"],
      [100, 500, "помпа, водяной насос"],
      [101, "", "электрика, генератор, проводка, провод, кабель, датчик, акб, аккумулятор, фары, свет, предохранитель, стартер"],
      [102, "", "гидравлика, гидронасос, гидроцилиндр, рвд, шланг, рукав, штуцер, течь масла, давление гидравлики"],
      [103, "", "шина, колесо, покрышка, прокол, камера"],
      [104, "", "тормоз, тормоза, колодка, колодки"],
      [107, "", "ходовая, подвеска, амортизатор, сайлентблок, стойка, пружина, шрус"],
      [108, "", "стрела, ковш, зуб, кузов"],
    ],
    reason: [[4, "износ, изношен, износился, выработка"], [3, "оператор, неправильная эксплуатация, наехал, удар, перегруз"], [1, "гарантия, гарантийный"], [2, "после ремонта, повторно, некачественный"]],
    dmg: [[1, 4, 2], [1, 3, 1]],
  };
  START.sites = { "*": RULES0, "Аралча": Object.assign(JSON.parse(JSON.stringify(RULES0)), { eo: [{ on: true, from: "06:30", to: "08:00", type: 3 }, { on: true, from: "18:30", to: "20:00", type: 3 }] }) };
  let S = JSON.parse(JSON.stringify(START));
  let site = "*";
  // Правила, которые действуют для площадки (свои или общие), и редактируемые (только свои или общие на «*»).
  const eff = (m) => S.sites[m] || S.sites["*"];
  const own = () => !!S.sites[site];
  const C = () => eff(site);
  const siteName = (m) => (m === "*" ? "Общие правила (все рудники)" : m);
  let tab = "types";
  const LOG = []; // журнал замен (в макете — только в памяти страницы)
  const SHARE = { "Аксу-2": 0.2, "Аралтобе": 0.45, "Аралча": 0.35 }; // примерная доля работ рудника
  const REPORTS = {
    types: "Доступность и надёжность (плановый/аварийный простой, MTBF, MTTR), Состояние парка, Журнал ремонтов, История ТО",
    subs: "Журнал ремонтов, Аварийный простой по подсистемам, Состояние парка",
    fails: "Журнал ремонтов, Аварийный простой по подсистемам",
    reasons: "Причины аварийных отказов, Журнал ремонтов",
    damages: "Простой по виновнику (рудник/сервис), Журнал ремонтов",
  };
  let nextId = 9000;

  const $ = (q) => document.querySelector(q);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmtN = (n) => Number(n || 0).toLocaleString("ru-RU");
  const L = (k) => S.dict[k].map((x) => [x[0], x[1]]);
  const name = (k, id) => (S.dict[k].find((x) => x[0] === Number(id)) || [])[1] || "";
  const opts = (list, sel, empty) => (empty ? `<option value="">${empty}</option>` : "") + list.map(([id, n]) => `<option value="${id}"${Number(sel) === id ? " selected" : ""}>${esc(n || "(без названия)")}</option>`).join("");
  const dirty = () => ($("#dirty").hidden = false);

  function render() {
    const T = L("types"), R = L("reasons"), DM = L("damages"), SB = L("subs");
    $("#tblType tbody").innerHTML = C().type.map(([t, w], i) => `<tr data-i="${i}">
      <td class="cat"><select data-f="0">${opts(T, t)}</select></td>
      <td><textarea data-f="1">${esc(w)}</textarea></td>
      <td><button class="pr-mv" data-mv="-1" title="Выше">↑</button> <button class="pr-mv" data-mv="1" title="Ниже">↓</button> <button class="pr-x" data-del title="Удалить строку">×</button></td></tr>`).join("");
    $("#tblSub tbody").innerHTML = C().sub.map(([s, f, w], i) => `<tr data-i="${i}">
      <td class="cat"><select data-f="0">${opts(SB, s)}</select></td>
      <td><select data-f="1">${opts(S.dict.fails.filter((x) => x[3] === Number(s)).map((x) => [x[0], x[1]]), f, "— любой —")}</select></td>
      <td><textarea data-f="2">${esc(w)}</textarea></td>
      <td><button class="pr-x" data-del title="Удалить строку">×</button></td></tr>`).join("");
    $("#tblReason tbody").innerHTML = C().reason.map(([r, w], i) => `<tr data-i="${i}">
      <td class="cat"><select data-f="0">${opts(R, r)}</select></td>
      <td><textarea data-f="1">${esc(w)}</textarea></td>
      <td><button class="pr-x" data-del title="Удалить строку">×</button></td></tr>`).join("");
    $("#tblDmg tbody").innerHTML = C().dmg.map(([t, r, d], i) => {
      const allowed = DM.filter(([id]) => S.rules.some((x) => x[0] === Number(t) && x[2] === Number(r) && x[1] === id));
      return `<tr data-i="${i}">
      <td><select data-f="0">${opts(T, t)}</select></td>
      <td><select data-f="1">${opts(R, r)}</select></td>
      <td><select data-f="2">${allowed.length ? opts(allowed, d, "— выберите —") : '<option value="">нет разрешённых вариантов</option>'}</select></td>
      <td><button class="pr-x" data-del title="Удалить строку">×</button></td></tr>`;
    }).join("");
    $("#eoRows").innerHTML = C().eo.map((p, i) => `<div class="pr-inline" data-eo="${i}">
      <label class="switch"><input type="checkbox" data-eof="on"${p.on ? " checked" : ""} /></label> Период ${i + 1}: если работа открыта с
      <input type="time" data-eof="from" value="${p.from}" /> до <input type="time" data-eof="to" value="${p.to}" /> → <select data-eof="type">${opts(T, p.type)}</select></div>`).join("");
    $("#aiOn").checked = S.ai.on;
    $("#aiLabel").textContent = S.ai.on ? "Включён" : "Выключен";
    $("#aiLabel").className = S.ai.on ? "ai-on" : "ai-off";
    $("#aiModel").value = S.ai.model;
    $("#aiModel").disabled = !S.ai.on;
    renderSite();
    renderDict();
  }

  function renderSite() {
    const all = ["*", ...S.mines];
    const lab = (m) => siteName(m) + (m !== "*" && S.sites[m] ? " — свои правила" : "");
    $("#site").innerHTML = all.map((m) => `<option value="${esc(m)}"${m === site ? " selected" : ""}>${esc(lab(m))}</option>`).join("");
    const ts = $("#testSite"), cur = ts.value || "Аралтобе";
    ts.innerHTML = S.mines.map((m) => `<option${m === cur ? " selected" : ""}>${esc(m)}</option>`).join("");
    $("#ownWrap").hidden = site === "*";
    $("#ownRules").checked = own();
    const ro = site !== "*" && !own();
    $("#siteState").textContent = site === "*" ? "Правят все рудники без своих правил" : ro ? "Сейчас использует общие правила (показаны, только чтение)" : "Свои правила рудника";
    document.querySelectorAll(".site-sec").forEach((sec) => {
      sec.classList.toggle("ro", ro);
      sec.querySelector(".badge-site").textContent = siteName(site);
      const n = sec.querySelector(".inherit-note");
      n.hidden = !ro;
      n.textContent = "Рудник использует общие правила. Чтобы задать свои — включите «Свои правила для этого рудника» вверху.";
    });
  }
  // ---------- Обмен правилами между площадками (модальное окно) ----------
  const PARTS = { eo: "Периоды ЕО", type: "Слова: тип работ", sub: "Подсистема и отказ", reason: "Причина", dmg: "Инициатор" };
  let xfer = null; // { mode: "import" | "export" }
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const wl = (str) => String(str || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const keyOf = (part, row) => (part === "sub" ? row[0] + "|" + row[1] : part === "dmg" ? row[0] + "|" + row[1] : String(row[0]));
  const wordsIdx = { type: 1, sub: 2, reason: 1 };
  const eoTxt = (eo) => eo.filter((x) => x.on).map((x) => `${x.from}–${x.to}`).join(", ") || "выключены";

  // Результат переноса: новые правила площадки-получателя.
  function transfer(src, dst, parts, mode) {
    const out = clone(dst);
    for (const part of parts) {
      if (part === "eo" || mode === "replace") { out[part] = clone(src[part]); continue; }
      const idx = new Map(out[part].map((r, i) => [keyOf(part, r), i]));
      for (const row of src[part]) {
        const k = keyOf(part, row);
        if (!idx.has(k)) { out[part].push(clone(row)); continue; }
        if (part === "dmg") continue; // инициатор у получателя уже задан — не трогаем
        const wi = wordsIdx[part], cur = out[part][idx.get(k)];
        const have = new Set(wl(cur[wi]));
        const add = wl(row[wi]).filter((w) => !have.has(w));
        if (add.length) cur[wi] = [cur[wi], add.join(", ")].filter(Boolean).join(", ");
      }
    }
    return out;
  }
  // Что изменится — для предпросмотра.
  function diffText(before, after, parts) {
    const lines = [];
    for (const part of parts) {
      if (part === "eo") { if (eoTxt(before.eo) !== eoTxt(after.eo)) lines.push(`Периоды ЕО: ${eoTxt(before.eo)} → ${eoTxt(after.eo)}`); continue; }
      if (part === "dmg") {
        const b = new Set(before.dmg.map((r) => r.join("|"))), a2 = new Set(after.dmg.map((r) => r.join("|")));
        const add = [...a2].filter((x) => !b.has(x)).length, del = [...b].filter((x) => !a2.has(x)).length;
        if (add || del) lines.push(`Инициатор: ${add ? "+" + add + " правил" : ""}${add && del ? ", " : ""}${del ? "−" + del + " правил" : ""}`);
        continue;
      }
      const wi = wordsIdx[part];
      const all = (rs) => new Set(rs.flatMap((r) => wl(r[wi]).map((w) => keyOf(part, r) + ":" + w)));
      const b = all(before[part]), a2 = all(after[part]);
      const add = [...a2].filter((x) => !b.has(x)).map((x) => x.split(":").pop()), del = [...b].filter((x) => !a2.has(x)).length;
      if (add.length || del) lines.push(`${PARTS[part]}: ${add.length ? "+" + add.length + " слов (" + add.slice(0, 6).join(", ") + (add.length > 6 ? "…" : "") + ")" : ""}${add.length && del ? ", " : ""}${del ? "−" + del + " слов" : ""}`);
    }
    return lines;
  }
  const xParts = () => [...document.querySelectorAll("#xferParts input:checked")].map((x) => x.value);
  const xMode = () => document.querySelector("input[name=xferMode]:checked").value;
  const xFrom = () => (xfer.mode === "import" ? $("#xferFromSel").value : site);
  const xTo = () => (xfer.mode === "import" ? [site] : [...document.querySelectorAll("#xferTo input:checked")].map((x) => x.value));

  function openXfer(mode) {
    xfer = { mode };
    const others = ["*", ...S.mines].filter((m) => m !== site);
    $("#xferTitle").textContent = mode === "import" ? `Импорт правил в «${siteName(site)}»` : `Экспорт правил «${siteName(site)}»`;
    $("#xferFrom").innerHTML = mode === "import"
      ? `<select id="xferFromSel">${others.map((m) => `<option value="${esc(m)}">${esc(siteName(m))}${m !== "*" && !S.sites[m] ? " (использует общие)" : ""}</option>`).join("")}</select>`
      : `<b>${esc(siteName(site))}</b>`;
    $("#xferTo").innerHTML = mode === "import"
      ? `<b>${esc(siteName(site))}</b>`
      : others.map((m) => `<label class="combo"><input type="checkbox" value="${esc(m)}" /> ${esc(siteName(m))}</label>`).join("<br>");
    $("#xferModal").hidden = false;
    xferPreview();
  }
  function xferPreview() {
    const parts = xParts(), to = xTo(), src = eff(xFrom());
    if (!to.length) { $("#xferPreview").innerHTML = '<span class="none">Отметьте, на какие площадки переносить.</span>'; $("#xferOk").disabled = true; return; }
    if (!parts.length) { $("#xferPreview").innerHTML = '<span class="none">Отметьте, что переносить.</span>'; $("#xferOk").disabled = true; return; }
    $("#xferOk").disabled = false;
    $("#xferPreview").innerHTML = "<b>Что изменится:</b>" + to.map((t) => {
      const before = eff(t), lines = diffText(before, transfer(src, before, parts, xMode()), parts);
      const note = t !== "*" && !S.sites[t] ? " — сейчас использует общие; станут свои правила" : "";
      return `<div style="margin-top:6px"><b>${esc(siteName(t))}</b>${esc(note)}${lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : '<div class="none">без изменений</div>'}</div>`;
    }).join("");
  }
  const closeXfer = () => { $("#xferModal").hidden = true; xfer = null; };
  $("#importBtn").addEventListener("click", () => openXfer("import"));
  $("#exportBtn").addEventListener("click", () => openXfer("export"));
  $("#xferClose").addEventListener("click", closeXfer);
  $("#xferCancel").addEventListener("click", closeXfer);
  $("#xferModal").addEventListener("change", xferPreview);
  $("#xferOk").addEventListener("click", () => {
    const parts = xParts(), mode = xMode(), src = eff(xFrom());
    for (const t of xTo()) S.sites[t] = transfer(src, eff(t), parts, mode);
    closeXfer(); dirty(); render();
  });

  // ---------- Заменить значение в записанных работах ----------
  let repl = null; // { kind, id }
  const KIND_LABEL = { types: "Тип работ", subs: "Подсистема", fails: "Отказ", reasons: "Причина", damages: "Инициатор" };
  function replCount() {
    const x = S.dict[repl.kind].find((r) => r[0] === repl.id);
    const st = $("#replSite").value, d1 = $("#replD1").value, d2 = $("#replD2").value;
    let n = x[2] * (st === "*" ? 1 : SHARE[st] || 0);
    if (d1 || d2) { // примерно: данные с 2019-01 по сегодня, равномерно
      const a = d1 ? new Date(d1) : new Date("2019-01-01"), b = d2 ? new Date(d2) : new Date();
      n *= Math.max(0, Math.min(1, (b - a) / (new Date() - new Date("2019-01-01"))));
    }
    return Math.round(n);
  }
  function openRepl(kind, id) {
    repl = { kind, id };
    $("#replTitle").textContent = "Заменить: " + KIND_LABEL[kind].toLowerCase();
    $("#replFrom").innerHTML = `<b>${esc(name(kind, id))}</b>`;
    $("#replTo").innerHTML = opts(L(kind).filter(([i]) => i !== id), "", "— выберите —") + '<option value="new">+ Новое значение…</option>';
    $("#replNew").value = ""; $("#replNew").hidden = true;
    $("#replSite").innerHTML = [["*", "Все рудники"], ...S.mines.map((m) => [m, m])].map(([v, l]) => `<option value="${esc(v)}"${v === site ? " selected" : ""}>${esc(l)}</option>`).join("");
    $("#replD1").value = ""; $("#replD2").value = "";
    $("#replAgree").checked = false;
    $("#replModal").hidden = false;
    replPreview();
  }
  // «На»: существующее значение или новое (создаётся при замене, получает новый ключ).
  const replIsNew = () => $("#replTo").value === "new";
  const replToName = () => (replIsNew() ? $("#replNew").value.trim() : name(repl.kind, $("#replTo").value));
  function replPreview() {
    $("#replNew").hidden = !replIsNew();
    const to = replIsNew() ? ($("#replNew").value.trim() ? -1 : 0) : Number($("#replTo").value), n = replCount(), st = $("#replSite").value;
    const d1 = $("#replD1").value, d2 = $("#replD2").value;
    const ru = (d) => d.split("-").reverse().join(".");
    const per = d1 || d2 ? `с ${d1 ? ru(d1) : "начала данных"} по ${d2 ? ru(d2) : "сегодня"}` : "за всё время";
    const ruleNote = $("#replRules").checked
      ? (st === "*" ? "Правила: заменится в общих правилах и в своих правилах всех рудников."
        : S.sites[st] ? `Правила: заменится в своих правилах рудника ${st}.` : `Правила: у рудника ${st} нет своих правил — будут созданы из общих, уже с заменой.`)
      : "Правила словаря не меняются.";
    $("#replPreview").innerHTML = !to
      ? '<span class="none">Выберите, на что заменить. Если нового значения нет в списке — сначала добавьте его кнопкой «+ Добавить».</span>'
      : `<b>Будет изменено ${fmtN(n)} работ</b> (${esc(st === "*" ? "все рудники" : st)}, ${esc(per)}): «${esc(name(repl.kind, repl.id))}» → «${esc(replToName())}»${replIsNew() ? " (новое значение, новый ключ)" : ""}.
        <div class="warn" style="margin-top:6px">Изменятся отчёты за эти месяцы: ${esc(REPORTS[repl.kind])}.</div>
        <div style="margin-top:6px">${esc(ruleNote)}</div>
        <div style="margin-top:6px">Значение «${esc(name(repl.kind, repl.id))}» останется в справочнике — его можно удалить, когда оно перестанет использоваться. Замену можно откатить в «Журнале замен».</div>`
        + (["types", "subs", "fails"].includes(repl.kind) ? `<div class="uses" style="margin-top:6px">Новые работы с «${esc(replToName())}» в форме ввода появятся, когда это значение будет в шаблонах моделей.</div>` : "");
    $("#replOk").disabled = !to || !n || !$("#replAgree").checked;
  }
  function swapInRules(R, kind, from, to) {
    const sw = (v) => (Number(v) === from ? to : v);
    if (kind === "types") { R.eo.forEach((p) => (p.type = sw(p.type))); R.type.forEach((r) => (r[0] = sw(r[0]))); R.dmg.forEach((r) => (r[0] = sw(r[0]))); }
    if (kind === "subs") R.sub.forEach((r) => (r[0] = sw(r[0])));
    if (kind === "fails") R.sub.forEach((r) => (r[1] = r[1] === "" ? "" : sw(r[1])));
    if (kind === "reasons") { R.reason.forEach((r) => (r[0] = sw(r[0]))); R.dmg.forEach((r) => (r[1] = sw(r[1]))); }
    if (kind === "damages") R.dmg.forEach((r) => (r[2] = r[2] === "" ? "" : sw(r[2])));
  }
  const closeRepl = () => { $("#replModal").hidden = true; repl = null; };
  $("#replClose").addEventListener("click", closeRepl);
  $("#replCancel").addEventListener("click", closeRepl);
  $("#replModal").addEventListener("change", replPreview);
  $("#replModal").addEventListener("input", replPreview);
  $("#replOk").addEventListener("click", () => {
    let to = Number($("#replTo").value);
    const n = replCount(), st = $("#replSite").value, d1 = $("#replD1").value, d2 = $("#replD2").value;
    const xs = S.dict[repl.kind];
    if (replIsNew()) { // добавить новое значение с новым ключом
      to = nextId++;
      const src = xs.find((r) => r[0] === repl.id);
      xs.push(repl.kind === "fails" ? [to, replToName(), 0, src[3]] : [to, replToName(), 0]);
      if (repl.kind === "reasons") S.rules.filter((r) => r[2] === repl.id).forEach((r) => S.rules.push([r[0], r[1], to])); // те же разрешённые сочетания
    }
    xs.find((r) => r[0] === repl.id)[2] -= n;
    xs.find((r) => r[0] === to)[2] += n;
    if ($("#replRules").checked) {
      const sites = st === "*" ? Object.keys(S.sites) : [st];
      for (const m of sites) { if (!S.sites[m]) S.sites[m] = clone(S.sites["*"]); swapInRules(S.sites[m], repl.kind, repl.id, to); }
    }
    LOG.unshift({ when: new Date().toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }), kind: repl.kind, from: repl.id, to, site: st,
      per: d1 || d2 ? `${d1 || "…"} — ${d2 || "…"}` : "всё время", n, undone: false });
    closeRepl(); dirty(); render();
  });
  function renderLog() {
    $("#tblLog tbody").innerHTML = LOG.length
      ? LOG.map((r, i) => `<tr data-li="${i}"${r.undone ? ' style="opacity:.5"' : ""}><td>${esc(r.when)}</td>
      <td>${esc(KIND_LABEL[r.kind])}: «${esc(name(r.kind, r.from))}» → «${esc(name(r.kind, r.to))}»</td><td>${esc(r.site === "*" ? "все" : r.site)}</td><td>${esc(r.per)}</td><td>${fmtN(r.n)}</td>
      <td>${r.undone ? "откачено" : '<button class="btn-secondary btn-small" data-undo>Откатить</button>'}</td></tr>`).join("")
      : '<tr><td colspan="6" class="uses">Замен ещё не было.</td></tr>';
  }
  document.addEventListener("click", (e) => {
    const rb = e.target.closest("[data-repl]");
    if (rb) { const tr = rb.closest("tr[data-di]"); openRepl(tab, S.dict[tab][tr.dataset.di][0]); return; }
    const ub = e.target.closest("[data-undo]");
    if (ub) {
      const r = LOG[ub.closest("tr").dataset.li];
      if (!confirm(`Откатить замену «${name(r.kind, r.from)}» → «${name(r.kind, r.to)}»? Вернутся ровно те ${fmtN(r.n)} работ, что были изменены.`)) return;
      const xs = S.dict[r.kind];
      xs.find((x) => x[0] === r.from)[2] += r.n;
      xs.find((x) => x[0] === r.to)[2] -= r.n;
      r.undone = true; render();
    }
  });

  const DICT_HINT = {
    types: "Переименование меняет название во всех работах и отчётах. Удалить можно только тип, который ни разу не использовался.",
    subs: "Новая подсистема появится в форме ввода, когда её добавят в шаблон модели (редактор шаблонов — отдельная задача). Удалить можно только неиспользованную.",
    fails: "Отказ относится к подсистеме. Новый отказ появится в форме, когда его добавят в шаблон модели. Удалить можно только неиспользованный.",
    reasons: "Отметьте, для каких «тип работ / инициатор» причина разрешена — только тогда она появится в форме. Удалить можно только неиспользованную.",
    damages: "Инициатор — кто виноват в простое. Удалить можно только неиспользованного.",
  };
  function renderDict() {
    renderLog();
    document.querySelectorAll("#dictTabs .tab").forEach((b) => b.classList.toggle("on", b.dataset.dict === tab));
    $("#dictHint").textContent = DICT_HINT[tab];
    const del = (u) => (u ? `<button class="btn-secondary btn-small" data-repl title="Заменить это значение другим в записанных работах">Заменить…</button> ` : "") + `<button class="pr-x" data-ddel ${u ? `disabled title="Используется в ${fmtN(u)} работах — удалить нельзя, можно переименовать"` : 'title="Удалить"'}>×</button>`;
    const nameCell = (x) => `<td><input type="text" data-dn value="${esc(x[1])}" placeholder="Название" /></td>`;
    const uses = (u) => `<td class="uses">${u ? fmtN(u) + " работ" : "не используется"}</td>`;
    if (tab === "fails") {
      $("#tblDict thead").innerHTML = "<tr><th style='width:30%'>Отказ</th><th style='width:30%'>Подсистема</th><th>Используется</th><th style='width:150px'></th></tr>";
      $("#tblDict tbody").innerHTML = S.dict.fails.map((x, i) => `<tr data-di="${i}" class="${x[2] ? "" : "new-row"}">${nameCell(x)}
        <td><select data-dsub>${opts(L("subs"), x[3])}</select></td>${uses(x[2])}<td>${del(x[2])}</td></tr>`).join("");
    } else if (tab === "reasons") {
      const combos = [];
      for (const [t, tn] of L("types")) for (const [d, dn] of L("damages")) combos.push([t, d, tn + " / " + dn]);
      $("#tblDict thead").innerHTML = "<tr><th style='width:24%'>Причина</th><th>Разрешена для (тип работ / инициатор)</th><th style='width:12%'>Используется</th><th style='width:150px'></th></tr>";
      $("#tblDict tbody").innerHTML = S.dict.reasons.map((x, i) => `<tr data-di="${i}" class="${x[2] ? "" : "new-row"}">${nameCell(x)}
        <td>${combos.map(([t, d, l]) => `<label class="combo"><input type="checkbox" data-combo="${t},${d}"${S.rules.some((r) => r[0] === t && r[1] === d && r[2] === x[0]) ? " checked" : ""} /> ${esc(l)}</label>`).join("")}</td>
        ${uses(x[2])}<td>${del(x[2])}</td></tr>`).join("");
    } else {
      $("#tblDict thead").innerHTML = `<tr><th style='width:45%'>${{ types: "Тип работ", subs: "Подсистема", damages: "Инициатор" }[tab]}</th><th>Используется</th><th style='width:150px'></th></tr>`;
      $("#tblDict tbody").innerHTML = S.dict[tab].map((x, i) => `<tr data-di="${i}" class="${x[2] ? "" : "new-row"}">${nameCell(x)}${uses(x[2])}<td>${del(x[2])}</td></tr>`).join("");
    }
  }

  const TBL = { tblType: "type", tblSub: "sub", tblReason: "reason", tblDmg: "dmg" };
  document.addEventListener("change", (e) => {
    const dtr = e.target.closest("tr[data-di]");
    if (dtr) {
      const x = S.dict[tab][dtr.dataset.di];
      if (e.target.dataset.dsub != null) x[3] = Number(e.target.value);
      if (e.target.dataset.combo) {
        const [t, d] = e.target.dataset.combo.split(",").map(Number);
        S.rules = S.rules.filter((r) => !(r[0] === t && r[1] === d && r[2] === x[0]));
        if (e.target.checked) S.rules.push([t, d, x[0]]);
      }
      dirty(); render(); return;
    }
    const tr = e.target.closest("tr[data-i]");
    if (tr && e.target.dataset.f != null) {
      const key = TBL[tr.closest("table").id], f = Number(e.target.dataset.f);
      if (e.target.tagName === "SELECT") C()[key][tr.dataset.i][f] = e.target.value === "" ? "" : Number(e.target.value);
      if (key === "sub" && f === 0) C().sub[tr.dataset.i][1] = "";
      dirty(); render(); return;
    }
    const id = e.target.id;
    if (id === "aiOn") S.ai.on = e.target.checked;
    if (id === "aiModel") S.ai.model = e.target.value;
    const eo = e.target.closest("[data-eo]");
    if (eo) { const p = C().eo[eo.dataset.eo], f = e.target.dataset.eof; p[f] = f === "on" ? e.target.checked : f === "type" ? Number(e.target.value) : e.target.value; }
    if (id === "site") { site = e.target.value; render(); return; }
    if (id === "ownRules") {
      if (e.target.checked) S.sites[site] = JSON.parse(JSON.stringify(S.sites["*"]));
      else if (confirm(`Удалить свои правила рудника «${site}»? Он будет использовать общие.`)) delete S.sites[site];
      dirty(); render(); return;
    }
    if (id === "testSite" || e.target.closest("#xferModal") || e.target.closest("#replModal")) return;
    if (e.target.closest(".pr-grid") && id !== "testTime" && id !== "testText") { dirty(); render(); }
  });
  document.addEventListener("input", (e) => {
    const dtr = e.target.closest("tr[data-di]");
    if (dtr && e.target.dataset.dn != null) { S.dict[tab][dtr.dataset.di][1] = e.target.value; dirty(); return; }
    const tr = e.target.closest("tr[data-i]");
    if (tr && e.target.tagName === "TEXTAREA") { C()[TBL[tr.closest("table").id]][tr.dataset.i][Number(e.target.dataset.f)] = e.target.value; dirty(); }
  });
  // Переименование в справочнике сразу видно в списках выбора выше.
  document.addEventListener("focusout", (e) => { if (e.target.dataset?.dn != null) render(); });
  document.addEventListener("click", (e) => {
    const t = e.target.closest("#dictTabs .tab");
    if (t) { tab = t.dataset.dict; renderDict(); return; }
    if (e.target.id === "dictAdd") {
      const id = nextId++;
      S.dict[tab].push(tab === "fails" ? [id, "", 0, S.dict.subs[0][0]] : [id, "", 0]);
      dirty(); renderDict();
      const inputs = document.querySelectorAll("#tblDict input[data-dn]"); inputs[inputs.length - 1]?.focus();
      return;
    }
    const dtr = e.target.closest("tr[data-di]");
    if (dtr && e.target.closest("[data-ddel]") && !e.target.disabled) {
      const x = S.dict[tab][dtr.dataset.di];
      if (!confirm(`Удалить «${x[1] || "без названия"}»?`)) return;
      S.dict[tab].splice(dtr.dataset.di, 1);
      if (tab === "reasons") S.rules = S.rules.filter((r) => r[2] !== x[0]);
      dirty(); render(); return;
    }
    const add = e.target.closest("[data-add]");
    if (add) {
      const k = add.dataset.add;
      C()[k].push(k === "type" ? [S.dict.types[0][0], ""] : k === "sub" ? [S.dict.subs[0][0], "", ""] : k === "reason" ? [S.dict.reasons[0][0], ""] : [S.dict.types[0][0], S.dict.reasons[0][0], ""]);
      dirty(); render(); return;
    }
    const tr = e.target.closest("tr[data-i]");
    if (!tr) return;
    const k = TBL[tr.closest("table").id], i = Number(tr.dataset.i);
    if (e.target.closest("[data-del]")) { C()[k].splice(i, 1); dirty(); render(); }
    const mv = e.target.closest("[data-mv]");
    if (mv) { const j = i + Number(mv.dataset.mv); if (j >= 0 && j < C()[k].length) { const a = C()[k]; [a[i], a[j]] = [a[j], a[i]]; dirty(); render(); } }
  });

  // Совпадение слова: короткие (до 3 букв) — целое слово, длинные — по началу слова (любое окончание), фразы — подстрокой.
  const normT = (s) => " " + String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim() + " ";
  function hit(text, w) {
    const k = normT(w).trim();
    if (!k) return false;
    if (k.includes(" ")) return text.includes(" " + k);
    if (k.length <= 3) return text.includes(" " + k + " ");
    return text.includes(" " + (k.length >= 6 ? k.slice(0, -2) : k));
  }
  const found = (text, list) => String(list || "").split(",").map((x) => x.trim()).filter(Boolean).filter((w) => hit(text, w));

  $("#testBtn").addEventListener("click", () => {
    const t = normT($("#testText").value), time = $("#testTime").value, R = eff($("#testSite").value);
    const out = [];
    let type = null, why = "";
    const p = R.eo.find((x) => x.on && time >= x.from && time < x.to);
    if (p) { type = p.type; why = `работа открыта в ${time}, период ЕО ${p.from}–${p.to} — слова не учитываются`; }
    if (!type) for (const [ty, w] of R.type) { const f = found(t, w); if (f.length) { type = ty; why = "слово «" + f[0] + "»"; break; } }
    if (!type) why = "вне периодов ЕО и слов типа нет — выберет ИИ по смыслу или пользователь";
    out.push(["Тип работ", type ? name("types", type) : "—", why]);
    const subs = R.sub.map(([s, f, w]) => [s, f, found(t, w)]).filter((x) => x[2].length);
    out.push(["Подсистема", subs.length ? [...new Set(subs.map((x) => name("subs", x[0]) + (x[1] ? " / " + name("fails", x[1]) : "")))].join("; ") : "—",
      subs.length ? subs.map((x) => "«" + x[2].join("», «") + "»").join("; ") + (subs.length > 1 ? " — несколько вариантов, выберет ИИ по шаблону машины" : "") : "слов из словаря нет — выберет ИИ"]);
    let reason = null, rwhy = "слов нет — выберет ИИ или пользователь";
    for (const [r, w] of R.reason) { const f = found(t, w); if (f.length) { reason = r; rwhy = "слово «" + f[0] + "»"; break; } }
    out.push(["Причина", reason ? name("reasons", reason) : "—", rwhy]);
    const dr = reason ? R.dmg.find((x) => x[0] === type && x[1] === reason) : null;
    let dmg = dr ? dr[2] : null, dwhy = dr ? "таблица «тип + причина»" : "";
    if (!dmg && reason) { const ds = [...new Set(S.rules.filter((x) => x[0] === type && x[2] === reason).map((x) => x[1]))]; if (ds.length === 1) { dmg = ds[0]; dwhy = "единственный по правилам"; } else dwhy = ds.length ? "по правилам возможны оба — выберет пользователь" : "сочетание не разрешено правилами"; }
    out.push(["Инициатор", dmg ? name("damages", dmg) : "—", dwhy || "нужна причина"]);
    $("#testRes").innerHTML = out.map(([k, v, w]) => `<div class="r"><b>${esc(k)}</b><span>${esc(v)} <span class="why">· ${esc(w)}</span></span></div>`).join("");
  });

  $("#saveBtn").addEventListener("click", () => { $("#dirty").hidden = true; alert("Макет: в рабочей версии правила и справочники сохранятся в базу, а форма ввода ремонтов и ИИ сразу начнут их использовать."); });
  $("#resetBtn").addEventListener("click", () => { S = JSON.parse(JSON.stringify(START)); $("#dirty").hidden = true; render(); });
  render();
  $("#testBtn").click();
})();
