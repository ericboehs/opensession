import * as React from "react";

type PopupEntry = {
	close: () => void;
};

type PopupGroup = {
	activate: (entry: PopupEntry) => void;
	deactivate: (entry: PopupEntry) => void;
};

const PopupGroupContext = React.createContext<PopupGroup | null>(null);

export function ExclusivePopupProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const activeRef = React.useRef<PopupEntry | null>(null);
	const group = React.useMemo<PopupGroup>(
		() => ({
			activate(entry) {
				const previous = activeRef.current;
				activeRef.current = entry;
				if (previous !== entry) previous?.close();
			},
			deactivate(entry) {
				if (activeRef.current === entry) activeRef.current = null;
			},
		}),
		[],
	);

	return (
		<PopupGroupContext.Provider value={group}>
			{children}
		</PopupGroupContext.Provider>
	);
}

export function useExclusivePopup(entry: PopupEntry) {
	const group = React.useContext(PopupGroupContext);

	React.useEffect(() => () => group?.deactivate(entry), [entry, group]);

	return group;
}
