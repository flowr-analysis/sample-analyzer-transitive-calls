import { FlowrAnalyzerBuilder } from '@eagleoutice/flowr/project/flowr-analyzer-builder';
import { TreeSitterExecutor } from '@eagleoutice/flowr/r-bridge/lang-4.x/tree-sitter/tree-sitter-executor';
import { fileProtocol } from '@eagleoutice/flowr/r-bridge/retriever.js';
import { jsonReplacer } from '@eagleoutice/flowr/util/json';
import { log, LogLevel } from '@eagleoutice/flowr/util/log';
import cp from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { collectMatches, type Match } from './collect';
import { pattern } from './pattern';
import { ensureSignatureDb } from './sigdb';

/** what one project contributes to the NDJSON, `matches` absent when the analysis failed */
interface ProjectResult {
	readonly project:  string;
	readonly ms:       number;
	readonly files?:   number;
	readonly matches?: readonly Match[];
	readonly error?:   string;
	/** set when flowR's gas guard stopped the extraction early, so the graph -- and the result -- is partial */
	readonly partial?: { dimension: string, reached: number, limit: number };
	/** the flowR frame the error came from, `fn @ file:line`, absent for our own failures (timeout, crash) */
	readonly site?:    string;
}

export interface Options {
	readonly jobs:      number;
	readonly timeoutMs: number;
	readonly limit:     number;
	/** projects a worker handles before it is replaced, so a leak in one analysis cannot grow without bound */
	readonly recycle:   number;
	/** heap cap per worker in MB; a project that needs more is abandoned instead of thrashing the garbage
	 * collector until node's default limit kills it (a 2 MB generated script can do that) */
	readonly heapMb:    number;
	/** dataflow vertices flowR may create before it stops extending the graph; `0` leaves it unbounded */
	readonly gasVertices: number;
	/** of `<pkg>/<version>` siblings, analyze only the newest -- an unpacked CRAN mirror is mostly history */
	readonly latest:    boolean;
	/** which discovered directories are collections of unrelated files rather than projects, so each of
	 * their R files becomes a project of its own: `'all'`, or the path segments naming them */
	readonly perFile?:  readonly string[] | 'all';
}

/* --------------------------------------------------------------- discovery */

const RFilePattern = /\.(r|rmd|qmd|rnw|ipynb)$/i;
/** a directory name that is a version, as the `<pkg>/<version>` layout of an unpacked CRAN mirror uses */
const VersionDirPattern = /^\d[\d.\-]*$/;

/**
 * The projects below `dir`, each a directory to hand the analyzer whole:
 *
 * - a directory with a `DESCRIPTION` is an R package, and the package -- not its `R/`, `tests/` and
 *   `vignettes/` separately -- is the unit, so flowR reads its dependencies and loading order,
 * - otherwise the topmost directories that hold R files themselves, so a collection organized as
 *   `<source>/<id>/...` yields one project per `<id>` and a single-child chain such as
 *   `dataverse/doi-.../DVN/<id>` is walked through rather than analyzed as one huge project.
 */
export function* projects(dir: string): Generator<string> {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	if(entries.some(e => e.isFile() && (e.name === 'DESCRIPTION' || RFilePattern.test(e.name)))) {
		yield dir;
		return;
	}
	for(const entry of entries) {
		if(entry.isDirectory()) {
			yield* projects(path.join(dir, entry.name));
		}
	}
}

/**
 * Of sibling projects that are versions of one thing (`<pkg>/1.0`, `<pkg>/1.2`), keep only the newest.
 * Siblings that are not all version numbers are left alone, so an id-keyed collection stays complete.
 */
