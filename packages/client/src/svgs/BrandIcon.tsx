import { cn } from '~/utils';

export default function BrandIcon({
  size = 25,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('fill-current text-text-primary', className)}
      aria-hidden="true"
    >
      {/*
        PLACEHOLDER — replace the path(s) below with your own SVG markup.
        Leave `fill`/`stroke` as "currentColor" (or unset, since the wrapping
        <svg> uses `fill-current`) so the icon inherits the themed color from
        `text-text-primary` and adapts to both light and dark mode automatically.
      */}
      <path d="M12 2l2.09 6.26L20.5 8.5l-5.2 3.78L17.4 18.5 12 14.77 6.6 18.5l2.1-6.22L3.5 8.5l6.41-.24L12 2z" />
    </svg>
  );
}
