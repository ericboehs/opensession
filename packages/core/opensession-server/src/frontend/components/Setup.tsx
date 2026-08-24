import React, { useEffect, useState } from "react";
import { useSetupStatus } from "../hooks/useSetupStatus";
import { DEFAULT_DOC_TITLE, docTitle } from "../lib/brand";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import {
  SettingCard,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsPanel,
} from "../ui/settings";
import { LoadingState } from "../ui/state";
import { EngineRow } from "./SetupChecklist";
import { IdentityCard } from "./SetupIdentity";
import { IntegrationsList } from "./SetupIntegrations";
import { ReposSection } from "./SetupRepos";
import { SetupRestart } from "./SetupRestart";
import { SetupServerAccess } from "./SetupServerAccess";
import {
  ClaudeAccountsSection,
  CodexAccountsSection,
} from "./settings/ModelAccounts";
import { ModelProvidersPanel } from "./ModelProviders";
import { ModelDefaultsSection } from "./Models";
import { IconCheck } from "./icons";
import {
  integrationState,
  publicUrlState,
  type SetupStatus,
} from "./setup-shared";

function SetupSummary({ status }: { status: SetupStatus }) {
  const github = status.integrations.find(
    (integration) => integration.id === "github",
  );
  const serverReady = publicUrlState(status.publicBaseUrl).tone === "on";
  const githubReady = !!github && integrationState(github).tone === "on";
  const requiredReady =
    serverReady && githubReady && status.engine.ready && status.repos.length > 0;
  const steps = [
    { label: "Server", complete: serverReady },
    { label: "GitHub", complete: githubReady },
    { label: "Identity", complete: true },
    { label: "AI", complete: status.engine.ready },
    { label: "Repositories", complete: status.repos.length > 0 },
    { label: "Review", complete: requiredReady },
  ];

  return (
    <aside
      aria-labelledby="setup-summary-title"
      className="mt-10 desktop:sticky desktop:top-0 desktop:col-start-2 desktop:row-start-1 desktop:mt-0"
    >
      <h2
        id="setup-summary-title"
        className="m-0 mb-2 px-4 text-label font-semibold text-faint"
      >
        Summary
      </h2>
      <SettingCard>
        {steps.map((step) => (
          <div key={step.label} className="flex items-center gap-2.5 px-4 py-3">
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full",
                step.complete ? "bg-green-soft text-green" : "bg-hover text-faint",
              )}
              aria-hidden="true"
            >
              <IconCheck size={14} />
            </span>
            <span
              className={cn(
                "min-w-0 text-label",
                step.complete ? "font-medium text-fg" : "text-dim",
              )}
            >
              {step.label}
            </span>
            <span className="sr-only">
              {step.complete ? ", complete" : ", needs setup"}
            </span>
          </div>
        ))}
      </SettingCard>
    </aside>
  );
}

function SetupPageSection({
  title,
  description,
  children,
  className = "mt-10",
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-3 px-5">
        <h2 className="m-0 text-section-title font-title tracking-[-0.015em] text-fg">
          {title}
        </h2>
        <p className="m-0 mt-1.5 max-w-[62ch] text-supporting leading-relaxed text-dim">
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
    <SettingsPanel className="relative max-w-[980px] [&_input]:phone:text-input-phone">
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
        <div className="grid items-start desktop:grid-cols-[minmax(0,720px)_220px] desktop:gap-10">
          <div className="min-w-0 desktop:col-start-1 desktop:row-start-1">
            <SetupPageSection
              title="Server access"
              description="Add a private app domain and a separate public address for signed webhooks."
              className="mt-0"
            >
              <SetupServerAccess
                access={status.access}
                onSaved={setup.applyAccess}
              />
            </SetupPageSection>

            <SetupPageSection
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
              title="Name your instance"
              description="Choose the names this instance and its agent use when they introduce themselves."
            >
              <IdentityCard />
            </SetupPageSection>

            <SetupPageSection
              title="Choose your AI"
              description="Connect Claude, OpenAI Codex, or another provider with an API key."
            >
              <ModelDefaultsSection key={aiRevision} />
              <SettingsGroupLabel>Engine</SettingsGroupLabel>
              <SettingCard>
                <EngineRow engine={status.engine} onChanged={refetch} />
              </SettingCard>
              <ClaudeAccountsSection compact onChanged={refreshAi} />
              <CodexAccountsSection compact onChanged={refreshAi} />
              <ModelProvidersPanel />
            </SetupPageSection>

            <SetupPageSection
              title="Add repositories"
              description="Register the repositories sessions can work in."
            >
              <ReposSection repos={status.repos} onChanged={refetch} />
            </SetupPageSection>
          </div>
          <SetupSummary status={status} />
        </div>
      )}
      <SetupRestart setup={setup} />
    </SettingsPanel>
  );
}