export function newestVersionsOnly(found: readonly string[]): string[] {
	const byParent = new Map<string, string[]>();
	for(const project of found) {
		const parent = path.dirname(project);
		byParent.set(parent, [...byParent.get(parent) ?? [], project]);
	}
	const kept: string[] = [];
	for(const siblings of byParent.values()) {
		if(siblings.length > 1 && siblings.every(s => VersionDirPattern.test(path.basename(s)))) {
			kept.push(siblings.reduce((a, b) => compareVersions(path.basename(a), path.basename(b)) >= 0 ? a : b));
		} else {
			kept.push(...siblings);
		}
	}
	return kept;
}

/** compares two version strings segment by segment, numerically where both segments are numbers */
function compareVersions(a: string, b: string): number {
	const left = a.split(/[.\-]/), right = b.split(/[.\-]/);
	for(let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = Number(left[i] ?? 0) - Number(right[i] ?? 0);
		if(diff !== 0) {
			return diff;
		}
	}
	return 0;
}

/**
 * Whether `project` is a directory of unrelated files rather than one project. Discovery cannot tell the
 * two apart -- a directory of 500 `app.R` files sampled from 500 repositories looks exactly like a project
 * with 500 files -- so it is named: `perFile` is `'all'`, or the path segments whose contents to split.
 */
function splitPerFile(project: string, perFile: Options['perFile']): boolean {
	return perFile === 'all' || (perFile?.some(name => project.split(path.sep).includes(name)) ?? false);
}

/** every R file below `dir`, each to be analyzed on its own */
function* rFiles(dir: string): Generator<string> {
	for(const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if(entry.isDirectory()) {
			yield* rFiles(full);
		} else if(RFilePattern.test(entry.name)) {
			yield full;
		}
	}
}

/* ------------------------------------------------------------------ worker */

/** analyzes the projects the parent sends, one at a time, reusing a single parser for all of them */
async function worker() {
	log.updateSettings(s => {
		s.settings.minLevel = LogLevel.Fatal;
	});
	await TreeSitterExecutor.initTreeSitter();
	const parser = new TreeSitterExecutor();
	const sigDb = process.env.FLOWR_SIGDB_MOUNT;
	const gasVertices = Number(process.env.FLOWR_GAS_VERTICES ?? 0);

	const analyze = async(project: string): Promise<ProjectResult> => {
		const time = Date.now();
		const builder = new FlowrAnalyzerBuilder().setParser(parser);
		if(sigDb) {
			builder.configure('solver.sigdb.additionalPaths', [sigDb]);
		}
		if(gasVertices > 0) {
			/* arming the `dataflow` feature makes flowR count the vertices it creates and stop at the bound,
			 * so a pathological file yields a partial graph instead of growing until the process dies */
			builder.configure('gas.features.dataflow', 1)
				.amendConfig(c => {
					c.gas.thresholds.vertices = { problematic: gasVertices / 2, critical: gasVertices };
				});
		}
		const analyzer = builder.buildSync();
		analyzer.addRequest(fileProtocol + project);
		try {
			const matches = await collectMatches(analyzer, pattern);
			const cut = (analyzer.peekDataflow() as { cutShort?: ProjectResult['partial'] } | undefined)?.cutShort;
			return {
				project,
				ms:      Date.now() - time,
				files:   analyzer.inspectContext().files.loadingOrder.getLoadingOrder().length,
				matches,
				partial: cut
			};
		} catch(e) {
			const error = e as Error;
			return { project, ms: Date.now() - time, error: error?.message ?? String(e), site: flowrSite(error?.stack) };
		} finally {
			/* frees the cached analyses (the wasm-backed parse trees included), but keeps the parser */
			analyzer.reset();
		}
	};

	process.on('message', (project: string) => {
		void analyze(project).then(result => process.send?.(JSON.stringify(result, jsonReplacer)));
	});
	process.send?.('ready');
}

