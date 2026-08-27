# Transitive calls of matched expressions

A sample project showing how to use [`flowR`](https://github.com/flowr-analysis/flowr) to

1. **match a pattern** in an R project — here every `glue`/`cli` string-template call (see [`src/pattern.ts`](src/pattern.ts)),
2. **collect what each match reaches** — its transitive calls *and* the variables they read, so a `{...}` holding nothing but a variable is tracked too, each with the `pkg::fn` name flowR resolves for it (see [`src/collect.ts`](src/collect.ts)),
3. **record it as JSON** (see [`src/main.ts`](src/main.ts)).

This was created with the help of [claude](https://claude.ai/) to experiment with its ability to understand and use flowR's API.
The project is not a polished tool but a demonstration of how to use flowR's API to collect transitive calls of matched expressions in R code.

## How the collection works

[`src/collect.ts`](src/collect.ts) exports a single `collectMatches(analyzer, search)`, which asks the
[analyzer](https://github.com/flowr-analysis/flowr/wiki/Analyzer) for what it needs directly rather than going
through the [query API](https://github.com/flowr-analysis/flowr/wiki/Query-API):

| what                        | where it comes from                                          |
|-----------------------------|--------------------------------------------------------------|
| the matches                 | `analyzer.runSearch(search)`                                  |
| the calls a match reaches   | `analyzer.callGraph()` + `Dataflow.views.callGraph.computeSubCallGraph(graph, {match})` |
| the variables those read    | the `Reads` edges of `analyzer.dataflow()`                    |
| the `pkg::fn` name of a call| `Dataflow.qualifyAll(graph, true)`                            |
| the source location         | `SourceLocation.fromNode(graph.idMap.get(id))`                |

Each analysis is requested once and reused for every match — the analyzer caches them, so asking for the
dataflow graph and the call graph does not analyze the project twice. The graph walks are generators
(`reads`, `reached`, `references`), so they are collected into an array only where the JSON needs one.

Note that with bigger projects `JSON.stringify` may hit its string-length limit; the flowR wiki lists ways to serialize/compress large results.

## The signature database

Naming a call `glue::glue` rather than `glue` needs flowR's
[signature database](https://github.com/flowr-analysis/flowr/wiki/Signature-Database): flowR ships only the
`sigdb.remote.json` link file naming its shards, not the shards themselves.
[`src/sigdb.ts`](src/sigdb.ts) downloads them once (they are cached across runs, under `$FLOWR_CACHE_DIR` or
`~/.cache/flowr`) and hands `main.ts` the path to mount via `solver.sigdb.additionalPaths`. A failed download
is not fatal: the analysis then simply reports the plain names. To fill the cache up front:

```bash
npm run sigdb
```

The docker image does exactly that at build time (~64 MB of shards), so a container run needs no network.
`npm run build` copies the link file next to the bundle, so a bundled build can fetch the shards itself
whenever its cache is empty.

## Quickstart

```bash
npm install
npm run main -- sample-project output.json
```

Or with the [docker image](https://hub.docker.com/r/eagleoutice/sample-flowr-transitive-calls):

```bash
docker run -it --rm -u "$(id -u):$(id -g)" -v "$PWD":"/data" eagleoutice/sample-flowr-transitive-calls:latest /data/sample-project /data/output.json
```

## Output

One entry per match. `glue("hi {user}")` interpolates a plain variable, so it has no calls of its own but a resolved reference:

```json
{ "id": 82, "name": "glue", "qualifiedName": "glue::glue", "at": ".../report.R:8:5",
  "transitiveCalls": [ { "id": 63, "name": "library", "qualifiedName": "base::library",
                         "at": ".../report.R:1:1" } ],
  "references": [ { "id": "glue::80:8:10-0", "name": "user",
                    "definedAt": [ { "id": 72, "name": "user", "at": ".../report.R:5:1" } ] } ] }
```

`glue("hello {label(user)}")` adds the chain behind the call: `label` → `base::paste0`, `normalize` → `base::trimws`, `base::tolower`, plus the `x` each of them reads.

Three things worth knowing about the output:

- `name` is the name as written (the `fn` of a `pkg::fn()` call), `qualifiedName` the package export flowR resolves it to. It is absent for a call that resolves to no export — a function the project defines itself, such as `label` above — and for everything that is not a call.
- flowR parses an interpolation as the R code it is, but the nodes it creates for it carry no source range of their own, hence the missing `at` on them (their id names the template they came from).
- `library` shows up among the transitive calls because the call graph follows how `glue` itself got bound — that is flowR's call graph, not a quirk of this sample.

## Running over a corpus

[`src/batch.ts`](src/batch.ts) applies the same analysis to every project below a root and aggregates as it
goes:

```bash
npm run batch -- /path/to/corpus results.ndjson --jobs 16
```

It discovers projects by walking down until it finds a directory to hand the analyzer whole: one holding a
`DESCRIPTION` (an R package, taken as a unit so flowR reads its dependencies and loading order rather than
seeing `R/`, `tests/` and `vignettes/` as three unrelated projects), or otherwise the topmost directory that
holds R files itself. So a collection laid out as `<source>/<id>/...` gives one project per `<id>`, a
single-child chain such as `dataverse/doi-10-7910/DVN/<id>` is walked through rather than analyzed as one
huge project, and an unpacked CRAN mirror laid out as `<pkg>/<version>/` gives one project per released
version. `--latest` keeps only the newest of sibling version directories, which is the difference between
CRAN's 166k releases and its 24k packages.

Not every directory of R files is a project, though: a corpus may also drop files sampled from hundreds of
different repositories into one flat directory, and nothing on disk distinguishes that from a project that
happens to have hundreds of files. So it is named rather than guessed. `--per-file a,b` analyzes each R file
below a directory called `a` or `b` on its own; bare `--per-file` does that for every directory found. A
corpus mixing both layouts is then still one run:

```bash
npm run batch -- /path/to/dataset dataset.ndjson --per-file notebooks,shiny-apps
```

which analyzes `dataset/projects/**/<id>/` whole, and every file of `dataset/notebooks/` and
`dataset/shiny-apps/` as a project of its own. Analyzing a notebook (`.Rmd`, `.qmd`, `.Rnw`, `.ipynb`) needs
nothing extra -- flowR reads the R out of the chunks itself.

A `WorkerPool` spreads the queue over worker processes, one project at a time per worker, each reusing a
single tree-sitter parser across its projects. It holds two invariants, in one place, that a run depends on:
a slot never holds two projects (a worker sharing its parser between two analyses dies), and an event from a
worker the slot has already replaced is ignored (a replaced worker exits long after its successor took over).
Around them, a worker that hangs is killed and its project recorded as `timeout`, a worker that crashes takes
only its own project down, and workers are replaced every `--recycle` projects so a leak cannot grow without
bound, and each worker runs under `--heap-mb` so a project that would exhaust memory is abandoned in seconds
rather than thrashing the garbage collector for minutes until node's default limit kills it.

| flag           | default | meaning                                          |
|----------------|---------|--------------------------------------------------|
| `--jobs`       | cores-1, max 16 | worker processes                         |
| `--timeout-ms` | 600000  | per-project budget before the worker is killed    |
| `--recycle`    | 200     | projects a worker handles before being replaced   |
| `--heap-mb`    | 8192    | heap cap per worker; a project needing more is abandoned |
| `--latest`     | off     | of `<pkg>/<version>` siblings, analyze only the newest |
| `--limit`      | all     | analyze only the first N projects (for a trial run) |
| `--per-file`   | off     | directories (comma-separated, or all if given bare) whose R files are each a project |

Two files come out. `results.ndjson` holds one line per project — `{project, ms, files, matches}` or
`{project, ms, error}` — so it stays streamable however large the corpus gets, sidestepping the
`JSON.stringify` limit that a single document would hit. `results.summary.json` holds the aggregate, counted
while the run proceeds rather than by reading the NDJSON back:

```json
{ "projects": { "total": 300, "analyzed": 300, "failed": 0, "withMatches": 2 },
  "files": 1220, "matches": 33, "transitiveCalls": 27, "references": 34,
  "matchesByName":    { "glue::glue": 33 },
  "matchesByPackage": { "glue": 33 },
  "calledFunctions":  { "base::library": 21, "base::paste0": 4 },
  "flowrBugs": [], "givenUp": {}, "slowestProjects": [ { "project": "...", "ms": 8123 } ] }
```

## Changing the pattern

Edit [`src/pattern.ts`](src/pattern.ts); it lists alternatives (by name, by tree-sitter syntax, by call property).
