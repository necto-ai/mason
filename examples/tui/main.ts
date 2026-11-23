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

tui.addChild(transcript);
tui.addChild(editor);
tui.setFocus(editor);

function plain(message: Message | undefined): string {
	if (message === undefined || !("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => ("text" in part ? part.text : "")).join("");
}

function show(entry: EntryRecord): void {
	if (UserEntry.is(entry)) transcript.addChild(new UserMessageComponent(plain(entry.model?.[0]), getMarkdownTheme()));
	else if (AssistantEntry.is(entry))
		transcript.addChild(
			new AssistantMessageComponent(entry.model?.[0] as AssistantMessage, false, getMarkdownTheme()),
		);
}

const model = `${settings.provider}/${settings.model}`;
transcript.addChild(new Text(`mason · ${model} · thinking ${settings.thinking} · ctrl+c to quit`, 1, 0));
for (const entry of await agent.entries(50)) show(entry);

let busy = false;
editor.onSubmit = async (input) => {
	const text = input.trim();
	if (text === "" || busy) return;
	busy = true;
	editor.disableSubmit = true;
	editor.setText("");
	editor.addToHistory(text);
	transcript.addChild(new UserMessageComponent(text, getMarkdownTheme()));
	tui.requestRender();
	try {
		const turn = await agent.prompt(text);
		if (turn.message !== undefined)
			transcript.addChild(new AssistantMessageComponent(turn.message, false, getMarkdownTheme()));
		else transcript.addChild(new Text(`(${turn.status})`, 1, 0));
	} catch (error) {
		transcript.addChild(new Text(error instanceof Error ? error.message : String(error), 1, 0));
	} finally {
		busy = false;
		editor.disableSubmit = false;
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