/** where inside flowR a failure was thrown, `fn @ file:line`, so one line can stand for one bug */
function flowrSite(stack?: string): string | undefined {
	const frame = stack?.split('\n').find(l => l.includes('@eagleoutice/flowr/'));
	const parsed = frame === undefined ? null : /at (\S+).*@eagleoutice\/flowr\/(\S+?):(\d+):\d+/.exec(frame);
	return parsed === null ? undefined : `${parsed[1]} @ ${parsed[2]}:${parsed[3]}`;
}

/* -------------------------------------------------------------------- pool */

/** a worker process and the project it currently holds */
interface Slot {
	child:  cp.ChildProcess;
	done:   number;
	job?:   { project: string, started: number, timer: NodeJS.Timeout };
}

/**
 * Runs the queue across `options.jobs` worker processes, one project per worker at a time.
 *
 * Two invariants keep a run honest, and both live in one place here: a slot never holds two projects (a
 * worker sharing its parser between two analyses dies), and an event from a worker the slot has already
 * replaced is ignored (a replaced worker exits asynchronously, long after its successor took over).
 */
class WorkerPool {
	private readonly slots: Slot[] = [];
	private next = 0;
	private finished?: () => void;

	constructor(
		private readonly queue: readonly string[],
		private readonly options: Options,
		private readonly childEnv: NodeJS.ProcessEnv,
		private readonly onResult: (result: ProjectResult) => void
	) {}

	run(): Promise<void> {
		return new Promise(resolve => {
			this.finished = resolve;
			for(let i = 0; i < this.options.jobs; i++) {
				const slot = { child: this.spawn(), done: 0 };
				this.slots.push(slot);
				this.attach(slot, slot.child);
			}
		});
	}

	private spawn(): cp.ChildProcess {
		return cp.fork(__filename, ['--worker'], {
			env:      this.childEnv,
			execArgv: [
				`--max-old-space-size=${this.options.heapMb}`,
				...(__filename.endsWith('.ts') ? ['-r', 'ts-node/register'] : [])
			],
			stdio:    ['ignore', 'inherit', 'inherit', 'ipc']
		});
	}

	/** hand the slot a fresh worker; it asks for work itself once it reports `ready` */
	private replace(slot: Slot) {
		slot.child.kill();
		slot.child = this.spawn();
		slot.done = 0;
		slot.job = undefined;
		this.attach(slot, slot.child);
	}

	private attach(slot: Slot, child: cp.ChildProcess) {
		child.on('message', (msg: string) => {
			if(slot.child !== child) {
				return; // from a worker this slot has already replaced
			} else if(msg === 'ready') {
				this.dispatch(slot);
			} else {
				this.complete(slot, JSON.parse(msg) as ProjectResult);
			}
		});
		child.on('exit', () => {
			/* a crash (out of memory, a wasm abort) loses the project rather than the whole run */
			if(slot.child === child) {
				this.abandon(slot, 'worker exited');
			}
		});
	}

	private dispatch(slot: Slot) {
		if(slot.job !== undefined) {
			return; // busy: a late `ready` must not put a second project into this worker
		} else if(this.next >= this.queue.length) {
			this.shutdown();
			return;
		}
		const project = this.queue[this.next++];
		slot.job = {
			project,
			started: Date.now(),
			/* the analysis runs in its own process, so a hang is a kill rather than a stuck event loop */
			timer:   setTimeout(() => this.abandon(slot, 'timeout'), this.options.timeoutMs)
		};
		slot.child.send(project);
	}

	/** the project is lost, for a reason the worker could not report itself */
	private abandon(slot: Slot, error: 'timeout' | 'worker exited') {
		const job = slot.job;
		if(job === undefined) {
			return;
		}
		clearTimeout(job.timer);
		slot.job = undefined;
		this.replace(slot);
		this.record({ project: job.project, ms: Date.now() - job.started, error });
	}

	private complete(slot: Slot, result: ProjectResult) {
		clearTimeout(slot.job?.timer);
		slot.job = undefined;
		slot.done++;
		this.record(result);
		if(slot.done >= this.options.recycle && this.next < this.queue.length) {
			this.replace(slot);
		} else {
			this.dispatch(slot);
		}
	}

