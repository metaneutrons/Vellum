"use client";

import type { Theme } from "@/lib/theme";

/** Mini preview of a theme — renders a simplified display layout */
export function ThemePreview({ theme }: { theme: Theme }) {
  const T = theme;
  return (
    <div className="border rounded-lg overflow-hidden" style={{ width: 280, height: 168 }}>
      <svg viewBox="0 0 800 480" width="280" height="168" xmlns="http://www.w3.org/2000/svg">
        {/* Background */}
        <rect width="800" height="480" fill={T.background} />
        {/* Header */}
        <rect width="800" height="70" fill={T.headerBg} />
        <text x="20" y="46" fill={T.headerText} fontSize="32" fontWeight="bold" fontFamily="sans-serif">Meeting Room</text>
        {/* FREE badge */}
        <rect x="640" y="15" width="120" height="40" rx="4" fill={T.freeBadge} />
        <text x="670" y="43" fill={T.badgeText} fontSize="24" fontWeight="bold" fontFamily="sans-serif">FREE</text>
        {/* Event block */}
        <rect x="80" y="120" width="640" height="80" rx="4" fill={T.slotBg} />
        <text x="100" y="155" fill={T.slotText} fontSize="22" fontWeight="bold" fontFamily="sans-serif">Sprint Planning</text>
        <text x="100" y="182" fill={T.slotText} fontSize="16" fontFamily="sans-serif" opacity="0.8">10:00 – 11:00</text>
        {/* Second event */}
        <rect x="80" y="220" width="640" height="80" rx="4" fill={T.busyBadge} />
        <text x="100" y="255" fill={T.badgeText} fontSize="22" fontWeight="bold" fontFamily="sans-serif">🔒 Private Meeting</text>
        <text x="100" y="282" fill={T.badgeText} fontSize="16" fontFamily="sans-serif" opacity="0.8">11:30 – 12:00</text>
        {/* Grid lines */}
        <line x1="80" y1="340" x2="720" y2="340" stroke={T.slotSecondary} strokeWidth="1" opacity="0.3" />
        <text x="20" y="345" fill={T.slotSecondary} fontSize="16" fontFamily="sans-serif">12:00</text>
        <line x1="80" y1="400" x2="720" y2="400" stroke={T.slotSecondary} strokeWidth="1" opacity="0.3" />
        <text x="20" y="405" fill={T.slotSecondary} fontSize="16" fontFamily="sans-serif">13:00</text>
        {/* Footer */}
        <text x="20" y="465" fill={T.footerText} fontSize="16" fontFamily="sans-serif">Updated: 10:30</text>
      </svg>
    </div>
  );
}
