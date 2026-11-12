const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const formatDateTime = (iso: string | null): string => {
  if (!iso) return "Never";
  const d = new Date(iso);
  const hours = d.getHours() % 12 || 12;
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = d.getHours() < 12 ? "AM" : "PM";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${hours}:${minutes}${ampm}`;
};

export const fullName = (u: { first_name: string; last_name: string }): string =>
  `${u.first_name} ${u.last_name}`.trim();

// A call's time: "850 ms" under a second, else seconds to one place, e.g. "3.1 s".
export const formatDuration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
