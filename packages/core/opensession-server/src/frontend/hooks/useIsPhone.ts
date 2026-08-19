import { useEffect, useState } from "react";

/** The app's phone breakpoint — matches the CSS page-stack media queries. */
const PHONE = "(max-width: 720px)";

/** Reactive "is this a phone-width viewport?" — components use it to swap in
 * phone-specific surfaces (bottom sheets) instead of desktop popups/pages. */
export function useIsPhone(): boolean {
	const [isPhone, setIsPhone] = useState(
		() => typeof window !== "undefined" && window.matchMedia(PHONE).matches,
	);
	useEffect(() => {
		const mq = window.matchMedia(PHONE);
		const onChange = () => setIsPhone(mq.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	return isPhone;
}
