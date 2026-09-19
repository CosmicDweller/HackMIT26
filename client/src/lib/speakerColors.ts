/** Stable per-speaker color, cycling through a small fixed palette by speaker index. */
const PALETTE = [
  { text: "text-blue-700 dark:text-blue-400", bg: "bg-blue-100 dark:bg-blue-950", dot: "bg-blue-500" },
  { text: "text-violet-700 dark:text-violet-400", bg: "bg-violet-100 dark:bg-violet-950", dot: "bg-violet-500" },
  { text: "text-teal-700 dark:text-teal-400", bg: "bg-teal-100 dark:bg-teal-950", dot: "bg-teal-500" },
  { text: "text-orange-700 dark:text-orange-400", bg: "bg-orange-100 dark:bg-orange-950", dot: "bg-orange-500" },
];

export function speakerColor(index: number) {
  return PALETTE[index % PALETTE.length];
}
