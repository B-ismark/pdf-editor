import { Icon } from "./Icon";
import type { FormField, FormValue } from "../pdf/types";

interface Props {
  fields: FormField[];
  scale: number;
  pageHeight: number;
  values: Record<string, FormValue>;
  /** Whether fields accept input now (Select tool only, so other tools can
   * draw over the page). */
  active: boolean;
  onChange: (name: string, value: FormValue) => void;
}

/** A field's value now: what was typed, else what the file came with. */
export function fieldValue(f: FormField, values: Record<string, FormValue>): FormValue {
  return f.name in values ? values[f.name] : f.defaultValue;
}

/** Whether a value fills its field: text typed, a box ticked, an option chosen. */
export function hasValue(v: FormValue): boolean {
  return Array.isArray(v) ? v.length > 0 : v === true || (typeof v === "string" && v !== "" && v !== "Off");
}

/**
 * Fillable controls over a page's form fields.
 *
 * Each is opaque: the page beneath was drawn with the field's look *as the file
 * came*, and a box ticked in the file but unticked here must not still show its
 * tick. What shows is the value the export writes.
 */
export function FormFieldLayer({ fields, scale, pageHeight, values, active, onChange }: Props) {
  if (fields.length === 0) return null;
  return (
    <div className="formlayer" style={{ pointerEvents: active ? "auto" : "none" }}>
      {fields.map((f) => {
        const left = f.rect.x * scale;
        const top = (pageHeight - (f.rect.y + f.rect.height)) * scale;
        const width = f.rect.width * scale;
        const height = f.rect.height * scale;
        const style = { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` };
        const font = `${Math.max(8, Math.min(16, height * 0.6))}px`;
        const value = fieldValue(f, values);
        const stop = (e: React.PointerEvent) => e.stopPropagation();

        if (f.type === "checkbox" || f.type === "radio") {
          const on = f.type === "checkbox" ? value === true : value === f.onValue && value !== "";
          const radio = f.type === "radio";
          return (
            <button
              key={f.id}
              type="button"
              role={radio ? "radio" : "checkbox"}
              className={`formfield formfield--check${radio ? " formfield--radio" : ""}${on ? " formfield--on" : ""}`}
              style={style}
              disabled={f.readOnly}
              aria-checked={on}
              aria-label={f.name}
              onPointerDown={stop}
              // A radio button chosen again stays chosen, as in every viewer;
              // a checkbox flips.
              onClick={() => !f.readOnly && onChange(f.name, radio ? f.onValue! : !on)}
            >
              {on &&
                (radio ? (
                  <span className="formfield__dot" style={{ width: Math.min(width, height) * 0.45, height: Math.min(width, height) * 0.45 }} />
                ) : (
                  <Icon name="check" size={Math.min(18, height * 0.8)} />
                ))}
            </button>
          );
        }

        if (f.type === "choice") {
          const options = f.options ?? [];
          const multi = !!f.multiSelect;
          const chosen = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
          return (
            <select
              key={f.id}
              className={`formfield formfield--choice${f.combo ? "" : " formfield--list"}`}
              style={{ ...style, fontSize: font }}
              disabled={f.readOnly}
              aria-label={f.name}
              multiple={multi}
              size={f.combo ? undefined : Math.max(2, Math.min(options.length, Math.floor(height / (parseFloat(font) * 1.3))))}
              value={multi ? chosen : (chosen[0] ?? "")}
              onPointerDown={stop}
              onChange={(e) =>
                onChange(f.name, multi ? [...e.target.selectedOptions].map((o) => o.value) : e.target.value)
              }
            >
              {/* A dropdown with nothing chosen shows blank, as the file does. */}
              {f.combo && !options.some((o) => o.value === "") && <option value="" />}
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          );
        }

        const text = typeof value === "string" ? value : "";
        const common = {
          className: `formfield formfield--text${f.multiline ? " formfield--multi" : ""}`,
          style: { ...style, fontSize: font },
          value: text,
          readOnly: f.readOnly,
          maxLength: f.maxLength,
          "aria-label": f.name,
          onPointerDown: stop,
        };
        return f.multiline ? (
          <textarea key={f.id} {...common} onChange={(e) => onChange(f.name, e.target.value)} />
        ) : (
          <input key={f.id} {...common} onChange={(e) => onChange(f.name, e.target.value)} />
        );
      })}
    </div>
  );
}
