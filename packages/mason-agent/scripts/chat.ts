/**
 * `mason chat` — the console connector, and the reason a person with no Telegram can still talk to their bot.
 *
 * The console is a connector like any other: it opens the one socket at `/api/connector`, presents a credential, and
 * reads the agent's replies as rows of the conversation, with the same streaming and the same controls as any other
 * connector. It is built in rather than published because there is nothing to install — `mason chat` is the process —
 * and because it proves the wire a first run has to prove. The developer adapter is where this ends in v0 (#201,
 * Gate 2 reviewed the decision): the sliding rule is one person, one surface, and this one is a terminal.
 *
 * It mints its own credential, and rotates it on every run. That is not carelessness: mason keeps only a hash, so a
 * credential that already exists cannot be printed again, and a terminal that could not open its own socket would need
 * the person to paste a secret before they had said a word. `replace: true` means there is exactly one live console
 * credential at a time, and the one a previous run held stops working — which is the right answer for a door that is
 * this terminal.
 *
 * The entry itself is written here if it is missing, so `mason chat` works on a home that was made by hand. That write
 * goes through the same `writeIntegration` the boot reads, so a grant that could not be served fails here rather than at
 * the next start. The write also names the home it just made when it leaves two enabled connectors holding a person's
 * words, which the boot refuses: writing it silently would leave `mason up` as the first to say the rule. The refusal
 * itself stays the boot's, as it does for every writer.
 */

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

/** The built-in entry's name. It is also the name the connector says in its hello, and mason refuses a mismatch. */
export const CONSOLE = "console";

/** The one line the model is told about this entry. It carries no MCP server, so nothing reads it yet — a person does. */
export const CONSOLE_DESCRIPTION = "The terminal, built in: talk to the bot with no Telegram at all";

/** The actor the console serves, and the address it mints on every append: the append's provenance. */
const OWNER = "local";
const TERMINAL = "terminal";

/** What the console is granted: the owner's words and every control the protocol has. */
export function consoleGrant(): ConnectorGrant {
	return {
		user: { owner: OWNER },
		commands: [...CONTROL_OPS],
	};
}

/**
 * Writes the console entry if the home does not have it, and leaves it alone if it does.
 *
 * A home that already granted `console` keeps its own grant: the entry is a permission, and a command that silently
 * widened one would be the thing AGENTS rule 8 exists against. `false` says the entry was already there as granted.
 *
 * The one thing the write says out loud is the home it may have just made unstartable: the boot allows one enabled
 * connector holding a person's words (`assertOneUserGrant`), and on a home whose user face is another connector this
 * grant is the second. The caller prints that note after its own "granted" line, so the output tells the write and
 * then the state the write made. `test/chat.test.ts` pins the line.
 */
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

/** The home a just-made console grant may have made unstartable, in the rule's one sentence; undefined says it is fine. */
export async function secondUserGrantAdvice(paths: HousePaths): Promise<string | undefined> {
	return secondUserGrantNote((await readIntegrations(paths)).integrations);
}

export interface ChatArgs {
	/** One question, one answer, then exit: what a test and a pipe use. */
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

/**
 * The console's journal, on disk.
 *
 * The SDK's own documentation is blunt about this: a store that cannot survive a restart is not a store, which is why the
 * in-memory one is named for what it is. A terminal is exactly the process that goes away without warning — ctrl-c, a
 * closed window, a `--once` run — and a call placed before the link dropped is replayed from the journal rather than
 * placed a second time. So the journal is a file: `service/console-ledger.json`, whole-file writes through the same
 * atomic writer the rest of the service half uses.
 */
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
	// Whole-file writes, one at a time: two of them interleaved would leave the file holding the newer one's bytes under
	// the older one's length. The SDK writes a journal entry and a settled key in the same turn, so this is not a
	// hypothetical.
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

/**
 * The command. Returns an exit code rather than calling `process.exit`, so a test can drive `--once` in-process and
 * `--chat` from setup can call it without a second process.
 *
 * The journal is a file under the service half (`fileStore`): it exists precisely so a call survives a *process*
 * restart, and a terminal is the process that ends without warning.
 */
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

	// One credential, rotated: mason keeps only the hash, so this is the only way to hold the plaintext of the door this
	// process is. The previous run's stops working at the next connection.
	const issued = await mintConnectorCredential(paths.home, CONSOLE, { replace: true }).catch((error: unknown) => {
		console.error(
			`[chat] cannot mint a credential for "${CONSOLE}": ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	});
	if (issued === undefined) return 1;

	let delivered: ((text: string) => void) | undefined;
	/** Set while a `--once` run waits: a socket that closes before it was ever open is mason not running, not a resend. */
	let closed: ((reason: string) => void) | undefined;
	let connected = false;
	/**
	 * The rows this run has already accounted for. The first frame is the conversation as it stands — what happened
	 * before this terminal opened — so its rows are marked and nothing is printed for them.
	 */
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
		// The SDK reconnects on its own, and it should: a socket that drops mid-conversation has a person waiting.
		// A one-shot command has nobody waiting, so it says what is wrong instead of retrying in the dark.
		if (!connected) {
			closed?.(reason);
			closed = undefined;
		}
	});
	connector.onConversation((state) => {
		for (const row of state.transcript) {
			// A row still being written is not the answer yet: the committed row is the message, under the same id.
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
		// A deadline, so a wrong url or a refused submission does not hold the command forever: a pipe has no ctrl-c.
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

	// The lines are an async iterator rather than `question()` per turn: a person typing while the bot answers must not
	// lose what they typed, and readline drops a line that arrives with no question waiting for it.
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
						// The whole line after the op is the instruction `/compact` takes and nothing else accepts; passing
						// it always would have the server refuse `/stop now please`, which is a word a person types.
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
