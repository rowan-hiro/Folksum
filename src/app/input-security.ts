export function containsLikelyCredential(text: string): boolean {
	return /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/u.test(text);
}