	private record(result: ProjectResult) {
		this.onResult(result);
	}

	private shutdown() {
		if(this.slots.some(s => s.job !== undefined)) {
			return;
		}
		for(const slot of this.slots) {
			slot.child.removeAllListeners('exit');
			slot.child.kill();
		}
		this.finished?.();
	}
}

/* --------------------------------------------------------------- aggregate */

/** one distinct flowR failure, however many projects ran into it */
interface FlowrBug {
	count:   number;
	site:    string;
	message: string;
	example: string;
}

/** the running aggregate over the per-project results, so nothing has to be read back afterwards */
class Summary {
	seen = 0;
	private ok = 0;
	private failed = 0;
	private withMatches = 0;
	private partial = 0;
	private matches = 0;
	private calls = 0;
	private references = 0;
	private files = 0;
	private readonly start = Date.now();
	private readonly byName = new Map<string, number>();
	private readonly byPackage = new Map<string, number>();
	private readonly calledByName = new Map<string, number>();
	/** flowR's own failures, one entry per throwing site */
	private readonly bugs = new Map<string, FlowrBug>();
	/** what we gave up on ourselves: `timeout`, `worker exited` */
	private readonly givenUp = new Map<string, number>();
	private readonly slowest: { project: string, ms: number }[] = [];

	constructor(private readonly total: number) {}

	add(result: ProjectResult) {
		this.seen++;
		this.files += result.files ?? 0;
		this.slowest.push({ project: result.project, ms: result.ms });
		this.slowest.sort((a, b) => b.ms - a.ms).splice(10);
		if(result.matches === undefined) {
			this.failed++;
			this.addFailure(result);
			return;
		}
		this.ok++;
		this.partial += result.partial === undefined ? 0 : 1;
		this.matches += result.matches.length;
		this.withMatches += result.matches.length > 0 ? 1 : 0;
		for(const match of result.matches) {
			bump(this.byName, match.qualifiedName ?? match.name);
			bump(this.byPackage, match.qualifiedName?.split('::')[0] ?? '<unresolved>');
			this.calls += match.transitiveCalls.length;
			this.references += match.references.length;
			for(const call of match.transitiveCalls) {
				bump(this.calledByName, call.qualifiedName ?? call.name);
			}
		}
	}

	private addFailure({ project, error = 'unknown', site }: ProjectResult) {
		if(site === undefined) {
			bump(this.givenUp, error);
			return;
		}
		const known = this.bugs.get(site);
		if(known === undefined) {
			this.bugs.set(site, { count: 1, site, message: error, example: project });
		} else {
			known.count++;
		}
	}

	/** the distinct flowR failures, worst first -- one entry per bug, not per project */
	flowrBugs(): FlowrBug[] {
		return [...this.bugs.values()].sort((a, b) => b.count - a.count);
	}

	progress(): string {
		const rate = this.seen / ((Date.now() - this.start) / 1000);
		return `${this.seen}/${this.total} projects (${this.failed} failed) | ${this.matches} matches in ${this.withMatches} projects | ${rate.toFixed(1)}/s`;
	}

	report() {
		return {
			projects:        { total: this.total, analyzed: this.ok, failed: this.failed, withMatches: this.withMatches, partial: this.partial },
			files:           this.files,
			matches:         this.matches,
			transitiveCalls: this.calls,
			references:      this.references,
			tookMs:          Date.now() - this.start,
			matchesByName:    top(this.byName, 50),
			matchesByPackage: top(this.byPackage, 50),
			calledFunctions:  top(this.calledByName, 100),
			flowrBugs:        this.flowrBugs(),
			givenUp:          top(this.givenUp, 10),
			slowestProjects:  this.slowest
		};
	}
}

const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
const top = (counts: Map<string, number>, n: number) =>
	Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).slice(0, n));

