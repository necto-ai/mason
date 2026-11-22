import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type ConnectorStore, createUserClient, nodeWebSocketLink, type StoreEntry } from "mason-client";
import { CONTROL_OPS, type ControlOp } from "mason-protocol";
import { writeFileAtomic } from "../src/server/atomic.ts";
import { UP } from "../src/server/command-line.ts";
import type { ConnectorGrant } from "../src/server/connectors.ts";
import { mintConnectorCredential } from "../src/server/connectors.ts";
import { type HousePaths, housePaths } from "../src/server/house.ts";
import { readIntegrations, secondUserGrantNote, writeIntegration } from "../src/server/integrations.ts";

export const CONSOLE = "console";

export const CONSOLE_DESCRIPTION = "The terminal, built in: talk to the bot with no Telegram at all";

const OWNER = "local";
const TERMINAL = "terminal";

export function consoleGrant(): ConnectorGrant {
	return {
		user: { owner: OWNER },
		commands: [...CONTROL_OPS],
	};
}

export async function ensureConsole(paths: HousePaths): Promise<boolean> {
	const { integrations } = await readIntegrations(paths);
	const existing = integrations[CONSOLE];
	if (existing?.connector !== undefined) return false;
	await writeIntegration(paths, CONSOLE, {
		...existing,
		enabled: true,
		description: existing?.description ?? CONSOLE_DESCRIPTION,
		connector: consoleGrant(),
	});
	return true;
}

export async function secondUserGrantAdvice(paths: HousePaths): Promise<string | undefined> {
	return secondUserGrantNote((await readIntegrations(paths)).integrations);
}

export interface ChatArgs {
	readonly once?: string;
	readonly url?: string;
	readonly help: boolean;
}

export function usage(): string {
	return `usage: mason chat [flags]

  Talk to the bot from this terminal. The console connector is built in: it opens the same socket every other connector
  opens, so this proves the wire a Telegram bot uses without a Telegram bot.

  --once "text"   send one message, print the answer, exit
  --url <ws-url>  connect somewhere other than ws://127.0.0.1:$PORT/api/connector
  --help          this

  In a conversation, /stop /status /compact /clear are the connector's controls, and /exit or ctrl-d quits.`;
}

export function parseChatArgs(argv: readonly string[]): ChatArgs {
	let once: string | undefined;
	let url: string | undefined;
	let help = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const flag = equals === -1 ? arg : arg.slice(0, equals);
		const inline = equals === -1 ? undefined : arg.slice(equals + 1);
		const value = (): string => {
			if (inline !== undefined) return inline;
			const next = argv[index + 1];
			if (next === undefined) throw new Error(`${flag} needs a value`);
			index += 1;
			return next;
		};
		if (flag === "--once") once = value();
		else if (flag === "--url") url = value();
		else if (flag === "--help" || flag === "-h") help = true;
		else throw new Error(`unknown argument ${arg}; \`mason chat --help\` lists the flags`);
	}
	return { ...(once === undefined ? {} : { once }), ...(url === undefined ? {} : { url }), help };
}

function fileStore(path: string): ConnectorStore {
	type Bucket = Record<string, StoreEntry<unknown>>;
	let cache: Record<string, Bucket> | undefined;
	const load = async (): Promise<Record<string, Bucket>> => {
		if (cache !== undefined) return cache;
		const text = await readFile(path, "utf8").catch(() => "{}");
		const parsed: unknown = JSON.parse(text);
		cache =
			typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? (parsed as Record<string, Bucket>)
				: {};
		return cache;
	};
	const bucket = async (namespace: string): Promise<Bucket> => {
		const data = await load();
		data[namespace] ??= {};
		return data[namespace];
	};
	let writing = Promise.resolve();
	const save = (): Promise<void> => {
		writing = writing.then(async () => writeFileAtomic(path, await load()));
		return writing;
	};
	return {
		kind: "file",
		async close() {},
		async read<T>(namespace: string, key: string): Promise<T | undefined> {
			return (await bucket(namespace))[key]?.value as T | undefined;
		},
		async write<T>(namespace: string, key: string, value: T): Promise<void> {
			(await bucket(namespace))[key] = { key, value, at: Date.now() };
			await save();
		},
		async delete(namespace: string, key: string): Promise<void> {
			delete (await bucket(namespace))[key];
			await save();
		},
		async entries<T>(namespace: string): Promise<ReadonlyArray<StoreEntry<T>>> {
			return Object.values(await bucket(namespace))
				.sort((left, right) => left.at - right.at)
				.map((entry) => entry as StoreEntry<T>);
		},
		async prune(namespace: string, keep: number): Promise<void> {
			const all = Object.values(await bucket(namespace)).sort((left, right) => left.at - right.at);
			if (all.length <= keep) return;
			const data = await load();
			data[namespace] = Object.fromEntries(all.slice(all.length - keep).map((entry) => [entry.key, entry]));
			await save();
		},
	};
}

function socketUrl(url: string | undefined): string {
	return url ?? `ws://127.0.0.1:${process.env.PORT ?? 8787}/api/connector`;
}

const dim = (text: string): string => `\x1b[2m${text}\x1b[22m`;

