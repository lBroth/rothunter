/**
 * Inline SVG variants of the RotHunter mark — keeps the brand under the
 * theme's control (no img cache, no extra HTTP request, gradients render
 * crisp at any size). Source of truth still lives at
 * public/brand/logo.svg; this file mirrors it for React composition.
 */

interface LogoProps {
  size?: number;
  className?: string;
}

export function LogoMark({ size = 32, className }: LogoProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 256 256"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <defs>
        <linearGradient id="rh-mint" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a7f3d0" />
          <stop offset="1" stopColor="#5eead4" />
        </linearGradient>
        <linearGradient id="rh-sage" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#86efac" />
          <stop offset="1" stopColor="#34d399" />
        </linearGradient>
        <linearGradient id="rh-amber" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fde68a" />
          <stop offset="1" stopColor="#fbbf24" />
        </linearGradient>
        <linearGradient id="rh-coral" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fda4af" />
          <stop offset="1" stopColor="#fb7185" />
        </linearGradient>
        <linearGradient id="rh-rose" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fecdd3" />
          <stop offset="1" stopColor="#f43f5e" />
        </linearGradient>
        <filter id="rh-dp" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="8" />
          <feOffset dy="10" />
          <feComponentTransfer><feFuncA type="linear" slope="0.35" /></feComponentTransfer>
          <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="rh-rotGlow" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="7" />
          <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <g filter="url(#rh-dp)">
        {/* Row 0 */}
        <rect x="68"  y="44"  width="22" height="22" rx="4" fill="url(#rh-mint)" />
        <rect x="92"  y="44"  width="22" height="22" rx="4" fill="url(#rh-mint)" />
        <rect x="116" y="44"  width="22" height="22" rx="4" fill="url(#rh-sage)" />
        <rect x="140" y="44"  width="22" height="22" rx="4" fill="url(#rh-sage)" />
        {/* Row 1 */}
        <rect x="68"  y="68"  width="22" height="22" rx="4" fill="url(#rh-mint)" />
        <rect x="164" y="68"  width="22" height="22" rx="4" fill="url(#rh-amber)" />
        {/* Row 2 */}
        <rect x="68"  y="92"  width="22" height="22" rx="4" fill="url(#rh-sage)" />
        <rect x="164" y="92"  width="22" height="22" rx="4" fill="url(#rh-amber)" />
        {/* Row 3 — mid bar */}
        <rect x="68"  y="116" width="22" height="22" rx="4" fill="url(#rh-sage)" />
        <rect x="92"  y="116" width="22" height="22" rx="4" fill="url(#rh-amber)" />
        <rect x="116" y="116" width="22" height="22" rx="4" fill="url(#rh-amber)" />
        <rect x="140" y="116" width="22" height="22" rx="4" fill="url(#rh-coral)" />
        {/* Row 4 */}
        <rect x="68"  y="140" width="22" height="22" rx="4" fill="url(#rh-amber)" />
        <rect x="116" y="140" width="22" height="22" rx="4" fill="url(#rh-coral)" />
        {/* Row 5 */}
        <rect x="68"  y="164" width="22" height="22" rx="4" fill="url(#rh-coral)" />
        <rect x="140" y="164" width="22" height="22" rx="4" fill="url(#rh-coral)" />
        {/* Row 6 — stem base + ROT tile */}
        <rect x="68"  y="188" width="22" height="22" rx="4" fill="url(#rh-coral)" />
        <g filter="url(#rh-rotGlow)">
          <rect x="164" y="188" width="22" height="22" rx="4" fill="url(#rh-rose)" />
        </g>
      </g>
      {/* Hunter crosshair on the rot tile. */}
      <g stroke="#fb7185" strokeWidth="2" strokeLinecap="round" fill="none" opacity="0.95">
        <line x1="175" y1="160" x2="175" y2="180" />
        <line x1="175" y1="218" x2="175" y2="240" />
        <line x1="194" y1="199" x2="222" y2="199" />
        <line x1="156" y1="199" x2="148" y2="199" />
        <circle cx="175" cy="199" r="20" strokeDasharray="3 4" />
      </g>
    </svg>
  );
}

/**
 * Compact mark (no crosshair, no glow) for sidebar / sub-32 px contexts.
 */
export function LogoMarkCompact({ size = 24, className }: LogoProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <defs>
        <linearGradient id="rh-c-mint" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a7f3d0" />
          <stop offset="1" stopColor="#5eead4" />
        </linearGradient>
        <linearGradient id="rh-c-sage" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#86efac" />
          <stop offset="1" stopColor="#34d399" />
        </linearGradient>
        <linearGradient id="rh-c-amber" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fde68a" />
          <stop offset="1" stopColor="#fbbf24" />
        </linearGradient>
        <linearGradient id="rh-c-coral" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fda4af" />
          <stop offset="1" stopColor="#fb7185" />
        </linearGradient>
        <linearGradient id="rh-c-rose" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fecdd3" />
          <stop offset="1" stopColor="#f43f5e" />
        </linearGradient>
      </defs>
      <rect x="1"  y="1"  width="5" height="5" rx="1" fill="url(#rh-c-mint)" />
      <rect x="7"  y="1"  width="5" height="5" rx="1" fill="url(#rh-c-mint)" />
      <rect x="13" y="1"  width="5" height="5" rx="1" fill="url(#rh-c-sage)" />
      <rect x="19" y="1"  width="5" height="5" rx="1" fill="url(#rh-c-sage)" />
      <rect x="1"  y="7"  width="5" height="5" rx="1" fill="url(#rh-c-mint)" />
      <rect x="25" y="7"  width="5" height="5" rx="1" fill="url(#rh-c-amber)" />
      <rect x="1"  y="13" width="5" height="5" rx="1" fill="url(#rh-c-sage)" />
      <rect x="7"  y="13" width="5" height="5" rx="1" fill="url(#rh-c-amber)" />
      <rect x="13" y="13" width="5" height="5" rx="1" fill="url(#rh-c-amber)" />
      <rect x="19" y="13" width="5" height="5" rx="1" fill="url(#rh-c-coral)" />
      <rect x="1"  y="19" width="5" height="5" rx="1" fill="url(#rh-c-amber)" />
      <rect x="13" y="19" width="5" height="5" rx="1" fill="url(#rh-c-coral)" />
      <rect x="1"  y="25" width="5" height="5" rx="1" fill="url(#rh-c-coral)" />
      <rect x="19" y="25" width="5" height="5" rx="1" fill="url(#rh-c-coral)" />
      <rect x="25" y="25" width="5" height="5" rx="1" fill="url(#rh-c-rose)" />
    </svg>
  );
}
