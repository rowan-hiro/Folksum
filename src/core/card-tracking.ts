export const CARD_TRACKING_MODES = ["lightweight", "integrated"] as const;

export type CardTrackingMode = (typeof CARD_TRACKING_MODES)[number];

export function isCardTrackingMode(value: unknown): value is CardTrackingMode {
	return typeof value === "string" && CARD_TRACKING_MODES.includes(value as CardTrackingMode);
}
