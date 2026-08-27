import { Q, type FlowrSearch } from '@eagleoutice/flowr/search/flowr-search-builder';
import { FlowrFilter } from '@eagleoutice/flowr/search/flowr-search-filters';
import { BuiltInProcName } from '@eagleoutice/flowr/dataflow/environments/built-in-proc-name';

/**
 * The pattern to match. Here: every call flowR treats as a string template carrying R code, i.e.
 * `glue`, `glue_safe`, `str_glue`, `cli_text`, `cli_alert_info`, ... . Matching on the *origin*
 * rather than on a name catches aliases and `pkg::fn` spellings for free.
 *
 * Other patterns you may want instead:
 * - `Q.all().filter(VertexType.FunctionCall)` — every call
 * - `Q.all().filter({ name: FlowrFilter.CallProps, args: { props: SemanticCallTag.User } })` — every call that asks the user
 * - `Q.fromQuery({ type: 'call-context', callName: '^glue$' })` — by (regex) name
 * - `Q.syntax('(call function: (identifier) @f))', 'f')` — by tree-sitter syntax
 */
export const pattern: FlowrSearch = Q.all()
	.filter({ name: FlowrFilter.OriginKind, args: { origin: BuiltInProcName.StringTemplate } })
	.build();
