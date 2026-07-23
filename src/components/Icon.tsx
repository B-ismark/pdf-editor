import type { ReactNode } from "react";

interface Props {
  name: string;
  size?: number;
  filled?: boolean;
  className?: string;
}

/* Inline SVG icons (feather/Material-ish). Self-contained so the UI never
 * depends on an external icon font loading. */
const PATHS: Record<string, ReactNode> = {
  stylus_note: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </>
  ),
  arrow_selector_tool: (
    <>
      <path d="M3 3l7.07 17 2.51-7.39L20 10.09z" />
      <path d="M13 13l6 6" />
    </>
  ),
  text_fields: (
    <>
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </>
  ),
  select: <rect x="4" y="7" width="16" height="10" rx="1.5" fill="currentColor" stroke="none" />,
  undo: (
    <>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </>
  ),
  redo: (
    <>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  ),
  upload_file: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </>
  ),
  picture_as_pdf: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="14" y2="17" />
    </>
  ),
  note_add: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </>
  ),
  more_vert: (
    <>
      <circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  close: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  delete: (
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
  remove: <line x1="5" y1="12" x2="19" y2="12" />,
  add: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  tag: (
    <>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <circle cx="7" cy="7" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  watermark: <path d="M12 3c3.2 4.2 6 7.2 6 11a6 6 0 0 1-12 0c0-3.8 2.8-6.8 6-11z" fill="none" />,
  signature: (
    <>
      <path d="M3 17c2.5 0 3-9 5.5-9S11 17 13 17s2-5 4-5 1.5 2 4 2" />
      <path d="M2 21h20" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" fill="none" />
      <circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" stroke="none" />
      <polyline points="21 16 15 10 4 20" />
    </>
  ),
  draw: (
    <>
      <path d="M15 3l6 6L9 21H3v-6z" />
      <path d="M13 5l6 6" />
    </>
  ),
  highlighter: (
    <>
      <path d="M4 21h16" />
      <path d="M7 17l7-7 4 4-7 7H7z" />
      <path d="M12 8l3-3 4 4-3 3" />
    </>
  ),
  rectangle: <rect x="4" y="6" width="16" height="12" rx="1" fill="none" />,
  line_tool: <line x1="5" y1="19" x2="19" y2="5" />,
  arrow_tool: (
    <>
      <line x1="5" y1="19" x2="19" y2="5" />
      <polyline points="10 5 19 5 19 14" />
    </>
  ),
  sticky_note: (
    <>
      <path d="M4 4h16v10l-6 6H4z" />
      <polyline points="20 14 14 14 14 20" />
    </>
  ),
  chevron_left: <polyline points="15 18 9 12 15 6" />,
  chevron_right: <polyline points="9 18 15 12 9 6" />,
  rotate: (
    <>
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </>
  ),
  hourglass_top: (
    <>
      <line x1="6" y1="3" x2="18" y2="3" />
      <line x1="6" y1="21" x2="18" y2="21" />
      <path d="M6 3c0 5 6 6 6 9 0 3-6 4-6 9" />
      <path d="M18 3c0 5-6 6-6 9 0 3 6 4 6 9" />
    </>
  ),
};

/** Render an inline SVG icon by name. `filled` is accepted for API
 * compatibility; most icons are stroke-based. */
export function Icon({ name, size = 24, className }: Props) {
  const path = PATHS[name] ?? PATHS.select;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", flex: "none" }}
    >
      {path}
    </svg>
  );
}
