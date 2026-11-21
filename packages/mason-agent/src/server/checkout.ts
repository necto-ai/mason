/**
 * The device's checkout: the host's memory, carried across the channel as git bundles.
 *
 * ADR-0002's mount is gone. A device holds `~/agent`, a checkout of the host's repository, and the host holds the
 * repository no tool mounts. Git is the sync protocol because it already knows how to send history, and a bundle is
 * bytes: the frames pi-env carries, not a second ssh credential pointed back at the host (which would restore the
 * credential the split removed).
 *
 * A turn is one sync in each direction. `pull` runs before the first request: the host's tip is fetched into the
 * checkout and hard-reset, so the guest starts from what the host accepted. `accept` runs when the turn answers: the
 * checkout's commits are bundled back, the host validates the incoming memory (`memory-check.ts`) and fast-forwards.
 * Two sides may author history — the agent in the checkout, the person on the host — so a host that moved during the
 * turn leaves the guest's commits on a ref and the next pull merges them: one history, the person's intent kept.
 *
 * A lost device throws `DeviceLostError` and is never retried: a mutation whose outcome is unknown cannot be replayed.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { defineExtension, type Extension, GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { deviceLost, isDeviceLost } from "./env.ts";
import { CREATED_BRANCH } from "./house.ts";
import { checkIncoming } from "./memory-check.ts";

const run = promisify(execFile);

/** The extension's name, as the surface document renders it. */
export const CHECKOUT_EXTENSION_NAME = "checkout";

/** What a pull did to the checkout. */
export type PullResult =
	| { readonly status: "pulled" }
	| { readonly status: "unchanged" }
	| { readonly status: "diverged"; readonly detail: string }
	| { readonly status: "conflicted"; readonly detail: string }
	| { readonly status: "blocked"; readonly detail: string }
	| { readonly status: "lost"; readonly detail: string };

/** What an accept did with the checkout's commits. */
export type AcceptResult =
	| { readonly status: "accepted"; readonly commits: number }
	| { readonly status: "up-to-date" }
	| { readonly status: "rejected"; readonly problems: readonly string[] }
	| { readonly status: "diverged"; readonly detail: string }
	| { readonly status: "blocked"; readonly detail: string }
	| { readonly status: "lost"; readonly detail: string };

export interface CheckoutOptions {
	/** The host's repository: the durable memory, and the ref a pull starts from. */
	readonly host: string;
	/** The checkout on the device, `~/agent`. */
	readonly deviceAgentDir: string;
	/** The branch both sides commit to. */
	readonly branch: string;
	/** `false` for a local run: the tools already write the host's own tree, and there is nothing to carry. */
	readonly enabled?: boolean;
	readonly onLog?: (line: string) => void;
}

/**
 * The host's current branch, or `CREATED_BRANCH` for a host mason made whose `HEAD` names no branch at all.
 *
 * The name comes from the repository, never from the machine: a repository mason created is `CREATED_BRANCH` by
 * construction (`house.ts`), and one it adopted keeps the person's branch — `master` included, because renaming a
 * history nobody asked mason to touch is not a sync.
 *
 * A detached `HEAD` is refused rather than guessed: a checkout follows a branch, and fast-forwarding a detached host
 * would move a commit no branch names. An empty repository is a first boot, not an error.
 */
export async function hostBranch(host: string): Promise<string> {
	try {
		const { stdout } = await run("git", ["-C", host, "symbolic-ref", "--short", "HEAD"]);
		const branch = stdout.trim();
		return branch === "" ? CREATED_BRANCH : branch;
	} catch {
		try {
			await run("git", ["-C", host, "rev-parse", "--verify", "--quiet", "HEAD"]);
		} catch {
			return CREATED_BRANCH;
		}
		throw new Error(
			`${host} is a detached HEAD: check out a branch before starting; a checkout follows a branch, not a commit`,
		);
	}
}

