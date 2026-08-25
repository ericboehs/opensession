import React, { useEffect, useState } from "react";
import { useSetupStatus } from "../hooks/useSetupStatus";
import { DEFAULT_DOC_TITLE, docTitle } from "../lib/brand";
import { Button } from "../ui/button";
import { cn, mergeStylexProps , mergeStylexClassName} from "../ui/cn";
import {
  SettingCard,
  SettingsHeader,
  SettingsPanel,
} from "../ui/settings";
import { LoadingState } from "../ui/state";
import { SetupChecklist } from "./SetupChecklist";
import { IntegrationsList } from "./SetupIntegrations";
import { ReposSection } from "./SetupRepos";
import { SetupRestart } from "./SetupRestart";
import { SetupServerAccess } from "./SetupServerAccess";
import { TeamSection } from "./SetupTeam";
import { OrganizationProfileSection } from "./settings/GeneralPanel";
import { ProviderAccountsSection } from "./settings/ModelAccounts";
import { ModelProvidersPanel } from "./ModelProviders";
import { ModelDefaultsSection } from "./Models";
import { IconCheck } from "./icons";
import {
  integrationState,
  publicUrlState,
  type SetupStatus,
} from "./setup-shared";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	mt10: {
			marginTop: "40px"
	},
	m0: {
			margin: "0"
	},
	mb2: {
			marginBottom: "8px"
	},
	px4: {
			paddingInline: "16px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	focusRing: {
			":focus-visible": {
					outline: "2px solid var(--accent-ink)",
					outlineOffset: "2px"
			}
	},
	flex: {
			display: "flex"
	},
	wFull: {
			width: "100%"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap25: {
			gap: "10px"
	},
	py3: {
			paddingBlock: "12px"
	},
	textLeft: {
			textAlign: "left"
	},
	srOnly: {
			clipPath: "inset(50%)",
			whiteSpace: "nowrap",
			borderWidth: "0",
			width: "1px",
			height: "1px",
			margin: "-1px",
			padding: "0",
			position: "absolute",
			overflow: "hidden"
	},
	mb3: {
			marginBottom: "12px"
	},
	px5: {
			paddingInline: "20px"
	},
	fontTitle: {
			fontWeight: "var(--title-weight)"
	},
	tracking0015em: {
			letterSpacing: "-.015em"
	},
	textFg: {
			color: "var(--text)"
	},
	mt15: {
			marginTop: "6px"
	},
	maxW62ch: {
			maxWidth: "62ch"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	relative: {
			position: "relative"
	},
	maxW980px: {
			maxWidth: "980px"
	},
	grid: {
			display: "grid"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	minW0: {
			minWidth: "0"
	},
	mt0: {
			marginTop: "0"
	},
	statusIcon: {
		display: "flex",
		width: "20px",
		height: "20px",
		flexShrink: 0,
		alignItems: "center",
		justifyContent: "center",
		borderRadius: "calc(infinity * 1px)",
	},
	statusComplete: {
		backgroundColor: "var(--green-soft)",
		color: "var(--green)",
	},
	statusIncomplete: {
		backgroundColor: "var(--hover)",
		color: "var(--text-faint)",
	},
	stepLabel: {
		minWidth: 0,
	},
	stepComplete: {
		fontWeight: "var(--font-weight-medium)",
		color: "var(--text)",
	},
	stepIncomplete: {
		color: "var(--text-dim)",
	},
	scrollMt4: {
		scrollMarginTop: "16px",
	},

	desktopSticky: {
		"@media (min-width: 721px)": {
			"position": "sticky"
		}
	},
	desktopTop0: {
		"@media (min-width: 721px)": {
			"top": "0"
		}
	},
	desktopColStart2: {
		"@media (min-width: 721px)": {
			"gridColumnStart": "2"
		}
	},
	desktopRowStart1: {
		"@media (min-width: 721px)": {
			"gridRowStart": "1"
		}
	},
	desktopMt0: {
		"@media (min-width: 721px)": {
			"marginTop": "0"
		}
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	desktopGridColsMinmax0720px220px: {
		"@media (min-width: 721px)": {
			"gridTemplateColumns": "minmax(0,720px) 220px"
		}
	},
	desktopGap10: {
		"@media (min-width: 721px)": {
			"gap": "40px"
		}
	},
	desktopColStart1: {
		"@media (min-width: 721px)": {
			"gridColumnStart": "1"
		}
	},
});

// Settings → Setup: every part of a new instance, in the order someone fills
// it in, with a summary rail that jumps to the section that still needs work.
// Sections match the onboarding steps, so the two never disagree on what
// "set up" means.

type SectionId =
  | "server"
  | "github"
  | "organisation"
  | "providers"
  | "repositories"
  | "members"
  | "review";

function sectionAnchor(id: SectionId) {
  return `setup-${id}`;
}

function scrollToSection(id: SectionId) {
  const target = document.getElementById(sectionAnchor(id));
  if (!target) return;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({
    behavior: reduced ? "auto" : "smooth",
    block: "start",
  });
}

function SetupSummary({
  status,
  onSelect,
}: {
  status: SetupStatus;
  onSelect: (id: SectionId) => void;
}) {
  const github = status.integrations.find(
    (integration) => integration.id === "github",
  );
  const githubReady = !!github && integrationState(github).tone === "on";
  const serverReady = publicUrlState(status.publicBaseUrl).tone === "on";
  const requiredReady =
    serverReady &&
    githubReady &&
    status.engine.ready &&
    status.repos.length > 0 &&
    status.team.count > 0;
  const steps: { id: SectionId; label: string; complete: boolean }[] = [
    { id: "server", label: "Server", complete: serverReady },
    { id: "github", label: "GitHub", complete: githubReady },
    { id: "organisation", label: "Organisation", complete: true },
    { id: "providers", label: "Providers", complete: status.engine.ready },
    {
      id: "repositories",
      label: "Repositories",
      complete: status.repos.length > 0,
    },
    { id: "members", label: "Members", complete: status.team.count > 0 },
    { id: "review", label: "Review", complete: requiredReady },
  ];

  return (
    <aside
      aria-labelledby="setup-summary-title" {...mergeStylexProps("", sx.desktopSticky, sx.desktopTop0, sx.desktopColStart2, sx.desktopRowStart1, sx.desktopMt0, sx.mt10)}
    >
      <h2
        id="setup-summary-title"
        {...stylex.props(sx.m0, sx.mb2, sx.px4, sx.fontSemibold, sx.textFaint, typography.label)}
      >
        Summary
      </h2>
      <SettingCard>
        {steps.map((step) => (
          <button
            key={step.id}
            type="button"
            onClick={() => onSelect(step.id)} {...mergeStylexProps("", sx.hoverBgHover, sx.focusRing, sx.flex, sx.wFull, sx.cursorPointer, sx.itemsCenter, sx.gap25, sx.px4, sx.py3, sx.textLeft)}
          >
            <span
              {...stylex.props(
                sx.statusIcon,
                step.complete ? sx.statusComplete : sx.statusIncomplete,
              )}
              aria-hidden="true"
            >
              <IconCheck size={14} />
            </span>
            <span
              {...stylex.props(
                sx.stepLabel,
                typography.label,
                step.complete ? sx.stepComplete : sx.stepIncomplete,
              )}
            >
              {step.label}
            </span>
            <span {...stylex.props(sx.srOnly)}>
              {step.complete ? ", complete" : ", needs setup"}
            </span>
          </button>
        ))}
      </SettingCard>
    </aside>
  );
}

function SetupPageSection({
  id,
  title,
  description,
  children,
  className,
}: {
  id: SectionId;
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={sectionAnchor(id)}
      className={cn(
        stylex.props(sx.scrollMt4, !className && sx.mt10).className,
        className,
      )}
    >      <div {...stylex.props(sx.mb3, sx.px5)}>
        <h2 {...stylex.props(sx.m0, sx.fontTitle, sx.tracking0015em, sx.textFg, typography.sectionTitle)}>
          {title}
        </h2>
        <p {...stylex.props(sx.m0, sx.mt15, sx.maxW62ch, sx.leadingRelaxed, sx.textDim, typography.supporting)}>
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

export function SetupPanel({
  onOpenOnboarding,
}: {
  onOpenOnboarding: () => void;
}) {
  const setup = useSetupStatus();
  const { status, failed, refetch } = setup;
  const [aiRevision, setAiRevision] = useState(0);

  useEffect(() => {
    document.title = docTitle("Setup");
    return () => {
      document.title = DEFAULT_DOC_TITLE;
    };
  }, []);

  async function refreshAi() {
    setAiRevision((revision) => revision + 1);
    await refetch();
  }

  return (
    <SettingsPanel {...mergeStylexProps("[&_input]:phone:text-input-phone", sx.relative, sx.maxW980px)}>
      <SettingsHeader
        title="Workspace setup"
        actions={
          <Button size="sm" onClick={onOpenOnboarding}>
            Open onboarding
          </Button>
        }
      />
      {!status ? (
        <LoadingState>
          {failed ? "Couldn't load setup status." : "Loading…"}
        </LoadingState>
      ) : (
        <div {...mergeStylexProps("", sx.desktopGridColsMinmax0720px220px, sx.desktopGap10, sx.grid, sx.itemsStart)}>
          <div {...mergeStylexProps("", sx.desktopColStart1, sx.desktopRowStart1, sx.minW0)}>
            <SetupPageSection
              id="server"
              title="Server access"
              description="Add a private app domain and a separate public address for signed webhooks."
              {...stylex.props(sx.mt0)}
            >
              <SetupServerAccess
                access={status.access}
                onSaved={setup.applyAccess}
              />
            </SetupPageSection>

            <SetupPageSection
              id="github"
              title="Connect GitHub"
              description="Give sessions access to repositories and pull requests."
            >
              <IntegrationsList
                integrations={status.integrations.filter(
                  (integration) => integration.id === "github",
                )}
                onSaved={setup.applyIntegration}
              />
            </SetupPageSection>

            <SetupPageSection
              id="organisation"
              title="Organisation"
              description="Your organisation's name and mark, and the names this instance and its agent use when they introduce themselves."
            >
              <OrganizationProfileSection />
            </SetupPageSection>

            <SetupPageSection
              id="providers"
              title="Providers"
              description="All providers available to runs, with the accounts connected to each one."
            >
              <ModelDefaultsSection key={aiRevision} />
              <ProviderAccountsSection onChanged={refreshAi} />
              <ModelProvidersPanel />
            </SetupPageSection>

            <SetupPageSection
              id="repositories"
              title="Add repositories"
              description="Register the repositories sessions can work in."
            >
              <ReposSection
                repos={status.repos}
                onChanged={refetch}
                onRepoUpdated={setup.applyRepo}
              />
            </SetupPageSection>

            <SetupPageSection
              id="members"
              title="Members"
              description="Everyone who uses this instance, so sessions and commits attribute to real people."
            >
              <TeamSection onChanged={refetch} />
            </SetupPageSection>

            <SetupPageSection
              id="review"
              title="Review"
              description="Everything this instance needs, and what each part is doing right now."
            >
              <SetupChecklist status={status} onChanged={refetch} />
            </SetupPageSection>
          </div>
          <SetupSummary status={status} onSelect={scrollToSection} />
        </div>
      )}
      <SetupRestart setup={setup} />
    </SettingsPanel>
  );
}
