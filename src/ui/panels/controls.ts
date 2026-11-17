// Small DOM builders for editor tool panels so controls update in place without rebuilding HTML.

export function heading(text: string): HTMLHeadingElement {
  const h = document.createElement('h2');
  h.textContent = text;
  return h;
}

export function para(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}

export interface ButtonSpec {
  label: string;
  id?: string;
  pressed?: boolean;
  dataset?: Record<string, string>;
  onClick: () => void;
}

export function buttonRow(specs: ButtonSpec[]) {
  const row = document.createElement('div');
  row.className = 'row';
  const buttons: HTMLButtonElement[] = [];
  for (const s of specs) {
    const b = document.createElement('button');
    if (s.id) b.id = s.id;
    b.textContent = s.label;
    if (s.pressed !== undefined) b.setAttribute('aria-pressed', String(s.pressed));
    if (s.dataset) for (const [k, v] of Object.entries(s.dataset)) b.dataset[k] = v;
    b.onclick = s.onClick;
    row.appendChild(b);
    buttons.push(b);
  }
  return { root: row, buttons };
}

export interface RangeSpec {
  id?: string;
  outputId?: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
  onChange?: (v: number) => void;
}

export function labeledRange(spec: RangeSpec) {
  const wrap = document.createElement('label');
  const format = spec.format ?? String;
  let out: HTMLOutputElement | null = null;
  if (spec.outputId !== undefined || spec.unit !== undefined) {
    const span = document.createElement('span');
    span.append(`${spec.label}: `);
    out = document.createElement('output');
    if (spec.outputId) out.id = spec.outputId;
    out.textContent = format(spec.value);
    span.append(out);
    if (spec.unit) span.append(spec.unit);
    wrap.appendChild(span);
  } else {
    wrap.append(spec.label);
  }
  const input = document.createElement('input');
  if (spec.id) input.id = spec.id;
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  if (spec.step !== undefined) input.step = String(spec.step);
  input.value = String(spec.value);
  input.oninput = () => {
    const v = Number(input.value);
    if (out) out.textContent = format(v);
    spec.onInput(v);
  };
  if (spec.onChange) input.onchange = () => spec.onChange!(Number(input.value));
  wrap.appendChild(input);
  return {
    root: wrap,
    input,
    output: out,
    setValue(v: number) {
      input.value = String(v);
      if (out) out.textContent = format(v);
    },
  };
}

export interface SelectSpec {
  id?: string;
  label: string;
  options: { value: string; label: string }[];
  value: string;
  dataset?: Record<string, string>;
  onChange: (value: string) => void;
}

export function labeledSelect(spec: SelectSpec) {
  const wrap = document.createElement('label');
  wrap.append(spec.label);
  const select = document.createElement('select');
  if (spec.id) select.id = spec.id;
  if (spec.dataset) for (const [k, v] of Object.entries(spec.dataset)) select.dataset[k] = v;
  for (const o of spec.options) select.add(new Option(o.label, o.value));
  select.value = spec.value;
  select.onchange = () => spec.onChange(select.value);
  wrap.appendChild(select);
  return {
    root: wrap,
    select,
    setValue(v: string) {
      select.value = v;
    },
  };
}

export interface CheckboxSpec {
  id?: string;
  label: string;
  checked: boolean;
  dataset?: Record<string, string>;
  onChange: (checked: boolean) => void;
}

export function labeledCheckbox(spec: CheckboxSpec) {
  const wrap = document.createElement('label');
  wrap.className = 'check';
  const input = document.createElement('input');
  if (spec.id) input.id = spec.id;
  input.type = 'checkbox';
  if (spec.dataset) for (const [k, v] of Object.entries(spec.dataset)) input.dataset[k] = v;
  input.checked = spec.checked;
  input.onchange = () => spec.onChange(input.checked);
  const text = document.createTextNode(` ${spec.label}`);
  wrap.append(input, text);
  return {
    root: wrap,
    input,
    setChecked(v: boolean) {
      input.checked = v;
    },
    setLabel(s: string) {
      text.nodeValue = ` ${s}`;
    },
  };
}

export interface TextSpec {
  id?: string;
  label: string;
  maxLength: number;
  value: string;
  onFocus?: () => void;
  onInput: (value: string) => void;
}

export function labeledText(spec: TextSpec) {
  const wrap = document.createElement('label');
  wrap.append(spec.label);
  const input = document.createElement('input');
  if (spec.id) input.id = spec.id;
  input.type = 'text';
  input.maxLength = spec.maxLength;
  input.value = spec.value;
  if (spec.onFocus) input.onfocus = spec.onFocus;
  input.oninput = () => spec.onInput(input.value);
  wrap.appendChild(input);
  return {
    root: wrap,
    input,
    setValue(v: string) {
      if (document.activeElement !== input) input.value = v;
    },
  };
}