interface GuestRun {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** The host-side refusal a detached `HEAD` gets mid-run, matching `hostBranch`'s boot refusal. */
const DETACHED_HOST = "The host's agent/ is a detached HEAD. Check out a branch there before the next turn.";

/** A failure as one line, for a status the model or the log reads. */
function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One host git command, with its output. */
async function hostGit(host: string, args: readonly string[]): Promise<string> {
	const { stdout } = await run("git", ["-C", host, ...args], { maxBuffer: 32 * 1024 * 1024 });
	return stdout;
}

export class Checkout {
	readonly #host: string;
	readonly #deviceAgentDir: string;
	readonly #branch: string;
	readonly #enabled: boolean;
	readonly #onLog: (line: string) => void;
	/** One sync at a time on one host: two conversations share the repository and its index. */
	#queue: Promise<unknown> = Promise.resolve();

	constructor(options: CheckoutOptions) {
		this.#host = options.host;
		this.#deviceAgentDir = options.deviceAgentDir;
		this.#branch = options.branch;
		this.#enabled = options.enabled ?? true;
		this.#onLog = options.onLog ?? (() => {});
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	/** Run `sync` after every earlier one, whether that one succeeded or failed. */
	async #serialize<T>(sync: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(sync, sync);
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** The device home: `~/agent`'s parent. */
	get #deviceHome(): string {
		return dirname(this.#deviceAgentDir);
	}

	/**
	 * A sync failure is a named result, not a throw.
	 *
	 * `beforeRequest` can name it in the request, and `onYield`/`afterRun` can leave the answer already committed: a
	 * throw here would become an `extension_error` after the person's message, which is the unnamed failure the issue
	 * is about. A dropped device is `lost`; every other failure is `blocked` and says what the host or the checkout
	 * refused.
	 */
	async #named<T extends PullResult | AcceptResult>(sync: Promise<T>): Promise<T> {
		try {
			return await sync;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.#onLog(`[checkout] ${detail}`);
			return { status: isDeviceLost(error) ? "lost" : "blocked", detail } as T;
		}
	}

	/** One git command in the checkout, its exit code and its streams. */
	async #git(env: ExecutionEnv, args: readonly string[], context: Context): Promise<GuestRun> {
		let stdout = "";
		let stderr = "";
		const result = await env.exec(
			["git", "-C", this.#deviceAgentDir, ...args],
			{
				onOutput: (text, _context, info) => {
					if (info.stream === "stdout") stdout += text;
					else stderr += text;
				},
			},
			context,
		);
		if (!result.ok) {
			if (isDeviceLost(result.error)) throw deviceLost(result.error);
			throw new Error(`checkout: git ${args.join(" ")} could not run: ${result.error.message}`);
		}
		return { code: result.value.exitCode, stdout, stderr };
	}

