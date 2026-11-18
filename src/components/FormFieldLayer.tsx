import { Icon } from "./Icon";
import type { FormField, FormValue } from "../pdf/types";
import { fieldValue } from "../pdf/formValue";

export { fieldValue, hasValue, sameValue } from "../pdf/formValue";

interface Props {
  fields: FormField[];
  scale: number;
  pageHeight: number;
  values: Record<string, FormValue>;
  /** Whether fields accept input now (Select tool only, so other tools can
   * draw over the page). */
  active: boolean;
  /** `typing`: a keystroke in a text field, which joins the field's undo step. */
  onChange: (name: string, value: FormValue, typing?: boolean) => void;
}

/**
 * Fillable controls over a page's form fields.
 *
 * Each is opaque: the page beneath was drawn with the field's look *as the file
 * came*, and a box ticked in the file but unticked here must not still show its
 * tick. What shows is the value the export writes.
 *
 * The layer covers the page but takes no pointer itself — only the fields do —
 * so text, redactions and the empty page around the fields stay reachable.
 */
export function FormFieldLayer({ fields, scale, pageHeight, values, active, onChange }: Props) {
  if (fields.length === 0) return null;
  // Radio buttons by group, in page order: arrow keys move between them, and
  // a group is one Tab stop.
  const groups = new Map<string, FormField[]>();
  for (const f of fields) if (f.type === "radio") groups.set(f.name, [...(groups.get(f.name) ?? []), f]);

  return (
    <div className="formlayer">
      {fields.map((f) => {
        const left = f.rect.x * scale;
        const top = (pageHeight - (f.rect.y + f.rect.height)) * scale;
        const width = f.rect.width * scale;
        const height = f.rect.height * scale;
        const style = {
          left: `${left}px`,
          top: `${top}px`,
          width: `${width}px`,
          height: `${height}px`,
          pointerEvents: active ? ("auto" as const) : ("none" as const),
        };
        const font = `${Math.max(8, Math.min(16, height * 0.6))}px`;
        const value = fieldValue(f, values);
        const stop = (e: React.PointerEvent) => e.stopPropagation();
        const label = f.label ?? f.name;
        const tag = { "data-field": f.name, "aria-label": label };

        if (f.type === "checkbox") {
          const on = value === true;
          return (
            <button
              key={f.id}
              {...tag}
              type="button"
              role="checkbox"
              className={`formfield formfield--check${on ? " formfield--on" : ""}`}
              style={style}
              disabled={f.readOnly}
              aria-checked={on}
              onPointerDown={stop}
              onClick={() => !f.readOnly && onChange(f.name, !on)}
            >
              {on && <Icon name="check" size={Math.min(18, height * 0.8)} />}
            </button>
          );
        }

        if (f.type === "radio") {
          const group = groups.get(f.name)!;
          const i = group.indexOf(f);
          const on = value !== "" && value === f.onValue;
          const anyOn = group.some((g) => value !== "" && value === g.onValue);
          // pdf-lib (and others) name the buttons "0", "1", …: say which one
          // it is rather than read out a number that means nothing.
          const which = /^\d+$/.test(f.onValue ?? "") ? `option ${i + 1} of ${group.length}` : f.onValue;
          const choose = (g: FormField, el?: HTMLElement | null) => {
            if (!g.readOnly) onChange(g.name, g.onValue!);
            el?.focus();
          };
          return (
            <button
              key={f.id}
              {...tag}
              aria-label={`${label}: ${which}`}
              data-on={f.onValue}
              type="button"
              role="radio"
              className={`formfield formfield--check formfield--radio${on ? " formfield--on" : ""}`}
              style={style}
              disabled={f.readOnly}
              aria-checked={on}
              // One Tab stop per group: the chosen button, else the first.
              tabIndex={on || (!anyOn && i === 0) ? 0 : -1}
              onPointerDown={stop}
              // Chosen again, a radio button stays chosen, as in every viewer.
              onClick={() => choose(f)}
              onKeyDown={(e) => {
                const step =
                  e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                if (!step || group.length < 2) return;
                e.preventDefault();
                const next = group[(i + step + group.length) % group.length];
                const el = e.currentTarget.parentElement?.querySelector<HTMLElement>(
                  `[data-field="${CSS.escape(next.name)}"][data-on="${CSS.escape(next.onValue ?? "")}"]`,
                );
                choose(next, el);
              }}
            >
              {on && (
                <span
                  className="formfield__dot"
                  style={{ width: Math.min(width, height) * 0.45, height: Math.min(width, height) * 0.45 }}
                />
              )}
            </button>
          );
        }

        if (f.type === "choice") {
          const options = f.options ?? [];
          const multi = !!f.multiSelect;
          const chosen = Array.isArray(value) ? value : typeof value === "string" && value !== "" ? [value] : [];
          // A value the file holds that isn't one of the options (a dropdown
          // you can type into): shown as it is, not as blank.
          const extra = chosen.filter((c) => !options.some((o) => o.value === c));
          const all = [...options, ...extra.map((v) => ({ value: v, label: v }))];
          const items = all.map((o, j) => (
            <option key={j} value={o.value}>
              {o.label}
            </option>
          ));
          if (f.combo) {
            return (
              <select
                key={f.id}
                {...tag}
                className="formfield formfield--choice"
                style={{ ...style, fontSize: font }}
                disabled={f.readOnly}
                value={chosen[0] ?? ""}
                onPointerDown={stop}
                onChange={(e) => onChange(f.name, e.target.value)}
              >
                {/* Nothing chosen shows blank, as the file does. */}
                {!all.some((o) => o.value === "") && <option value="" />}
                {items}
              </select>
            );
          }
          // A list. A single-choice one is still a `multiple` select: a plain
          // one always shows *something* chosen (the first option, when the
          // file has none), and that option then can't be picked.
          return (
            <select
              key={f.id}
              {...tag}
              className="formfield formfield--choice formfield--list"
              style={{ ...style, fontSize: font }}
              disabled={f.readOnly}
              multiple
              aria-multiselectable={multi}
              size={Math.max(2, Math.min(all.length, Math.floor(height / (parseFloat(font) * 1.3))))}
              value={chosen}
              onPointerDown={stop}
              onChange={(e) => {
                const picked = [...e.target.selectedOptions].map((o) => o.value);
                if (multi) return onChange(f.name, picked);
                // One at most: the option just picked.
                const fresh = picked.find((v) => !chosen.includes(v)) ?? picked[0] ?? "";
                onChange(f.name, fresh);
              }}
            >
              {items}
            </select>
          );
        }

        const text = typeof value === "string" ? value : "";
        const common = {
          ...tag,
          className: `formfield formfield--text${f.multiline ? " formfield--multi" : ""}`,
          style: { ...style, fontSize: font },
          value: text,
          readOnly: f.readOnly,
          maxLength: f.maxLength,
          onPointerDown: stop,
        };
        return f.multiline ? (
          <textarea key={f.id} {...common} onChange={(e) => onChange(f.name, e.target.value, true)} />
        ) : (
          <input key={f.id} {...common} onChange={(e) => onChange(f.name, e.target.value, true)} />
        );
      })}
    </div>
  );
}
