import pinballPng from '../assets/pinball.png';

interface PinballIconProps {
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
  /**
   * Draw the flippers in the current text color (`text-*` classes) instead of white.
   * The asset is a single-color silhouette on transparency, so it is used as a CSS mask
   * over a `currentColor` fill. Default (false) keeps the white `<img>`.
   */
  tint?: boolean;
}

export function PinballIcon({ className, 'aria-hidden': ariaHidden, tint = false }: PinballIconProps) {
  if (tint) {
    const mask = `url(${pinballPng}) center / contain no-repeat`;
    return (
      <span
        className={className}
        style={{
          display: 'inline-block',
          backgroundColor: 'currentColor',
          mask,
          WebkitMask: mask,
        }}
        aria-hidden={ariaHidden ?? true}
      />
    );
  }
  return (
    <img
      src={pinballPng}
      className={className}
      style={{ filter: 'brightness(0) invert(1)' }}
      aria-hidden={ariaHidden ?? true}
      alt=""
    />
  );
}
