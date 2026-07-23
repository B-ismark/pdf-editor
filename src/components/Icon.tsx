import {
  AlignHorizontalDistributeCenter,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignVerticalDistributeCenter,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Combine,
  Command,
  Contrast,
  Copy,
  CopyPlus,
  Download,
  Droplets,
  Eraser,
  FilePlus,
  FileText,
  Hash,
  Highlighter,
  Hourglass,
  Image as ImageIcon,
  Layers,
  Link,
  ListChecks,
  Minus,
  Monitor,
  Moon,
  MousePointer2,
  MoreVertical,
  PanelLeft,
  Pencil,
  PenLine,
  Plus,
  Redo2,
  RotateCw,
  ScanText,
  Search,
  Shrink,
  Signature,
  Square,
  StickyNote,
  Sun,
  Trash2,
  Type,
  Undo2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";

interface Props {
  name: string;
  size?: number;
  filled?: boolean;
  className?: string;
}

/** Maps the app's semantic icon names to Lucide icon components. */
const MAP: Record<string, LucideIcon> = {
  stylus_note: PenLine,
  arrow_selector_tool: MousePointer2,
  text_fields: Type,
  select: Square, // redact (rendered filled)
  draw: Pencil,
  signature: Signature,
  highlighter: Highlighter,
  rectangle: Square,
  line_tool: Minus,
  arrow_tool: ArrowUpRight,
  sticky_note: StickyNote,
  undo: Undo2,
  redo: Redo2,
  download: Download,
  upload_file: Upload,
  picture_as_pdf: FileText,
  note_add: FilePlus,
  image: ImageIcon,
  tag: Hash,
  watermark: Droplets,
  more_vert: MoreVertical,
  close: X,
  delete: Trash2,
  add: Plus,
  remove: Minus,
  chevron_left: ChevronLeft,
  chevron_right: ChevronRight,
  check: Check,
  contrast: Contrast,
  rotate: RotateCw,
  hourglass_top: Hourglass,
  light_mode: Sun,
  dark_mode: Moon,
  system_mode: Monitor,
  search: Search,
  content_copy: Copy,
  duplicate: CopyPlus,
  command: Command,
  link: Link,
  eraser: Eraser,
  compress: Shrink,
  combine: Combine,
  layers: Layers,
  scan_text: ScanText,
  form: ListChecks,
  panel: PanelLeft,
  chevron_up: ChevronUp,
  chevron_down: ChevronDown,
  align_left: AlignHorizontalJustifyStart,
  align_center_h: AlignHorizontalJustifyCenter,
  align_right: AlignHorizontalJustifyEnd,
  align_top: AlignVerticalJustifyStart,
  align_center_v: AlignVerticalJustifyCenter,
  align_bottom: AlignVerticalJustifyEnd,
  distribute_h: AlignHorizontalDistributeCenter,
  distribute_v: AlignVerticalDistributeCenter,
};

/** Icons that read best filled (e.g. the redaction "black box"). */
const FILLED = new Set(["select"]);

/** Render a Lucide icon by the app's semantic name. */
export function Icon({ name, size = 24, className }: Props) {
  const C = MAP[name] ?? Square;
  const fill = FILLED.has(name);
  return (
    <C
      size={size}
      className={className}
      strokeWidth={1.75}
      absoluteStrokeWidth
      aria-hidden="true"
      style={{ display: "block", flex: "none", fill: fill ? "currentColor" : "none" }}
    />
  );
}
