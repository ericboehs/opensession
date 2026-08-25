import { useState } from "react";
import type {
  PreviewPortalRecipe,
  PreviewService,
  PreviewStatus,
} from "../lib/api";
import { portalTargetFor, type PortalTarget } from "../lib/portals";
import {
	INFO_LABEL_CLASS,
	INFO_SECTION_CLASS,
} from "../lib/session-viewer-classes";
import { IconArrowUpRight } from "./icons";
import { PanelPageHeader } from "./PanelPageHeader";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap2: {
			gap: "8px"
	},
	px2: {
			paddingInline: "8px"
	},
	py1: {
			paddingBlock: "4px"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	size35: {
			width: "14px",
			height: "14px"
	},
	animateSpin: {
			animation: "var(--animate-spin)"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	},
	border2: {
			borderStyle: "solid",
			borderWidth: "2px"
	},
	borderLineStrong: {
			borderColor: "var(--border-strong)"
	},
	borderTAccent: {
			borderTopColor: "var(--accent)"
	},
	shrink0: {
			flexShrink: "0"
	},
	px1: {
			paddingInline: "4px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	grid: {
			display: "grid"
	},
	gap4: {
			gap: "16px"
	},
	pt2: {
			paddingTop: "8px"
	},
	pb22px: {
			paddingBottom: "22px"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	},
	bgRedSoft: {
			backgroundColor: "var(--red-soft)"
	},
	px3: {
			paddingInline: "12px"
	},
	py2: {
			paddingBlock: "8px"
	},
	textRed: {
			color: "var(--red)"
	},
	focusRing: {
			":focus-visible": {
					outline: "2px solid var(--accent-ink)",
					outlineOffset: "2px"
			}
	},
	minH11: {
			minHeight: "44px"
	},
	wFull: {
			width: "100%"
	},
	minW0: {
			minWidth: "0"
	},
	gap3: {
			gap: "12px"
	},
	py15: {
			paddingBlock: "6px"
	},
	textLeft: {
			textAlign: "left"
	},
	flex1: {
			flex: "1"
	},
	block: {
			display: "block"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textFg: {
			color: "var(--text)"
	},
	mt05: {
			marginTop: "2px"
	},
	py5px: {
			paddingBlock: "5px"
	},
	inlineFlex: {
			display: "inline-flex"
	},
	size11: {
			width: "44px",
			height: "44px"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	opacity0: {
			opacity: "0"
	},
	transitionOpacity: {
			transitionProperty: "opacity",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	px15: {
			paddingInline: "6px"
	},
	transitionColors: {
    transitionProperty:
      "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
  py7px: { paddingBlock: "7px" },
  serviceRow: {
    display: "flex",
    minHeight: "44px",
    minWidth: 0,
    alignItems: "center",
    gap: "4px",
    borderRadius: "calc(12px * var(--rf))",
    paddingRight: "4px",
    transitionProperty: "color, background-color",
	},
  active: { backgroundColor: "var(--hover)" },
  inactive: { ":hover": { backgroundColor: "var(--hover)" } },
  serviceDot: {
    width: "7px",
    height: "7px",
    flexShrink: 0,
    borderRadius: "50%",
  },
  bgGreen: { backgroundColor: "var(--green)" },
  bgLineStrong: { backgroundColor: "var(--border-strong)" },
});

/** A plain divided list. Portal rows do not need a shared grey plate around
 * them: the panel itself is already their surface. */
const PORTAL_LIST_RESIDUAL_CLASS = "divide-y divide-line/70";

/** What a service row says on its right: where it is, in one word. */
function statusLabel(
	service: PreviewService,
	target: PortalTarget | null,
	active: boolean,
): string {
	if (target) return active ? "Open" : "Running";
	if (service.running) {
		if (service.state === "starting") return "Starting";
		if (service.state === "sleeping") return "Sleeping";
		if (service.state === "waking") return "Waking";
		return "Unavailable";
	}
	return service.state === "failed" ? "Failed" : `Port ${service.port}`;
}

function DiscoveringRow() {
	return (
    <div
      {...stylex.props(
        sx.flex,
        sx.itemsCenter,
        sx.gap2,
        sx.px2,
        sx.py1,
        sx.textDim,
        typography.supporting,
      )}
    >
      <span
        {...stylex.props(
          sx.size35,
          sx.animateSpin,
          sx.roundedFull,
          sx.border2,
          sx.borderLineStrong,
          sx.borderTAccent,
        )}
      />
			Discovering services…
		</div>
	);
}

/**
 * The portals page: the panel one level deeper, opened from the Portals item
 * in the panel's tab strip. The recipes this repository can start, every
 * discovered service, and the restart and stop controls for the ones we manage.
 */
export function PortalsPage({
	sessionId,
	status,
	activePortal,
	onBack,
	hideHeader = false,
	onOpenPortal,
	onStartPortal,
	onPortalAction,
}: {
	sessionId: string;
	status: PreviewStatus | null;
	activePortal?: PortalTarget | null;
	onBack: () => void;
	hideHeader?: boolean;
	onOpenPortal?: (target: PortalTarget) => void;
	onStartPortal?: (recipe: PreviewPortalRecipe) => Promise<void>;
	onPortalAction?: (name: string, action: "stop" | "restart") => Promise<void>;
}) {
	const [requestedId, setRequestedId] = useState<string | null>(null);
	const [working, setWorking] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const services = status?.services ?? [];
	const recipes = status?.portalRecipes ?? [];
	const liveCount = services.filter((service) =>
		portalTargetFor(sessionId, service),
	).length;

	return (
		<>
			{!hideHeader && (
				<PanelPageHeader
					title="Portals"
					onBack={onBack}
					trailing={
						liveCount > 0 && (
              <span
                className="tabular-nums"
                {...stylex.props(
                  sx.shrink0,
                  sx.px1,
                  sx.fontSemibold,
                  sx.textFaint,
                  typography.label,
                )}
              >
								{liveCount} live
							</span>
						)
					}
				/>
			)}
			<div {...stylex.props(sx.grid, sx.gap4, sx.px2, sx.pt2, sx.pb22px)}>
			{error ? (
          <div
            role="alert"
            {...stylex.props(
              sx.roundedControl,
              sx.bgRedSoft,
              sx.px3,
              sx.py2,
              sx.textRed,
              typography.label,
            )}
          >
					{error}
				</div>
			) : null}
			{!status ? (
				<DiscoveringRow />
			) : (
				<>
					{recipes.length ? (
						<div className={INFO_SECTION_CLASS}>
							<div className={INFO_LABEL_CLASS}>Start a portal</div>
                <div
                  className={PORTAL_LIST_RESIDUAL_CLASS}
                  {...stylex.props(sx.grid)}
                >
								{recipes.map((recipe) => {
									const service = recipe.serviceKey
										? services.find(
												(candidate) => candidate.key === recipe.serviceKey,
											)
										: null;
									const target = service
										? portalTargetFor(sessionId, service)
										: null;
									return (
										<button
											key={recipe.id}
											type="button"
                        disabled={
                          !target && (!onStartPortal || requestedId != null)
                        }
											onClick={() => {
												if (target) {
													onOpenPortal?.(target);
													return;
												}
												if (!onStartPortal) return;
												setError(null);
												setRequestedId(recipe.id);
												void onStartPortal(recipe)
                            .catch((cause) =>
                              setError(
                                cause instanceof Error
                                  ? cause.message
                                  : String(cause),
                              ),
                            )
													.finally(() => setRequestedId(null));
											}}
                        className="transition-[background-color,scale] hover:bg-hover active:scale-[0.96] disabled:cursor-default disabled:opacity-45"
                        {...stylex.props(
                          sx.focusRing,
                          sx.flex,
                          sx.minH11,
                          sx.wFull,
                          sx.minW0,
                          sx.itemsCenter,
                          sx.gap3,
                          sx.roundedControl,
                          sx.px2,
                          sx.py15,
                          sx.textLeft,
                        )}
										>
											<span {...stylex.props(sx.minW0, sx.flex1)}>
                          <span
                            {...stylex.props(
                              sx.block,
                              sx.truncate,
                              sx.fontMedium,
                              sx.textFg,
                              typography.label,
                            )}
                          >
                            {recipe.name}
                          </span>
												{recipe.description ? (
                            <span
                              className="line-clamp-2"
                              {...stylex.props(
                                sx.mt05,
                                sx.block,
                                sx.textDim,
                                typography.supporting,
                              )}
                            >
                              {recipe.description}
                            </span>
												) : null}
											</span>
                        <span
                          {...stylex.props(
                            sx.shrink0,
                            sx.fontSemibold,
                            sx.textFaint,
                            typography.label,
                          )}
                        >
                          {target
                            ? "Open"
                            : requestedId === recipe.id
                              ? "Starting…"
                              : "Start"}
											</span>
										</button>
									);
								})}
							</div>
						</div>
					) : null}
					<div className={INFO_SECTION_CLASS}>
						{recipes.length > 0 && (
							<div className={INFO_LABEL_CLASS}>Services</div>
						)}
              <div
                className={PORTAL_LIST_RESIDUAL_CLASS}
                {...stylex.props(sx.grid)}
              >
							{services.length ? (
								services.map((service) => {
									const target = portalTargetFor(sessionId, service);
									const active =
										!!target &&
										activePortal?.sessionId === sessionId &&
										activePortal.key === service.key;
									return (
										<div
											key={service.key}
                        className="group"
                        {...stylex.props(
                          sx.serviceRow,
                          active ? sx.active : sx.inactive,
											)}
										>
											<button
												type="button"
												disabled={!target}
												onClick={() => target && onOpenPortal?.(target)}
                          className="disabled:cursor-default"
                          {...stylex.props(
                            sx.flex,
                            sx.minW0,
                            sx.flex1,
                            sx.itemsCenter,
                            sx.gap2,
                            sx.roundedControl,
                            sx.px2,
                            sx.py5px,
                            sx.textLeft,
                          )}
											>
												<span
                            {...stylex.props(
                              sx.serviceDot,
                              service.running ? sx.bgGreen : sx.bgLineStrong,
													)}
													aria-hidden="true"
												/>
                          <span
                            {...stylex.props(
                              sx.minW0,
                              sx.flex1,
                              sx.truncate,
                              sx.textFg,
                              typography.label,
                            )}
                          >
													{service.name}
												</span>
                          <span
                            {...stylex.props(
                              sx.shrink0,
                              sx.truncate,
                              sx.textFaint,
                              typography.label,
                            )}
                          >
													{statusLabel(service, target, active)}
												</span>
											</button>
											{target ? (
												<a
													href={target.url}
													target="_blank"
													rel="noopener"
                            className="transition-[color,opacity] phone:opacity-100 hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
                            {...stylex.props(
                              sx.focusRing,
                              sx.inlineFlex,
                              sx.size11,
                              sx.shrink0,
                              sx.itemsCenter,
                              sx.justifyCenter,
                              sx.roundedControl,
                              sx.textFaint,
                              sx.opacity0,
                            )}
													aria-label={`Open ${service.name} in a separate browser window`}
													title="Open in browser"
												>
													<IconArrowUpRight size={14} />
												</a>
											) : null}
											{service.managed && onPortalAction ? (
                          <div
                            className="phone:opacity-100 group-hover:opacity-100 focus-within:opacity-100"
                            {...stylex.props(
                              sx.flex,
                              sx.shrink0,
                              sx.itemsCenter,
                              sx.opacity0,
                              sx.transitionOpacity,
                            )}
                          >
													<button
														type="button"
														disabled={working === service.name}
														onClick={() => {
															setError(null);
															setWorking(service.name);
															void onPortalAction(service.name, "restart")
                                  .catch((cause) =>
                                    setError(
                                      cause instanceof Error
                                        ? cause.message
                                        : String(cause),
                                    ),
                                  )
																.finally(() => setWorking(null));
														}}
                              className="phone:min-h-11 hover:text-fg disabled:opacity-45"
                              {...stylex.props(
                                sx.focusRing,
                                sx.roundedControl,
                                sx.px15,
                                sx.py1,
                                sx.fontSemibold,
                                sx.textFaint,
                                sx.transitionColors,
                                typography.label,
                              )}
													>
														Restart
													</button>
													<button
														type="button"
                              disabled={
                                working === service.name || !service.running
                              }
														onClick={() => {
															setError(null);
															setWorking(service.name);
															void onPortalAction(service.name, "stop")
                                  .catch((cause) =>
                                    setError(
                                      cause instanceof Error
                                        ? cause.message
                                        : String(cause),
                                    ),
                                  )
																.finally(() => setWorking(null));
														}}
                              className="phone:min-h-11 hover:text-red disabled:opacity-45"
                              {...stylex.props(
                                sx.focusRing,
                                sx.roundedControl,
                                sx.px15,
                                sx.py1,
                                sx.fontSemibold,
                                sx.textRed,
                                sx.transitionColors,
                                typography.label,
                              )}
													>
														Stop
													</button>
												</div>
											) : null}
										</div>
									);
								})
							) : (
                  <div
                    {...stylex.props(
                      sx.px2,
                      sx.py7px,
                      sx.textDim,
                      typography.label,
                    )}
                  >
									{status.starting
										? "Starting services…"
										: "No Portals are running. Start one above, or ask the agent to expose a service."}
								</div>
							)}
						</div>
					</div>
				</>
			)}
			</div>
		</>
	);
}
