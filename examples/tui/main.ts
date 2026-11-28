import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	getSelectListTheme,
	initTheme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Editor, matchesKey, ProcessTerminal, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { AssistantEntry, createAgent, type EntryRecord, UserEntry } from "../../package/index.ts";

initTheme();
const { agent, settings } = await createAgent({
	home: process.env.MASON_HOME ?? join(homedir(), ".mason", "tui"),
});

const tui = new TuiMainScreen(new ProcessTerminal());
const transcript = new Container();
const editor = new Editor(tui, {
	borderColor: (line) => line,
	selectList: getSelectListTheme(),
});

const model = `${settings.provider}/${settings.model}`;
const status = new Text("", 1, 0);
const submissionError = new Text("", 1, 0);
tui.addChild(new Text(`mason · ${model} · thinking ${settings.thinking} · ctrl+c to quit`, 1, 0));
tui.addChild(transcript);
tui.addChild(status);
tui.addChild(submissionError);
tui.addChild(editor);
tui.setFocus(editor);

function plain(message: Message | undefined): string {
	if (message === undefined || !("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => ("text" in part ? part.text : "")).join("");
}

function show(entry: EntryRecord): void {
	if (entry.kind === "mason.service-events") transcript.addChild(new Text(plain(entry.model?.[0]), 1, 0));
	else if (UserEntry.is(entry))
		transcript.addChild(new UserMessageComponent(plain(entry.model?.[0]), getMarkdownTheme()));
	else if (AssistantEntry.is(entry))
		transcript.addChild(
			new AssistantMessageComponent(entry.model?.[0] as AssistantMessage, false, getMarkdownTheme()),
		);
}

const watch = await agent.watch();
let shown: readonly EntryRecord[] | undefined;
function render(view: typeof watch.value): void {
	if (shown !== view.entries) {
		shown = view.entries;
		transcript.clear();
		for (const entry of shown) show(entry);
	}
	const live = view.docs["pi.live"];
	const queued = view.docs["pi.inbox"]?.items.length ?? 0;
	const tool = live?.tools?.find((slot) => slot.status === "running");
	const state = live?.compactions?.length ? "compacting" : (tool?.name ?? (live?.run ? "working" : "idle"));
	const failure = live?.runFailure;
	status.setText(
		`${state}${queued ? ` · ${queued} queued` : ""}${failure ? ` · ${failure.detail ?? failure.reason}` : ""}`,
	);
	tui.requestRender();
}
render(watch.value);
watch.start(async (call) => {
	if (call.kind === "value") render(call.value);
	else {
		status.setText(`watch: ${String(call.error)}`);
		tui.requestRender();
	}
});

editor.onSubmit = async (input) => {
	const text = input.trim();
	if (text === "") return;
	editor.setText("");
	editor.addToHistory(text);
	submissionError.setText("");
	try {
		await agent.submit(text, "followUp");
	} catch (error) {
		submissionError.setText(String(error));
		tui.requestRender();
	}
};

tui.addInputListener((data) => {
	if (!matchesKey(data, "ctrl+c")) return undefined;
	tui.stop();
	void agent.close().then(() => process.exit(0));
	return { consume: true };
});

tui.start();
