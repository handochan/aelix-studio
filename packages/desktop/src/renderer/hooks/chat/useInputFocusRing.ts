/**
 * Composer focus ring and ambient glow. The colors are theme tokens from the
 * default color scheme, so light/dark switching happens in CSS.
 */
export const INPUT_FOCUS_RING = {
  activeBorderColor: 'var(--composer-ring-active)',
  inactiveBorderColor: 'var(--composer-ring-inactive)',
  activeShadow: 'var(--composer-ambient)',
} as const;

export const useInputFocusRing = () => INPUT_FOCUS_RING;
