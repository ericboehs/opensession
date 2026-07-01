import React from "react";

/**
 * Icon set lifted from tella-fusion's `iconic-pro` library
 * (packages/core/webapp/src/frontend/assets/icons/iconic-pro) so Backstage's
 * chat UI uses the same quality stroke icons as the product instead of emoji.
 * All are 24×24, `currentColor`, stroke-width 1.5 — size via the `size` prop.
 */
type IconProps = React.SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

const stroke = {
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconArrowUp(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M17.25 10.25L12 4.75L6.75 10.25" />
      <path {...stroke} d="M12 19.25V5.75" />
    </Svg>
  );
}

export function IconSidebarRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M6.75 4.75H17.25C18.3546 4.75 19.25 5.64543 19.25 6.75V17.25C19.25 18.3546 18.3546 19.25 17.25 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V6.75C4.75 5.64543 5.64543 4.75 6.75 4.75Z"
      />
      <path {...stroke} d="M14.75 4.75V19.25" />
    </Svg>
  );
}

export function IconChevronDown(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M6.75 10.25L12 15.25L17.25 10.25" />
    </Svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M5.75 12.75L9.5 16.25L18.25 7.75" />
    </Svg>
  );
}

export function IconBolt(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M10.75 13.25H6.75L13.25 4.75V10.75H17.25L10.75 19.25V13.25Z" />
    </Svg>
  );
}

export function IconArrowDownRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M17.25 8.75V17.25H8.75" />
      <path {...stroke} d="M17 17L6.75 6.75" />
    </Svg>
  );
}

export function IconPlus(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M12 5.75V18.25" />
      <path {...stroke} d="M18.25 12L5.75 12" />
    </Svg>
  );
}

export function IconPaperclip(p: IconProps) {
  return (
    <Svg viewBox="0 0 25 24" {...p}>
      <path
        {...stroke}
        d="M19.4496 11.9511L13.3335 17.8601C11.4156 19.7131 8.30597 19.7131 6.38804 17.8601C4.46306 16.0003 4.47116 12.9826 6.4061 11.1325L12.0503 5.70078C13.3626 4.43293 15.4902 4.43292 16.8025 5.70075C18.1196 6.97324 18.114 9.038 16.7901 10.3039L11.0824 15.7858C10.374 16.4702 9.22538 16.4702 8.51694 15.7858C7.80849 15.1013 7.80849 13.9916 8.51695 13.3071L13.2435 8.74069"
      />
    </Svg>
  );
}

export function IconAtSign(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="12" cy="12" r="3.25" />
      <path
        {...stroke}
        d="M12 19.25C7.99594 19.25 4.75 16.0041 4.75 12C4.75 7.99594 7.99594 4.75 12 4.75C18.8125 4.75 19.25 9.125 19.25 12V13.25C19.25 14.3546 18.3546 15.25 17.25 15.25C16.1454 15.25 15.25 14.3546 15.25 13.25V8.75"
      />
    </Svg>
  );
}

export function IconCrosshair(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M18.25 12C18.25 15.4518 15.4518 18.25 12 18.25C8.54822 18.25 5.75 15.4518 5.75 12C5.75 8.54822 8.54822 5.75 12 5.75C15.4518 5.75 18.25 8.54822 18.25 12Z"
      />
      <path {...stroke} d="M12 4.75V9.25" />
      <path {...stroke} d="M19.25 12L14.75 12" />
      <path {...stroke} d="M12 14.75V19.25" />
      <path {...stroke} d="M9.25 12L4.75 12" />
    </Svg>
  );
}

export function IconMap(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M4.75 6.75L9.25 4.75V17.25L4.75 19.25V6.75Z" />
      <path {...stroke} d="M14.75 6.75L19.25 4.75V17.25L14.75 19.25V6.75Z" />
      <path {...stroke} d="M14.75 6.75L9.25 4.75V17.25L14.75 19.25V6.75Z" />
    </Svg>
  );
}
