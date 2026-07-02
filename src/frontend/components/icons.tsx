import React from "react";

/**
 * Icon set lifted from tella-fusion's `iconic-pro` library
 * (packages/core/webapp/src/frontend/assets/icons/iconic-pro) so Backstage's
 * chat UI uses the same quality stroke icons as the product instead of emoji.
 * All are 24×24, `currentColor`, stroke-width 1.5 — size via the `size` prop.
 */
type IconProps = React.SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: IconProps & { children: React.ReactNode }) {
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

export function IconChevronLeft(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M13.75 6.75L8.75 12L13.75 17.25" />
    </Svg>
  );
}

export function IconChevronRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M10.25 6.75L15.25 12L10.25 17.25" />
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

/* ── Tool icons (transcript work blocks) ─────────────────── */

export function IconTerminal(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M6.75 8.75L10.25 12L6.75 15.25" />
      <path {...stroke} d="M12.75 15.25H17.25" />
    </Svg>
  );
}

export function IconFile(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M7.75 19.25H16.25C17.3546 19.25 18.25 18.3546 18.25 17.25V9L14 4.75H7.75C6.64543 4.75 5.75 5.64543 5.75 6.75V17.25C5.75 18.3546 6.64543 19.25 7.75 19.25Z"
      />
      <path {...stroke} d="M18 9.25H13.75V5" />
    </Svg>
  );
}

export function IconPencil(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M4.75 19.25L9 18.25L18.2929 8.95711C18.6834 8.56658 18.6834 7.93342 18.2929 7.54289L16.4571 5.70711C16.0666 5.31658 15.4334 5.31658 15.0429 5.70711L5.75 15L4.75 19.25Z"
      />
      <path {...stroke} d="M14.0234 7.03906L17.0234 10.0391" />
    </Svg>
  );
}

export function IconSearch(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="11" cy="11" r="4.25" />
      <path {...stroke} d="M14.5 14.5L19.25 19.25" />
    </Svg>
  );
}

export function IconGlobe(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="12" cy="12" r="7.25" />
      <path {...stroke} d="M4.75 12H19.25" />
      <path
        {...stroke}
        d="M12 4.75C13.6569 4.75 15 7.99594 15 12C15 16.0041 13.6569 19.25 12 19.25C10.3431 19.25 9 16.0041 9 12C9 7.99594 10.3431 4.75 12 4.75Z"
      />
    </Svg>
  );
}

export function IconSparkle(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M12 4.75C12.75 8.5 15.5 11.25 19.25 12C15.5 12.75 12.75 15.5 12 19.25C11.25 15.5 8.5 12.75 4.75 12C8.5 11.25 11.25 8.5 12 4.75Z"
      />
    </Svg>
  );
}

export function IconPlug(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M7.75 10.75H16.25V12.25C16.25 14.5972 14.3472 16.5 12 16.5C9.65279 16.5 7.75 14.5972 7.75 12.25V10.75Z"
      />
      <path {...stroke} d="M9.75 10.5V7.75" />
      <path {...stroke} d="M14.25 10.5V7.75" />
      <path {...stroke} d="M12 16.5V19.25" />
    </Svg>
  );
}

export function IconBook(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M5.75 19.25V6.75C5.75 5.64543 6.64543 4.75 7.75 4.75H18.25V16.25H7.5C6.5335 16.25 5.75 17.0335 5.75 18V19.25Z"
      />
      <path {...stroke} d="M5.75 19.25H18.25" />
    </Svg>
  );
}

export function IconBranches(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="7" cy="7" r="1.75" />
      <circle {...stroke} cx="7" cy="17" r="1.75" />
      <circle {...stroke} cx="17" cy="7" r="1.75" />
      <path {...stroke} d="M7 9V15.25" />
      <path {...stroke} d="M17 9C17 12 14 12.75 12 13C10 13.25 8.5 14 7.75 15" />
    </Svg>
  );
}

export function IconListChecks(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M11.75 7.25H19.25" />
      <path {...stroke} d="M11.75 12H19.25" />
      <path {...stroke} d="M11.75 16.75H19.25" />
      <path {...stroke} d="M4.75 7.25L5.75 8.25L7.75 6.25" />
      <path {...stroke} d="M4.75 12L5.75 13L7.75 11" />
      <path {...stroke} d="M4.75 16.75L5.75 17.75L7.75 15.75" />
    </Svg>
  );
}

export function IconWrench(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M13.5 6.5C14.5 5.5 16.5 5 17.5 5.5L14.75 8.25L15.75 9.25L18.5 6.5C19 7.5 18.5 9.5 17.5 10.5C16.6 11.4 15.1 11.7 14 11.25L7.75 17.5C7.19772 18.0523 6.30228 18.0523 5.75 17.5C5.19772 16.9477 5.19772 16.0523 5.75 15.5L12 9.25C11.8 8.15 12.6 7.4 13.5 6.5Z"
      />
    </Svg>
  );
}

export function IconImage(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M6.75 4.75H17.25C18.3546 4.75 19.25 5.64543 19.25 6.75V17.25C19.25 18.3546 18.3546 19.25 17.25 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V6.75C4.75 5.64543 5.64543 4.75 6.75 4.75Z"
      />
      <path {...stroke} d="M4.75 16.25L9 11.75L13 15.25L15.5 12.75L19.25 16.25" />
      <circle cx="14.5" cy="8.5" r="1.25" stroke="currentColor" strokeWidth="1.5" />
    </Svg>
  );
}

export function IconTrash(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        {...stroke}
        d="M6.75 7.75L7.59115 17.4233C7.68102 18.4568 8.54622 19.25 9.58363 19.25H14.4164C15.4538 19.25 16.319 18.4568 16.4088 17.4233L17.25 7.75"
      />
      <path
        {...stroke}
        d="M9.75 7.5V6.75C9.75 5.64543 10.6454 4.75 11.75 4.75H12.25C13.3546 4.75 14.25 5.64543 14.25 6.75V7.5"
      />
      <path {...stroke} d="M5 7.75H19" />
    </Svg>
  );
}

export function IconX(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} d="M17.25 6.75L6.75 17.25" />
      <path {...stroke} d="M6.75 6.75L17.25 17.25" />
    </Svg>
  );
}

// Octicon-style git-pull-request, redrawn to this set's 24×24 stroke grammar.
export function IconPullRequest(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="7" cy="6.5" r="1.75" />
      <circle {...stroke} cx="7" cy="17.5" r="1.75" />
      <circle {...stroke} cx="17" cy="17.5" r="1.75" />
      <path {...stroke} d="M7 8.25V15.75" />
      <path {...stroke} d="M12.25 6.5H15C16.1046 6.5 17 7.39543 17 8.5V15.75" />
    </Svg>
  );
}

// Octicon-style git-merge: branch line curving into the merge target.
export function IconGitMerge(p: IconProps) {
  return (
    <Svg {...p}>
      <circle {...stroke} cx="7" cy="6.5" r="1.75" />
      <circle {...stroke} cx="7" cy="17.5" r="1.75" />
      <circle {...stroke} cx="17" cy="13" r="1.75" />
      <path {...stroke} d="M7 8.25V15.75" />
      <path {...stroke} d="M7 9C7 11.5 10 13 15.25 13" />
    </Svg>
  );
}
