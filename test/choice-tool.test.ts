import assert from "node:assert/strict";
import test from "node:test";

import { createUserChoiceTool, type PiChoiceRequest } from "../src/runtime/pi/choice-tool.ts";

test("emits one bounded channel-neutral choice request and terminates the model turn", async () => {
	const requests: PiChoiceRequest[] = [];
	const tool = createUserChoiceTool((request) => requests.push(request));
	const result = await tool.execute("call-1", {
		prompt: " Which Visa card? ",
		options: [
			{ value: "visa-a", label: "Visa A" },
			{ value: "visa-b", label: "Visa B", description: "Joint card" },
		],
	});

	assert.equal(tool.name, "request_user_choice");
	assert.equal(result.terminate, true);
	assert.equal(result.details?.status, "choice_required");
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.prompt, "Which Visa card?");
	assert.deepEqual(requests[0]?.options, [
		{ value: "visa-a", label: "Visa A" },
		{ value: "visa-b", label: "Visa B", description: "Joint card" },
	]);
});

test("rejects duplicate values and choice lists outside the supported bounds", async () => {
	const tool = createUserChoiceTool(() => undefined);
	await assert.rejects(
		tool.execute("call-1", {
			prompt: "Choose",
			options: [
				{ value: "same", label: "First" },
				{ value: "same", label: "Second" },
			],
		}),
		/values must be unique/,
	);
	await assert.rejects(
		tool.execute("call-2", { prompt: "Choose", options: [{ value: "one", label: "Only" }] }),
		/2 to 6 options/,
	);
});
