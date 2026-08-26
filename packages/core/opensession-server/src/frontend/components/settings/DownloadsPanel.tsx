import { useState } from "react";
import { Button } from "../../ui/button";
import { SettingsHeader, SettingsPanel } from "../../ui/settings";
import { IconChevronLeft } from "../icons";
import { DownloadAppsBody } from "../DownloadAppsDialog";

// ── Downloads: the same two app cards the account menu opens as a modal, shown
// inline so Settings has a permanent home for "how do I install this". ──
export function DownloadsPanel() {
	const [showInstallHelp, setShowInstallHelp] = useState(false);

	return (
		<SettingsPanel>
			<SettingsHeader
				title={showInstallHelp ? "Install the web app" : "Downloads"}
				description={
					showInstallHelp
						? "Add Open Session to your home screen or dock."
						: "Install Open Session on your Mac, or add the web app to your phone."
				}
				actions={
					showInstallHelp ? (
						<Button
							variant="soft"
							icon={<IconChevronLeft size={20} />}
							onClick={() => setShowInstallHelp(false)}
						>
							Back
						</Button>
					) : undefined
				}
			/>
			<div className="px-5">
				<DownloadAppsBody
					showInstallHelp={showInstallHelp}
					onShowInstallHelp={() => setShowInstallHelp(true)}
				/>
			</div>
		</SettingsPanel>
	);
}