export async function runChat(argv: readonly string[]): Promise<number> {
	let args: ChatArgs;
	try {
		args = parseChatArgs(argv);
	} catch (error) {
		console.error(`[chat] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	if (args.help) {
		console.log(usage());
		return 0;
	}

	let paths: HousePaths;
	try {
		paths = housePaths();
		if (await ensureConsole(paths)) {
			console.log(dim(`[chat] granted the built-in "${CONSOLE}" connector in ${paths.integrations}`));
			const note = await secondUserGrantAdvice(paths);
			if (note !== undefined) console.log(dim(`[chat] ${note}`));
		}
	} catch (error) {
		console.error(`[chat] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}

	const issued = await mintConnectorCredential(paths.home, CONSOLE, { replace: true }).catch((error: unknown) => {
		console.error(
			`[chat] cannot mint a credential for "${CONSOLE}": ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	});
	if (issued === undefined) return 1;

	let delivered: ((text: string) => void) | undefined;
	let closed: ((reason: string) => void) | undefined;
	let connected = false;
	const seen = new Set<string>();
	let first = true;
	const connector = createUserClient({
		name: CONSOLE,
		version: "0.2.0",
		url: socketUrl(args.url),
		credential: issued.credential,
		store: fileStore(join(paths.serviceDir, "console-ledger.json")),
		link: nodeWebSocketLink(WebSocket as never),
	});
	connector.onSession(() => {
		connected = true;
		if (args.once === undefined) console.log(dim("[chat] connected. type a message; /help lists the controls\n"));
	});
	connector.onClosed((reason) => {
		if (args.once === undefined) console.log(dim(`[chat] socket closed: ${reason}`));
		if (!connected) {
			closed?.(reason);
			closed = undefined;
		}
	});
	connector.onConversation((state) => {
		for (const row of state.transcript) {
			if (row.kind !== "delivered" || row.streaming === true) continue;
			if (seen.has(row.id)) continue;
			seen.add(row.id);
			if (first) continue;
			if (args.once !== undefined) {
				console.log(row.text);
				delivered?.(row.text);
				delivered = undefined;
			} else {
				console.log(`\nmason: ${row.text}\n`);
			}
		}
		first = false;
	});

	try {
		await connector.start();
	} catch (error) {
		console.error(
			`[chat] cannot open ${socketUrl(args.url)}: ${error instanceof Error ? error.message : String(error)}`,
		);
		console.error(`[chat] if mason is not running, start it with \`${UP}\`.`);
		await connector.stop().catch(() => {});
		return 1;
	}

	if (args.once !== undefined) {
		let settle: (text: string) => void = () => {};
		const reply = new Promise<string>((resolve) => {
			delivered = resolve;
			settle = resolve;
		});
		const lost = new Promise<string>((resolve) => {
			closed = (reason) => resolve(reason === "" ? "the socket closed" : reason);
		});
		const deadline = setTimeout(() => {
			console.error("[chat] no answer in 120 s");
			settle("");
		}, 120_000);
		const outcome = await connector
			.submit({
				appendId: `chat-${Date.now()}-once`,
				origin: { ref: TERMINAL, actor: { id: OWNER, name: "you" } },
				content: [{ type: "text", text: args.once }],
				mode: "followUp",
			})
			.catch((error: unknown) => ({
				status: "refused" as const,
				id: "",
				code: "mason.internal",
				reason: String(error),
			}));
		if (outcome.status === "refused") {
			clearTimeout(deadline);
			console.error(`[chat] mason refused the message: ${outcome.reason}`);
			await connector.stop().catch(() => {});
			return 1;
		}
		const text = await Promise.race([
			reply,
			lost.then((reason) => {
				console.error(`[chat] cannot open ${socketUrl(args.url)}: ${reason}`);
				console.error(`[chat] if mason is not running, start it with \`${UP}\`.`);
				return "";
			}),
		]);
		clearTimeout(deadline);
		await connector.stop().catch(() => {});
		return text === "" ? 1 : 0;
	}

	const lines = createInterface({ input: process.stdin, output: process.stdout });
	let counter = 0;
	const prompt = (): void => {
		process.stdout.write("you: ");
	};
	try {
		prompt();
		for await (const raw of lines) {
			const text = raw.trim();
			if (text === "/exit" || text === "/quit") break;
			if (text !== "") {
				if (text.startsWith("/")) {
					const op = text.slice(1).split(/\s+/)[0] ?? "";
					if (!CONTROL_OPS.includes(op as ControlOp)) {
						const help = op === "help" ? "/stop /status /compact /clear, /exit" : `${op} is not a control`;
						console.log(dim(`[chat] ${help}`));
					} else {
						counter += 1;
						const instructions = op === "compact" ? text.slice(1 + op.length).trim() : "";
						const answer = await connector
							.control({
								op: op as ControlOp,
								requestId: `c${counter}`,
								...(instructions === "" ? {} : { instructions }),
							})
							.catch((error: unknown) => ({ handled: false, reply: String(error) }));
						console.log(
							dim(
								`[${op}] ${answer.handled ? "handled" : "refused"}${answer.reply === undefined ? "" : `: ${answer.reply}`}`,
							),
						);
					}
				} else {
					counter += 1;
					const outcome = await connector
						.submit({
							appendId: `chat-${Date.now()}-${counter}`,
							origin: { ref: TERMINAL },
							content: [{ type: "text", text }],
							mode: "followUp",
						})
						.catch((error: unknown) => ({
							status: "refused" as const,
							id: "",
							code: "mason.internal",
							reason: String(error),
						}));
					if (outcome.status === "refused") console.log(dim(`[chat] refused: ${outcome.reason}`));
				}
			}
			prompt();
		}
	} finally {
		lines.close();
		await connector.stop().catch(() => {});
	}
	return 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await runChat(process.argv.slice(2)));
}
