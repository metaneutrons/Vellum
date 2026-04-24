"use client";

interface ScheduleRule {
  name: string;
  days: number[];
  startHour: number;
  endHour: number;
  intervalS: number;
}

const COLORS = [
  "#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#ef4444", "#6366f1", "#14b8a6",
];

function fmtInterval(s: number): string {
  if (s >= 3600) return `${(s / 3600).toFixed(s % 3600 ? 1 : 0)}h`;
  if (s >= 60) return `${Math.round(s / 60)}m`;
  return `${s}s`;
}

function isOvernight(r: ScheduleRule): boolean {
  return r.startHour > r.endHour;
}

function rulesOverlap(a: ScheduleRule, b: ScheduleRule): boolean {
  // Check day overlap
  const aDays = a.days.length === 0 ? [0,1,2,3,4,5,6] : a.days;
  const bDays = b.days.length === 0 ? [0,1,2,3,4,5,6] : b.days;
  const sharedDays = aDays.some(d => bDays.includes(d));
  if (!sharedDays) return false;

  // Check hour overlap
  const aHours = new Set<number>();
  const bHours = new Set<number>();
  for (let h = 0; h < 24; h++) {
    if (isOvernight(a) ? (h >= a.startHour || h < a.endHour) : (h >= a.startHour && h < a.endHour)) aHours.add(h);
    if (isOvernight(b) ? (h >= b.startHour || h < b.endHour) : (h >= b.startHour && h < b.endHour)) bHours.add(h);
  }
  for (const h of aHours) if (bHours.has(h)) return true;
  return false;
}

function matchesNow(rule: ScheduleRule): boolean {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();
  if (rule.days.length > 0 && !rule.days.includes(day)) return false;
  if (isOvernight(rule)) return hour >= rule.startHour || hour < rule.endHour;
  return hour >= rule.startHour && hour < rule.endHour;
}

export function ScheduleTimeline({ rules, defaultIntervalS }: { rules: ScheduleRule[]; defaultIntervalS: number }) {
  if (rules.length === 0) return null;

  const nowHour = new Date().getHours();

  // Detect overlaps
  const overlaps: [number, number][] = [];
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      if (rulesOverlap(rules[i], rules[j])) overlaps.push([i, j]);
    }
  }

  return (
    <div className="mt-4 mb-2">
      <div className="flex justify-between items-center mb-2">
        <span className="text-xs font-medium">24h Timeline (today)</span>
        <span className="text-xs text-gray-500">Default: {fmtInterval(defaultIntervalS)}</span>
      </div>

      {/* Timeline bar */}
      <div className="relative h-8 rounded overflow-hidden border" style={{ background: "#1a1a2e" }}>
        {/* Hour markers */}
        {[0, 6, 12, 18].map(h => (
          <div key={h} className="absolute top-0 bottom-0 border-l border-gray-700" style={{ left: `${(h / 24) * 100}%` }}>
            <span className="absolute -top-4 text-[9px] text-gray-500" style={{ transform: "translateX(-50%)" }}>{h}:00</span>
          </div>
        ))}

        {/* Rule blocks */}
        {rules.map((rule, i) => {
          const color = COLORS[i % COLORS.length];
          if (isOvernight(rule)) {
            // Two blocks: startHour→24 and 0→endHour
            return (
              <span key={i}>
                <div className="absolute top-1 bottom-1 rounded-sm opacity-80" title={`${rule.name}: ${fmtInterval(rule.intervalS)}`}
                  style={{ left: `${(rule.startHour / 24) * 100}%`, right: "0%", background: color }} />
                <div className="absolute top-1 bottom-1 rounded-sm opacity-80" title={`${rule.name}: ${fmtInterval(rule.intervalS)}`}
                  style={{ left: "0%", width: `${(rule.endHour / 24) * 100}%`, background: color }} />
              </span>
            );
          }
          return (
            <div key={i} className="absolute top-1 bottom-1 rounded-sm opacity-80" title={`${rule.name}: ${fmtInterval(rule.intervalS)}`}
              style={{ left: `${(rule.startHour / 24) * 100}%`, width: `${((rule.endHour - rule.startHour) / 24) * 100}%`, background: color }} />
          );
        })}

        {/* Now indicator */}
        <div className="absolute top-0 bottom-0 w-0.5 bg-orange-400 z-10" style={{ left: `${(nowHour / 24) * 100}%` }} />
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
        {rules.map((rule, i) => {
          const active = matchesNow(rule);
          const hasOverlap = overlaps.some(([a, b]) => a === i || b === i);
          return (
            <div key={i} className="flex items-center gap-1">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} />
              <span className={`text-[10px] ${active ? "font-bold text-white" : "text-gray-500"}`}>
                {rule.name || `Rule ${i + 1}`} ({fmtInterval(rule.intervalS)})
                {active && <span className="ml-1 text-orange-400">● active</span>}
                {isOvernight(rule) && <span className="ml-1">🌙</span>}
              </span>
              {hasOverlap && <span className="text-[10px] text-yellow-500" title="This rule overlaps with another rule. First match wins.">⚠</span>}
            </div>
          );
        })}
      </div>

      {/* Overlap warnings */}
      {overlaps.length > 0 && (
        <div className="mt-2 text-[10px] text-yellow-500">
          ⚠ Rules overlap: {overlaps.map(([a, b]) => `#${a + 1}↔#${b + 1}`).join(", ")} — first match wins
        </div>
      )}
    </div>
  );
}
