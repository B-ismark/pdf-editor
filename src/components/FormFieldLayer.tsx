import { Icon } from "./Icon";
import type { FormField } from "../pdf/types";

interface Props {
  fields: FormField[];
  scale: number;
  pageHeight: number;
  values: Record<string, string | boolean>;
  /** Whether fields accept input now (Select tool only, so other tools can
   * draw over the page). */
  active: boolean;
  onChange: (name: string, value: string | boolean) => void;
}

/** Renders fillable overlays for a page's AcroForm fields. */
export function FormFieldLayer({ fields, scale, pageHeight, values, active, onChange }: Props) {
  if (fields.length === 0) return null;
  return (
    <div className="formlayer" style={{ pointerEvents: active ? "auto" : "none" }}>
      {fields.map((f) => {
        const left = f.rect.x * scale;
        const top = (pageHeight - (f.rect.y + f.rect.height)) * scale;
        const width = f.rect.width * scale;
        const height = f.rect.height * scale;
        const common = { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` };

        if (f.type === "checkbox") {
          const on = (values[f.name] ?? f.defaultValue) === true;
          return (
            <button
              key={f.id}
              type="button"
              className={`formfield formfield--check${on ? " formfield--on" : ""}`}
              style={common}
              disabled={f.readOnly}
              aria-pressed={on}
              aria-label={f.name}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => !f.readOnly && onChange(f.name, !on)}
            >
              {on && <Icon name="check" size={Math.min(18, height * 0.8)} />}
            </button>
          );
        }

        const val = String(values[f.name] ?? f.defaultValue ?? "");
        return (
          <input
            key={f.id}
            className="formfield formfield--text"
            style={{ ...common, fontSize: `${Math.min(16, height * 0.6)}px` }}
            value={val}
            readOnly={f.readOnly}
            aria-label={f.name}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => onChange(f.name, e.target.value)}
          />
        );
      })}
    </div>
  );
}
