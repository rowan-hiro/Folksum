export type ChannelKind = "telegram" | "web" | "cli" | "scheduler";
export type HouseholdRole = "owner" | "member" | "viewer";

export interface IdentityScope {
	householdId: string;
	actorId: string;
	sessionId: string;
	channel: ChannelKind;
	role: HouseholdRole;
	timezone: string;
}

export interface HouseholdMember {
	id: string;
	householdId: string;
	displayName: string;
	role: HouseholdRole;
	timezone: string;
	createdAt: string;
}
