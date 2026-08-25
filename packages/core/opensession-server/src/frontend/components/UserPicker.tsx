import React, { useState, useEffect } from "react";
import { BrandMark } from "./BrandMark";
import { UserAvatar } from "./UserAvatar";
import { IconArrowUpRight } from "./icons";
import { BASE_PATH } from "../lib/base";
import { PRODUCT_NAME } from "../lib/brand";
import { usePeople } from "../lib/people";
import { effectiveTheme, onThemeChanged } from "../lib/theme";
import { Button } from "../ui/button";
import { DeviceCode } from "../ui/device-code";
import { InlineAlert } from "../ui/state";
import { PulseDot } from "../ui/status";
import { AUTH_STATUS_EVENT, authGatesOut } from "../lib/auth-ready";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps , mergeStylexClassName} from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	pointerEventsNone: {
			pointerEvents: "none"
	},
	absolute: {
			position: "absolute"
	},
	inset0: {
			inset: "0"
	},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	bgCover: {
			backgroundSize: "cover"
	},
	bgCenter: {
			backgroundPosition: "50%"
	},
	sizeFull: {
			width: "100%",
			height: "100%"
	},
	objectCover: {
			objectFit: "cover"
	},
	relative: {
			position: "relative"
	},
	flex: {
			display: "flex"
	},
	hScreen: {
			height: "100vh"
	},
	itemsCenter: {
			alignItems: "center"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	p6: {
			padding: "24px"
	},
	w400px: {
			width: "400px"
	},
	maxWFull: {
			maxWidth: "100%"
	},
	rounded2xl: {
			borderRadius: "calc(22px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	p8: {
			padding: "32px"
	},
	textCenter: {
			textAlign: "center"
	},
	mxAuto: {
			marginInline: "auto"
	},
	mb5: {
			marginBottom: "20px"
	},
	block: {
			display: "block"
	},
	size14: {
			width: "56px",
			height: "56px"
	},
	m0: {
			margin: "0"
	},
	fontTitle: {
			fontWeight: "var(--title-weight)"
	},
	textFg: {
			color: "var(--text)"
	},
	mt2: {
			marginTop: "8px"
	},
	mb6: {
			marginBottom: "24px"
	},
	maxW32ch: {
			maxWidth: "32ch"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	minH10: {
			minHeight: "40px"
	},
	wFull: {
			width: "100%"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap2: {
			gap: "8px"
	},
	roundedLg: {
			borderRadius: "calc(14px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderLine: {
			borderColor: "var(--border)"
	},
	bgButton: {
			backgroundColor: "var(--button-surface)"
	},
	px3: {
			paddingInline: "12px"
	},
	py4: {
			paddingBlock: "16px"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	smoothShadowXs: {
			boxShadow: "0 1px 2px -1px var(--smooth-shadow-color), 0 2px 5px -3px var(--smooth-shadow-color)"
	},
	focusRing: {
			":focus-visible": {
					outline: "2px solid var(--accent-ink)",
					outlineOffset: "2px"
			}
	},
	px4: {
			paddingInline: "16px"
	},
	py25: {
			paddingBlock: "10px"
	},
	mt5: {
			marginTop: "20px"
	},
	mt35: {
			marginTop: "14px"
	},
	textLeft: {
			textAlign: "left"
	},
	grid: {
		display: "grid",
	},
	gridCols1: {
		gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
	},
	gridCols2: {
		gridTemplateColumns: {
			default: "repeat(2, minmax(0, 1fr))",
			"@media (max-width: 720px)": "repeat(1, minmax(0, 1fr))",
		},
	},

	selectNone: {
		"WebkitUserSelect": "none",
		"userSelect": "none"
	},
	motionReduceHidden: {
		"@media (prefers-reduced-motion: reduce)": {
			"display": "none"
		}
	},
	shadowAuthCardEdge: {
		"--tw-shadow": "var(--auth-card-edge)",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	phoneP6: {
		"@media (max-width: 720px)": {
			"padding": "24px"
		}
	},
	transitionBorderColorScale: {
		"transitionProperty": "border-color,scale",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	hoverBorderLineStrong: {
		"@media (hover: hover)": {
			":hover": {
				"borderColor": "var(--border-strong)"
			}
		}
	},
	activeScale098: {
		":active": {
			"scale": ".98"
		}
	},
});

/**
 * Mutable compatibility view for older consumers. `usePeople()` owns the
 * roster and updates this array in place after GET /api/people resolves.
 */
export const TEAM: string[] = [];
// Rename shim: read the new key first, fall back to the legacy one (existing
// browsers + tooling that presets it stay signed in); writes go to the new key.
const KEY = "opensession-user";
const LEGACY_KEY = "backstage-user";
const CHANGE_EVENT = "opensession-user-changed";

function setStoredUser(val: string) {
  const changed = getCurrentUser() !== val;
  localStorage.setItem(KEY, val);
  // Auth verification commonly confirms the identity already restored from
  // localStorage. Do not make every per-user store hydrate again in that case.
  if (changed) window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function getCurrentUser(): string {
  return (
    localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY) || "Anonymous"
  );
}

/** Switch the current user (used by the account menu's switcher). */
export function setCurrentUser(name: string) {
  setStoredUser(name);
}

/** Reactive current user — updates when the picker (or another tab) changes it. */
export function useCurrentUser(): string {
  const [user, setUser] = useState(() =>
    typeof localStorage === "undefined" ? "" : getCurrentUser(),
  );

  useEffect(() => {
    const handler = () => setUser(getCurrentUser());
    // Server-rendered component tests start without localStorage. Hydrate the
    // real browser identity as soon as the hook reaches the client.
    handler();
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, []);

  return user;
}

export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
  admin?: boolean;
  /** Signed out because GitHub permanently rejected this person's grant, not
   *  because they never signed in: `login` is still theirs, and the way back
   *  in is the same authorize. */
  reconnectRequired?: boolean;
  login?: string;
  name?: string;
}

// Shared auth state: UserGate fetches /api/auth/status once on load; other
// components (Settings' account footer) read it reactively from here
// instead of re-fetching.
let authStatusCache: AuthStatus | null = null;

function setAuthStatusCache(status: AuthStatus) {
  authStatusCache = status;
  window.dispatchEvent(new Event(AUTH_STATUS_EVENT));
}

/** Publish an auth status discovered outside UserGate — the WebSocket layer
 *  learns the gate turned on (or that a fresh load landed on a gated instance)
 *  from a refused upgrade, and drives UserGate to the sign-in card through
 *  this, without a reload that would loop on the card's own refused socket. */
export function publishAuthStatus(status: AuthStatus): void {
  setAuthStatusCache(status);
}

/** Reactive sign-in state; null until /api/auth/status answers (or when the
 *  server predates it). `required && authenticated` ⇒ GitHub-verified user. */
export function useAuthStatus(): AuthStatus | null {
  const [status, setStatus] = useState(authStatusCache);
  useEffect(() => {
    const handler = () => setStatus(authStatusCache);
    window.addEventListener(AUTH_STATUS_EVENT, handler);
    return () => window.removeEventListener(AUTH_STATUS_EVENT, handler);
  }, []);
  return status;
}

/** Sign out of the GitHub web session and return to the sign-in screen. */
export async function signOut(): Promise<void> {
  await (async () => {
await fetch(`${BASE_PATH}/api/auth/logout`, { method: "POST" });
})().catch(async () => {

});
  window.location.reload();
}

/**
 * The backdrop behind every gate screen: the same "Silver Silk" loop the
 * landing page runs, so the site and the app's front door are one surface.
 * Served from our own origin (routes/static-assets.ts), never the site's CDN.
 *
 * Three layers, each covering for the one above it: a flat fill that is
 * whatever paints first, the loop's own first frame as a background image, and
 * the video. So an offline browser, a slow connection and a reduced-motion
 * visitor all get the same picture, just not moving. `aria-hidden` and
 * `pointer-events-none` because it is wallpaper.
 *
 * Dark gets its OWN cut of the loop rather than the silver one behind a scrim.
 * A dimmed light background is still a light background: it stays the
 * brightest thing on the display and the whole screen glows in a dark room.
 * The dark cut is the same footage graded to charcoal (`scripts/signin-bg.sh`),
 * so it is the same material and the same motion in a different finish, and
 * its darkest point still sits clear of the card's own fill.
 *
 * `key` on the video: swapping a <source> child does not make an already-live
 * <video> reload, so a theme flip would keep playing the old cut. Keying it to
 * the theme replaces the element instead.
 */
function AuthBackdrop() {
	const [theme, setTheme] = useState(effectiveTheme);
	useEffect(() => onThemeChanged(() => setTheme(effectiveTheme())), []);
	const name = theme === "dark" ? "signin-bg-dark" : "signin-bg";
	const poster = `${BASE_PATH}/${name}.webp`;
	return (
		<div
			aria-hidden="true" {...mergeStylexProps("", sx.selectNone, sx.pointerEventsNone, sx.absolute, sx.inset0, sx.bgSurface, sx.bgCover, sx.bgCenter)}
			style={{ backgroundImage: `url(${poster})` }}
		>
			<video
				key={name} {...mergeStylexProps("", sx.motionReduceHidden, sx.sizeFull, sx.objectCover)}
				autoPlay
				loop
				muted
				playsInline
				poster={poster}
			>
				<source src={`${BASE_PATH}/${name}.mp4`} type="video/mp4" />
			</video>
		</div>
	);
}

/**
 * The shell every pre-app screen shares: sign-in, the local name picker, the
 * expired-session notice, the retry after a failed status check. They were
 * four hand-built boxes with their own paddings and inline styles, which is
 * why the first thing a new teammate saw looked like a different product from
 * the one behind it.
 *
 * One card, one corner, one width. The corner is the container step of the
 * radius scale (`rounded-2xl`) rather than the card step: nothing is stacked
 * around it, so it is the whole page's shape.
 *
 * It is paper (`bg-surface`, the page's own base) rather than the panel grey
 * every other card takes: on the silk it is the only opaque thing on screen,
 * so it reads against the backdrop rather than against a page.
 *
 * Its edge is the one thing that changes with the theme, and `--auth-card-edge`
 * (base.css) holds both answers. Over the silver loop the card is white in
 * front of a picture and takes the `lg` cast a genuinely floating card has
 * earned. Over the charcoal cut there is nothing for a cast to fall on, so it
 * takes a hairline instead.
 *
 * Every screen opens on the product's own icon, the same one the loading
 * splash shows (index.html), so the app you are signing in to is what you land
 * on. GitHub is the method, and it is named on the button.
 */
function AuthCard({
	title,
	children,
}: {
	title: string;
	children?: React.ReactNode;
}) {
	return (
		// Before sign-in there is no sidebar or header, so the desktop shell has
		// none of the rows it normally makes draggable. The backdrop is the handle
		// here; the card opts back out so its controls stay clickable. The durable
		// shell capability keeps this working if WCO geometry disappears.
		<div {...mergeStylexProps("[html.wco_&]:[-webkit-app-region:drag] [html.wco_&]:[app-region:drag] [html.desktop-shell_&]:[-webkit-app-region:drag] [html.desktop-shell_&]:[app-region:drag]", sx.relative, sx.flex, sx.hScreen, sx.itemsCenter, sx.justifyCenter, sx.overflowHidden, sx.p6)}>
			<AuthBackdrop />
			<div {...mergeStylexProps("[html.wco_&]:[-webkit-app-region:no-drag] [html.wco_&]:[app-region:no-drag] [html.desktop-shell_&]:[-webkit-app-region:no-drag] [html.desktop-shell_&]:[app-region:no-drag]", sx.shadowAuthCardEdge, sx.phoneP6, sx.relative, sx.w400px, sx.maxWFull, sx.rounded2xl, sx.bgSurface, sx.p8, sx.textCenter)}>
				<img
					src={`${BASE_PATH}/mac-app-icon.png?v=7`}
					alt=""
					width={56}
					height={56}
					{...stylex.props(sx.mxAuto, sx.mb5, sx.block, sx.size14)}
				/>
				{/* Medium, not semibold: at 19px on the card's own paper the heavier
				    step read as a slab rather than a heading. */}
				<h1 {...stylex.props(sx.m0, sx.fontTitle, sx.textFg, typography.sectionTitle)}>{title}</h1>
				{children}
			</div>
		</div>
	);
}

/** The sentence under an AuthCard's title. */
function AuthCopy({ children }: { children: React.ReactNode }) {
	return (
		// `last:mb-0` for the cards whose sentence IS the card (the expired
		// notice): the margin is air before whatever follows, and with nothing
		// following it just lands the card off-centre.
		<p {...mergeStylexProps("last:mb-0", sx.mxAuto, sx.mt2, sx.mb6, sx.maxW32ch, sx.leadingRelaxed, sx.textDim, typography.supporting)}>
			{children}
		</p>
	);
}

/**
 * Identity gate. Default: the historical localStorage name picker. When
 * GitHub web sign-in is active on the server (config
 * integrations.github.userPrAuth), the picker is replaced by a real GitHub
 * sign-in (device flow → HttpOnly cookie) — the server then ignores
 * client-claimed names, so the localStorage value is display-only and is
 * synced to the verified identity here.
 */
export function UserGate({ children }: { children: React.ReactNode }) {
  const user = useCurrentUser();
  const roster = usePeople();
  TEAM.splice(0, TEAM.length, ...roster.map(({ name }) => name));
	const [auth, setAuth] = useState<AuthStatus | null>(null);
	const [authFailed, setAuthFailed] = useState(false);
	const loadAuth = () => {
		setAuthFailed(false);
		fetch(`${BASE_PATH}/api/auth/status`)
			.then((r) => {
				if (!r.ok) throw new Error(`Authentication status failed: ${r.status}`);
				return r.json();
			})
			.then((body: AuthStatus | null) => {
				if (!body) throw new Error("Authentication status was empty");
				setAuth(body);
				if (body.required && body.authenticated && body.name) {
					const user = body.name.split(" ")[0];
					setStoredUser(user);
				}
				// Publish readiness after localStorage carries the verified name so
				// deferred per-user stores hydrate the authenticated account.
				setAuthStatusCache(body);
			})
			.catch(() => setAuthFailed(true));
	};

  useEffect(() => {
		loadAuth();
  }, []);

	// A refused WebSocket upgrade can reveal the gate is up before this
	// component's own status resolves (the optimistic paint below) or after it
	// resolved to no-gate (the gate was enabled under an open tab). Honor that
	// signal so the sign-in card, not a "reconnecting" overlay, stands in for a
	// browser the server will no longer accept.
	const liveAuth = useAuthStatus();
	if (authGatesOut(liveAuth) && !(auth?.required && auth.authenticated)) {
		return (
			<GithubSignIn
				reconnect={liveAuth!.reconnectRequired === true}
				login={liveAuth!.login}
				onSignedIn={(status) => {
					setAuth(status);
					setAuthStatusCache(status);
				}}
			/>
		);
	}

	// Returning visitors already have a local identity. Let the app paint while
	// the server verifies its HttpOnly session, as it did before this check grew
	// a blocking loading screen. The server still enforces auth on every route.
	if (!auth && !authFailed && user !== "Anonymous") return <>{children}</>;

	if (!auth) {
		if (authFailed) {
			return (
				<AuthCard title="Couldn't check sign-in">
					<AuthCopy>The server didn't answer. It may still be starting up.</AuthCopy>
					<Button variant="primary" size="lg" {...stylex.props(sx.minH10, sx.wFull)} onClick={loadAuth}>
						Try again
					</Button>
				</AuthCard>
			);
		}
		// The static launch splash stays visible while this returns nothing. Only
		// mount the sign-in scene once the server says it is actually needed.
		return null;
	}

  // GitHub sign-in is configured: it is the only way in, and the name picker
  // below is unreachable. The two are alternatives, never steps of one flow
  // (web-auth.ts: "Off (default): the UI keeps today's localStorage name
  // picker"), so nobody signing in with GitHub is ever asked to pick a name.
  if (auth?.required) {
    if (auth.authenticated) return <>{children}</>;
    return (
      <GithubSignIn
        reconnect={auth.reconnectRequired === true}
        login={auth.login}
        onSignedIn={(status) => {
          setAuth(status);
          setAuthStatusCache(status);
        }}
      />
    );
  }

  if (user !== "Anonymous") return <>{children}</>;

  // No sign-in configured, which is the default for a fresh instance: the
  // server cannot verify anyone, so this name is a label rather than an
  // identity. It is also the bootstrap path, since an admin has to get in
  // here before there is a GitHub app to sign in with.
  return (
    <AuthCard title="Who are you?">
      <AuthCopy>
        Sign-in isn't set up here, so your name is only a label on your
        sessions.
      </AuthCopy>
      <div
        {...stylex.props(
          sx.grid,
          sx.gap2,
          // One tile has no column to pair with: a half-width button floating
          // in a card reads as a layout that lost its other half.
          roster.length > 1 ? sx.gridCols2 : sx.gridCols1,
        )}
      >
        {(roster.length ? roster.map(({ name }) => name) : ["Local User"]).map(
          (name) => (
            <button
              key={name} {...mergeStylexProps("", sx.transitionBorderColorScale, sx.hoverBorderLineStrong, sx.activeScale098, sx.flex, sx.flexCol, sx.itemsCenter, sx.gap2, sx.roundedLg, sx.border, sx.borderLine, sx.bgButton, sx.px3, sx.py4, sx.fontMedium, sx.textFg, sx.smoothShadowXs, sx.focusRing, typography.itemTitle)}
              onClick={() => setStoredUser(name)}
            >
              <UserAvatar name={name} size={36} />
              {roster.length ? name : "Continue locally"}
            </button>
          ),
        )}
      </div>
    </AuthCard>
  );
}

/**
 * Sign in with GitHub's device flow: the code is entered on github.com in
 * whatever browser the person already trusts, and this screen waits.
 *
 * It is the only flow, deliberately. An authorization-code redirect has to
 * come back to the exact origin it left, and on the iOS PWA it returns into
 * Safari instead of the installed app, stranding the person one tab away from
 * the thing they were signing in to. Entering a code is one step longer and
 * lands everywhere.
 */
function GithubSignIn({
  reconnect = false,
  login,
  onSignedIn,
}: {
  /** The grant behind an existing session died; this is the same screen and
   *  the same flow, saying which of the two happened. */
  reconnect?: boolean;
  login?: string;
  onSignedIn: (status: AuthStatus) => void;
}) {
  const [flow, setFlow] = useState<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    interval: number;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll GitHub (via the server) until the device code is authorized.
  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    let intervalMs = Math.max(flow.interval, 5) * 1000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await (async () => {
const res = await fetch(`${BASE_PATH}/api/auth/device/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode: flow.deviceCode }),
        });
        const body = await res.json();
        if (cancelled) return;
        if (body.status === "ok") {
          if (body.name) setStoredUser(body.name.split(" ")[0]);
          onSignedIn({ required: true, authenticated: true, admin: body.admin, login: body.login, name: body.name });
          return;
        }
        if (body.status === "slow_down") intervalMs = Math.max(body.interval, 5) * 1000;
        if (body.status === "error" || body.error) {
          setError(body.error || "Sign-in failed");
          setFlow(null);
          return;
        }
})().catch(async () => {

});
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [flow, onSignedIn]);

  async function start() {
    setError(null);
    setStarting(true);
    await (async () => {
const res = await fetch(`${BASE_PATH}/api/auth/device`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      setFlow(body);
})().catch(async (e: any) => {
setError(e.message);
});
    setStarting(false);
  }

  return (
    <AuthCard
      title={
        flow
          ? "Enter this code"
          : reconnect
            ? "Reconnect GitHub"
            : `Sign in to ${PRODUCT_NAME}`
      }
    >
      {!flow ? (
        <>
          <AuthCopy>
            {reconnect ? (
              <>
                GitHub's authorization
                {login ? <> for @{login}</> : null} expired. Sign in again to
                continue.
              </>
            ) : (
              <>
                Sessions act as your own GitHub account, so pull requests are
                authored by you.
              </>
            )}
          </AuthCopy>
          <Button
            variant="primary"
            size="lg"
            {...stylex.props(sx.minH10, sx.wFull)}
            icon={<BrandMark name="github" size={20} />}
            disabled={starting}
            onClick={() => void start()}
          >
            {starting
              ? "Starting…"
              : reconnect
                ? "Reconnect with GitHub"
                : "Continue with GitHub"}
          </Button>
        </>
      ) : (
        <div {...stylex.props(sx.flex, sx.flexCol, sx.itemsCenter)}>
          <AuthCopy>
            GitHub will ask for it at{" "}
            <span {...stylex.props(sx.fontMedium, sx.textFg)}>
              {flow.verificationUri.replace(/^https:\/\//, "")}
            </span>
            .
          </AuthCopy>
          {/* The code is what this screen is for, so it gets the display step
              and room to breathe rather than the inline chip size. */}
          <DeviceCode
            code={flow.userCode}
            {...stylex.props(sx.px4, sx.py25, typography.pageTitle)}
          />
          <a
            href={flow.verificationUri}
            target="_blank"
            rel="noreferrer"
            {...stylex.props(sx.mt5, sx.wFull)}
          >
            <Button
              variant="primary"
              size="lg"
              {...stylex.props(sx.minH10, sx.wFull)}
              icon={<IconArrowUpRight size={20} />}
            >
              Open GitHub
            </Button>
          </a>
          <span {...stylex.props(sx.mt35, sx.flex, sx.itemsCenter, sx.gap2, sx.textDim, typography.label)}>
            <PulseDot size={7} />
            Waiting for GitHub…
          </span>
        </div>
      )}
      {error && (
        <InlineAlert variant="error" {...stylex.props(sx.mt5, sx.textLeft)}>
          {error}
        </InlineAlert>
      )}
    </AuthCard>
  );
}
