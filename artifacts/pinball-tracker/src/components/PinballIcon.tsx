import pinballPng from '../assets/pinball.png';

interface PinballIconProps {
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}

export function PinballIcon({ className, 'aria-hidden': ariaHidden }: PinballIconProps) {
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