	/** A git command that must succeed, or the sentence naming what failed. */
	async #must(env: ExecutionEnv, args: readonly string[], context: Context): Promise<GuestRun> {
		const result = await this.#git(env, args, context);
		if (result.code !== 0) {
			throw new Error(`checkout: git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
		}
		return result;
	}

	/**
	 * Carry the host's tip into the checkout.
	 *
	 * A first pull initialises the checkout and resets it to the host's tip. A later pull hard-resets when the guest has
	 * nothing the host lacks, leaves a guest that is ahead alone, and merges when both sides committed: the merge is
	 * where a person's mid-turn edit becomes one history, and a conflict is the model's to resolve.
	 */
	async pull(env: ExecutionEnv, context: Context): Promise<PullResult> {
		if (!this.#enabled) return { status: "unchanged" };
		return this.#serialize(() => this.#named(this.#pull(env, context)));
	}

	async #pull(env: ExecutionEnv, context: Context): Promise<PullResult> {
		const hostRef = await this.#hostBranchRef();
		if (hostRef === undefined) return { status: "blocked", detail: DETACHED_HOST };
		try {
			await this.#commitHostEdits();
		} catch (error) {
			return { status: "blocked", detail: `the host could not commit the person's edit: ${reason(error)}` };
		}
		// A pull before every model request would ship a bundle each round. The prompt's own prepare already pulled, so
		// an equal head is the common case: answer it from two `rev-parse`s.
		const hostHead = await hostGit(this.#host, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => undefined);
		// An unborn host has no bytes to carry: `ensureRepository` commits the first tree, and a repository whose first
		// commit never landed is repaired by the next person's edit, not by refusing every turn.
		if (hostHead === undefined) return { status: "unchanged" };
		// A device that lost its accept keeps its last turn's writes dirty. Commit them before comparing heads: a commit
		// is the only thing a bundle can carry, and a `reset --hard` below would otherwise discard the writes silently.
		await this.#commitGuestEdits(env, context);
		const guestHead = await this.#git(env, ["rev-parse", "--verify", "--quiet", "HEAD"], context);
		if (guestHead.code === 0 && guestHead.stdout.trim() === hostHead.trim()) return { status: "unchanged" };
		let bundle: Uint8Array;
		try {
			bundle = await this.#hostBundle();
		} catch (error) {
			return { status: "blocked", detail: `the host could not bundle its memory: ${reason(error)}` };
		}
		const incoming = join(this.#deviceHome, `.checkout-incoming-${randomUUID()}.bundle`);
		const created = await env.createDir(this.#deviceAgentDir, { recursive: true }, context);
		if (!created.ok) {
			if (isDeviceLost(created.error)) throw deviceLost(created.error);
			throw new Error(`checkout: cannot create ${this.#deviceAgentDir}: ${created.error.message}`);
		}
		try {
			await this.#writeBundle(env, incoming, bundle, context);
			const repo = await this.#git(env, ["rev-parse", "--git-dir"], context);
			if (repo.code !== 0) await this.#must(env, ["init", "--quiet"], context);
			// The device has no global git config, and a commit without an identity fails: set it on every pull, because a
			// checkout a person cloned by hand has the repository but not the identity.
			await this.#identity(env, context);
			await this.#must(
				env,
				["fetch", "--quiet", "--force", incoming, "+refs/heads/*:refs/remotes/mason/*"],
				context,
			);
			const remote = `refs/remotes/mason/${this.#branch}`;
			const head = await this.#git(env, ["rev-parse", "--verify", "--quiet", "HEAD"], context);
			if (head.code !== 0) {
				await this.#must(env, ["checkout", "--quiet", "-B", this.#branch, remote], context);
				this.#onLog(`[checkout] checked out ${remote} at ${this.#deviceAgentDir}`);
				return { status: "pulled" };
			}
			// The checkout is the same commit the host has: nothing to do, and `reset --hard` would only touch mtimes.
			const headSha = (await this.#must(env, ["rev-parse", "HEAD"], context)).stdout.trim();
			const remoteSha = (await this.#must(env, ["rev-parse", remote], context)).stdout.trim();
			if (headSha === remoteSha) return { status: "unchanged" };
			const headIsOld = await this.#git(env, ["merge-base", "--is-ancestor", "HEAD", remote], context);
			if (headIsOld.code === 0) {
				await this.#must(env, ["reset", "--quiet", "--hard", remote], context);
				this.#onLog(`[checkout] the checkout follows the host to ${remoteSha.slice(0, 12)}`);
				return { status: "pulled" };
			}
			const remoteIsOld = await this.#git(env, ["merge-base", "--is-ancestor", remote, "HEAD"], context);
			if (remoteIsOld.code === 0) {
				// The checkout is ahead: the previous turn's accept did not land (a validation refusal, a host that moved).
				// Its commits are the truth this turn will offer again; a reset here would delete them.
				return { status: "diverged", detail: "the checkout is ahead of the host" };
			}
			const merged = await this.#git(env, ["merge", "--quiet", "--no-edit", remote], context);
			if (merged.code !== 0) {
				// A merge can refuse without starting one: local changes would be overwritten, or the histories are
				// unrelated. Only unmerged paths are the conflict reminder's to resolve.
				const unmerged = await this.#git(env, ["diff", "--name-only", "--diff-filter=U"], context);
				if (unmerged.code === 0 && unmerged.stdout.trim() === "") {
					return {
						status: "blocked",
						detail: `the checkout could not merge the host's commits: ${merged.stderr.trim()}`,
					};
				}
				return {
					status: "conflicted",
					detail: `the host moved and the merge into ${this.#deviceAgentDir} conflicted: ${merged.stderr.trim()}`,
				};
			}
			this.#onLog("[checkout] merged the host's commits into the checkout");
			return { status: "pulled" };
		} finally {
			await this.#removeTemp(env, incoming, context);
		}
	}

	/**
	 * Offer the checkout's commits to the host, and accept the ones the memory rules allow.
	 *
	 * The host fast-forwards only: a host that moved during the turn is reported as diverged, and the next pull merges
	 * it into the checkout, so the model resolves the one history rather than the host rewriting it.
	 */
	async accept(env: ExecutionEnv, context: Context): Promise<AcceptResult> {
		if (!this.#enabled) return { status: "up-to-date" };
		return this.#serialize(() => this.#named(this.#accept(env, context)));
	}

	async #accept(env: ExecutionEnv, context: Context): Promise<AcceptResult> {
		const hostRef = await this.#hostBranchRef();
		if (hostRef === undefined) return { status: "blocked", detail: DETACHED_HOST };
		const repo = await this.#git(env, ["rev-parse", "--git-dir"], context);
		if (repo.code !== 0) return { status: "up-to-date" };
		const head = await this.#git(env, ["rev-parse", "--verify", "--quiet", "HEAD"], context);
		if (head.code !== 0) return { status: "up-to-date" };
		// A commit is accepted from whatever branch the model is on, as long as it is a branch: the host fast-forwards
		// its own branch to that commit. A detached HEAD has no ref a bundle can carry, so it is the one shape refused.
		const branch = await this.#git(env, ["symbolic-ref", "--short", "HEAD"], context);
		if (branch.code !== 0) {
			return {
				status: "blocked",
				detail: `The checkout is on a detached HEAD. Switch to ${this.#branch} (or another branch) with \`git switch\`, commit there, and answer again.`,
			};
		}
		const guestBranch = branch.stdout.trim();
		// A turn that wrote the memory but did not commit it still wrote it; the host accepts commits, so the end of
		// the turn is the last moment that work can become one.
		await this.#commitGuestEdits(env, context);
		const stray = await this.#strayGuestBranch(env, context);
		if (stray !== undefined) {
			return {
				status: "blocked",
				detail: `The checkout has commits on branch ${stray} that are not on the branch it is on. Merge or delete that branch before answering; the host accepts one history, not a branch left behind.`,
			};
		}
		const outgoing = join(this.#deviceHome, `.checkout-outgoing-${randomUUID()}.bundle`);
		let bundle: Uint8Array;
		try {
			await this.#must(env, ["bundle", "create", "--quiet", outgoing, "--all"], context);
			bundle = await this.#readBundle(env, outgoing, context);
		} finally {
			await this.#removeTemp(env, outgoing, context);
		}
		try {
			await this.#commitHostEdits();
		} catch (error) {
			return { status: "blocked", detail: `the host could not commit the person's edit: ${reason(error)}` };
		}
		const temporary = join(tmpdir(), `mason-accept-${randomUUID()}.bundle`);
		const namespace = `refs/remotes/guest/${randomUUID()}`;
		try {
			await writeFile(temporary, bundle);
			try {
				await hostGit(this.#host, ["fetch", "--quiet", "--force", temporary, `+refs/heads/*:${namespace}/*`]);
			} catch (error) {
				return { status: "blocked", detail: `the host could not fetch the checkout: ${reason(error)}` };
			}
			const guestRef = `${namespace}/${guestBranch}`;
			const guestTip = (await hostGit(this.#host, ["rev-parse", guestRef])).trim();
			const hostTip = await hostGit(this.#host, ["rev-parse", "--verify", "--quiet", "HEAD"])
				.then((sha) => sha.trim())
				.catch(() => undefined);
			// The host has no first commit yet: the guest's tree becomes it, validated against the empty tree. This is
			// the shape a boot leaves behind when `ensureRepository` found a `.git` whose first commit never landed.
			if (hostTip === undefined) {
				const emptyTree = (await hostGit(this.#host, ["hash-object", "-w", "-t", "tree", "/dev/null"])).trim();
				let problems: string[];
				try {
					problems = await checkIncoming(this.#host, emptyTree, guestTip);
				} catch (error) {
					return { status: "blocked", detail: `the host could not validate the checkout: ${reason(error)}` };
				}
				if (problems.length > 0) return { status: "rejected", problems };
				await hostGit(this.#host, ["checkout", "--quiet", "-B", this.#branch, guestRef]);
				const commits = Number((await hostGit(this.#host, ["rev-list", "--count", guestTip])).trim());
				this.#onLog(
					`[checkout] accepted ${commits} commit(s) at ${guestTip.slice(0, 12)} as the first on ${this.#branch}`,
				);
				return { status: "accepted", commits };
			}
			if (hostTip === guestTip) return { status: "up-to-date" };
			const guestIsOld = await this.#hostAncestor(guestTip, hostTip);
			if (guestIsOld) return { status: "up-to-date" };
			const accepted = await this.#hostAncestor(hostTip, guestTip);
			if (!accepted) {
				return {
					status: "diverged",
					detail: `the host moved to ${hostTip.slice(0, 12)} while the turn was working; the next pull merges it`,
				};
			}
			let problems: string[];
			try {
				problems = await checkIncoming(this.#host, hostTip, guestTip);
			} catch (error) {
				return { status: "blocked", detail: `the host could not validate the checkout: ${reason(error)}` };
			}
			if (problems.length > 0) return { status: "rejected", problems };
			try {
				await hostGit(this.#host, ["merge", "--quiet", "--ff-only", guestRef]);
			} catch (error) {
				return { status: "blocked", detail: `the host could not fast-forward its memory: ${reason(error)}` };
			}
			const commits = Number((await hostGit(this.#host, ["rev-list", "--count", `${hostTip}..${guestTip}`])).trim());
			this.#onLog(`[checkout] accepted ${commits} commit(s) at ${guestTip.slice(0, 12)}`);
			return { status: "accepted", commits };
		} finally {
			await rm(temporary, { force: true }).catch(() => undefined);
			await this.#dropRefs(namespace);
		}
	}

	/** Delete the per-accept refs the host fetch wrote, so a stale tip can never be read as this turn's. */
	async #dropRefs(namespace: string): Promise<void> {
		try {
			const refs = (await hostGit(this.#host, ["for-each-ref", "--format=%(refname)", namespace]))
				.split("\n")
				.map((ref) => ref.trim())
				.filter((ref) => ref !== "");
			for (const ref of refs) await hostGit(this.#host, ["update-ref", "-d", ref]);
		} catch {
			// The next accept writes a new namespace; cleanup is not worth failing a turn over.
		}
	}

	/** Remove a bundle from the device home, naming a failed cleanup instead of swallowing it. */
	async #removeTemp(env: ExecutionEnv, path: string, context: Context): Promise<void> {
		try {
			const removed = await env.remove(path, { force: true }, context);
			if (!removed.ok && !isDeviceLost(removed.error)) {
				this.#onLog(`[checkout] could not remove ${path}: ${removed.error.message}`);
			}
		} catch (error) {
			if (!isDeviceLost(error)) this.#onLog(`[checkout] could not remove ${path}: ${reason(error)}`);
		}
	}

	/** The host's symbolic HEAD, or `undefined` when a person left the repository detached mid-run. */
	async #hostBranchRef(): Promise<string | undefined> {
		return hostGit(this.#host, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => undefined);
	}

	/** Whether `ancestor` is an ancestor of `descendant` in the host's repository. */
	async #hostAncestor(ancestor: string, descendant: string): Promise<boolean> {
		try {
			await run("git", ["-C", this.#host, "merge-base", "--is-ancestor", ancestor, descendant]);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * A person's edit is committed on the host before either direction, labelled as theirs.
	 *
	 * The agent cannot write the host's tree — no tool mounts it — so anything uncommitted here is a hand edit. It is
	 * committed rather than carried as a dirty tree, because a bundle carries commits and a dirty tree would make the
	 * host's tip a lie.
	 */
	async #commitHostEdits(): Promise<void> {
		const dirty = (await hostGit(this.#host, ["status", "--porcelain"])).trim();
		if (dirty === "") return;
		await hostGit(this.#host, ["add", "-A"]);
		await hostGit(this.#host, [
			"-c",
			"user.name=the person",
			"-c",
			"user.email=person@localhost",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--quiet",
			"--no-verify",
			"-m",
			"The person's edit",
		]);
		this.#onLog("[checkout] committed the person's edit on the host");
	}

	/** A bundle of every host ref, as bytes the channel carries. */
	async #hostBundle(): Promise<Uint8Array> {
		const temporary = join(tmpdir(), `mason-pull-${randomUUID()}.bundle`);
		try {
			await hostGit(this.#host, ["bundle", "create", "--quiet", temporary, "--all"]);
			return await readFile(temporary);
		} finally {
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	/** Write bundle bytes into the checkout, naming a lost device instead of an ordinary refusal. */
	async #writeBundle(env: ExecutionEnv, path: string, bytes: Uint8Array, context: Context): Promise<void> {
		const written = await env.writeFile(path, bytes, context);
		if (written.ok) return;
		if (isDeviceLost(written.error)) throw deviceLost(written.error);
		throw new Error(`checkout: cannot write ${path}: ${written.error.message}`);
	}

	/** Read bundle bytes out of the checkout. */
	async #readBundle(env: ExecutionEnv, path: string, context: Context): Promise<Uint8Array> {
		const read = await env.readBinaryFile(path, context);
		if (read.ok) return read.value;
		if (isDeviceLost(read.error)) throw deviceLost(read.error);
		throw new Error(`checkout: cannot read ${path}: ${read.error.message}`);
	}

	/**
	 * A local branch with commits the current branch does not contain.
	 *
	 * A model that commits on a branch it made and then switches back has left its memory on a ref `accept` would not
	 * carry; "up-to-date" would report success for work the host never saw. A branch already merged is its ancestor.
	 */
	async #strayGuestBranch(env: ExecutionEnv, context: Context): Promise<string | undefined> {
		const refs = await this.#git(env, ["for-each-ref", "--format=%(refname)", "refs/heads"], context);
		if (refs.code !== 0) return undefined;
		const head = await this.#git(env, ["rev-parse", "--verify", "--quiet", "HEAD"], context);
		if (head.code !== 0) return undefined;
		for (const ref of refs.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "")) {
			const tip = await this.#git(env, ["rev-parse", "--verify", "--quiet", ref], context);
			if (tip.code !== 0 || tip.stdout.trim() === head.stdout.trim()) continue;
			const contained = await this.#git(env, ["merge-base", "--is-ancestor", ref, "HEAD"], context);
			if (contained.code !== 0) return ref.replace(/^refs\/heads\//, "");
		}
		return undefined;
	}

	/**
	 * Commit whatever the checkout has left uncommitted, as the turn's work.
	 *
	 * Unmerged paths are left alone: a conflict is the model's to resolve, not something to commit with its markers.
	 * `--no-verify` because a hook in the checkout is agent-editable and cannot be a guard; the host validates the diff.
	 */
	async #commitGuestEdits(env: ExecutionEnv, context: Context): Promise<void> {
		const dirty = await this.#git(env, ["status", "--porcelain"], context);
		if (dirty.code !== 0 || dirty.stdout.trim() === "") return;
		if (/^(DD|AU|UD|UA|DU|AA|UU)/m.test(dirty.stdout)) return;
		await this.#identity(env, context);
		await this.#must(env, ["add", "-A"], context);
		await this.#must(
			env,
			["-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", "The turn's uncommitted work"],
			context,
		);
		this.#onLog("[checkout] committed the turn's uncommitted work");
	}

	/** The identity a guest commit uses: the device has no global git config, and a commit without one fails. */
	async #identity(env: ExecutionEnv, context: Context): Promise<void> {
		await this.#must(env, ["config", "user.name", "mason"], context);
		await this.#must(env, ["config", "user.email", "mason@localhost"], context);
		await this.#must(env, ["config", "commit.gpgsign", "false"], context);
	}
}

/** What a rejected accept says to the model, once per turn. */
export const MEMORY_REMINDER =
	"The host did not accept your memory: the files below break a rule the prompt already told you about. Fix each " +
	"one in ~/agent, commit the fix with git, and answer again.";

/** What a conflicted pull says to the model. */
export const CONFLICT_REMINDER =
	"The host changed while you were working, and merging its commits into ~/agent left conflicts. Resolve the " +
	"conflicts, commit, and answer again; the host accepts a fast-forward only.";

const PULLED = "checkout.pulled";
const REFUSED = "checkout.refused";

export interface CheckoutExtensionOptions {
	readonly checkout: Checkout;
	/** The turn's environment, resolved from the conversation the hook runs in. */
	readonly envFor: (conversationId: string) => Promise<ExecutionEnv>;
}

/**
 * The turn's two sync points: pull before the first request, accept when the turn answers.
 *
 * Both are `GenerationTask` hooks because that is where a turn's boundaries are: `beforeRequest` runs once per run for
 * the pull, memoized so a tool round pays one bundle rather than one per request; `onYield` runs on the final answer,
 * and a refusal continues the run with the reminder `delivery.ts` uses, so the model fixes the file in the turn that
 * broke it. `afterRun` accepts too, which is what lands the commits of a turn that ended in a tool `terminate`.
 */
export function createCheckoutExtension(options: CheckoutExtensionOptions): Extension {
	const checkout = options.checkout;
	/**
	 * A tool call that found the device gone settles named, in the place the model reads.
	 *
	 * pi-env reports a lost connection as an ordinary `unknown` error, so a lost device used to read in a transcript
	 * like a tool that refused a request — while a resident read threw and was memoized. The rewrite is one named
	 * result the model sees immediately: one settlement, the same sentence in the transcript as in the prompt's failure,
	 * and no second attempt hidden behind it.
	 */
	const lossHook = hook(ToolTask, {
		afterTool: (call, result) => {
			const lost = (result.diagnostics ?? []).find((diagnostic) => isDeviceLost(diagnostic.message));
			if (lost === undefined) return undefined;
			const named = `device lost: ${call.name}: ${lost.message} — the turn was not retried`;
			return {
				...result,
				isError: true,
				output: [{ type: "text" as const, text: named }],
				diagnostics: [{ severity: "error" as const, code: "device_lost", message: named }],
			};
		},
	});
	const checkoutHook = hook(GenerationTask, {
		beforeRequest: async (request, api, context) => {
			if ((await api.memo(PULLED, context)) === true) return undefined;
			if (!checkout.enabled) {
				await api.memo(PULLED, true, context);
				return undefined;
			}
			const env = await options.envFor(String(api.conversationId));
			const pulled = await checkout.pull(env, context);
			await api.memo(PULLED, true, context);
			if (pulled.status === "lost") {
				return {
					messages: [
						...request.messages,
						{
							role: "user" as const,
							content: `${pulled.detail}. Answer without tools and say what you could not do; this turn is not retried.`,
							timestamp: Date.now(),
						},
					],
				};
			}
			if (pulled.status === "blocked") {
				return {
					messages: [
						...request.messages,
						{
							role: "user" as const,
							content: `${pulled.detail}. Work from what is in ~/agent and say what could not be synced; do not retry the pull.`,
							timestamp: Date.now(),
						},
					],
				};
			}
			if (pulled.status !== "conflicted") return undefined;
			// The request only: the conflict is in the checkout, and the model is told where to look. A durable entry
			// would re-say it on every later turn, after the conflict is long resolved.
			return {
				messages: [
					...request.messages,
					{ role: "user" as const, content: `${CONFLICT_REMINDER}\n${pulled.detail}`, timestamp: Date.now() },
				],
			};
		},
		onYield: async (_answer, api, context) => {
			if (!checkout.enabled) return undefined;
			const env = await options.envFor(String(api.conversationId));
			let accepted = await checkout.accept(env, context);
			if (accepted.status === "diverged") {
				const pulled = await checkout.pull(env, context);
				if (pulled.status === "conflicted") return { continue: `${CONFLICT_REMINDER}\n${pulled.detail}` };
				accepted = await checkout.accept(env, context);
			}
			if (accepted.status === "blocked") {
				if ((await api.memo(REFUSED, context)) === true) return undefined;
				await api.memo(REFUSED, true, context);
				return { continue: accepted.detail };
			}
			if (accepted.status !== "rejected") return undefined;
			if ((await api.memo(REFUSED, context)) === true) return undefined;
			await api.memo(REFUSED, true, context);
			return { continue: `${MEMORY_REMINDER}\n${accepted.problems.map((problem) => `- ${problem}`).join("\n")}` };
		},
		afterRun: async (_run, api, context) => {
			if (!checkout.enabled) return undefined;
			const env = await options.envFor(String(api.conversationId));
			await checkout.accept(env, context);
			return undefined;
		},
	});
	return defineExtension({ name: CHECKOUT_EXTENSION_NAME, hooks: [checkoutHook, lossHook] });
}