/* --------------------------------------------------------------------- run */

async function run(root: string, outputFile: string, options: Options) {
	const sigDb = await ensureSignatureDb(msg => console.log(`sigdb: ${msg}`));
	console.log('discovering projects...');
	const found = [...projects(root)];
	const kept = options.latest ? newestVersionsOnly(found) : found;
	if(options.latest && kept.length < found.length) {
		console.log(`${found.length} project directories, ${kept.length} after keeping only the newest version of each`);
	}
	/* a directory named by `--per-file` holds unrelated files, so each of them is a project of its own */
	const split = kept.flatMap(p => splitPerFile(p, options.perFile) ? [...rFiles(p)] : [p]);
	if(split.length !== kept.length) {
		console.log(`${kept.length} project directories, ${split.length} after splitting the per-file ones`);
	}
	const queue = split.slice(0, options.limit);
	console.log(`${queue.length} projects, ${options.jobs} workers`);

	const out = fs.createWriteStream(outputFile, { encoding: 'utf-8' });
	const summary = new Summary(queue.length);
	await new WorkerPool(queue, options, { ...process.env, FLOWR_SIGDB_MOUNT: sigDb, FLOWR_GAS_VERTICES: String(options.gasVertices) }, result => {
		out.write(JSON.stringify(result, jsonReplacer) + '\n');
		summary.add(result);
		if(summary.seen % 100 === 0 || summary.seen === queue.length) {
			console.log(summary.progress());
		}
	}).run();
	await new Promise<void>(resolve => out.end(resolve));

	const summaryFile = outputFile.replace(/\.ndjson$/, '') + '.summary.json';
	fs.writeFileSync(summaryFile, JSON.stringify(summary.report(), jsonReplacer, 2), 'utf-8');
	console.log(`\n${summary.progress()}\n  * per-project results: ${outputFile}\n  * aggregate: ${summaryFile}`);
	const bugs = summary.flowrBugs();
	if(bugs.length > 0) {
		console.log(`\n${bugs.length} distinct flowR failure${bugs.length === 1 ? '' : 's'}:`);
		for(const bug of bugs) {
			console.log(`  ${String(bug.count).padStart(4)}x ${bug.site}: ${bug.message} (e.g. ${bug.example})`);
		}
	}
}

if(process.argv.includes('--worker')) {
	void worker();
} else if(require.main === module) {
	const [root, outputFile] = process.argv.slice(2);
	if(root === undefined || outputFile === undefined) {
		console.error('Usage: ts-node src/batch.ts <root> <output.ndjson> [--jobs N] [--timeout-ms N] [--limit N] [--recycle N] [--heap-mb N] [--gas-vertices N] [--latest] [--per-file [dir,dir,...]]');
		process.exit(1);
	}
	const flag = (name: string, fallback: number) => {
		const at = process.argv.indexOf(`--${name}`);
		return at === -1 ? fallback : Number(process.argv[at + 1]);
	};
	/** `--per-file` splits every discovered directory, `--per-file a,b` only those below an `a` or `b` */
	const perFile = (): Options['perFile'] => {
		const at = process.argv.indexOf('--per-file');
		const value = at === -1 ? undefined : process.argv[at + 1];
		return at === -1 ? undefined : value === undefined || value.startsWith('--') ? 'all' : value.split(',');
	};
	void run(root, outputFile, {
		jobs:      flag('jobs', Math.max(1, Math.min(16, os.cpus().length - 1))),
		timeoutMs:   flag('timeout-ms', 600_000),
		limit:     flag('limit', Number.MAX_SAFE_INTEGER),
		recycle:   flag('recycle', 200),
		heapMb:      flag('heap-mb', 8192),
		gasVertices: flag('gas-vertices', 0),
		latest:      process.argv.includes('--latest'),
		perFile:     perFile()
	}).catch(err => {
		console.error('Batch run failed:', err);
		process.exit(1);
	});
}
