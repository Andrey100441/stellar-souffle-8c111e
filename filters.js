const $ = (sel) => document.querySelector(sel);

export function populateSelect(sel, values) {
  const el = $(sel);
  const existing = new Set(Array.from(el.options).map((o) => o.value));
  for (const v of values) {
    if (v == null || v === "" || existing.has(String(v))) continue;
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    el.appendChild(opt);
    existing.add(String(v));
  }
}

// Shared equipment reference cascade: Объект -> Шахта -> Модель -> Борт/код.
// Expects #filterObject #filterMine #filterModel #filterCode on the page.
export async function loadEquipmentList(supabase) {
  const { data, error } = await supabase.from("v_equipment_list").select("*");
  if (error) throw error;
  return data;
}

export function updateMineOptions(equipmentList) {
  const objectSel = $("#filterObject");
  const mineSel = $("#filterMine");
  const selectedObject = objectSel.value;
  const previousMine = mineSel.value;

  const source = selectedObject
    ? equipmentList.filter((d) => d.object === selectedObject)
    : equipmentList;
  const mines = [...new Set(source.map((d) => d.mine).filter(Boolean))].sort();

  mineSel.innerHTML = '<option value="">Все</option>';
  for (const m of mines) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    mineSel.appendChild(opt);
  }
  mineSel.value = mines.includes(previousMine) ? previousMine : "";
}

export function updateModelAndCodeOptions(equipmentList) {
  const selectedObject = $("#filterObject").value;
  const selectedMine = $("#filterMine").value;
  const modelSel = $("#filterModel");
  const codeSel = $("#filterCode");
  const previousModel = modelSel.value;
  const previousCode = codeSel.value;

  let source = equipmentList;
  if (selectedObject) source = source.filter((d) => d.object === selectedObject);
  if (selectedMine) source = source.filter((d) => d.mine === selectedMine);

  const models = [...new Set(source.map((d) => d.model).filter(Boolean))].sort();

  modelSel.innerHTML = '<option value="">Все</option>';
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    modelSel.appendChild(opt);
  }
  modelSel.value = models.includes(previousModel) ? previousModel : "";

  const selectedModel = modelSel.value;
  const codeSource = selectedModel ? source.filter((d) => d.model === selectedModel) : source;
  const codes = [...new Set(codeSource.map((d) => d.local_code).filter(Boolean))].sort();

  codeSel.innerHTML = '<option value="">Все</option>';
  for (const c of codes) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    codeSel.appendChild(opt);
  }
  codeSel.value = codes.includes(previousCode) ? previousCode : "";
}
