import { CallProp, CallProps } from '@eagleoutice/flowr/dataflow/environments/built-in-props';
import { Dataflow } from '@eagleoutice/flowr/dataflow/graph/df-helper';
import { callFnProps } from '@eagleoutice/flowr/dataflow/environments/query-fn-props';
import { EdgeType } from '@eagleoutice/flowr/dataflow/graph/edge';
import { NoEdges } from '@eagleoutice/flowr/dataflow/graph/graph';
import { FunctionCallVertex, UseVertex, VariableDefinitionVertex } from '@eagleoutice/flowr/dataflow/graph/vertex';
import { Identifier } from '@eagleoutice/flowr/dataflow/environments/identifier';
import { RNode } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/model';
import { SourceLocation } from '@eagleoutice/flowr/util/range';
import type { Identifier as IdentifierType } from '@eagleoutice/flowr/dataflow/environments/identifier';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { ReadonlyFlowrAnalysisProvider } from '@eagleoutice/flowr/project/flowr-analyzer';
import type { FlowrSearchLike } from '@eagleoutice/flowr/search/flowr-search-builder';

export interface Node {
	readonly id:   NodeId;
	/** the name as written, so the `fn` of a `pkg::fn()` call */
	readonly name: string;
	/** the `pkg::fn` export flowR resolves the call to, absent for anything it does not resolve */
	readonly qualifiedName?: string;
	/** `file:line:column`, absent for nodes flowR synthesized (e.g. the code inside a `{...}`) */
	readonly at?:  string;
}
/** a variable an expression refers to, e.g. the `user` of `glue("hi {user}")` */
export interface Reference extends Node {
	/** where the value read here is written, empty if flowR resolves it to nothing it can see */
	readonly definedAt: readonly Node[];
}
export interface Match extends Node {
	/** every call reachable from this one, the calls written inside the template's `{...}` included */
	readonly transitiveCalls: readonly Node[];
	/** every variable those read, so a `{...}` holding nothing but a variable is tracked too */
	readonly references:      readonly Reference[];
}

/**
 * For every expression `search` matches, collect what it reaches: the calls it (transitively) makes and the
 * variables those read. Everything comes from the analyzer directly rather than through the query API, so
 * each analysis runs once and is reused for every match.
 * @param analyzer - the analyzer holding the project to inspect
 * @param search   - the pattern picking the expressions to start from, see `src/pattern.ts`
 */
export async function collectMatches(analyzer: ReadonlyFlowrAnalysisProvider, search: FlowrSearchLike): Promise<Match[]> {
	const dataflow = await analyzer.dataflow();
	const { graph: dfg } = dataflow;
	/* before the search, not after: computing the call graph propagates transitive side effects (a package
	 * attached inside a function, say), which lets origins resolve that the search would otherwise miss */
	const callGraph = await analyzer.callGraph();
	const found = (await analyzer.runSearch(search)).getElements();
	/* only the nodes that end up in the result are qualified, which is far fewer than the project's calls */
	const qualified = new Map<NodeId, IdentifierType | undefined>();

	function describe(id: NodeId): Node {
		const vertex = dfg.getVertex(id);
		const ast = dfg.idMap?.get(id);
		const [line, column, , , file] = SourceLocation.fromNode(ast) ?? [];
		if(!qualified.has(id)) {
			/* `true` also names a bare base-R call from the package exporting it, e.g. `sd` as `stats::sd` */
			qualified.set(id, Dataflow.qualify(id, dfg, true));
		}
		const name = qualified.get(id);
		return {
			id,
			name:          FunctionCallVertex.is(vertex) ? Identifier.getName(vertex.name) : RNode.lexeme(ast) ?? '',
			qualifiedName: name === undefined ? undefined : Identifier.toString(name),
			at:            file === undefined ? undefined : `${file}:${line}:${column}`
		};
	}

	/** the ids `from` reads, i.e. what it takes its value from */
	function* reads(from: NodeId): Generator<NodeId> {
		for(const [target, edge] of dfg.outgoingEdges(from) ?? NoEdges) {
			if(Dataflow.edge.includesType(edge, EdgeType.Reads)) {
				yield target;
			}
		}
	}

	/**
	 * Whether the call at `id` binds names outside its own frame, as `library`, `require`, and `assign` do.
	 * The call graph links a call to where its callee's name was bound, so every `glue()` in a project that
	 * opens with `library(glue)` reports that `library` among what it reaches. That is provenance, not a
	 * call the expression makes, and it drowns out the real ones -- on a corpus of 8k projects it was 72%
	 * of everything reported.
	 */
	function binds(id: NodeId): boolean {
		const info = callFnProps(id, dataflow);
		return info?.props !== undefined && CallProps.hasAny({ props: info.props, tags: [] }, CallProp.Scope);
	}

	/** `root` first, then the calls it reaches: the sub call graph rooted in it holds exactly those */
	function* reached(root: NodeId): Generator<NodeId> {
		yield root;
		for(const [id] of Dataflow.views.callGraph.computeSubCallGraph(callGraph, new Set([root])).vertices(true)) {
			if(id !== root && FunctionCallVertex.is(dfg.getVertex(id)) && !binds(id)) {
				yield id;
			}
		}
	}

	/** the variables the given nodes read, each with the definitions flowR resolves it to */
	function* references(from: Iterable<NodeId>): Generator<Reference> {
		const seen = new Set<NodeId>();
		for(const source of from) {
			for(const id of reads(source)) {
				if(!seen.has(id) && UseVertex.is(dfg.getVertex(id))) {
					seen.add(id);
					yield { ...describe(id), definedAt: [...definitions(id)] };
				}
			}
		}
	}

	/** the writes the read at `id` may take its value from */
	function* definitions(id: NodeId): Generator<Node> {
		for(const target of reads(id)) {
			if(VariableDefinitionVertex.is(dfg.getVertex(target))) {
				yield describe(target);
			}
		}
	}

	const matches: Match[] = [];
	for(const { node } of found) {
		const root = RNode.getId(node);
		const ids = [...reached(root)]; // `ids[0]` is the root, the rest are its transitive calls
		matches.push({
			...describe(root),
			transitiveCalls: ids.slice(1).map(describe),
			references:      [...references(ids)]
		});
	}
	return matches;
}
